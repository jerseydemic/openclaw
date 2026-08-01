// Cloudflare Turnstile (CAPTCHA) verification.
// Disabled entirely when no secret is configured, so local dev and the Node
// server keep working without one.
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export class TurnstileError extends Error {
  constructor(message) {
    super(message);
    this.name = "TurnstileError";
    this.status = 400;
  }
}

/**
 * Verify a Turnstile token. No-op when `secret` is falsy.
 * @param {string|undefined} token client-supplied token
 * @param {string|undefined} secret TURNSTILE_SECRET, unset = disabled
 * @param {string|undefined} remoteIp optional client IP for extra signal
 */
export async function verifyTurnstile(token, secret, remoteIp) {
  if (!secret) return { skipped: true };
  if (!token || typeof token !== "string")
    throw new TurnstileError("Captcha missing. Please complete the verification and try again.");

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  let data;
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    data = await res.json();
  } catch {
    // Fail closed: if we cannot verify, we do not accept the submission.
    throw new TurnstileError("Could not verify the captcha right now. Please try again.");
  }

  if (!data.success) {
    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"] : [];
    // Expired/duplicate tokens are the common, user-fixable case.
    if (codes.includes("timeout-or-duplicate"))
      throw new TurnstileError("Captcha expired. Please complete the verification again.");
    throw new TurnstileError("Captcha verification failed. Please try again.");
  }
  return { skipped: false };
}
