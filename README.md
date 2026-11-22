# Greb Meals

Family meal planner at `meals.greb.party`: our recipes, a monthly dinner plan you can regenerate and tweak, shopping lists grouped by aisle with check-off, a calendar feed, a Home Assistant endpoint, and an ingest API for store data feeds (Target, Costco, Amazon) from a local agent.

One Cloudflare Worker serves the React PWA and the Hono API, with D1 for storage and Cloudflare Access for sign-in. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, data model, API and HA setup.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # sets DEV_AUTH_EMAIL so local requests are signed in
npm run dev                      # Vite on :5173, API (wrangler dev) on :8787, local D1
```

Checks:

```sh
npm test            # unit tests (parser, units, plan generator, list aggregation, ICS)
npm run dev:api     # in another shell, then:
npm run smoke       # end-to-end API checks against wrangler dev
npm run build && npm run check:ui   # renders every screen in jsdom against the running API
```

Schema changes: edit `worker/db/schema.ts`, run `npm run db:generate`, commit the new file in `drizzle/`.

## Deploy (one-time setup)

1. Create the D1 database: `npx wrangler d1 create greb-meals`, and put its id in `wrangler.jsonc` (`d1_databases[0].database_id`).
2. Workers Builds: connect this repo to a Worker named `greb-meals`, production branch `main`, build command `npm ci`, deploy command `npm run deploy` (build, apply D1 migrations, deploy).
3. Custom domain `meals.greb.party` on the Worker.
4. Cloudflare Access:
   - Self-hosted app on `meals.greb.party`: Google login, Allow policy with the family's emails, plus a Service Auth policy for the HA and feeder service tokens.
   - Bypass app on `meals.greb.party/api/calendar.ics` (the feed checks its own token).
   - Put the team domain (`<team>.cloudflareaccess.com`) and the app's AUD tag in `wrangler.jsonc` vars `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
5. In the app, Settings → Home Assistant: register each service token's Client ID with its scopes, and make a calendar link.

Until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, the deployed API refuses every request (it fails closed).
