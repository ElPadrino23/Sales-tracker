# Control de Ventas (Cloudflare Workers + Supabase)

Panel para seguir ventas de Mercado Libre y TikTok Shop con tres perfiles
(administrador, operador, lector).

```
Navegador ──> Worker de Cloudflare (src/worker.js)
                ├─ archivos estáticos  public/
                └─ /api/*  (src/api.js)           login, roles, validación
                    └─> Supabase (Postgres + Auth)    datos
```

- El navegador nunca habla con Supabase. Solo conoce `/api/*`.
- La sesión vive en cookies HttpOnly + Secure + SameSite=Strict.
- Las llaves de Supabase están como secretos del Worker. Las tablas tienen RLS
  activo y sin políticas, así que aunque alguien consiga la llave anon no lee nada.
- El servidor calcula `$ prov` y `$ total` con el catálogo. El navegador solo manda SKU y cantidad.

## 1. Supabase (10 min)

1. Crea un proyecto en supabase.com.
2. SQL Editor > New query > pega `supabase/schema.sql` > Run.
3. Authentication > Sign In / Providers > Email: **desactiva "Allow new users to sign up"**.
4. Authentication > Users > Add user (tu correo y contraseña, marca "Auto Confirm").
5. En el SQL Editor corre, con tu correo:
   ```sql
   insert into public.team_members (user_id, nombre, email, rol)
   select id, 'Fernando', email, 'admin' from auth.users where email = 'tu-correo@ejemplo.com';
   ```
6. Project Settings > API: copia `Project URL`, `anon key` y `service_role key`.
   La `service_role` es secreta: solo va en Cloudflare, nunca en el código ni en GitHub.

## 2. Cloudflare (Worker con archivos estáticos)

El proyecto se despliega como un Worker que sirve `public/` y atiende `/api/*`.

Con GitHub (recomendado):
1. Cloudflare > Workers & Pages > Create > Import a repository, y elige este repo.
2. El nombre del proyecto debe ser `sales-tracker` (igual al `name` de `wrangler.toml`).
3. Build command: vacío. Deploy command: `npx wrangler deploy`. Root directory: `/`.
4. Edita `SUPABASE_URL` en `wrangler.toml` con la URL de tu proyecto y haz commit.
5. Después del primer despliegue: Worker > Settings > Variables and Secrets > agrega como **Secret**
   `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. Luego vuelve a desplegar.

Con terminal:
```bash
npm install
npx wrangler login
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npm run deploy
```

## 3. Después de desplegar

- Entra con tu correo. En la pestaña **Equipo** agrega a las otras 2 personas con una contraseña temporal; cada quien la cambia con el botón Contraseña.
- Recomendado: en Cloudflare > Security > WAF > Rate limiting rules, limita `POST /api/login` (por ejemplo 10 intentos por minuto por IP).
- Opcional: conecta tu dominio en Worker > Settings > Domains & Routes.

## Local

```bash
cp .dev.vars.example .dev.vars   # llena las 3 variables
npm install && npm run dev
npm test                         # pruebas de la API con Supabase simulado
```

## Perfiles

| Perfil | Puede |
|---|---|
| admin | Todo: catálogo, ventas (incluye borrar), personas |
| operador | Registrar y editar ventas, guía, estatus, observaciones |
| lector | Solo ver |

Un perfil cambiado o bloqueado tarda hasta 30 s en aplicarse en todas las instancias del Worker.

## Fase 2: estatus de envío automático

Las tablas ya traen `ml_shipment_id`, `tiktok_package_id`, `status_source`, `tracking_updated_at`
y `shipment_events`. Falta el sincronizador (un Worker aparte con Cron Trigger y receptores de webhooks).
