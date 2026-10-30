import test from "node:test";
import assert from "node:assert/strict";
import { handle, _resetCaches } from "../src/api.js";

const ENV = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "svc" };
const ORIGIN = "https://ventas.example.com";

import { makeFake } from "./fake-supabase.mjs";

// ------------------------------------------------------------- helpers
let sb;
async function setup() {
  _resetCaches();
  sb = makeFake();
  globalThis.fetch = sb.fake;
  sb.addUser("admin@x.com", "adminpass123", "admin", "Fernando");
  sb.addUser("op@x.com", "operpass1234", "operador", "Operadora");
  sb.addUser("lec@x.com", "lectpass1234", "lector", "Lector");
  sb.addUser("fuera@x.com", "fuerapass123", null);
  sb.addUser("baja@x.com", "bajapass1234", "operador", "Baja", false);
}
function req(method, path, { body, cookie, origin = ORIGIN } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  return new Request(ORIGIN + "/api" + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const call = (...a) => handle(req(...a), ENV);
async function login(email, password) {
  const r = await call("POST", "/login", { body: { email, password } });
  const set = r.headers.getSetCookie();
  return { res: r, cookie: set.map((c) => c.split(";")[0]).join("; "), set };
}

// ---------------------------------------------------------------- tests
test("login correcto pone cookies HttpOnly + Secure y no expone tokens", async () => {
  await setup();
  const { res, set } = await login("admin@x.com", "adminpass123");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.rol, "admin");
  assert.ok(!JSON.stringify(data).includes("at_"));
  assert.equal(set.length, 2);
  for (const c of set) { assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Strict/); }
});

test("login rechaza contraseña mala, cuenta sin perfil y cuenta bloqueada", async () => {
  await setup();
  assert.equal((await login("admin@x.com", "mala")).res.status, 401);
  const fuera = await login("fuera@x.com", "fuerapass123");
  assert.equal(fuera.res.status, 403);
  assert.equal(fuera.set.length, 0);
  assert.equal((await login("baja@x.com", "bajapass1234")).res.status, 403);
});

test("sin sesión todo da 401; con token inválido también", async () => {
  await setup();
  assert.equal((await call("GET", "/products")).status, 401);
  assert.equal((await call("GET", "/sales", { cookie: "vt_at=basura" })).status, 401);
});

test("el refresh token renueva la sesión y emite cookies nuevas", async () => {
  await setup();
  const { cookie } = await login("admin@x.com", "adminpass123");
  const rt = cookie.split("; ").find((c) => c.startsWith("vt_rt="));
  const res = await call("GET", "/me", { cookie: rt });
  assert.equal(res.status, 200);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("vt_at=")));
});

test("CSRF: origen distinto se rechaza", async () => {
  await setup();
  const { cookie } = await login("admin@x.com", "adminpass123");
  const r = await call("POST", "/products", { cookie, origin: "https://malo.example", body: { sku: "A", nombre: "A" } });
  assert.equal(r.status, 403);
});

test("admin crea producto; SKU duplicado da 409; datos inválidos 422", async () => {
  await setup();
  const { cookie } = await login("admin@x.com", "adminpass123");
  const ok = await call("POST", "/products", { cookie, body: { sku: "LACE-001", nombre: "Playera", tipo_prov: "Nacional", costo_prov: "100", precio_ml: "250", precio_tt: 230 } });
  assert.equal(ok.status, 201);
  assert.equal((await call("POST", "/products", { cookie, body: { sku: "LACE-001", nombre: "Otra" } })).status, 409);
  assert.equal((await call("POST", "/products", { cookie, body: { sku: "mal;sku", nombre: "X" } })).status, 422);
  assert.equal((await call("POST", "/products", { cookie, body: { sku: "B", nombre: "X", costo_prov: -5 } })).status, 422);
});

async function seedProducts() {
  const { cookie } = await login("admin@x.com", "adminpass123");
  await call("POST", "/products", { cookie, body: { sku: "LACE-001", nombre: "Playera", tipo_prov: "Nacional", costo_prov: 100, precio_ml: 250, precio_tt: 230 } });
  await call("POST", "/products", { cookie, body: { sku: "SAT-002", nombre: "Crema", tipo_prov: "Importación", costo_prov: 80, precio_ml: 199.5, precio_tt: 180 } });
  return cookie;
}

