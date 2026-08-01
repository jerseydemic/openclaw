# Deploying FairPlay to Cloudflare

Cloudflare has folded Pages into Workers — new sites deploy as a **Worker with
static assets**, which is what this config does: the same `public/` frontend is
served as static assets, and `worker.mjs` runs the same API as `server.mjs`
using the shared store core (`core.mjs`) with Workers KV persistence.

## One-time setup

1. Create an API token at https://dash.cloudflare.com/profile/api-tokens
   (the **Edit Cloudflare Workers** template is sufficient).
2. The KV namespace `fairplay-db` (`89f7effc4455498e9d197d6ab177314d`) already
   exists in the account and is referenced by `wrangler.jsonc`. If deploying to
   a different account, create one (`npx wrangler kv namespace create fairplay-db`)
   and update the `id`.

## Deploy

```sh
cd apps/music-exec-review/deploy/cloudflare
export CLOUDFLARE_API_TOKEN=...   # from step 1
npx wrangler@latest deploy
npx wrangler@latest secret put ADMIN_TOKEN   # enables the moderation queue
```

`wrangler deploy` prints the live URL, e.g. `https://fairplay.<your-subdomain>.workers.dev`.

## Seed demo data (optional)

The seed script only writes to the local JSON store, so seed the deployed site
through the API + moderation queue, or temporarily run it locally and copy
`data/db.json` into KV:

```sh
node ../../seed.mjs
npx wrangler@latest kv key put db --binding DB --path ../../data/db.json --remote
```

## Caveats

- KV stores the whole database as one JSON value: reads are eventually
  consistent and concurrent writes can race. Fine for a small moderated site;
  switch to D1 or a Durable Object before real traffic.
- Same go-live checklist as the main README: rate limiting, real moderator
  auth, ToS/privacy policy, and jurisdiction-specific legal review.
