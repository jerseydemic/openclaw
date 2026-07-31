# FairPlay — Music Industry Accountability Reviews

A self-contained web app for collecting **moderated, first-hand reviews** of music industry
executives, managers, and labels: contract terms, royalty practices, transparency, and
professional conduct. Think "Glassdoor for artists signing deals."

Zero runtime dependencies — plain Node (22+), a vanilla-JS single-page frontend, and a
pluggable store (JSON file locally, Workers KV in production).

**Live:** https://fairplay.jerseydemic.workers.dev

## Quick start

```sh
cd apps/music-exec-review
node seed.mjs                 # optional: load fictional demo data
ADMIN_TOKEN=changeme node server.mjs
# open http://localhost:8790
```

| Variable              | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `PORT`                | Listen port (default `8790`)                                           |
| `DATA_DIR`            | Where `db.json` lives (default `./data`, gitignored)                   |
| `ADMIN_TOKEN`         | Required for the moderation queue at `#/admin`; unset disables the admin API |
| `TURNSTILE_SITE_KEY`  | Cloudflare Turnstile public key; unset disables the captcha            |
| `TURNSTILE_SECRET`    | Turnstile secret; unset disables captcha verification                  |

Tests: `node --test` (uses `node:test`; intentionally not wired into the repo's vitest suites).

## Architecture

`core.mjs` holds all store logic as a pure function over a plain `db` object with a
`persist()` callback. Two thin adapters wrap it, so both runtimes share identical behavior:

- `store.mjs` + `server.mjs` — Node, JSON file on disk (local development)
- `deploy/cloudflare/worker.mjs` — Cloudflare Workers, Workers KV (production)

`validators.mjs` holds field-level validation, `turnstile.mjs` the captcha check.

## How it works

Everything a user submits — profiles, reviews, right-of-reply responses, reports, and
claims — is created with `status: "pending"` (or `"open"`) and is invisible to the public
until a moderator acts on it. Ratings and averages come from approved reviews only.

### Features

- **Browse and search** with filters by category, location, and sort order
- **Reviews** carry a 1–5 rating, one of 10 issue categories, deal year, and the
  **location where the dealings took place** (aggregated onto the profile)
- **Profile links** — LinkedIn, Instagram, website; https-only and host-locked
- **Right of reply** — anyone reviewed may publish a response
- **Disputes** — the subject asks for content to be re-examined
- **Reports** — anyone can flag a published review
- **Profile claims** — the subject verifies identity; approved claims mark the profile
  "Claimed" and adopt the links they supplied
- **Terms of Service and Privacy Policy** pages at `#/terms` and `#/privacy`

### Public API

| Method | Path                  | Purpose                                                     |
| ------ | --------------------- | ------------------------------------------------------------ |
| GET    | `/api/config`         | Whether a captcha site key is configured                    |
| GET    | `/api/executives`     | Search/filter published profiles (`q`, `category`, `location`, `minRating`, `maxRating`, `sort`) |
| GET    | `/api/executives/:id` | Profile + approved reviews and responses                    |
| POST   | `/api/executives`     | Propose a new profile (moderated)                           |
| POST   | `/api/reviews`        | Submit a review; may create the profile in the same request |
| POST   | `/api/responses`      | Right of reply to a review (moderated)                      |
| POST   | `/api/disputes`       | Ask moderators to re-review content                         |
| POST   | `/api/reports`        | Flag a published review                                     |
| POST   | `/api/claims`         | Claim a profile as its subject                              |

All `POST` endpoints require a Turnstile token when `TURNSTILE_SECRET` is set.
`POST /api/reviews` accepts either `executiveId` or a `newExecutive` object — creating both
in one atomic request, rolling the profile back if the review fails validation.

### Admin API (requires `x-admin-token` header)

| Method | Path                  | Purpose                                                          |
| ------ | --------------------- | ----------------------------------------------------------------- |
| GET    | `/api/admin/queue`    | Pending profiles/reviews/responses plus open disputes/reports/claims |
| POST   | `/api/admin/moderate` | `{type, id, action, note}` — approve/reject, or resolve/dismiss   |
| POST   | `/api/admin/links`    | `{executiveId, links}` — correct a profile's links                |

## Deployment

See [`deploy/cloudflare/DEPLOY.md`](deploy/cloudflare/DEPLOY.md). Short version:

```sh
bash deploy/cloudflare/deploy.sh
```

`.github/workflows/deploy-fairplay.yml` deploys automatically on pushes to `main` that
touch this directory, running the test suite first. It needs a `CLOUDFLARE_API_TOKEN`
repository secret (Workers Scripts: Edit, Workers KV Storage: Edit, Account Settings: Read).

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
- **Right of reply, disputes, and reports.** Three independent routes to challenge content.
- **Captcha on every public write**, so floods and scripted review-bombing are gated.
- **No injected markup.** The frontend renders all user content via `textContent`, and
  profile links are https-only with LinkedIn/Instagram host-locked.

### Known gaps before a public launch

- **Terms and Privacy still contain bracketed placeholders** (entity name, address,
  jurisdiction, retention periods, DMCA agent) and carry a visible "complete before
  launch" banner. Have a lawyer in your jurisdiction review both, then delete the banner.
- **Moderator auth is a single shared token.** Replace with per-moderator accounts so
  approvals are attributable and revocable.
- **KV stores the whole database as one JSON value**, so concurrent writes can race.
  Migrate to D1 before real traffic.
- **The Workers rate-limit bindings do not enforce on the current plan** — verified by
  setting the limit to 1/60s on a fixed key and observing 19/20 requests succeed. They are
  wired up as defense-in-depth; Turnstile is the control actually gating submissions.
- **Profiles are not indexable.** Hash routing plus client rendering means search engines
  cannot see individual profiles; server-rendered routes are needed for discoverability.

All seed data is fictional (`seed.mjs`); never commit real names or live data to the repo.
