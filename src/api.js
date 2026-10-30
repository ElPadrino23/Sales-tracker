// API de Control de Ventas. Corre como Pages Function (Cloudflare Workers).
// Login con Supabase Auth, sesion en cookies HttpOnly, permisos por rol,
// y acceso a los datos solo con la service_role key (que nunca llega al navegador).

const ROLES = ["admin", "operador", "lector"];
const CANALES = ["ml", "tt"];
const ESTATUS = ["pendiente", "preparando", "en_transito", "entregado", "devuelto", "cancelado"];
const WRITE_ROLES = ["admin", "operador"];

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ------------------------------------------------------------ utilidades
const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function json(data, status = 200, extra) {
  const h = new Headers(baseHeaders);
  if (extra) for (const c of extra) h.append("set-cookie", c);
  return new Response(JSON.stringify(data), { status, headers: h });
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge, secure) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
function sessionCookies(tokens, secure) {
  return [
    cookie("vt_at", tokens.access_token, Math.max(60, Number(tokens.expires_in) || 3600), secure),
    cookie("vt_rt", tokens.refresh_token, 60 * 60 * 24 * 30, secure),
  ];
}
function clearCookies(secure) {
  return [cookie("vt_at", "", 0, secure), cookie("vt_rt", "", 0, secure)];
}

const str = (v, max, field, { required = false } = {}) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  if (required && !s) throw new ApiError(422, `Falta ${field}.`);
  if (s.length > max) throw new ApiError(422, `${field} es demasiado largo.`);
  return s;
};
const money = (v, field) => {
  const n = v === "" || v == null ? 0 : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new ApiError(422, `${field} no es un monto válido.`);
  return Math.round(n * 100) / 100;
};
const round2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------- Supabase
function cfg(env) {
  const anon = String(env.SUPABASE_ANON_KEY || "").trim();
  const svc = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!env.SUPABASE_URL || !anon || !svc) throw new ApiError(500, "Falta configurar Supabase en el servidor.");
  let url;
  try { url = new URL(String(env.SUPABASE_URL).trim()).origin; } // tolera "/rest/v1/" u otros restos al pegar
  catch { throw new ApiError(500, "SUPABASE_URL no es una URL válida."); }
  return { url, anon, svc };
}

