// Servidor local de prueba: sirve public/ y enruta /api al Worker con un Supabase simulado.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handle } from "../src/api.js";
import { makeFake } from "./fake-supabase.mjs";

const sb = makeFake();
globalThis.fetch = sb.fake;
sb.addUser("admin@x.com", "adminpass123", "admin", "Fernando");
sb.addUser("op@x.com", "operpass1234", "operador", "Operadora");
const ENV = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s" };
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const port = Number(process.argv[2] || 8799);

http.createServer(async (req, res) => {
  const origin = `http://localhost:${port}`;
  if (req.url.startsWith("/api")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handle(new Request(origin + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), ENV);
    const headers = {}; r.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
    const sc = r.headers.getSetCookie(); if (sc.length) headers["set-cookie"] = sc;
    res.writeHead(r.status, headers); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  const f = path.join("public", req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" }); res.end(fs.readFileSync(f));
}).listen(port, () => console.log("listo " + port));
