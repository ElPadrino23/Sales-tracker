-- Control de Ventas: esquema para Supabase (SQL Editor > New query > Run)
-- Seguridad: todas las tablas tienen RLS activo y NINGUNA política.
-- Con eso las llaves anon/authenticated no leen ni escriben nada.
-- Solo el Worker de Cloudflare, con la service_role key, accede a los datos.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- equipo
create table if not exists public.team_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  nombre     text not null check (char_length(nombre) between 1 and 80),
  email      text not null,
  rol        text not null check (rol in ('admin','operador','lector')),
  activo     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------- productos
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  sku         text not null unique check (char_length(sku) between 1 and 60),
  nombre      text not null check (char_length(nombre) between 1 and 120),
  tipo_prov   text not null default '' check (char_length(tipo_prov) <= 60),
  costo_prov  numeric(12,2) not null default 0 check (costo_prov >= 0),
  precio_ml   numeric(12,2) not null default 0 check (precio_ml >= 0),
  precio_tt   numeric(12,2) not null default 0 check (precio_tt >= 0),
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- ventas
create sequence if not exists public.sales_folio_seq;

create table if not exists public.sales (
  id            uuid primary key default gen_random_uuid(),
  folio         text not null unique
                default ('V-' || lpad(nextval('public.sales_folio_seq')::text, 5, '0')),
  fecha         date not null,
  canal         text not null check (canal in ('ml','tt')),
  pedido_ext    text not null default '' check (char_length(pedido_ext) <= 60),
  prov_total    numeric(12,2) not null default 0,
  total         numeric(12,2) not null default 0,
  total_manual  boolean not null default false,
  paqueteria    text not null default '' check (char_length(paqueteria) <= 40),
  guia          text not null default '' check (char_length(guia) <= 80),
  estatus       text not null default 'pendiente'
                check (estatus in ('pendiente','preparando','en_transito','entregado','devuelto','cancelado')),
  obs           text not null default '' check (char_length(obs) <= 2000),
  created_by    uuid references auth.users(id) on delete set null,
  -- Preparado para el seguimiento automatico de envios (fase 2)
  status_source        text not null default 'manual' check (status_source in ('manual','mercadolibre','tiktok','agregador')),
  ml_shipment_id       text,
  tiktok_package_id    text,
  tracking_updated_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists sales_fecha_idx   on public.sales (fecha desc, created_at desc);
create index if not exists sales_estatus_idx on public.sales (estatus);
create index if not exists sales_guia_idx    on public.sales (guia) where guia <> '';

-- Lineas de cada venta. Guardan una copia de costo y precio al momento de
-- vender, asi que cambiar el catalogo despues no altera ventas pasadas.
create table if not exists public.sale_items (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references public.sales(id) on delete cascade,
  sku         text not null,
  nombre      text not null default '',
  qty         integer not null check (qty > 0),
  tipo_prov   text not null default '',
  costo_prov  numeric(12,2) not null default 0,
  precio_ml   numeric(12,2) not null default 0,
  precio_tt   numeric(12,2) not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists sale_items_sale_idx on public.sale_items (sale_id);

-- Historial de movimientos del envio (lo llenara el sincronizador en fase 2)
create table if not exists public.shipment_events (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references public.sales(id) on delete cascade,
  source       text not null,
  status       text not null,
  detail       text not null default '',
  occurred_at  timestamptz not null,
  raw          jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists shipment_events_sale_idx on public.shipment_events (sale_id, occurred_at desc);

-- ------------------------------------------------------- updated_at auto
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

drop trigger if exists sales_touch on public.sales;
create trigger sales_touch before update on public.sales
  for each row execute function public.touch_updated_at();

-- ---------------------------------------- guardar una venta de forma atomica
-- p_id null = crear. Reemplaza las lineas en una sola transaccion.
create or replace function public.save_sale(p_id uuid, p jsonb, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_id is null then
    insert into sales (fecha, canal, pedido_ext, prov_total, total, total_manual,
                       paqueteria, guia, estatus, obs, created_by)
    values ((p->>'fecha')::date, p->>'canal', coalesce(p->>'pedido_ext',''),
            (p->>'prov_total')::numeric, (p->>'total')::numeric,
            coalesce((p->>'total_manual')::boolean, false),
            coalesce(p->>'paqueteria',''), coalesce(p->>'guia',''),
            coalesce(p->>'estatus','pendiente'), coalesce(p->>'obs',''), p_user)
    returning id into v_id;
  else
    update sales set
      fecha = (p->>'fecha')::date,
      canal = p->>'canal',
      pedido_ext = coalesce(p->>'pedido_ext',''),
      prov_total = (p->>'prov_total')::numeric,
      total = (p->>'total')::numeric,
      total_manual = coalesce((p->>'total_manual')::boolean, false),
      paqueteria = coalesce(p->>'paqueteria',''),
      guia = coalesce(p->>'guia',''),
      estatus = coalesce(p->>'estatus','pendiente'),
      obs = coalesce(p->>'obs','')
    where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'sale_not_found' using errcode = 'P0002';
    end if;
    delete from sale_items where sale_id = v_id;
  end if;

  insert into sale_items (sale_id, sku, nombre, qty, tipo_prov, costo_prov, precio_ml, precio_tt)
  select v_id, i->>'sku', coalesce(i->>'nombre',''), (i->>'qty')::int,
         coalesce(i->>'tipo_prov',''), (i->>'costo_prov')::numeric,
         (i->>'precio_ml')::numeric, (i->>'precio_tt')::numeric
  from jsonb_array_elements(p->'items') as i;

  return v_id;
end $$;

revoke all on function public.save_sale(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_sale(uuid, jsonb, uuid) to service_role;

-- ------------------------------------------------------------------ RLS
alter table public.team_members    enable row level security;
alter table public.products        enable row level security;
alter table public.sales           enable row level security;
alter table public.sale_items      enable row level security;
alter table public.shipment_events enable row level security;
-- Sin politicas a proposito: solo service_role (el Worker) puede acceder.

-- ------------------------------------------- primer administrador (una vez)
-- 1) Authentication > Users > Add user (tu correo y una contrasena).
-- 2) Ejecuta esto con TU correo:
--
-- insert into public.team_members (user_id, nombre, email, rol)
-- select id, 'Fernando', email, 'admin' from auth.users where email = 'tu-correo@ejemplo.com';