async function rest(env, path, { method = "GET", body, prefer } = {}) {
  const { url, svc } = cfg(env);
  const headers = { apikey: svc, authorization: `Bearer ${svc}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (prefer) headers.prefer = prefer;
  const res = await fetch(`${url}/rest/v1/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (e.code === "23505") throw new ApiError(409, "Ya existe un registro con ese valor.");
    if (e.code === "P0002") throw new ApiError(404, "No se encontró el registro.");
    if (e.code === "23514" || e.code === "22P02" || e.code === "22007") throw new ApiError(422, "Alguno de los datos no es válido.");
    console.error("supabase_rest_error", res.status, e.code, e.message);
    throw new ApiError(502, "Error de base de datos.");
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const eq = (v) => "eq." + encodeURIComponent(v);

// Caches cortos por instancia: evitan consultar Supabase en cada clic.
const tokenCache = new Map();   // token -> { user, exp }
const memberCache = new Map();  // user_id -> { member, exp }
export function _resetCaches() { tokenCache.clear(); memberCache.clear(); }
function cacheSet(map, key, value, ms) {
  if (map.size > 500) map.clear();
  map.set(key, { value, exp: Date.now() + ms });
}
function cacheGet(map, key) {
  const hit = map.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  map.delete(key);
  return undefined;
}

async function userFromToken(env, token) {
  const hit = cacheGet(tokenCache, token);
  if (hit) return hit;
  const { url, anon } = cfg(env);
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json();
  if (!u || !u.id) return null;
  const user = { id: u.id, email: u.email };
  cacheSet(tokenCache, token, user, 60_000);
  return user;
}

async function refreshSession(env, refreshToken) {
  const { url, anon } = cfg(env);
  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  const t = await res.json();
  return t && t.access_token ? t : null;
}

async function memberOf(env, userId) {
  const hit = cacheGet(memberCache, userId);
  if (hit !== undefined) return hit;
  const rows = await rest(env, `team_members?user_id=${eq(userId)}&select=user_id,nombre,email,rol,activo`);
  const m = rows && rows[0] ? rows[0] : null;
  cacheSet(memberCache, userId, m, 30_000);
  return m;
}

// Devuelve { user, token, cookies } o lanza 401/403.
async function authenticate(request, env, secure) {
  const c = parseCookies(request.headers.get("cookie"));
  let token = c.vt_at;
  let u = token ? await userFromToken(env, token) : null;
  let cookies = null;
  if (!u && c.vt_rt) {
    const t = await refreshSession(env, c.vt_rt);
    if (t) {
      token = t.access_token;
      u = await userFromToken(env, token);
      cookies = sessionCookies(t, secure);
    }
  }
  if (!u) throw new ApiError(401, "Inicia sesión para continuar.");
  const m = await memberOf(env, u.id);
  if (!m || !m.activo) throw new ApiError(403, "Tu cuenta no tiene acceso a este panel.");
  return { user: { id: u.id, email: m.email || u.email, nombre: m.nombre, rol: m.rol }, token, cookies };
}

function requireRole(user, roles) {
  if (!roles.includes(user.rol)) throw new ApiError(403, "Tu perfil no permite esta acción.");
}

async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new ApiError(415, "Se esperaba JSON.");
  try { return await request.json(); } catch { throw new ApiError(400, "El cuerpo no es JSON válido."); }
}

// ----------------------------------------------------------------- login
async function login(request, env, secure) {
  const b = await readBody(request);
  const email = str(b.email, 200, "el correo", { required: true }).toLowerCase();
  const password = str(b.password, 200, "la contraseña", { required: true });
  const { url, anon } = cfg(env);
  let res;
  try {
    res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anon, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    console.error("supabase_login_unreachable", err && err.message);
    throw new ApiError(502, "No se pudo alcanzar Supabase. Revisa que SUPABASE_URL sea la URL real de tu proyecto.");
  }
  if (res.status === 429) throw new ApiError(429, "Demasiados intentos. Espera unos minutos.");
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (e.error_code === "email_not_confirmed") throw new ApiError(403, "Ese correo aún no está confirmado en Supabase. Confírmalo o crea el usuario con Auto Confirm.");
    // 400 = credenciales malas. Cualquier otro código apunta a la configuración (URL o llave).
    if (res.status !== 400) {
      console.error("supabase_login_error", res.status, e.error_code || e.message || "");
      if (res.status === 401 || res.status === 403) throw new ApiError(502, "Supabase rechazó la llave (SUPABASE_ANON_KEY). Copia de nuevo la llave anon de la pestaña Legacy API Keys.");
      if (res.status === 404) throw new ApiError(502, "Supabase no encontró esa URL. En SUPABASE_URL va solo https://tu-proyecto.supabase.co.");
      throw new ApiError(502, `Supabase respondió con el código ${res.status}. Intenta de nuevo en un minuto.`);
    }
    throw new ApiError(401, "Correo o contraseña incorrectos.");
  }
  const t = await res.json();
  const m = await memberOf(env, t.user && t.user.id);
  if (!m || !m.activo) throw new ApiError(403, "Tu cuenta no tiene acceso a este panel.");
  const user = { id: m.user_id, email: m.email, nombre: m.nombre, rol: m.rol };
  return json({ user }, 200, sessionCookies(t, secure));
}

async function logout(request, env, secure) {
  const c = parseCookies(request.headers.get("cookie"));
  if (c.vt_at) {
    const { url, anon } = cfg(env);
    tokenCache.delete(c.vt_at);
    await fetch(`${url}/auth/v1/logout`, { method: "POST", headers: { apikey: anon, authorization: `Bearer ${c.vt_at}` } }).catch(() => {});
  }
  return json({ ok: true }, 200, clearCookies(secure));
}

