import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Port must be an integer from 1 to 65535.");
}

const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed.");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Invalid URL.");
    return;
  }
  const relative = (pathname.replace(/^\/+/, "") || "index.html").replaceAll("/", sep);
  const file = resolve(root, relative);
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end("Forbidden.");
    return;
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types.get(extname(file).toLowerCase()) || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500).end("File unavailable.");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("Serving " + root + " at http://localhost:" + port + "/ (Ctrl+C to stop).");
});
