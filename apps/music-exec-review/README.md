# FairPlay — Music Industry Accountability Reviews

A self-contained web app for collecting **moderated, first-hand reviews** of music industry
executives, managers, and labels: contract terms, royalty practices, transparency, and
professional conduct. Think "Glassdoor for artists signing deals."

Zero runtime dependencies — plain Node (22+), a JSON-file data store, and a vanilla-JS
single-page frontend.

## Quick start

```sh
cd apps/music-exec-review
node seed.mjs                 # optional: load fictional demo data
ADMIN_TOKEN=changeme node server.mjs
# open http://localhost:8790
```

- `PORT` — listen port (default `8790`)
- `DATA_DIR` — where `db.json` lives (default `./data`, gitignored)
- `ADMIN_TOKEN` — required to use the moderation queue at `#/admin`; if unset, the
  admin API is disabled entirely.

Tests: `node --test` (uses `node:test`; intentionally not wired into the repo's vitest suites).

## How it works

Everything a user submits — executive profiles, reviews, right-of-reply responses — is
created with `status: "pending"` and is invisible to the public until a moderator approves
it from the moderation queue. Ratings and averages are computed from approved reviews only.

### Public API

| Method | Path                  | Purpose                                      |
| ------ | --------------------- | -------------------------------------------- |
| GET    | `/api/executives?q=`  | Search published profiles (approved only)    |
| GET    | `/api/executives/:id` | Profile + approved reviews and responses     |
| POST   | `/api/executives`     | Propose a new profile (goes to moderation)   |
| POST   | `/api/reviews`        | Submit a review (goes to moderation)         |
| POST   | `/api/responses`      | Right of reply to a review (moderated)       |
| POST   | `/api/disputes`       | Ask moderators to re-review content          |

### Admin API (requires `x-admin-token` header)

| Method | Path                  | Purpose                                            |
| ------ | --------------------- | -------------------------------------------------- |
| GET    | `/api/admin/queue`    | Pending profiles/reviews/responses, open disputes  |
| POST   | `/api/admin/moderate` | `{type, id, action, note}` approve/reject/resolve  |

## Safety and legal design

This kind of platform lives or dies on being an honest review site rather than a
defamation machine. The design bakes in the standard protections:

- **Pre-publication moderation.** Nothing is public until approved; the guidelines tell
  moderators to reject second-hand accounts, unsupported accusations of crimes, doxxing,
  and content about people not acting in a business capacity.
- **First-hand attestation.** Reviews cannot be submitted without the reviewer affirming
  the account is their own truthful, first-hand experience.
- **Describe conduct, not labels.** The submission form and guidelines steer users toward
  factual descriptions ("no royalty statements for two years") instead of legal
  conclusions ("fraudster"), which is the difference between protected opinion/true
  statements and actionable defamation.
- **Right of reply.** Any reviewed person can publish a response under any review.
- **Dispute flow.** Reviewed people can file a dispute; moderators re-review and remove
  anything that cannot be substantiated.
- **No injected markup.** The frontend renders all user content via `textContent`.

Before operating this publicly you should still: consult a lawyer in your jurisdiction
(defamation exposure varies widely — U.S. operators get significant protection from
Section 230 for user content, other countries do not), add rate limiting and CAPTCHA,
add an operator privacy policy + terms of service, and use real authentication for
moderators instead of a shared token.

All seed data is fictional (`seed.mjs`); never commit real names or live data to the repo.