async function changePassword(env, auth, request) {
  const b = await readBody(request);
  const nueva = str(b.nueva, 200, "la contraseña nueva", { required: true });
  if (nueva.length < 10) throw new ApiError(422, "La contraseña debe tener al menos 10 caracteres.");
  const { url, anon } = cfg(env);
  const res = await fetch(`${url}/auth/v1/user`, {
    method: "PUT",
    headers: { apikey: anon, authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: JSON.stringify({ password: nueva }),
  });
  if (!res.ok) throw new ApiError(422, "No se pudo cambiar la contraseña. Prueba con otra más larga.");
  return json({ ok: true });
}

// -------------------------------------------------------------- productos
function productFields(b, partial) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has("sku")) {
    out.sku = str(b.sku, 60, "el SKU", { required: true });
    if (!/^[A-Za-z0-9._\-\/ ]+$/.test(out.sku)) throw new ApiError(422, "El SKU solo puede tener letras, números, punto, guion, diagonal y espacio.");
  }
  if (!partial || has("nombre")) out.nombre = str(b.nombre, 120, "el nombre", { required: true });
  if (!partial || has("tipo_prov")) out.tipo_prov = str(b.tipo_prov, 60, "el tipo de proveedor");
  if (!partial || has("costo_prov")) out.costo_prov = money(b.costo_prov, "El $ de proveedor");
  if (!partial || has("precio_ml")) out.precio_ml = money(b.precio_ml, "El precio de Mercado Libre");
  if (!partial || has("precio_tt")) out.precio_tt = money(b.precio_tt, "El precio de TikTok Shop");
  if (!partial || has("activo")) out.activo = b.activo !== false;
  return out;
}

async function productsRoute(request, env, auth, id) {
  const m = request.method;
  if (m === "GET" && !id) {
    return json(await rest(env, "products?select=*&order=sku.asc&limit=5000"));
  }
  requireRole(auth.user, ["admin"]);
  if (m === "POST" && !id) {
    const row = productFields(await readBody(request), false);
    const out = await rest(env, "products", { method: "POST", body: row, prefer: "return=representation" });
    return json(out[0], 201);
  }
  if (!id) throw new ApiError(405, "Método no permitido.");
  if (m === "PATCH") {
    const row = productFields(await readBody(request), true);
    if (!Object.keys(row).length) throw new ApiError(422, "No hay cambios.");
    const out = await rest(env, `products?id=${eq(id)}`, { method: "PATCH", body: row, prefer: "return=representation" });
    if (!out || !out.length) throw new ApiError(404, "No se encontró el producto.");
    return json(out[0]);
  }
  if (m === "DELETE") {
    await rest(env, `products?id=${eq(id)}`, { method: "DELETE" });
    return json({ ok: true });
  }
  throw new ApiError(405, "Método no permitido.");
}

// ----------------------------------------------------------------- ventas
const SALE_SELECT = "sales?select=*,sale_items(*)";

