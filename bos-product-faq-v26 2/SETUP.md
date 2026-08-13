# Bells of Steel — Product FAQ · Setup & deploy

A small internal web app: a static front end on Netlify, serverless Netlify Functions for the
backend, and a Google Sheet as the data store. The product catalog is a read-only snapshot
(`catalog.json`). Everything the team writes (questions, answers, approvals) lives in the Sheet.

You should be able to go from zero to live in about 20–30 minutes. The code is done — these are
the account/credential steps that have to be done under your logins.

---

## What's in this folder

```
faq-app/
  index.html            front-end shell
  app.js                front-end logic (search, workflow)
  styles.css            styling
  catalog.json          read-only product snapshot (refreshable)
  netlify.toml          Netlify build/redirect config
  package.json          backend dependency (googleapis)
  netlify/functions/
    faq.js              the API (reads/writes the Google Sheet)
  SETUP.md              this file
```

---

## Step 1 — Create the Google Sheet (the data store)

1. Create a new Google Sheet. Name it e.g. **BoS Product FAQ – Data**.
2. Rename the first tab to exactly **`FAQ`** (capital letters). You can leave it empty — the app
   writes the header row automatically on first use.
3. Add a second tab named exactly **`Audit`** (optional but recommended — it logs every add,
   answer, approval, and delete).
4. Copy the **spreadsheet ID** from the URL — it's the long string between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

## Step 2 — Create a Google service account (read/write to the Sheet)

1. Go to <https://console.cloud.google.com> → create (or pick) a project.
2. Enable the **Google Sheets API** for that project (APIs & Services → Library → "Google Sheets
   API" → Enable).
3. APIs & Services → Credentials → **Create credentials → Service account**. Give it a name like
   `bos-faq`. No roles needed.
4. Open the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file
   downloads. Keep it safe. Inside it you'll find `client_email` and `private_key`.
5. **Share the Sheet with the service account:** open the Sheet → Share → paste the
   `client_email` value (looks like `bos-faq@yourproject.iam.gserviceaccount.com`) → give it
   **Editor** access.

## Step 3 — Put the code on Netlify

Either drag-and-drop or connect a Git repo (Git is recommended so updates redeploy automatically).

**Option A — Git (recommended):** push this `faq-app` folder to a GitHub repo, then in Netlify
→ Add new site → Import from Git → pick the repo. Netlify reads `netlify.toml` automatically.

**Option B — Manual:** in Netlify → Add new site → Deploy manually → drag the `faq-app` folder in.
(You'll re-drag to update; Git avoids that.)

## Step 4 — Set environment variables in Netlify

Netlify → Site settings → Environment variables → add three:

| Key | Value |
|-----|-------|
| `SHEET_ID` | the spreadsheet ID from Step 1 |
| `GOOGLE_CLIENT_EMAIL` | `client_email` from the service-account JSON |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON — paste it exactly, including the `\n` characters |
| `LEAD_PIN` | OPTIONAL — a short PIN. If set, only people who enter it can tick "Approve". Leave it out entirely and anyone can approve (the app still records who did). |

Then trigger a redeploy so the functions pick up the variables.

## Step 5 — Sign-in (none needed)

There is no account login. The first time someone opens the site they type their name once; it's
remembered in their browser and used for attribution (initials + date) on answers. The "not you?"
link in the header lets them switch.

If you set the optional `LEAD_PIN` above, the app asks for it the first time someone ticks
"Approve" and remembers it on that device — a lightweight way to keep approving to whoever knows
the PIN, without a full login system. Change the PIN value any time the lead changes.

## Step 6 — Test it

Visit your Netlify URL, sign in, search "buzz-saw", log a question, answer it, and (as the lead)
approve it. Check the Google Sheet — you should see the row appear and update, and the Audit tab
fill in.

---

## How the pieces fit (for whoever maintains it)

- The browser never talks to Google directly. `app.js` calls `/.netlify/functions/faq`, sending
  the signed-in user's Netlify Identity token. `faq.js` verifies the user, then reads/writes the
  Sheet using the service account. Credentials live only in Netlify env vars.
- One row per question in the `FAQ` tab. Columns: `id, product_id, product_title, variant_sku,
  question, tags, status, answer, source_link, attachment_url, created_by, created_at,
  answered_by, answered_at, approved_by, last_verified_at`.
- Status flows: `unanswered → pending → approved`. Editing an approved answer ("Edit
  (re-approval)") sets it back to `pending` and clears the approval.
- `created_by` / `answered_by` / `approved_by` are set from the verified identity on the server,
  not trusted from the browser.

## Refreshing the catalog

`catalog.json` is a point-in-time export of products, variants, and SKUs. To refresh it, re-run
the export (ask Claude to pull the latest from Shopify/Plytix/Brightpearl and regenerate the
file), then redeploy. A future upgrade can have a scheduled Netlify function pull the catalog
live — that needs each system's own API credentials.

## Known limits (by design, for v1)

- **Attachments** are stored as a pasted link (e.g. a Google Drive share link) rather than an
  in-app file upload. Add Drive upload later if needed.
- **Google Sheets isn't a database** — fine for a team and a few thousand Q&As, but it has API
  rate limits and no row locking, so two people approving the exact same row at the same instant
  could clash. Rare in practice.
- **Box dimensions** are intentionally out of scope for v1.
