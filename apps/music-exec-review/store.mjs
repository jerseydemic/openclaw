// Node persistence wrapper around the shared store core (see core.mjs).
// JSON-file backed, no deps. The Cloudflare Worker uses the same core with KV.
import fs from "node:fs";
import path from "node:path";
import { createStoreCore, emptyDb } from "./core.mjs";

export { REVIEW_CATEGORIES, CATEGORY_LABELS, ValidationError } from "./core.mjs";

export function createStore(dataDir) {
  const file = path.join(dataDir, "db.json");
  let db;
  if (fs.existsSync(file)) {
    db = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    db = emptyDb();
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function persist() {
    // Write-then-rename so a crash mid-write never corrupts the db file.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }
  persist();

  return createStoreCore(db, persist);
}
