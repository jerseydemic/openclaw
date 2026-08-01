// Generate a moderator credential.
//
//   node make-moderator.mjs alice
//
// Prints a random token (give it to that person, once, over a secure channel)
// and the JSON entry to add to the MODERATORS secret. Only the hash is stored,
// so the token cannot be recovered from configuration — if someone loses it,
// issue a new one and replace their entry.
import { hashToken } from "./auth.mjs";

const name = process.argv[2];
if (!name) {
  console.error("Usage: node make-moderator.mjs <name>");
  process.exit(2);
}

const bytes = new Uint8Array(24);
globalThis.crypto.getRandomValues(bytes);
const token = btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

const entry = { name, hash: await hashToken(token) };

console.log(`\nModerator: ${name}`);
console.log(`Token (share once, then discard this output):\n  ${token}`);
console.log(`\nAdd this entry to the MODERATORS secret:\n  ${JSON.stringify(entry)}`);
console.log(`\nTo set the secret (all entries in one JSON array):`);
console.log(`  npx wrangler secret put MODERATORS`);
console.log(`  then paste e.g.  [${JSON.stringify(entry)}]\n`);
