import { handle } from "../../src/api.js";

// Todas las rutas /api/* pasan por aqui.
export const onRequest = ({ request, env }) => handle(request, env);
