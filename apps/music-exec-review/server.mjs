// Zero-dependency HTTP server: static frontend + JSON API.
// Run with: node server.mjs  (PORT and ADMIN_TOKEN via env)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, ValidationError } from "./store.mjs";
import { TurnstileError, verifyTurnstile } from "./turnstile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
const PORT = Number(process.env.PORT || 8790);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const MAX_BODY_BYTES = 64 * 1024;

const store = createStore(DATA_DIR);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function requireAdmin(req) {
  if (!ADMIN_TOKEN)
    throw Object.assign(new Error("Admin API disabled: set ADMIN_TOKEN to enable moderation"), {
      status: 503,
    });
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN)
    throw Object.assign(new Error("Invalid admin token"), { status: 401 });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    // SPA fallback: unknown non-API paths get the app shell.
    const index = path.join(PUBLIC_DIR, "index.html");
    if (!fs.existsSync(index)) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": MIME[".html"] });
    return res.end(fs.readFileSync(index));
  }
  res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(target));
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/config") {
    return json(res, 200, { turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? null });
  }
  if (method === "GET" && pathname === "/api/executives") {
    return json(res, 200, { executives: store.listExecutives({ q: url.searchParams.get("q") ?? "" }) });
  }
  const execMatch = pathname.match(/^\/api\/executives\/([a-f0-9]+)$/);
  if (method === "GET" && execMatch) {
    const executive = store.getExecutive(execMatch[1]);
    return executive
      ? json(res, 200, { executive })
      : json(res, 404, { error: "Executive not found (profiles appear after moderation)" });
  }
  if (method === "POST" && pathname === "/api/executives") {
    const body = await readBody(req);
    const executive = store.submitExecutive(body);
    return json(res, 201, { executive, message: "Profile submitted for moderation" });
  }
  if (method === "POST" && pathname === "/api/reviews") {
    const body = await readBody(req);
    await verifyTurnstile(body.turnstileToken, process.env.TURNSTILE_SECRET, req.socket.remoteAddress);
    const review = store.submitReviewBundle(body);
    return json(res, 201, { review, message: "Review submitted for moderation" });
  }
  if (method === "POST" && pathname === "/api/responses") {
    const body = await readBody(req);
    const response = store.submitResponse(body);
    return json(res, 201, { response, message: "Response submitted for moderation" });
  }
  if (method === "POST" && pathname === "/api/disputes") {
    const body = await readBody(req);
    const dispute = store.submitDispute(body);
    return json(res, 201, { dispute, message: "Dispute received; a moderator will review it" });
  }

  if (pathname === "/api/admin/queue" && method === "GET") {
    requireAdmin(req);
    return json(res, 200, store.moderationQueue());
  }
  if (pathname === "/api/admin/moderate" && method === "POST") {
    requireAdmin(req);
    const body = await readBody(req);
    return json(res, 200, { item: store.moderate(body) });
  }

  return json(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, url.pathname);
    } else {
      json(res, 405, { error: "Method not allowed" });
    }
  } catch (err) {
    const status =
      err instanceof ValidationError || err instanceof TurnstileError ? 400 : (err.status ?? 500);
    if (status >= 500) console.error(err);
    json(res, status, { error: err.message ?? "Internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`music-exec-review listening on http://localhost:${PORT}`);
  if (!ADMIN_TOKEN) console.log("ADMIN_TOKEN not set — moderation API is disabled.");
});
