// Cloudflare Worker entry: same API as server.mjs, backed by Workers KV
// (whole-db JSON under one key — fine for a small moderated site; move to D1
// or a Durable Object before heavy traffic since concurrent writes can race).
// Static frontend is served by the Workers static assets binding (see
// wrangler.jsonc), with SPA fallback handled by the platform.
import { createStoreCore, emptyDb, ValidationError } from "../../core.mjs";

const DB_KEY = "db";
const MAX_BODY_BYTES = 64 * 1024;

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
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

async function handleApi(request, url, store, env) {
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/api/executives") {
    return json(200, { executives: store.listExecutives({ q: url.searchParams.get("q") ?? "" }) });
  }
  const execMatch = pathname.match(/^\/api\/executives\/([a-f0-9]+)$/);
  if (method === "GET" && execMatch) {
    const executive = store.getExecutive(execMatch[1]);
    return executive
      ? json(200, { executive })
      : json(404, { error: "Executive not found (profiles appear after moderation)" });
  }
  if (method === "POST" && pathname === "/api/executives") {
    const executive = store.submitExecutive(await readBody(request));
    return json(201, { executive, message: "Profile submitted for moderation" });
  }
  if (method === "POST" && pathname === "/api/reviews") {
    const review = store.submitReview(await readBody(request));
    return json(201, { review, message: "Review submitted for moderation" });
  }
  if (method === "POST" && pathname === "/api/responses") {
    const response = store.submitResponse(await readBody(request));
    return json(201, { response, message: "Response submitted for moderation" });
  }
  if (method === "POST" && pathname === "/api/disputes") {
    const dispute = store.submitDispute(await readBody(request));
    return json(201, { dispute, message: "Dispute received; a moderator will review it" });
  }
  if (pathname === "/api/admin/queue" && method === "GET") {
    requireAdmin(request, env);
    return json(200, store.moderationQueue());
  }
  if (pathname === "/api/admin/moderate" && method === "POST") {
    requireAdmin(request, env);
    return json(200, { item: store.moderate(await readBody(request)) });
  }
  return json(404, { error: "Not found" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
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
      const status = err instanceof ValidationError ? 400 : (err.status ?? 500);
      if (status >= 500) console.error(err);
      return json(status, { error: err.message ?? "Internal error" });
    }
  },
};
