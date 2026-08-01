// Run with: node --test
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashToken,
  identifyModerator,
  parseModerators,
  readCookie,
  safeEqual,
  signSession,
  verifySession,
} from "./auth.mjs";

test("safeEqual compares without leaking length via early return", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(null, ""), true);
  assert.equal(safeEqual("abc", null), false);
});

test("moderators are identified by token hash, never by stored plaintext", async () => {
  const token = "s3cret-token-value";
  const raw = JSON.stringify([{ name: "alice", hash: await hashToken(token) }]);
  // The configuration must not contain the token itself.
  assert.ok(!raw.includes(token));

  const moderators = parseModerators(raw);
  assert.equal(await identifyModerator(token, { moderators }), "alice");
  assert.equal(await identifyModerator("wrong", { moderators }), null);
  assert.equal(await identifyModerator("", { moderators }), null);
});

test("each moderator is revocable independently", async () => {
  const a = "token-alice";
  const b = "token-bob";
  const all = [
    { name: "alice", hash: await hashToken(a) },
    { name: "bob", hash: await hashToken(b) },
  ];
  assert.equal(await identifyModerator(b, { moderators: all }), "bob");
  // Drop bob only; alice keeps working.
  const afterRevoke = all.filter((m) => m.name !== "bob");
  assert.equal(await identifyModerator(b, { moderators: afterRevoke }), null);
  assert.equal(await identifyModerator(a, { moderators: afterRevoke }), "alice");
});

test("shared ADMIN_TOKEN still works as a fallback", async () => {
  assert.equal(await identifyModerator("shared-tok", { sharedToken: "shared-tok" }), "shared");
  assert.equal(await identifyModerator("nope", { sharedToken: "shared-tok" }), null);
  assert.equal(await identifyModerator("anything", {}), null);
});

test("malformed MODERATORS fails closed rather than allowing access", () => {
  assert.throws(() => parseModerators("not json"), /valid JSON/);
  assert.throws(() => parseModerators('{"name":"x"}'), /array/);
  assert.deepEqual(parseModerators(""), []);
  // Entries missing fields are dropped rather than trusted.
  assert.deepEqual(parseModerators('[{"name":"x"},{"name":"y","hash":"AB"}]'), [
    { name: "y", hash: "ab" },
  ]);
});

test("sessions are signed, expire, and reject tampering", async () => {
  const secret = "session-secret";
  const value = await signSession("alice", secret);
  assert.equal(await verifySession(value, secret), "alice");

  // Wrong secret.
  assert.equal(await verifySession(value, "other-secret"), null);
  // Tampered moderator name.
  const [, exp, sig] = value.split(".");
  assert.equal(await verifySession(`bob.${exp}.${sig}`, secret), null);
  // Expired.
  const old = await signSession("alice", secret, Date.now() - 9 * 60 * 60 * 1000);
  assert.equal(await verifySession(old, secret), null);
  // Junk.
  assert.equal(await verifySession("garbage", secret), null);
  assert.equal(await verifySession("", secret), null);
});

test("cookie parsing picks the right value", () => {
  assert.equal(readCookie("a=1; fp_mod=xyz; b=2", "fp_mod"), "xyz");
  assert.equal(readCookie("", "fp_mod"), "");
  assert.equal(readCookie("other=1", "fp_mod"), "");
});