function shapeSale(s, names) {
  const items = (s.sale_items || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((i) => ({ sku: i.sku, nombre: i.nombre, qty: i.qty, tipo_prov: i.tipo_prov, costo_prov: Number(i.costo_prov), precio_ml: Number(i.precio_ml), precio_tt: Number(i.precio_tt) }));
  const { sale_items, ...rest } = s;
  return { ...rest, prov_total: Number(s.prov_total), total: Number(s.total), items, registrada_por: names.get(s.created_by) || "" };
}

async function nameMap(env) {
  const rows = await rest(env, "team_members?select=user_id,nombre");
  return new Map((rows || []).map((r) => [r.user_id, r.nombre]));
}

async function getSale(env, id) {
  const rows = await rest(env, `${SALE_SELECT}&id=${eq(id)}`);
  if (!rows || !rows.length) throw new ApiError(404, "No se encontró la venta.");
  return rows[0];
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Arma la venta completa. Los totales los calcula el servidor con el catalogo.
async function buildSale(env, merged, existingItems) {
  const fecha = str(merged.fecha, 10, "la fecha", { required: true });
  if (!validDate(fecha)) throw new ApiError(422, "La fecha no es válida.");
  if (!CANALES.includes(merged.canal)) throw new ApiError(422, "Elige un canal válido.");
  if (!ESTATUS.includes(merged.estatus)) throw new ApiError(422, "El estatus no es válido.");
  if (!Array.isArray(merged.items) || merged.items.length < 1 || merged.items.length > 30) throw new ApiError(422, "Agrega de 1 a 30 productos.");

  const existing = new Map((existingItems || []).map((i) => [i.sku, i]));
  const need = [];
  const lines = merged.items.map((it) => {
    const sku = str(it && it.sku, 60, "el SKU", { required: true });
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) throw new ApiError(422, `La cantidad de ${sku} debe ser un entero de 1 a 9999.`);
    if (!existing.has(sku)) need.push(sku);
    return { sku, qty };
  });

  let catalog = new Map();
  if (need.length) {
    const list = [...new Set(need)];
    if (list.some((s) => !/^[A-Za-z0-9._\-\/ ]+$/.test(s))) throw new ApiError(422, "Hay un SKU con caracteres no válidos.");
    const q = list.map((s) => `"${s}"`).join(",");
    const rows = await rest(env, `products?select=*&sku=in.(${encodeURIComponent(q)})`);
    catalog = new Map((rows || []).map((p) => [p.sku, p]));
  }

  const items = lines.map(({ sku, qty }) => {
    const snap = existing.get(sku) || catalog.get(sku);
    if (!snap) throw new ApiError(422, `El SKU ${sku} no existe en el catálogo.`);
    if (!existing.has(sku) && snap.activo === false) throw new ApiError(422, `El producto ${sku} está inactivo.`);
    return {
      sku, qty, nombre: snap.nombre || "", tipo_prov: snap.tipo_prov || "",
      costo_prov: Number(snap.costo_prov) || 0, precio_ml: Number(snap.precio_ml) || 0, precio_tt: Number(snap.precio_tt) || 0,
    };
  });

  const calcTotal = items.reduce((a, i) => a + i.qty * (merged.canal === "ml" ? i.precio_ml : i.precio_tt), 0);
  const prov = items.reduce((a, i) => a + i.qty * i.costo_prov, 0);
  const manual = merged.total_manual !== null && merged.total_manual !== undefined && merged.total_manual !== "";
  const total = manual ? money(merged.total_manual, "El $ total") : round2(calcTotal);

  return {
    fecha, canal: merged.canal, pedido_ext: str(merged.pedido_ext, 60, "el pedido"),
    prov_total: round2(prov), total, total_manual: manual,
    paqueteria: str(merged.paqueteria, 40, "la paquetería"), guia: str(merged.guia, 80, "la guía"),
    estatus: merged.estatus, obs: str(merged.obs, 2000, "las observaciones"), items,
  };
}

async function salesRoute(request, env, auth, id) {
  const m = request.method;
  if (m === "GET" && !id) {
    const [rows, names] = await Promise.all([
      rest(env, `${SALE_SELECT}&order=fecha.desc,created_at.desc&limit=3000`),
      nameMap(env),
    ]);
    return json((rows || []).map((s) => shapeSale(s, names)));
  }
  if (m === "DELETE" && id) {
    requireRole(auth.user, ["admin"]);
    await rest(env, `sales?id=${eq(id)}`, { method: "DELETE" });
    return json({ ok: true });
  }
  requireRole(auth.user, WRITE_ROLES);

  if (m === "POST" && !id) {
    const b = await readBody(request);
    const sale = await buildSale(env, {
      fecha: b.fecha, canal: b.canal, pedido_ext: b.pedido_ext, items: b.items, total_manual: b.total_manual,
      paqueteria: b.paqueteria, guia: b.guia, estatus: b.estatus || "pendiente", obs: b.obs,
    }, []);
    const newId = await rest(env, "rpc/save_sale", { method: "POST", body: { p_id: null, p: sale, p_user: auth.user.id } });
    return json(shapeSale(await getSale(env, newId), await nameMap(env)), 201);
  }

  if (m === "PATCH" && id) {
    const b = await readBody(request);
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const structural = ["fecha", "canal", "items", "total_manual"].some(has);

    if (!structural) {
      const row = {};
      if (has("estatus")) { if (!ESTATUS.includes(b.estatus)) throw new ApiError(422, "El estatus no es válido."); row.estatus = b.estatus; }
      if (has("guia")) row.guia = str(b.guia, 80, "la guía");
      if (has("paqueteria")) row.paqueteria = str(b.paqueteria, 40, "la paquetería");
      if (has("obs")) row.obs = str(b.obs, 2000, "las observaciones");
      if (has("pedido_ext")) row.pedido_ext = str(b.pedido_ext, 60, "el pedido");
      if (!Object.keys(row).length) throw new ApiError(422, "No hay cambios.");
      const out = await rest(env, `sales?id=${eq(id)}`, { method: "PATCH", body: row, prefer: "return=representation" });
      if (!out || !out.length) throw new ApiError(404, "No se encontró la venta.");
      return json(shapeSale(await getSale(env, id), await nameMap(env)));
    }

    const cur = await getSale(env, id);
    const merged = {
      fecha: has("fecha") ? b.fecha : cur.fecha,
      canal: has("canal") ? b.canal : cur.canal,
      pedido_ext: has("pedido_ext") ? b.pedido_ext : cur.pedido_ext,
      items: has("items") ? b.items : cur.sale_items,
      total_manual: has("total_manual") ? b.total_manual : (cur.total_manual ? cur.total : null),
      paqueteria: has("paqueteria") ? b.paqueteria : cur.paqueteria,
      guia: has("guia") ? b.guia : cur.guia,
      estatus: has("estatus") ? b.estatus : cur.estatus,
      obs: has("obs") ? b.obs : cur.obs,
    };
    const sale = await buildSale(env, merged, cur.sale_items);
    await rest(env, "rpc/save_sale", { method: "POST", body: { p_id: id, p: sale, p_user: auth.user.id } });
    return json(shapeSale(await getSale(env, id), await nameMap(env)));
  }
  throw new ApiError(405, "Método no permitido.");
}

// ----------------------------------------------------------------- equipo
async function teamRoute(request, env, auth, id) {
  requireRole(auth.user, ["admin"]);
  const m = request.method;
  if (m === "GET" && !id) {
    return json(await rest(env, "team_members?select=user_id,nombre,email,rol,activo,created_at&order=created_at.asc"));
  }
  if (m === "POST" && !id) {
    const b = await readBody(request);
    const email = str(b.email, 200, "el correo", { required: true }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(422, "El correo no es válido.");
    const nombre = str(b.nombre, 80, "el nombre", { required: true });
    if (!ROLES.includes(b.rol)) throw new ApiError(422, "Elige un perfil válido.");
    const password = str(b.password, 200, "la contraseña", { required: true });
    if (password.length < 10) throw new ApiError(422, "La contraseña debe tener al menos 10 caracteres.");
    const { url, svc } = cfg(env);
    const res = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: svc, authorization: `Bearer ${svc}`, "content-type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!res.ok) throw new ApiError(res.status === 422 ? 409 : 502, res.status === 422 ? "Ese correo ya tiene cuenta." : "No se pudo crear la cuenta.");
    const u = await res.json();
    try {
      const out = await rest(env, "team_members", { method: "POST", body: { user_id: u.id, nombre, email, rol: b.rol, activo: true }, prefer: "return=representation" });
      return json(out[0], 201);
    } catch (e) {
      await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: { apikey: svc, authorization: `Bearer ${svc}` } }).catch(() => {});
      throw e;
    }
  }
  if (m === "PATCH" && id) {
    const b = await readBody(request);
    const row = {};
    if (Object.prototype.hasOwnProperty.call(b, "rol")) { if (!ROLES.includes(b.rol)) throw new ApiError(422, "Elige un perfil válido."); row.rol = b.rol; }
    if (Object.prototype.hasOwnProperty.call(b, "activo")) row.activo = b.activo === true;
    if (Object.prototype.hasOwnProperty.call(b, "nombre")) row.nombre = str(b.nombre, 80, "el nombre", { required: true });
    if (!Object.keys(row).length) throw new ApiError(422, "No hay cambios.");
    if (id === auth.user.id && ("rol" in row || "activo" in row)) throw new ApiError(422, "No puedes cambiar tu propio perfil ni desactivarte.");
    const out = await rest(env, `team_members?user_id=${eq(id)}`, { method: "PATCH", body: row, prefer: "return=representation" });
    if (!out || !out.length) throw new ApiError(404, "No se encontró a la persona.");
    memberCache.delete(id);
    return json(out[0]);
  }
  throw new ApiError(405, "Método no permitido.");
}

// ----------------------------------------------------------------- router
export async function handle(request, env) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) throw new ApiError(403, "Origen no permitido.");
    }
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const [res, id] = parts;
    const m = request.method;

    if (res === "login" && m === "POST") return await login(request, env, secure);
    if (res === "logout" && m === "POST") return await logout(request, env, secure);

    const auth = await authenticate(request, env, secure);
    const out = await (async () => {
      if (res === "me" && m === "GET") return json({ user: auth.user });
      if (res === "password" && m === "POST") return changePassword(env, auth, request);
      if (res === "products") return productsRoute(request, env, auth, id);
      if (res === "sales") return salesRoute(request, env, auth, id);
      if (res === "team") return teamRoute(request, env, auth, id);
      throw new ApiError(404, "No encontrado.");
    })();
    if (auth.cookies) for (const c of auth.cookies) out.headers.append("set-cookie", c);
    return out;
  } catch (e) {
    if (e instanceof ApiError) {
      const clear = e.status === 401 ? clearCookies(secure) : undefined;
      return json({ error: e.message }, e.status, clear);
    }
    console.error("unhandled", e && e.message);
    return json({ error: "Error interno." }, 500);
  }
}