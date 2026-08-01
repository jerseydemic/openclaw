// Zero-dependency HTTP server: static frontend + JSON API.
// Run with: node server.mjs  (PORT and ADMIN_TOKEN via env)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, ValidationError } from "./store.mjs";
import {
  SESSION_COOKIE,
  identifyModerator,
  parseModerators,
  readCookie,
  sessionCookie,
  signSession,
  verifySession,
} from "./auth.mjs";
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

const MODERATORS = parseModerators(process.env.MODERATORS);
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_TOKEN;

/** Resolve the acting moderator from a session cookie or token header. */
async function requireAdmin(req) {
  if (!MODERATORS.length && !ADMIN_TOKEN)
    throw Object.assign(
      new Error("Moderation disabled: configure MODERATORS to enable it"),
      { status: 503 },
    );
  const session = await verifySession(
    readCookie(req.headers.cookie, SESSION_COOKIE),
    SESSION_SECRET,
  );
  if (session) return session;
  const name = await identifyModerator(req.headers["x-admin-token"], {
    moderators: MODERATORS,
    sharedToken: ADMIN_TOKEN,
  });
  if (!name) throw Object.assign(new Error("Invalid moderator credentials"), { status: 401 });
  return name;
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

// Public write endpoints gated by captcha (a no-op unless TURNSTILE_SECRET is set).
const SUBMIT_PATHS = new Set([
  "/api/executives",
  "/api/reviews",
  "/api/responses",
  "/api/disputes",
  "/api/reports",
  "/api/claims",
]);

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/config") {
    return json(res, 200, { turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? null });
  }
  if (method === "GET" && pathname === "/api/executives") {
    const p = url.searchParams;
    return json(res, 200, {
      executives: store.listExecutives({
        q: p.get("q") ?? "",
        category: p.get("category") ?? "",
        location: p.get("location") ?? "",
        minRating: p.get("minRating") ?? 0,
        maxRating: p.get("maxRating") ?? 5,
        sort: p.get("sort") ?? "reviews",
      }),
    });
  }
  const execMatch = pathname.match(/^\/api\/executives\/([a-f0-9]+)$/);
  if (method === "GET" && execMatch) {
    const executive = store.getExecutive(execMatch[1]);
    return executive
      ? json(res, 200, { executive })
      : json(res, 404, { error: "Executive not found (profiles appear after moderation)" });
  }
  if (method === "POST" && SUBMIT_PATHS.has(pathname)) {
    const body = await readBody(req);
    await verifyTurnstile(body.turnstileToken, process.env.TURNSTILE_SECRET, req.socket.remoteAddress);
    if (pathname === "/api/executives")
      return json(res, 201, {
        executive: store.submitExecutive(body),
        message: "Profile submitted for moderation",
      });
    if (pathname === "/api/reviews")
      return json(res, 201, {
        review: store.submitReviewBundle(body),
        message: "Review submitted for moderation",
      });
    if (pathname === "/api/responses")
      return json(res, 201, {
        response: store.submitResponse(body),
        message: "Response submitted for moderation",
      });
    if (pathname === "/api/reports")
      return json(res, 201, {
        report: store.submitReport(body),
        message: "Report received; a moderator will review this content",
      });
    if (pathname === "/api/claims")
      return json(res, 201, {
        claim: store.submitClaim(body),
        message: "Claim received; a moderator will verify it and contact you",
      });
    return json(res, 201, {
      dispute: store.submitDispute(body),
      message: "Dispute received; a moderator will review it",
    });
  }

  if (pathname === "/api/admin/login" && method === "POST") {
    const body = await readBody(req);
    const name = await requireAdmin({ headers: { "x-admin-token": body.token ?? "" } });
    const value = await signSession(name, SESSION_SECRET);
    res.setHeader("set-cookie", sessionCookie(value).replace("; Secure", ""));
    return json(res, 200, { moderator: name });
  }
  if (pathname === "/api/admin/logout" && method === "POST") {
    res.setHeader("set-cookie", sessionCookie("", { maxAge: 0 }).replace("; Secure", ""));
    return json(res, 200, { ok: true });
  }
  if (pathname === "/api/admin/queue" && method === "GET") {
    const moderator = await requireAdmin(req);
    return json(res, 200, { ...store.moderationQueue(), moderator });
  }
  if (pathname === "/api/admin/moderate" && method === "POST") {
    const moderator = await requireAdmin(req);
    const body = await readBody(req);
    return json(res, 200, { item: store.moderate({ ...body, moderator }) });
  }
  if (pathname === "/api/admin/links" && method === "POST") {
    await requireAdmin(req);
    const body = await readBody(req);
    return json(res, 200, { executive: store.updateExecutiveLinks(body) });
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
