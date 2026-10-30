import { handle } from "./api.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return handle(request, env);
    // Cualquier otra ruta que no sea un archivo de public/
    return env.ASSETS.fetch(request);
  },
};
