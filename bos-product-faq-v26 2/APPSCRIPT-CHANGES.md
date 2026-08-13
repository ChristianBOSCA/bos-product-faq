# Changes to port into the Apps Script version

Two features were added. The front-end code (`app.js`, `index.html`, `styles.css`) ports
across unchanged — it's plain browser JS, so it drops straight into the Apps Script HTML
service. Only the server side needs translating.

---

## 1. Concurrency safety (multi-user editing)

**Three new sheet columns** on the `FAQ` tab: `locked_by`, `locked_at`, `updated_at`.

**Two new actions:**

| Action | Behaviour |
|---|---|
| `lock` | If `locked_by` is set by someone else AND `locked_at` is within 10 min → return **409** with `{error, locked_by}`. Otherwise set `locked_by = actor`, `locked_at = now`. |
| `unlock` | Clear `locked_by`/`locked_at` if the caller owns the lock (or `force`). |

**Every mutation** (`answer`, `edit`, `approve`, `unapprove`, `delete`, `set_visibility`) must:

1. Reject with **409** if the row is locked by another user (lock < 10 min old).
2. Reject with **409** if the client's `base_updated_at` differs from the row's current
   `updated_at` — this is what actually prevents silent overwrites.
3. On success, set `updated_at = now` and clear the lock.

Also: `answer` rejects if `status !== "unanswered"` (someone already answered it).

**Apps Script advantage:** wrap each mutation in `LockService.getScriptLock()` —
that gives you a true serialised write, which the Netlify version couldn't do. With that,
the `updated_at` check becomes genuinely airtight rather than merely very likely to hold.

```javascript
function withLock_(fn){
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);          // serialise all writers
  try { return fn(); } finally { lock.releaseLock(); }
}
```

The front end sends `base_updated_at` on every mutation and treats HTTP 409 as
"refresh and tell the user" (`onConflict`). It also polls every 25 s so locks appear
for everyone, and fires an `unlock` beacon on page unload.

---

## 2. Visibility tagging (customer-approved vs internal-only)

**Three new sheet columns:** `visibility`, `visibility_by`, `visibility_at`.

`visibility` is one of:

| Value | Meaning |
|---|---|
| `customer` | Cleared for customer-facing use. **Downstream projects/agents may use ONLY these.** |
| `internal` | Explicitly internal-only — never send to a customer. |
| `""` (empty) | Not reviewed. Treated as internal by consumers. This is the default for new and imported rows. |

**One new action:** `set_visibility` with `{id, visibility}` — validates the value is one of
the three, sets `visibility_by = actor` and `visibility_at = now` (both cleared when unset),
and is subject to the same lock + `base_updated_at` checks as any other mutation.
The `edit` action also accepts a `visibility` field.

**For any consumer (agent, PDP tooling, help centre sync):** filter to
`status === "approved" && visibility === "customer"`. Never assume an untagged row is safe.

---

## Migration note

`ensureHeaders` rewrites the header row whenever it has fewer columns than expected, so an
existing 16-column sheet self-upgrades to 22 on first load. Existing rows get blank values,
which means: no locks held, and everything defaults to "visibility not set" (i.e. treated as
internal until someone reviews it). That's intentional — nothing becomes customer-facing by
accident.

Column order (A→V):

```
id, product_id, product_title, variant_sku, question, tags, status, answer,
source_link, attachment_url, created_by, created_at, answered_by, answered_at,
approved_by, last_verified_at, locked_by, locked_at, updated_at,
visibility, visibility_by, visibility_at
```

---

## 3. AI answer generation (optional)

`netlify/functions/generate.js` calls the Anthropic API to turn rough notes into a
customer-ready answer. In Apps Script this becomes a `UrlFetchApp.fetch` call to
`https://api.anthropic.com/v1/messages` with headers `x-api-key` and
`anthropic-version: 2023-06-01`; keep the key in Script Properties, not in the code.
The system prompt (facts-only, no invented specs, `[confirm: ...]` for gaps) is worth
copying verbatim — it's what keeps the output trustworthy.
