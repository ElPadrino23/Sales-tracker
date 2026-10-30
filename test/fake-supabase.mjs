// ---------------------------------------------------------- Supabase simulado
export function makeFake() {
  const db = { users: [], team: [], products: [], sales: [], items: [], seq: 0, id: 0 };
  const uid = () => "id" + ++db.id;
  const log = [];
  const addUser = (email, password, rol, nombre = email, activo = true) => {
    const id = uid();
    db.users.push({ id, email, password });
    if (rol) db.team.push({ user_id: id, nombre, email, rol, activo, created_at: new Date(++db.seq).toISOString() });
    return id;
  };
  const filt = (rows, params) => {
    let out = rows;
    for (const [k, v] of params) {
      if (["select", "order", "limit"].includes(k)) continue;
      if (v.startsWith("eq.")) out = out.filter((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith("in.(")) {
        const set = v.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, ""));
        out = out.filter((r) => set.includes(r[k]));
      }
    }
    return out;
  };
  const embed = (s) => ({ ...s, sale_items: db.items.filter((i) => i.sale_id === s.id) });
  const J = (data, status = 200) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  async function fake(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = (init.headers && init.headers.authorization) || "";
    const p = url.pathname;
    log.push(`${method} ${p}${url.search}`);

    if (p === "/auth/v1/token") {
      if (url.searchParams.get("grant_type") === "password") {
        const u = db.users.find((x) => x.email === body.email && x.password === body.password);
        if (!u) return J({ error: "invalid" }, 400);
        return J({ access_token: "at_" + u.id, refresh_token: "rt_" + u.id, expires_in: 3600, user: { id: u.id, email: u.email } });
      }
      const m = /^rt_(.+)$/.exec(body.refresh_token || "");
      const u = m && db.users.find((x) => x.id === m[1]);
      if (!u) return J({ error: "bad" }, 400);
      return J({ access_token: "at_" + u.id, refresh_token: "rt_" + u.id, expires_in: 3600 });
    }
    if (p === "/auth/v1/user" && method === "GET") {
      const m = /^Bearer at_(.+)$/.exec(auth);
      const u = m && db.users.find((x) => x.id === m[1]);
      return u ? J({ id: u.id, email: u.email }) : J({ msg: "bad jwt" }, 401);
    }
    if (p === "/auth/v1/user" && method === "PUT") {
      const m = /^Bearer at_(.+)$/.exec(auth);
      const u = m && db.users.find((x) => x.id === m[1]);
      if (!u) return J({}, 401);
      u.password = body.password; return J({ id: u.id });
    }
    if (p === "/auth/v1/logout") return J(null, 204);
    if (p === "/auth/v1/admin/users" && method === "POST") {
      if (db.users.some((u) => u.email === body.email)) return J({ msg: "exists" }, 422);
      return J({ id: addUser(body.email, body.password, null) });
    }
    const du = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(p);
    if (du && method === "DELETE") { db.users = db.users.filter((u) => u.id !== du[1]); return J({}); }

    const t = /^\/rest\/v1\/(\w+)$/.exec(p);
    if (p === "/rest/v1/rpc/save_sale") {
      const { p_id, p: sale, p_user } = body;
      let s;
      if (!p_id) {
        s = { id: uid(), folio: "V-" + String(++db.seq).padStart(5, "0"), created_by: p_user, created_at: new Date(++db.seq).toISOString() };
        db.sales.push(s);
      } else {
        s = db.sales.find((x) => x.id === p_id);
        if (!s) return J({ code: "P0002", message: "sale_not_found" }, 400);
        db.items = db.items.filter((i) => i.sale_id !== s.id);
      }
      const { items, ...fields } = sale;
      Object.assign(s, fields);
      for (const it of items) db.items.push({ ...it, id: uid(), sale_id: s.id, created_at: new Date(++db.seq).toISOString() });
      return J(s.id);
    }
    if (!t) return J({ message: "no route " + p }, 404);
    const table = t[1];
    const store = { team_members: db.team, products: db.products, sales: db.sales }[table];
    if (!store) return J({ message: "no table" }, 404);
    const params = [...url.searchParams.entries()];
    if (method === "GET") {
      let rows = filt(store, params);
      if (table === "sales") rows = rows.map(embed);
      return J(rows);
    }
    if (method === "POST") {
      const row = { ...body, created_at: new Date(++db.seq).toISOString() };
      if (table === "products") {
        if (db.products.some((x) => x.sku === row.sku)) return J({ code: "23505", message: "dup" }, 409);
        row.id = uid();
      }
      store.push(row);
      return J([row], 201);
    }
    if (method === "PATCH") {
      const rows = filt(store, params);
      rows.forEach((r) => Object.assign(r, body));
      return J(rows);
    }
    if (method === "DELETE") {
      const rows = filt(store, params);
      for (const r of rows) store.splice(store.indexOf(r), 1);
      if (table === "sales") db.items = db.items.filter((i) => db.sales.some((s) => s.id === i.sale_id));
      return J(null, 204);
    }
    return J({}, 400);
  }
  return { db, fake, log, addUser };
}

