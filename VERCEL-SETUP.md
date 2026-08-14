# Moving the Product FAQ from Netlify to Vercel

Netlify paused production deploys ("used all of its available credits for this
billing cycle"), so commits stopped going live. Nothing was wrong with the code.
This move puts the same app on Vercel's free tier.

**Nothing changes for the team.** Same Google Sheet, same questions, same
approvals, same fuzzy search. Only the URL changes.

---

## What changed in the repo

| Added | Why |
|---|---|
| `api/*.js` | Vercel routes any file in `api/` as a serverless function. Each of these is two lines: it points at the existing function in `netlify/functions/`. |
| `api/_adapt.js` | Translates between Netlify's `(event) -> {statusCode, body}` shape and Vercel's `(req, res)`. Files starting with `_` are not routed. |
| `vercel.json` | Function timeouts, the daily ClickUp cron, and a rewrite so old `/.netlify/functions/*` URLs still work. |

| Edited | Why |
|---|---|
| `app.js` | Calls `/api/...` instead of `/.netlify/functions/...`. |
| `remap.js`, `clickup-ingest.js`, `clickup-backfill-background.js` | Netlify set a `URL` env var; Vercel sets `VERCEL_URL`. These now accept either. |

The actual logic still lives in `netlify/functions/` — one copy, untouched. The
folder name is now a bit of a misnomer, but nothing about the working code moved,
which is why this migration is low-risk.

---

## Steps

### 1. Import the repo
1. Go to **vercel.com** → log in with GitHub → **Add New… → Project**
2. Find **bos-product-faq** → **Import**
3. Framework Preset: **Other**. Leave build/output settings empty — this is a
   static site plus functions, there is no build step.
4. **Do not deploy yet.** Add the environment variables first (next step), or the
   first deploy will fail and you will just have to redeploy.

### 2. Environment variables
Open Netlify → your site → **Site configuration → Environment variables**, and
copy each value across into Vercel's **Environment Variables** box. Set each one
for **Production, Preview, and Development**.

Required:

- `SHEET_ID`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `SHOPIFY_STORE`
- `CLICKUP_TOKEN`
- `ANTHROPIC_API_KEY`

Optional, only if you had them set:

- `LEAD_PIN`
- `ANTHROPIC_MODEL`
- `CLICKUP_BOT_IDS`

Two things to watch:

- **`GOOGLE_PRIVATE_KEY`** is the fiddly one. Paste it exactly as Netlify shows
  it, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`
  lines and the `\n` sequences. If Sheets calls fail after deploy, this is
  almost always the reason.
- Once the site is live, add one more: `URL` = your new Vercel address
  (e.g. `https://bos-product-faq.vercel.app`). Things work without it, but
  setting it explicitly is more reliable than the automatic fallback.

Keep these values in the Vercel dashboard only — not in the repo, not in chat,
not in screenshots.

### 3. Deploy
Click **Deploy**. It takes under a minute. Then open the new URL and check:

- a product search returns results (proves `catalog.json` loads)
- opening a product shows its questions (proves the Sheet connection works)
- **✨ Polish** on any question returns text (proves the Anthropic key works)

### 4. Point the team at the new URL
Share the `*.vercel.app` address. You can rename it under
**Settings → Domains**, or attach a subdomain like `faq.bellsofsteel.com`.

### 5. Turn Netlify off
Once Vercel is confirmed working, in Netlify go to **Site configuration →
Build & deploy → Stop builds**, so the two hosts can never both write to the
same sheet from a stale copy of the code. Keep the site itself around for a few
days as a fallback if you like, then delete it.

---

## The daily ClickUp ingest
`vercel.json` runs `/api/clickup-ingest` at 08:00 UTC daily, replacing Netlify's
scheduled function. Vercel's free tier allows one run per day, which is what we
were doing anyway. You can confirm it under **Settings → Cron Jobs** after the
first deploy, or trigger it by hand by visiting `/api/clickup-ingest`.

## Cost
Free tier covers this comfortably: the site is static, the functions only run
when someone clicks something, and the only paid dependency is the Anthropic key
you already own. Vercel's free tier does not have the build-credit ceiling that
stopped Netlify.