test("permisos por perfil: operador no toca catálogo, lector no escribe nada", async () => {
  await setup();
  const admin = await seedProducts();
  const op = (await login("op@x.com", "operpass1234")).cookie;
  const lec = (await login("lec@x.com", "lectpass1234")).cookie;
  assert.equal((await call("GET", "/products", { cookie: op })).status, 200);
  assert.equal((await call("POST", "/products", { cookie: op, body: { sku: "Z", nombre: "Z" } })).status, 403);
  assert.equal((await call("GET", "/sales", { cookie: lec })).status, 200);
  const venta = { fecha: "2026-10-30", canal: "ml", items: [{ sku: "LACE-001", qty: 1 }] };
  assert.equal((await call("POST", "/sales", { cookie: lec, body: venta })).status, 403);
  assert.equal((await call("GET", "/team", { cookie: op })).status, 403);
  const created = await (await call("POST", "/sales", { cookie: op, body: venta })).json();
  assert.equal((await call("DELETE", "/sales/" + created.id, { cookie: op })).status, 403);
  assert.equal((await call("DELETE", "/sales/" + created.id, { cookie: admin })).status, 200);
});

test("venta: el servidor calcula totales, tipo y costo con el catálogo", async () => {
  await setup();
  await seedProducts();
  const op = (await login("op@x.com", "operpass1234")).cookie;
  const r = await call("POST", "/sales", { cookie: op, body: {
    fecha: "2026-10-30", canal: "ml", pedido_ext: "2000123", guia: "ABC123", paqueteria: "Estafeta",
    items: [{ sku: "LACE-001", qty: 2 }, { sku: "SAT-002", qty: 1 }],
    total: 1, prov_total: 1 /* el cliente no manda totales: se ignoran */ } });
  assert.equal(r.status, 201);
  const s = await r.json();
  assert.equal(s.total, 2 * 250 + 199.5);
  assert.equal(s.prov_total, 2 * 100 + 80);
  assert.equal(s.total_manual, false);
  assert.equal(s.folio, "V-00" + s.folio.slice(-3));
  assert.equal(s.registrada_por, "Operadora");
  assert.equal(s.items.length, 2);
  // mismo pedido en TikTok usa el otro precio
  const t = await (await call("POST", "/sales", { cookie: op, body: { fecha: "2026-10-30", canal: "tt", items: [{ sku: "LACE-001", qty: 1 }] } })).json();
  assert.equal(t.total, 230);
});

test("venta: total manual, SKU inexistente, cantidad y fecha inválidas", async () => {
  await setup();
  await seedProducts();
  const op = (await login("op@x.com", "operpass1234")).cookie;
  const base = { fecha: "2026-10-30", canal: "ml", items: [{ sku: "LACE-001", qty: 1 }] };
  const m = await (await call("POST", "/sales", { cookie: op, body: { ...base, total_manual: 199 } })).json();
  assert.equal(m.total, 199); assert.equal(m.total_manual, true);
  assert.equal((await call("POST", "/sales", { cookie: op, body: { ...base, items: [{ sku: "NOPE", qty: 1 }] } })).status, 422);
  assert.equal((await call("POST", "/sales", { cookie: op, body: { ...base, items: [{ sku: "LACE-001", qty: 0 }] } })).status, 422);
  assert.equal((await call("POST", "/sales", { cookie: op, body: { ...base, fecha: "2026-02-31" } })).status, 422);
  assert.equal((await call("POST", "/sales", { cookie: op, body: { ...base, items: [] } })).status, 422);
  assert.equal((await call("POST", "/sales", { cookie: op, body: { ...base, items: [{ sku: 'X"),sku=eq.(', qty: 1 }] } })).status, 422);
});

