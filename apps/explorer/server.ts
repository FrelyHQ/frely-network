const port = Number(Bun.env.PORT ?? 4173);
const appDir = import.meta.dir;
const server = Bun.serve({
  port,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const relative = pathname === "/" ? "index.html" : pathname === "/assets/main.js" ? "dist/main.js" : pathname === "/assets/main.css" ? "dist/main.css" : pathname.slice(1);
    if (relative.includes("..")) return new Response("Not found", { status: 404 });
    const target = Bun.file(`${appDir}/${relative}`);
    if (!(await target.exists())) return new Response("Not found", { status: 404 });
    return new Response(target);
  },
});
console.log(`Explorer running at http://localhost:${server.port}`);
