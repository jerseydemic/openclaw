// Cloudflare Worker entry: same API as server.mjs, backed by Workers KV
// (whole-db JSON under one key — fine for a small moderated site; move to D1
// or a Durable Object before heavy traffic since concurrent writes can race).
// Static frontend is served by the Workers static assets binding (see
// wrangler.jsonc), with SPA fallback handled by the platform.
//
// Abuse protection: per-IP rate limits on every API route (stricter on writes,
// separate bucket on the admin routes so the moderator token cannot be brute
// forced), plus optional Turnstile on public submissions.
import { createStoreCore, emptyDb, ValidationError } from "../../core.mjs";
import { TurnstileError, verifyTurnstile } from "../../turnstile.mjs";

const DB_KEY = "db";
const MAX_BODY_BYTES = 64 * 1024;

// Public write endpoints: these create rows, so they get the tightest limit
// and are the only ones gated by Turnstile.
const SUBMIT_PATHS = new Set([
  "/api/executives",
  "/api/reviews",
  "/api/responses",
  "/api/disputes",
  "/api/reports",
  "/api/claims",
]);

function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // API responses are per-query and change as moderators act on the queue.
      // Without this, intermediaries serve stale results when a user changes
      // filters (observed in testing against the live site).
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES)
    throw Object.assign(new Error("Request body too large"), { status: 413 });
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN)
    throw Object.assign(new Error("Admin API disabled: set the ADMIN_TOKEN secret to enable moderation"), {
      status: 503,
    });
  if (request.headers.get("x-admin-token") !== env.ADMIN_TOKEN)
    throw Object.assign(new Error("Invalid admin token"), { status: 401 });
}

const clientIp = (request) => request.headers.get("cf-connecting-ip") ?? "unknown";

/**
 * Apply the appropriate per-IP rate limit. Bindings are absent in `wrangler dev`
 * without the flag and in the Node server, so a missing binding is a no-op.
 */
async function enforceRateLimit(request, url, env) {
  const ip = clientIp(request);
  const isWrite = request.method === "POST";
  const isAdmin = url.pathname.startsWith("/api/admin/");

  let limiter;
  let scope;
  if (isAdmin) {
    limiter = env.ADMIN_LIMITER;
    scope = "admin";
  } else if (isWrite) {
    limiter = env.SUBMIT_LIMITER;
    scope = "submit";
  } else {
    limiter = env.READ_LIMITER;
    scope = "read";
  }
  if (!limiter?.limit) return;

  const { success } = await limiter.limit({ key: `${scope}:${ip}` });
  if (!success) {
    throw Object.assign(
      new Error(
        isWrite
          ? "You are submitting too quickly. Please wait a minute and try again."
          : "Too many requests. Please wait a minute and try again.",
      ),
      { status: 429, retryAfter: 60 },
    );
  }
}

async function handleApi(request, url, store, env) {
  const { pathname } = url;
  const method = request.method;

  // Lets the frontend know whether to render a Turnstile widget.
  if (method === "GET" && pathname === "/api/config") {
    return json(200, { turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null });
  }


  if (method === "GET" && pathname === "/api/executives") {
    const p = url.searchParams;
    return json(200, {
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
      ? json(200, { executive })
      : json(404, { error: "Executive not found (profiles appear after moderation)" });
  }

  if (method === "POST" && SUBMIT_PATHS.has(pathname)) {
    const body = await readBody(request);
    await verifyTurnstile(body.turnstileToken, env.TURNSTILE_SECRET, clientIp(request));
    if (pathname === "/api/executives")
      return json(201, {
        executive: store.submitExecutive(body),
        message: "Profile submitted for moderation",
      });
    if (pathname === "/api/reviews")
      return json(201, {
        review: store.submitReviewBundle(body),
        message: "Review submitted for moderation",
      });
    if (pathname === "/api/responses")
      return json(201, {
        response: store.submitResponse(body),
        message: "Response submitted for moderation",
      });
    if (pathname === "/api/reports")
      return json(201, {
        report: store.submitReport(body),
        message: "Report received; a moderator will review this content",
      });
    if (pathname === "/api/claims")
      return json(201, {
        claim: store.submitClaim(body),
        message: "Claim received; a moderator will verify it and contact you",
      });
    return json(201, {
      dispute: store.submitDispute(body),
      message: "Dispute received; a moderator will review it",
    });
  }

  if (pathname === "/api/admin/queue" && method === "GET") {
    requireAdmin(request, env);
    return json(200, store.moderationQueue());
  }
  if (pathname === "/api/admin/moderate" && method === "POST") {
    requireAdmin(request, env);
    return json(200, { item: store.moderate(await readBody(request)) });
  }
  if (pathname === "/api/admin/links" && method === "POST") {
    requireAdmin(request, env);
    return json(200, { executive: store.updateExecutiveLinks(await readBody(request)) });
  }
  return json(404, { error: "Not found" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      await enforceRateLimit(request, url, env);
      const db = (await env.DB.get(DB_KEY, "json")) ?? emptyDb();
      let dirty = false;
      const store = createStoreCore(db, () => {
        dirty = true;
      });
      const response = await handleApi(request, url, store, env);
      // Persist after the handler so validation failures never write.
      if (dirty) await env.DB.put(DB_KEY, JSON.stringify(db));
      return response;
    } catch (err) {
      const status =
        err instanceof ValidationError || err instanceof TurnstileError ? 400 : (err.status ?? 500);
      if (status >= 500) console.error(err);
      const headers = err.retryAfter ? { "retry-after": String(err.retryAfter) } : {};
      return json(status, { error: err.message ?? "Internal error" }, headers);
    }
  },
};
