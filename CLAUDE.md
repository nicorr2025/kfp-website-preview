# CLAUDE.md

Project context for KFP Website — read this before making changes.

## What this is

Marketing site + internal admin/CRM for KFP (a hardwood lumber / wood-products
company). Static HTML front-end pages backed by a single Express server that
exposes a JSON API. Deployed to **Vercel** as one serverless function.

## Stack

- **Front-end:** plain static HTML pages (no framework, no build step). Each
  page is a standalone `.html` file at the repo root.
- **Back-end:** `server.js` — Express app, exports the `app` instance.
- **Serverless entry:** `api/index.js` simply re-exports `server.js`. Vercel
  routes all `/api/*` requests to it (see `vercel.json` rewrites).
- **Database / auth:** Supabase (Postgres + Supabase Auth). Server uses the
  **service-role key** and does its own token verification in middleware.
- **Email:** Nodemailer over SMTP (invoices, outreach).
- **Third-party:** Apollo.io (lead search/enrich), LITS (`getItem.php`,
  inventory lookup by SKU), Anthropic API (AI outreach copy).

## Run locally

```bash
npm install
npm run dev      # node server.js, defaults to PORT or 8080
```

Needs a `.env` file at the repo root (git-ignored — never commit it). Required
vars, all read in `server.js`:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SMTP_USER
SMTP_PASS
APOLLO_API_KEY
LITS_PUBLIC_KEY
LITS_PRIVATE_KEY
ANTHROPIC_API_KEY
PORT            # optional, local only
```

Ask the repo owner for values, or copy them from the Vercel project's
Environment Variables. On Vercel these are set in the dashboard, not in code.

## Deploy

Push to `main` → Vercel auto-deploys. There is no separate build command; it's
a static site + the `api/index.js` function.

## Front-end pages

- `index.html` and product pages: `lumber.html`, `cross-ties.html`,
  `fencing.html`, `matting.html`, `utility.html`, `byproducts.html`,
  `contact.html` — public marketing.
- `login.html` — Supabase Auth sign-in.
- `admin.html` — the internal dashboard (inventory, orders, customers, quotes,
  shipping, outreach, team, settings). Most logic is inline in this file and
  talks to the `/api/*` routes.
- `logs.html` — log viewer.

## API (all in `server.js`)

Auth model:
- `requireAuth` — validates the Supabase bearer token, sets `req.user`.
- `requireAdmin` — additionally checks `kfp_team_members` for
  `role === 'admin'` and `status === 'approved'`.

Route groups:
- **Team:** `/api/team/me` (auto-provisions the first user as admin),
  `/api/team`, `/api/team/:id`.
- **Outreach/leads:** `/api/apollo/*`, `/api/outreach/ai-compose`,
  `/api/leads*`, `/api/campaigns*`, `/api/templates*`.
- **Inventory:** `/api/inventory` (LITS-backed, SKU species codes mapped via the
  `SPECIES_NAMES` table in `server.js`).
- **Misc:** `/api/stats`, `/api/send-invoice`.

> Note: some lists (leads, campaigns, templates) are kept in **in-memory**
> stores in `server.js`, so they reset on each cold start / redeploy. Persist to
> Supabase before relying on them.

## Database

Supabase. Key table: `kfp_team_members` (RLS enabled — users read their own row,
admins manage all). Schema/migration: `kfp-team-migration.sql`. SKU species
codes are decoded in `server.js` (`SPECIES_NAMES`), not in the DB.

## Conventions / gotchas

- No build tooling — edit HTML/JS directly; refresh the browser.
- Two-space indent, single quotes, no semicolons in `server.js` — match it.
- Never commit secrets. `.env`, `.env*.local`, and `.vercel` are git-ignored.
- The same `server.js` runs locally (listens on a port) and on Vercel (exported
  as a function) — keep it compatible with both; don't assume a long-lived
  process or local filesystem writes in production.

## Working together (team)

- Branch per change, open a PR into `main`. (Pushing straight to `main` is
  technically possible on this plan — don't; use PRs by convention.)
- Pull before starting; keep PRs small.
- Each person needs their own `.env` (shared out-of-band) and their own Supabase
  admin user.
