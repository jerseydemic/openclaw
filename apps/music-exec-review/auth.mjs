// Moderator authentication.
//
// Moderators are configured as a JSON list in the MODERATORS secret, holding
// only SHA-256 hashes of their tokens — never the tokens themselves. That way
// a leaked configuration does not hand anyone moderation access, and each
// moderator can be revoked individually without disturbing the others.
//
//   MODERATORS='[{"name":"alice","hash":"<sha256-hex>"}]'
//
// Generate entries with:  node make-moderator.mjs alice
//
// The older single ADMIN_TOKEN still works as a fallback so existing
// deployments keep running; it is reported as the moderator name "shared".

/** Length-independent, constant-time compare (no early return). */
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** SHA-256 hex digest. Web Crypto, so it runs on Node 22+ and Workers alike. */
export async function hashToken(token) {
  const bytes = new TextEncoder().encode(String(token ?? ""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseModerators(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Misconfiguration must not silently disable auth.
    throw new Error("MODERATORS is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("MODERATORS must be a JSON array");
  return parsed
    .filter((m) => m && typeof m.name === "string" && typeof m.hash === "string")
    .map((m) => ({ name: m.name, hash: m.hash.toLowerCase() }));
}

/**
 * Identify the moderator presenting `token`.
 * @returns {Promise<string|null>} moderator name, or null if unrecognized
 */
export async function identifyModerator(token, { moderators = [], sharedToken = "" } = {}) {
  if (!token) return null;

  if (moderators.length) {
    const provided = await hashToken(token);
    // Compare against every entry so timing does not reveal which name matched.
    let matched = null;
    for (const moderator of moderators) {
      if (safeEqual(provided, moderator.hash)) matched = moderator.name;
    }
    if (matched) return matched;
  }

  if (sharedToken && safeEqual(token, sharedToken)) return "shared";
  return null;
}

// --- signed sessions ---------------------------------------------------------
// After a successful sign-in the browser holds a short-lived HMAC-signed
// session in an HttpOnly cookie instead of keeping the raw token in
// sessionStorage and replaying it on every request. The cookie is useless
// outside its lifetime and cannot be read by page scripts.

export const SESSION_COOKIE = "fp_mod";
const SESSION_TTL_SECONDS = 8 * 60 * 60; // one working day

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function hmac(message, secret) {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/** Create a signed session value for `name`, valid for SESSION_TTL_SECONDS. */
export async function signSession(name, secret, nowMs = Date.now()) {
  const expires = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const payload = `${encodeURIComponent(name)}.${expires}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

/** @returns {Promise<string|null>} moderator name, or null if invalid/expired */
export async function verifySession(value, secret, nowMs = Date.now()) {
  if (!value || !secret) return null;
  const parts = String(value).split(".");
  if (parts.length !== 3) return null;
  const [rawName, expires, signature] = parts;
  const payload = `${rawName}.${expires}`;
  if (!safeEqual(await hmac(payload, secret), signature)) return null;
  if (!/^\d+$/.test(expires) || Number(expires) * 1000 < nowMs) return null;
  return decodeURIComponent(rawName);
}

export function sessionCookie(value, { maxAge = SESSION_TTL_SECONDS } = {}) {
  // HttpOnly keeps it away from page scripts; SameSite=Strict blocks CSRF from
  // other origins; Secure because the site is always served over HTTPS.
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export function readCookie(header, name) {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}
