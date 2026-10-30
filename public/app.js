"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(n) || 0);
const ESTATUS = { pendiente: "Pendiente", preparando: "Preparando", en_transito: "En tránsito", entregado: "Entregado", devuelto: "Devuelto", cancelado: "Cancelado" };
const CANAL = { ml: "Mercado Libre", tt: "TikTok Shop" };
const CANAL_SHORT = { ml: "ML", tt: "TikTok" };
const ROL = { admin: "Administrador", operador: "Operador", lector: "Lector" };
const PAQ = ["Mercado Envíos", "TikTok Logística", "Estafeta", "DHL", "FedEx", "Redpack", "Paquetexpress", "Otra"];

const S = { me: null, products: [], sales: [], team: [], tab: "ventas", q: "", fCanal: "", fEstatus: "", qp: "", draft: null, loaded: false, timer: null };
const canWrite = () => S.me && (S.me.rol === "admin" || S.me.rol === "operador");
const isAdmin = () => S.me && S.me.rol === "admin";

function todayStr() { return new Date().toLocaleDateString("en-CA"); }
function fmtDate(s) { if (!s) return ""; return new Date(s + "T00:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }); }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2400); }
function prodBySku(sku) { return S.products.find((p) => p.sku === sku); }

/* ---------- Cliente de la API ---------- */
async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method, credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") showLogin();
    const err = new Error((data && data.error) || "Algo salió mal. Intenta de nuevo.");
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- Acceso ---------- */
function showLogin() {
  clearInterval(S.timer);
  S.me = null;
  closeModal();
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  $("#lgPass").value = "";
}
function showApp() {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#whoName").textContent = S.me.nombre;
  $("#roleChip").textContent = ROL[S.me.rol];
  $("#btnNewSale").classList.toggle("hidden", !canWrite());
  $("#btnNewProd").classList.toggle("hidden", !isAdmin());
  $("#tabEquipo").classList.toggle("hidden", !isAdmin());
  if (!isAdmin() && S.tab === "equipo") setTab("ventas");
  renderAll();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#lgErr"), btn = $("#lgBtn");
  err.classList.add("hidden");
  btn.disabled = true;
  try {
    const r = await api("POST", "/login", { email: $("#lgEmail").value, password: $("#lgPass").value });
    S.me = r.user;
    await start();
  } catch (ex) {
    err.textContent = ex.message; err.classList.remove("hidden");
  } finally { btn.disabled = false; }
});
$("#btnOut").addEventListener("click", async () => { try { await api("POST", "/logout", {}); } catch (e) { /* ignorar */ } showLogin(); });

/* ---------- Carga de datos ---------- */
async function loadAll() {
  const jobs = [api("GET", "/products"), api("GET", "/sales")];
  if (isAdmin()) jobs.push(api("GET", "/team"));
  const [p, s, t] = await Promise.all(jobs);
  S.products = p; S.sales = s; if (t) S.team = t;
  S.loaded = true;
  renderAll();
}
async function start() {
  showApp();
  try { await loadAll(); } catch (e) { if (e.status !== 401) toast(e.message); }
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden && S.me) loadAll().catch(() => {}); }, 20000);
}

/* ---------- Pestañas ---------- */
function setTab(t) {
  S.tab = t;
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
  for (const n of ["ventas", "productos", "equipo"]) $("#view-" + n).classList.toggle("hidden", n !== t);
}
document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) setTab(b.dataset.tab); });