test("editar: cambio de estatus rápido y recálculo conservando precios congelados", async () => {
  await setup();
  const admin = await seedProducts();
  const op = (await login("op@x.com", "operpass1234")).cookie;
  const s = await (await call("POST", "/sales", { cookie: op, body: { fecha: "2026-10-30", canal: "ml", items: [{ sku: "LACE-001", qty: 1 }] } })).json();
  const st = await call("PATCH", "/sales/" + s.id, { cookie: op, body: { estatus: "en_transito", guia: "G-77" } });
  assert.equal(st.status, 200);
  assert.equal((await st.json()).estatus, "en_transito");
  assert.equal((await call("PATCH", "/sales/" + s.id, { cookie: op, body: { estatus: "volando" } })).status, 422);

  // el catálogo sube de precio: la venta vieja conserva 250
  const prods = await (await call("GET", "/products", { cookie: admin })).json();
  const lace = prods.find((p) => p.sku === "LACE-001");
  await call("PATCH", "/products/" + lace.id, { cookie: admin, body: { precio_ml: 999, precio_tt: 999, costo_prov: 500 } });
  const edit = await (await call("PATCH", "/sales/" + s.id, { cookie: op, body: { items: [{ sku: "LACE-001", qty: 3 }] } })).json();
  assert.equal(edit.total, 750);
  assert.equal(edit.prov_total, 300);
  // una línea nueva con ese SKU en otra venta sí toma el precio nuevo
  const nueva = await (await call("POST", "/sales", { cookie: op, body: { fecha: "2026-10-30", canal: "ml", items: [{ sku: "LACE-001", qty: 1 }] } })).json();
  assert.equal(nueva.total, 999);
  // cambiar canal recalcula con el precio congelado del otro canal
  const tt = await (await call("PATCH", "/sales/" + s.id, { cookie: op, body: { canal: "tt" } })).json();
  assert.equal(tt.total, 3 * 230);
  assert.equal((await call("PATCH", "/sales/noexiste", { cookie: op, body: { canal: "ml" } })).status, 404);
});

test("equipo: admin crea acceso, no puede degradarse a sí mismo y bloquear quita el acceso", async () => {
  await setup();
  const admin = (await login("admin@x.com", "adminpass123")).cookie;
  const nuevo = await call("POST", "/team", { cookie: admin, body: { nombre: "Nueva", email: "nueva@x.com", rol: "operador", password: "temporal-12345" } });
  assert.equal(nuevo.status, 201);
  assert.equal((await login("nueva@x.com", "temporal-12345")).res.status, 200);
  assert.equal((await call("POST", "/team", { cookie: admin, body: { nombre: "N", email: "nueva@x.com", rol: "lector", password: "temporal-12345" } })).status, 409);
  assert.equal((await call("POST", "/team", { cookie: admin, body: { nombre: "N", email: "n2@x.com", rol: "root", password: "temporal-12345" } })).status, 422);
  assert.equal((await call("POST", "/team", { cookie: admin, body: { nombre: "N", email: "n2@x.com", rol: "lector", password: "corta" } })).status, 422);
  const me = (await (await call("GET", "/me", { cookie: admin })).json()).user;
  assert.equal((await call("PATCH", "/team/" + me.id, { cookie: admin, body: { rol: "lector" } })).status, 422);
  // bloquear a alguien le quita el acceso (tras vencer el caché corto)
  const op = (await login("op@x.com", "operpass1234")).cookie;
  const opId = (await (await call("GET", "/me", { cookie: op })).json()).user.id;
  assert.equal((await call("PATCH", "/team/" + opId, { cookie: admin, body: { activo: false } })).status, 200);
  assert.equal((await call("GET", "/products", { cookie: op })).status, 403);
});

test("cambio de contraseña y logout limpian/actualizan sesión", async () => {
  await setup();
  const { cookie } = await login("op@x.com", "operpass1234");
  assert.equal((await call("POST", "/password", { cookie, body: { nueva: "corta" } })).status, 422);
  assert.equal((await call("POST", "/password", { cookie, body: { nueva: "una-clave-larga-1" } })).status, 200);
  assert.equal((await login("op@x.com", "una-clave-larga-1")).res.status, 200);
  const out = await call("POST", "/logout", { cookie });
  assert.equal(out.status, 200);
  assert.ok(out.headers.getSetCookie().every((c) => /Max-Age=0/.test(c)));
});

test("rutas desconocidas dan 404 y errores de BD no filtran detalles", async () => {
  await setup();
  const { cookie } = await login("admin@x.com", "adminpass123");
  assert.equal((await call("GET", "/nada", { cookie })).status, 404);
  const r = await handle(req("GET", "/products", { cookie }), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "" });
  assert.equal(r.status, 500);
});
