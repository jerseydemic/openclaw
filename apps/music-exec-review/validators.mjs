// Shared input validation. Kept separate from core.mjs so the store stays
// focused on data flow rather than field-level checks.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

export const MAX_TEXT = 5000;

export function reqString(value, name, { min = 1, max = 300 } = {}) {
  if (typeof value !== "string") throw new ValidationError(`${name} is required`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ValidationError(`${name} is too short`);
  if (trimmed.length > max) throw new ValidationError(`${name} is too long (max ${max} chars)`);
  return trimmed;
}

export function optString(value, name, opts = {}) {
  if (value === undefined || value === null || value === "") return "";
  return reqString(value, name, { min: 0, ...opts });
}

export function reqEmail(value, name) {
  const email = reqString(value, name, { min: 5, max: 200 });
  // Deliberately permissive; the only real test of an address is delivery.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new ValidationError(`${name} must be a valid email address`);
  return email;
}

/**
 * Validate a public profile URL. Only https is accepted (never javascript:,
 * data:, or http), and when `allowedHosts` is given the link must sit on one of
 * those domains — this is what stops the "links" fields being used to point at
 * arbitrary or hostile destinations.
 */
export function optUrl(value, name, { allowedHosts } = {}) {
  if (value === undefined || value === null || value === "") return "";
  const raw = reqString(value, name, { max: 300 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`${name} must be a full URL, e.g. https://www.linkedin.com/in/example`);
  }
  if (url.protocol !== "https:") throw new ValidationError(`${name} must start with https://`);
  if (allowedHosts) {
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const ok = allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    if (!ok)
      throw new ValidationError(`${name} must be a link on ${allowedHosts.join(" or ")}`);
  }
  return url.toString();
}

export function newId() {
  // Web Crypto so the same code runs on Node 22+ and Cloudflare Workers.
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