/* ---------- Render: ventas ---------- */
function salesFiltered() {
  const q = S.q.trim().toLowerCase();
  return S.sales.filter((s) => {
    if (S.fCanal && s.canal !== S.fCanal) return false;
    if (S.fEstatus && s.estatus !== S.fEstatus) return false;
    if (!q) return true;
    const hay = [s.folio, s.pedido_ext, s.guia, s.paqueteria, s.obs, ...(s.items || []).flatMap((i) => [i.sku, i.nombre])].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function renderTiles() {
  const ym = todayStr().slice(0, 7);
  const mes = S.sales.filter((s) => (s.fecha || "").startsWith(ym) && s.estatus !== "cancelado");
  const ingreso = mes.reduce((a, s) => a + (s.total || 0), 0);
  const costo = mes.reduce((a, s) => a + (s.prov_total || 0), 0);
  const porEnviar = S.sales.filter((s) => s.estatus === "pendiente" || s.estatus === "preparando").length;
  const mesNombre = new Date().toLocaleDateString("es-MX", { month: "long" });
  $("#tiles").innerHTML = `
    <div class="tile"><div class="k">Ventas de ${esc(mesNombre)}</div><div class="v num">${mes.length}</div><div class="s">sin contar canceladas</div></div>
    <div class="tile"><div class="k">Ingresos del mes</div><div class="v num">${money(ingreso)}</div><div class="s">suma de $ total</div></div>
    <div class="tile"><div class="k">Margen bruto del mes</div><div class="v num">${money(ingreso - costo)}</div><div class="s">$ total menos $ proveedor</div></div>
    <div class="tile ${porEnviar ? "attn" : ""}"><div class="k">Por enviar</div><div class="v num">${porEnviar}</div><div class="s">pendientes y en preparación</div></div>`;
}

function statusCell(s) {
  const label = ESTATUS[s.estatus] || s.estatus;
  if (!canWrite()) return `<span class="pill st-${esc(s.estatus)}">${esc(label)}</span>`;
  return `<select class="stsel st-${esc(s.estatus)}" data-id="${esc(s.id)}" aria-label="Estatus de ${esc(s.folio)}">${
    Object.entries(ESTATUS).map(([k, v]) => `<option value="${k}" ${k === s.estatus ? "selected" : ""}>${v}</option>`).join("")}</select>`;
}

function renderSales() {
  const rows = salesFiltered();
  const body = $("#salesBody");
  if (!S.loaded) { body.innerHTML = `<tr><td colspan="9" class="empty">Cargando ventas</td></tr>`; return; }
  if (!rows.length) {
    const hasAny = S.sales.length > 0;
    body.innerHTML = `<tr><td colspan="9"><div class="empty"><strong>${hasAny ? "Ninguna venta coincide con el filtro" : "Aún no hay ventas registradas"}</strong>${
      hasAny ? "Cambia la búsqueda o el filtro."
        : (S.products.length ? "Registra la primera venta eligiendo productos del catálogo." : "Primero agrega tus productos en la pestaña Productos. Después cada venta se llena sola.")}
      ${(!hasAny && canWrite() && S.products.length) ? `<br><button class="btn primary" data-act="newsale" type="button">+ Nueva venta</button>` : ""}
      ${(!hasAny && !S.products.length && isAdmin()) ? `<br><button class="btn primary" data-act="goprod" type="button">Ir a Productos</button>` : ""}</div></td></tr>`;
    return;
  }
  body.innerHTML = rows.map((s) => {
    const items = s.items || [];
    const skus = items.map((i) => `${esc(i.sku)}${i.qty > 1 ? ` <span class="sub">×${i.qty}</span>` : ""}`).join("<br>");
    const tipos = [...new Set(items.map((i) => i.tipo_prov).filter(Boolean))].join(", ");
    return `<tr class="click" data-id="${esc(s.id)}">
      <td class="num" style="white-space:nowrap">${esc(fmtDate(s.fecha))}</td>
      <td><span class="mono">${esc(s.folio)}</span><br><span class="chan ${esc(s.canal)}">${esc(CANAL_SHORT[s.canal] || s.canal)}</span>${s.pedido_ext ? `<div class="sub">Pedido ${esc(s.pedido_ext)}</div>` : ""}</td>
      <td>${skus}</td>
      <td>${esc(tipos) || '<span class="sub">Sin definir</span>'}</td>
      <td class="r num">${money(s.prov_total)}</td>
      <td class="r num"><strong>${money(s.total)}</strong></td>
      <td>${s.guia ? `<span class="mono">${esc(s.guia)}</span>` : '<span class="sub">Sin guía</span>'}${s.paqueteria ? `<div class="sub">${esc(s.paqueteria)}</div>` : ""}</td>
      <td>${statusCell(s)}</td>
      <td><div class="clamp">${esc(s.obs)}</div></td></tr>`;
  }).join("");
}

/* ---------- Render: productos ---------- */
function renderProducts() {
  const q = S.qp.trim().toLowerCase();
  const rows = S.products.filter((p) => !q || [p.sku, p.nombre, p.tipo_prov].join(" ").toLowerCase().includes(q));
  const body = $("#prodBody");
  if (!S.loaded) { body.innerHTML = `<tr><td colspan="7" class="empty">Cargando productos</td></tr>`; return; }
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty"><strong>${S.products.length ? "Ningún producto coincide" : "El catálogo está vacío"}</strong>${
      S.products.length ? "Prueba con otra búsqueda." : "Cada producto guarda su SKU, proveedor, costo y precio por canal. Con eso las ventas se llenan solas."}
      ${(!S.products.length && isAdmin()) ? `<br><button class="btn primary" data-act="newprod" type="button">+ Agregar el primer producto</button>` : ""}</div></td></tr>`;
    return;
  }
  body.innerHTML = rows.map((p) => `<tr class="${isAdmin() ? "click" : ""}" data-id="${esc(p.id)}">
    <td class="mono">${esc(p.sku)}</td><td>${esc(p.nombre)}</td><td>${esc(p.tipo_prov) || '<span class="sub">Sin definir</span>'}</td>
    <td class="r num">${money(p.costo_prov)}</td><td class="r num">${money(p.precio_ml)}</td><td class="r num">${money(p.precio_tt)}</td>
    <td>${p.activo === false ? '<span class="pill st-cancelado">Inactivo</span>' : '<span class="pill st-entregado">Activo</span>'}</td></tr>`).join("");
}

/* ---------- Render: equipo ---------- */
function renderTeam() {
  if (!isAdmin()) return;
  $("#teamBody").innerHTML = S.team.map((m) => {
    const self = m.user_id === S.me.id;
    return `<tr><td>${esc(m.nombre)}${self ? ' <span class="sub">(tú)</span>' : ""}</td><td>${esc(m.email)}</td>
      <td><select data-member="${esc(m.user_id)}" data-f="rol" ${self ? "disabled" : ""} aria-label="Perfil de ${esc(m.nombre)}">${
        Object.entries(ROL).map(([k, v]) => `<option value="${k}" ${k === m.rol ? "selected" : ""}>${v}</option>`).join("")}</select></td>
      <td><select data-member="${esc(m.user_id)}" data-f="activo" ${self ? "disabled" : ""} aria-label="Acceso de ${esc(m.nombre)}">
        <option value="1" ${m.activo ? "selected" : ""}>Activo</option><option value="0" ${m.activo ? "" : "selected"}>Bloqueado</option></select></td></tr>`;
  }).join("");
}

function renderAll() { if (!S.me) return; renderTiles(); renderSales(); renderProducts(); renderTeam(); }

/* ---------- Modal base ---------- */
function openModal(html) {
  $("#modalRoot").innerHTML = `<div class="overlay" id="ov"><div class="dlg" role="dialog" aria-modal="true">${html}</div></div>`;
  const f = $("#modalRoot input:not([disabled]), #modalRoot select"); if (f) f.focus();
}
function closeModal() { $("#modalRoot").innerHTML = ""; S.draft = null; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#ov")) closeModal(); });
$("#modalRoot").addEventListener("mousedown", (e) => { if (e.target.id === "ov") closeModal(); });
function showErr(id, msg) { const e = $(id); if (e) { e.textContent = msg; e.classList.remove("hidden"); } }

/* ---------- Formulario de venta ---------- */
function newDraft() { return { id: null, fecha: todayStr(), canal: "ml", pedido_ext: "", lines: [{ sku: "", qty: 1 }], totalManual: null, paqueteria: "", guia: "", estatus: "pendiente", obs: "" }; }
function draftFromSale(s) {
  return {
    id: s.id, fecha: s.fecha, canal: s.canal, pedido_ext: s.pedido_ext || "",
    lines: (s.items || []).map((i) => ({ sku: i.sku, qty: i.qty, snap: { nombre: i.nombre, tipo_prov: i.tipo_prov, costo_prov: i.costo_prov, precio_ml: i.precio_ml, precio_tt: i.precio_tt } })),
    totalManual: s.total_manual ? s.total : null, paqueteria: s.paqueteria || "", guia: s.guia || "", estatus: s.estatus, obs: s.obs || "",
  };
}
function lineProd(l) { return l.snap || prodBySku(l.sku) || null; }
function calc(d) {
  let total = 0, prov = 0; const tipos = new Set();
  for (const l of d.lines) {
    const p = lineProd(l); if (!p) continue;
    const q = Number(l.qty) || 0;
    total += q * ((d.canal === "ml" ? p.precio_ml : p.precio_tt) || 0);
    prov += q * (p.costo_prov || 0);
    if (p.tipo_prov) tipos.add(p.tipo_prov);
  }
  return { total, prov, tipos: [...tipos] };
}
function lineOptions(l) {
  const opts = S.products.filter((p) => p.activo !== false || p.sku === l.sku);
  let html = `<option value="">Elige un producto</option>` + opts.map((p) => `<option value="${esc(p.sku)}" ${p.sku === l.sku ? "selected" : ""}>${esc(p.sku)} — ${esc(p.nombre)}</option>`).join("");
  if (l.sku && !opts.some((p) => p.sku === l.sku)) html += `<option value="${esc(l.sku)}" selected>${esc(l.sku)} — ${esc(l.snap && l.snap.nombre)}</option>`;
  return html;
}
function renderLines() {
  const d = S.draft;
  $("#lines").innerHTML = d.lines.map((l, i) => `
    <div class="line">
      <select data-i="${i}" data-f="sku" id="ln-sku-${i}" aria-label="Producto ${i + 1}">${lineOptions(l)}</select>
      <input type="number" min="1" step="1" value="${esc(l.qty)}" data-i="${i}" data-f="qty" id="ln-qty-${i}" aria-label="Cantidad del producto ${i + 1}">
      <button class="x" type="button" data-rm="${i}" aria-label="Quitar producto ${i + 1}" ${d.lines.length === 1 ? "disabled" : ""}>&times;</button>
      <div class="line-detail" data-detail="${i}"></div>
    </div>`).join("");
  updatePreview();
}
function updatePreview(skipTotal) {
  const d = S.draft; if (!d) return;
  const c = calc(d);
  d.lines.forEach((l, i) => {
    const el = document.querySelector(`[data-detail="${i}"]`); if (!el) return;
    const p = lineProd(l);
    el.textContent = p ? `${p.tipo_prov || "Sin tipo de proveedor"} · proveedor ${money(p.costo_prov)} c/u · precio ${money(d.canal === "ml" ? p.precio_ml : p.precio_tt)} en ${CANAL_SHORT[d.canal]}` : "";
  });
  $("#pvTipo").textContent = c.tipos.join(", ") || "—";
  $("#pvProv").textContent = money(c.prov);
  const manual = d.totalManual !== null;
  const shown = manual ? d.totalManual : c.total;
  if (!skipTotal) $("#pvTotal").value = shown ? String(Math.round(shown * 100) / 100) : "";
  $("#pvHint").textContent = manual ? `Editado a mano. Calculado: ${money(c.total)}` : "Se calcula con el precio del canal";
  $("#pvMargen").textContent = money(shown - c.prov);
  $("#btnReset").classList.toggle("hidden", !manual);
}

function openSale(id) {
  const s = id ? S.sales.find((x) => x.id === id) : null;
  if (id && !s) return;
  if (!id && !S.products.some((p) => p.activo !== false)) { toast("Primero agrega productos al catálogo"); return; }
  S.draft = s ? draftFromSale(s) : newDraft();
  const d = S.draft, ro = !canWrite();
  openModal(`
    <form id="saleForm" novalidate>
      <div class="dlg-h"><h2>${s ? `Venta ${esc(s.folio)}` : "Nueva venta"}</h2><button class="x" type="button" data-close aria-label="Cerrar">&times;</button></div>
      <fieldset style="border:0;padding:0;margin:0" ${ro ? "disabled" : ""}>
      <div class="grid">
        <div><label class="f" for="fFecha">Fecha de ingreso</label><input type="date" id="fFecha" value="${esc(d.fecha)}"></div>
        <div><label class="f" for="fCan">Canal de venta</label><select id="fCan"><option value="ml" ${d.canal === "ml" ? "selected" : ""}>Mercado Libre</option><option value="tt" ${d.canal === "tt" ? "selected" : ""}>TikTok Shop</option></select></div>
        <div><label class="f" for="fPed">Pedido en el marketplace (opcional)</label><input type="text" id="fPed" maxlength="60" value="${esc(d.pedido_ext)}" placeholder="Ej. 2000012345678"></div>
      </div>
      <div class="sec">Productos de la venta</div>
      <div id="lines"></div>
      <button class="btn small" type="button" id="btnAddLine">+ Agregar otro producto</button>
      <div class="prev">
        <div><div class="k">Tipo de proveedor</div><div class="v" id="pvTipo">—</div></div>
        <div><div class="k">$ de proveedor</div><div class="v num" id="pvProv">$0.00</div></div>
        <div><label class="k" for="pvTotal" style="display:block">$ total de la venta</label><input type="number" min="0" step="0.01" id="pvTotal"><div class="hint" id="pvHint"></div><button type="button" class="btn small hidden" id="btnReset" style="margin-top:6px">Volver al cálculo</button></div>
        <div><div class="k">Margen bruto</div><div class="v num" id="pvMargen">$0.00</div></div>
      </div>
      <div class="grid">
        <div><label class="f" for="fPaq">Paquetería</label><select id="fPaq"><option value="">Sin asignar</option>${PAQ.map((p) => `<option ${p === d.paqueteria ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></div>
        <div><label class="f" for="fGuia"># de guía</label><input type="text" id="fGuia" maxlength="80" value="${esc(d.guia)}" placeholder="Captura el número de guía"></div>
        <div><label class="f" for="fEst">Estatus de envío</label><select id="fEst">${Object.entries(ESTATUS).map(([k, v]) => `<option value="${k}" ${k === d.estatus ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      </div>
      <label class="f" for="fObs">Observaciones</label>
      <textarea id="fObs" maxlength="2000">${esc(d.obs)}</textarea>
      </fieldset>
      <div class="err hidden" id="saleErr" role="alert"></div>
      <div class="dlg-f">
        <span class="sp">${s && s.registrada_por ? `Registrada por ${esc(s.registrada_por)}` : ""}</span>
        ${(s && isAdmin()) ? `<button class="btn danger" type="button" id="btnDel">Eliminar venta</button>` : ""}
        <button class="btn" type="button" data-close>${ro ? "Cerrar" : "Cancelar"}</button>
        ${ro ? "" : `<button class="btn primary" type="submit" id="btnSave">Guardar venta</button>`}
      </div>
    </form>`);
  renderLines();
}

async function saveSale() {
  const d = S.draft;
  const lines = d.lines.filter((l) => l.sku);
  if (!d.fecha) return showErr("#saleErr", "Falta la fecha de ingreso.");
  if (!lines.length) return showErr("#saleErr", "Elige al menos un producto del catálogo.");
  if (lines.some((l) => !(Number(l.qty) >= 1))) return showErr("#saleErr", "La cantidad de cada producto debe ser 1 o más.");
  const payload = {
    fecha: d.fecha, canal: d.canal, pedido_ext: d.pedido_ext, items: lines.map((l) => ({ sku: l.sku, qty: Math.round(Number(l.qty)) })),
    total_manual: d.totalManual, paqueteria: d.paqueteria, guia: d.guia, estatus: d.estatus, obs: d.obs,
  };
  const btn = $("#btnSave"); btn.disabled = true;
  try {
    if (d.id) await api("PATCH", "/sales/" + d.id, payload); else await api("POST", "/sales", payload);
    closeModal(); toast("Venta guardada");
    await loadAll();
  } catch (e) { btn.disabled = false; showErr("#saleErr", e.message); }
}

$("#modalRoot").addEventListener("input", (e) => {
  const d = S.draft, t = e.target; if (!d || !$("#saleForm")) return;
  if (t.id === "fFecha") d.fecha = t.value;
  else if (t.id === "fPed") d.pedido_ext = t.value;
  else if (t.id === "fGuia") d.guia = t.value;
  else if (t.id === "fObs") d.obs = t.value;
  else if (t.id === "pvTotal") { d.totalManual = t.value === "" ? null : Math.max(0, parseFloat(t.value) || 0); updatePreview(true); }
  else if (t.dataset.f === "qty") { d.lines[+t.dataset.i].qty = t.value; updatePreview(); }
});
$("#modalRoot").addEventListener("change", (e) => {
  const d = S.draft, t = e.target; if (!d || !$("#saleForm")) return;
  if (t.id === "fCan") { d.canal = t.value; updatePreview(); }
  else if (t.id === "fPaq") d.paqueteria = t.value;
  else if (t.id === "fEst") d.estatus = t.value;
  else if (t.id === "pvTotal") { if (t.value === "") updatePreview(); }
  else if (t.dataset.f === "sku") { const l = d.lines[+t.dataset.i]; l.sku = t.value; delete l.snap; updatePreview(); }
});
$("#modalRoot").addEventListener("click", async (e) => {
  const d = S.draft, t = e.target;
  if (t.closest("[data-close]")) return closeModal();
  if (t.id === "btnAddLine" && d) { d.lines.push({ sku: "", qty: 1 }); renderLines(); const el = $("#ln-sku-" + (d.lines.length - 1)); if (el) el.focus(); }
  else if (t.dataset && t.dataset.rm !== undefined && d) { d.lines.splice(+t.dataset.rm, 1); renderLines(); }
  else if (t.id === "btnReset" && d) { d.totalManual = null; updatePreview(); }
  else if (t.id === "btnDel" && d) {
    if (t.dataset.sure !== "1") { t.dataset.sure = "1"; t.textContent = "Confirmar eliminación"; return; }
    try { await api("DELETE", "/sales/" + d.id); closeModal(); toast("Venta eliminada"); await loadAll(); } catch (err) { showErr("#saleErr", err.message); }
  }
  else if (t.id === "btnDelP" && d && d.prodId) {
    if (t.dataset.sure !== "1") { t.dataset.sure = "1"; t.textContent = "Confirmar eliminación"; return; }
    try { await api("DELETE", "/products/" + d.prodId); closeModal(); toast("Producto eliminado"); await loadAll(); } catch (err) { showErr("#prodErr", err.message); }
  }
});
$("#modalRoot").addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "saleForm") saveSale();
  else if (e.target.id === "prodForm") saveProduct();
  else if (e.target.id === "memberForm") saveMember();
  else if (e.target.id === "passForm") savePassword();
});

/* ---------- Producto ---------- */
function openProduct(id) {
  if (!isAdmin()) return;
  const p = id ? S.products.find((x) => x.id === id) : null;
  if (id && !p) return;
  S.draft = { prodId: p ? p.id : null };
  const types = [...new Set(S.products.map((x) => x.tipo_prov).filter(Boolean))];
  openModal(`
    <form id="prodForm" novalidate>
      <div class="dlg-h"><h2>${p ? "Editar producto" : "Nuevo producto"}</h2><button class="x" type="button" data-close aria-label="Cerrar">&times;</button></div>
      <div class="grid">
        <div><label class="f" for="pSku">SKU</label><input type="text" id="pSku" maxlength="60" value="${esc(p && p.sku)}" placeholder="Ej. LACE-001"></div>
        <div><label class="f" for="pNom">Nombre del producto</label><input type="text" id="pNom" maxlength="120" value="${esc(p && p.nombre)}"></div>
        <div><label class="f" for="pTipo">Tipo de proveedor</label><input type="text" id="pTipo" maxlength="60" list="tiposList" value="${esc(p && p.tipo_prov)}" placeholder="Ej. Nacional, Importación"><datalist id="tiposList">${types.map((t) => `<option value="${esc(t)}">`).join("")}</datalist></div>
      </div>
      <div class="grid">
        <div><label class="f" for="pCost">$ de proveedor (por pieza)</label><input type="number" min="0" step="0.01" id="pCost" value="${p ? esc(p.costo_prov) : ""}"></div>
        <div><label class="f" for="pMl">Precio en Mercado Libre</label><input type="number" min="0" step="0.01" id="pMl" value="${p ? esc(p.precio_ml) : ""}"></div>
        <div><label class="f" for="pTt">Precio en TikTok Shop</label><input type="number" min="0" step="0.01" id="pTt" value="${p ? esc(p.precio_tt) : ""}"></div>
      </div>
      <label class="check"><input type="checkbox" id="pAct" ${(!p || p.activo !== false) ? "checked" : ""}> Producto activo (aparece al registrar ventas)</label>
      <div class="hint">Al editar costos o precios, las ventas ya registradas conservan los valores con los que se hicieron.</div>
      <div class="err hidden" id="prodErr" role="alert"></div>
      <div class="dlg-f"><span class="sp"></span>
        ${p ? `<button class="btn danger" type="button" id="btnDelP">Eliminar producto</button>` : ""}
        <button class="btn" type="button" data-close>Cancelar</button>
        <button class="btn primary" type="submit" id="btnSaveP">Guardar producto</button>
      </div>
    </form>`);
}
async function saveProduct() {
  const editing = S.draft && S.draft.prodId;
  const body = {
    sku: $("#pSku").value, nombre: $("#pNom").value, tipo_prov: $("#pTipo").value,
    costo_prov: $("#pCost").value, precio_ml: $("#pMl").value, precio_tt: $("#pTt").value, activo: $("#pAct").checked,
  };
  const btn = $("#btnSaveP"); btn.disabled = true;
  try {
    if (editing) await api("PATCH", "/products/" + editing, body); else await api("POST", "/products", body);
    closeModal(); toast("Producto guardado"); await loadAll();
  } catch (e) { btn.disabled = false; showErr("#prodErr", e.message); }
}

/* ---------- Equipo y contraseña ---------- */
function openMember() {
  openModal(`
    <form id="memberForm" novalidate>
      <div class="dlg-h"><h2>Agregar persona</h2><button class="x" type="button" data-close aria-label="Cerrar">&times;</button></div>
      <div class="grid">
        <div><label class="f" for="mNom">Nombre</label><input type="text" id="mNom" maxlength="80"></div>
        <div><label class="f" for="mMail">Correo</label><input type="email" id="mMail" autocomplete="off"></div>
        <div><label class="f" for="mRol">Perfil</label><select id="mRol"><option value="operador">Operador</option><option value="lector">Lector</option><option value="admin">Administrador</option></select></div>
        <div><label class="f" for="mPass">Contraseña temporal</label><input type="text" id="mPass" autocomplete="off" placeholder="Mínimo 10 caracteres"></div>
      </div>
      <div class="hint">Comparte la contraseña por un canal privado. Cada persona puede cambiarla con el botón Contraseña.</div>
      <div class="err hidden" id="memErr" role="alert"></div>
      <div class="dlg-f"><span class="sp"></span><button class="btn" type="button" data-close>Cancelar</button><button class="btn primary" type="submit" id="btnSaveM">Crear acceso</button></div>
    </form>`);
}
async function saveMember() {
  const btn = $("#btnSaveM"); btn.disabled = true;
  try {
    await api("POST", "/team", { nombre: $("#mNom").value, email: $("#mMail").value, rol: $("#mRol").value, password: $("#mPass").value });
    closeModal(); toast("Acceso creado"); await loadAll();
  } catch (e) { btn.disabled = false; showErr("#memErr", e.message); }
}
function openPassword() {
  openModal(`
    <form id="passForm" novalidate>
      <div class="dlg-h"><h2>Cambiar contraseña</h2><button class="x" type="button" data-close aria-label="Cerrar">&times;</button></div>
      <div class="grid">
        <div><label class="f" for="pw1">Contraseña nueva</label><input type="password" id="pw1" autocomplete="new-password"></div>
        <div><label class="f" for="pw2">Repítela</label><input type="password" id="pw2" autocomplete="new-password"></div>
      </div>
      <div class="hint">Mínimo 10 caracteres.</div>
      <div class="err hidden" id="pwErr" role="alert"></div>
      <div class="dlg-f"><span class="sp"></span><button class="btn" type="button" data-close>Cancelar</button><button class="btn primary" type="submit" id="btnSaveW">Guardar</button></div>
    </form>`);
}
async function savePassword() {
  const a = $("#pw1").value, b = $("#pw2").value;
  if (a.length < 10) return showErr("#pwErr", "La contraseña debe tener al menos 10 caracteres.");
  if (a !== b) return showErr("#pwErr", "Las contraseñas no coinciden.");
  const btn = $("#btnSaveW"); btn.disabled = true;
  try { await api("POST", "/password", { nueva: a }); closeModal(); toast("Contraseña actualizada"); }
  catch (e) { btn.disabled = false; showErr("#pwErr", e.message); }
}

/* ---------- Eventos de la página ---------- */
$("#q").addEventListener("input", (e) => { S.q = e.target.value; renderSales(); });
$("#qp").addEventListener("input", (e) => { S.qp = e.target.value; renderProducts(); });
$("#fCanal").addEventListener("change", (e) => { S.fCanal = e.target.value; renderSales(); });
$("#fEstatus").innerHTML = `<option value="">Todos los estatus</option>` + Object.entries(ESTATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
$("#fEstatus").addEventListener("change", (e) => { S.fEstatus = e.target.value; renderSales(); });
$("#btnNewSale").addEventListener("click", () => openSale());
$("#btnNewProd").addEventListener("click", () => openProduct());
$("#btnNewMember").addEventListener("click", openMember);
$("#btnPass").addEventListener("click", openPassword);

$("#salesBody").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (act) { if (act.dataset.act === "newsale") openSale(); if (act.dataset.act === "goprod") setTab("productos"); return; }
  if (e.target.closest("select")) return;
  const tr = e.target.closest("tr[data-id]"); if (tr) openSale(tr.dataset.id);
});
$("#salesBody").addEventListener("change", async (e) => {
  const sel = e.target.closest("select.stsel"); if (!sel) return;
  try { await api("PATCH", "/sales/" + sel.dataset.id, { estatus: sel.value }); toast("Estatus actualizado"); await loadAll(); }
  catch (err) { toast(err.message); renderSales(); }
});
$("#prodBody").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]"); if (act && act.dataset.act === "newprod") return openProduct();
  const tr = e.target.closest("tr[data-id]"); if (tr) openProduct(tr.dataset.id);
});
$("#teamBody").addEventListener("change", async (e) => {
  const sel = e.target.closest("select[data-member]"); if (!sel) return;
  const body = sel.dataset.f === "rol" ? { rol: sel.value } : { activo: sel.value === "1" };
  try { await api("PATCH", "/team/" + sel.dataset.member, body); toast("Cambio guardado"); await loadAll(); }
  catch (err) { toast(err.message); renderTeam(); }
});

$("#btnCopy").addEventListener("click", async () => {
  const cell = (v) => String(v ?? "").replace(/\t|\n/g, " ");
  const head = ["Fecha de ingreso", "No. de venta", "Canal", "SKU", "Tipo de prov", "$ de prov", "$ total de la venta", "# de guía", "Paquetería", "Estatus de envío", "Observaciones"];
  const lines = [head.join("\t"), ...salesFiltered().map((s) => [s.fecha, s.folio, CANAL[s.canal] || s.canal,
    (s.items || []).map((i) => i.sku + (i.qty > 1 ? " x" + i.qty : "")).join(", "),
    [...new Set((s.items || []).map((i) => i.tipo_prov).filter(Boolean))].join(", "),
    s.prov_total, s.total, s.guia, s.paqueteria, ESTATUS[s.estatus] || s.estatus, s.obs].map(cell).join("\t"))];
  try { await navigator.clipboard.writeText(lines.join("\n")); toast("Tabla copiada. Pégala en Excel o Sheets"); }
  catch (e) { toast("Tu navegador no permitió copiar"); }
});

/* ---------- Arranque ---------- */
(async function init() {
  try {
    const r = await api("GET", "/me");
    S.me = r.user;
    await start();
  } catch (e) {
    showLogin();
  }
})();
