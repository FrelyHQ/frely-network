import { identityBindingResponse } from "./identity-api.ts";

const port = Number(Bun.env.PORT ?? 4173);
const appDir = import.meta.dir;
const assets: Record<string, string> = {
  "/": "index.html", "/assets/main.js": "dist/main.js", "/assets/main.css": "dist/main.css",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) ||
        (request.headers.has("origin") && request.headers.get("origin") !== url.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site") {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/api/identity-binding" || url.pathname === "/api/identity-binding/verify") {
      return identityBindingResponse(url.pathname);
    }
    const relative = assets[url.pathname];
    if (!relative) return new Response("Not found", { status: 404 });
    const target = Bun.file(`${appDir}/${relative}`);
    if (!(await target.exists())) return new Response("Not found", { status: 404 });
    return new Response(target);
  },
});
console.log(`Explorer running at http://localhost:${server.port}`);
