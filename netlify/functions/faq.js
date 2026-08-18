/* Netlify Function: FAQ data API backed by Google Sheets.
 *
 * Attribution: the caller sends their picked name in the request body ("actor").
 * It is recorded as created_by / answered_by / approved_by.
 *
 * Env vars (set in Netlify → Site settings → Environment):
 *   GOOGLE_CLIENT_EMAIL   service-account email
 *   GOOGLE_PRIVATE_KEY    service-account private key (keep the \n escapes)
 *   SHEET_ID              the spreadsheet id (the long string in the Sheet URL)
 *   LEAD_PIN              OPTIONAL — if set, approving requires this PIN. Leave
 *                         unset and anyone may approve (just attributed).
 *
 * Sheet must have a tab named "FAQ". Headers are auto-created on first call.
 */
const { google } = require("googleapis");

const TAB = "FAQ";
const AUDIT = "Audit";
const COLS = ["id","product_id","product_title","variant_sku","question","tags",
  "status","answer","source_link","attachment_url","created_by","created_at",
  "answered_by","answered_at","approved_by","last_verified_at",
  "locked_by","locked_at","updated_at",
  "visibility","visibility_by","visibility_at",
  "archived_by","archived_at","archive_reason"];
const LASTCOL = "Y"; // 25 columns

/* status: unanswered -> pending -> approved, plus two ways out of circulation.
 *
 *   archived   the answer is fine, the question just no longer earns a place in
 *              the working queue — time-bound, discontinued, superseded.
 *              Hidden from the queue, still searchable, still readable.
 *
 *   dismissed  the question should never have been here. A tombstone: invisible
 *              in the UI and excluded from search, but the ROW SURVIVES so the
 *              ClickUp ingest still sees its id and skips it.
 *
 * Nothing is hard-deleted, and that is deliberate. The ingest dedupes on the
 * row id (ck_<clickup message id>); deleting a row frees its id, so the next
 * ingest run re-adds the exact question someone just removed. Every "delete"
 * before this change was temporary without anyone realising. */
const OUT_OF_CIRCULATION = ["archived", "dismissed"];
/* visibility: "" = not reviewed (treat as internal), "customer" = cleared for
 * customer-facing use, "internal" = explicitly internal-only. Downstream
 * projects/agents must use ONLY rows where visibility === "customer". */
const VIS = ["", "customer", "internal"];
const LOCK_TTL_MS = 10 * 60 * 1000;   // a lock auto-expires after 10 minutes
const FB_TAB = "Feedback";
const FB_COLS = ["id","type","text","by","created_at","status"];

function json(statusCode, obj){ return { statusCode, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(obj) }; }
function text(statusCode, msg){ return { statusCode, headers:{ "Content-Type":"text/plain" }, body: msg }; }

function sheetsClient(){
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL, null,
    (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

function rowToObj(row){ const o={}; COLS.forEach((c,i)=>o[c]=row[i]!=null?row[i]:""); return o; }
function objToRow(o){ return COLS.map(c=>o[c]!=null?o[c]:""); }
function nowISO(){ return new Date().toISOString(); }
function genId(){ return "app_" + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

async function ensureTab(sheets, id, tab, cols){
  const meta = await sheets.spreadsheets.get({ spreadsheetId:id, fields:"sheets.properties.title" });
  const exists = (meta.data.sheets||[]).some(s=>s.properties.title===tab);
  if(!exists){ await sheets.spreadsheets.batchUpdate({ spreadsheetId:id, requestBody:{ requests:[{ addSheet:{ properties:{ title:tab } } }] } }); }
  const lastCol = String.fromCharCode(64 + cols.length);
  const hr = await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${tab}!A1:${lastCol}1` });
  if(!hr.data.values || !hr.data.values.length){
    await sheets.spreadsheets.values.update({ spreadsheetId:id, range:`${tab}!A1:${lastCol}1`, valueInputOption:"RAW", requestBody:{ values:[cols] } });
  }
}
async function ensureHeaders(sheets, id){
  const r = await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${TAB}!A1:${LASTCOL}1` });
  const cur = (r.data.values && r.data.values[0]) || [];
  // write (or extend) the header row — self-migrates older 16-column sheets
  if(cur.length < COLS.length){
    await sheets.spreadsheets.values.update({ spreadsheetId:id, range:`${TAB}!A1:${LASTCOL}1`,
      valueInputOption:"RAW", requestBody:{ values:[COLS] } });
  }
}
/* ---- locking ----
 * A row is "locked" when locked_by is set and locked_at is within LOCK_TTL_MS.
 * Locks are advisory: they stop two people editing the same question at once.
 * Every write also checks updated_at, so a stale save can never silently
 * overwrite someone else's change. */
function lockInfo(o){
  const by = (o.locked_by||"").trim();
  if(!by) return null;
  const t = Date.parse(o.locked_at||"");
  if(isNaN(t) || (Date.now()-t) > LOCK_TTL_MS) return null;   // expired
  return { by, at:o.locked_at };
}
function lockedByOther(o, actor){
  const li = lockInfo(o);
  return (li && li.by !== actor) ? li : null;
}
function conflict(msg, obj){ return { statusCode:409, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(Object.assign({ error:msg }, obj||{})) }; }
async function readAll(sheets, id){
  const r = await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${TAB}!A2:${LASTCOL}` });
  const rows = (r.data.values || []).map((row,i)=>({ _row:i+2, obj:rowToObj(row) }));
  return rows;
}
async function writeRow(sheets, id, rowNum, obj){
  await sheets.spreadsheets.values.update({ spreadsheetId:id, range:`${TAB}!A${rowNum}:${LASTCOL}${rowNum}`,
    valueInputOption:"RAW", requestBody:{ values:[objToRow(obj)] } });
}
async function appendRow(sheets, id, obj){
  await sheets.spreadsheets.values.append({ spreadsheetId:id, range:`${TAB}!A2:${LASTCOL}`,
    valueInputOption:"RAW", insertDataOption:"INSERT_ROWS", requestBody:{ values:[objToRow(obj)] } });
}
/* No row-deletion helper on purpose — see the status comment at the top.
 * Removing a row frees its ClickUp id and the next ingest run puts the question
 * straight back. Use archive or dismiss. */
async function audit(sheets, id, actor, action, qid, detail){
  try { await sheets.spreadsheets.values.append({ spreadsheetId:id, range:`${AUDIT}!A:E`,
    valueInputOption:"RAW", insertDataOption:"INSERT_ROWS",
    requestBody:{ values:[[nowISO(), actor, action, qid, detail||""]] } }); } catch(e){ /* Audit tab optional */ }
}

exports.handler = async (event, context) => {
  let body = {};
  if(event.httpMethod === "POST"){ try { body = JSON.parse(event.body || "{}"); } catch(e){ return text(400, "Bad JSON."); } }
  const actor = (body.actor ? String(body.actor) : "unknown").slice(0, 60);

  const id = process.env.SHEET_ID;
  if(!id || !process.env.GOOGLE_CLIENT_EMAIL) return text(500, "Server not configured (missing SHEET_ID / service account).");
  const sheets = sheetsClient();

  try {
    await ensureHeaders(sheets, id);

    if(event.httpMethod === "GET"){
      const rows = await readAll(sheets, id);
      return json(200, { rows: rows.map(r=>r.obj) });
    }

    if(event.httpMethod === "POST"){
      const action = body.action;

      if(action === "add"){
        if(!body.question || !body.product_id) return text(400, "Missing question or product.");
        const obj = { id:genId(), product_id:String(body.product_id), product_title:body.product_title||"",
          variant_sku:body.variant_sku||"", question:body.question, tags:body.tags||"",
          status:"unanswered", answer:"", source_link:"", attachment_url:"",
          created_by:actor, created_at:nowISO(), answered_by:"", answered_at:"", approved_by:"", last_verified_at:"",
          locked_by:"", locked_at:"", updated_at:nowISO(),
          visibility:"", visibility_by:"", visibility_at:"",
          archived_by:"", archived_at:"", archive_reason:"" };
        await appendRow(sheets, id, obj);
        await audit(sheets, id, actor, "add", obj.id, obj.question);
        return json(200, { ok:true });
      }

      if(action === "feedback_list"){
        await ensureTab(sheets, id, FB_TAB, FB_COLS);
        const r = await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${FB_TAB}!A2:F` });
        const fb = (r.data.values||[]).map(row=>{ const o={}; FB_COLS.forEach((c,i)=>o[c]=row[i]!=null?row[i]:""); return o; });
        return json(200, { feedback: fb });
      }
      if(action === "feedback_add"){
        if(!body.text) return text(400, "Empty feedback.");
        await ensureTab(sheets, id, FB_TAB, FB_COLS);
        await sheets.spreadsheets.values.append({ spreadsheetId:id, range:`${FB_TAB}!A2:F`,
          valueInputOption:"RAW", insertDataOption:"INSERT_ROWS",
          requestBody:{ values:[[ "fb_"+Date.now().toString(36), body.type||"idea", String(body.text).slice(0,2000), actor, nowISO(), "open" ]] } });
        return json(200, { ok:true });
      }
      if(action === "feedback_resolve"){
        await ensureTab(sheets, id, FB_TAB, FB_COLS);
        const r = await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${FB_TAB}!A2:F` });
        const vals = r.data.values||[]; const i = vals.findIndex(row=>row[0]===body.id);
        if(i<0) return text(404, "Feedback not found.");
        const rowNum = i+2; const row = vals[i]; while(row.length<6) row.push(""); row[5] = body.status||"done";
        await sheets.spreadsheets.values.update({ spreadsheetId:id, range:`${FB_TAB}!A${rowNum}:F${rowNum}`, valueInputOption:"RAW", requestBody:{ values:[row] } });
        return json(200, { ok:true });
      }

      // remaining actions target an existing row by id
      const rows = await readAll(sheets, id);
      const target = rows.find(r=>r.obj.id === body.id);
      if(!target) return text(404, "Question not found.");
      const o = target.obj;
      const held = lockedByOther(o, actor);

      // --- claim / release an editing lock ---
      if(action === "lock"){
        if(held) return conflict(`${held.by} is editing this right now.`, { locked_by:held.by });
        o.locked_by = actor; o.locked_at = nowISO();
        await writeRow(sheets, id, target._row, o);
        return json(200, { ok:true, updated_at:o.updated_at||"" });
      }
      if(action === "unlock"){
        const li = lockInfo(o);
        if(!li || li.by === actor || body.force){ o.locked_by = ""; o.locked_at = ""; await writeRow(sheets, id, target._row, o); }
        return json(200, { ok:true });
      }

      // --- every mutation below respects the lock and checks for stale writes ---
      if(["answer","edit","approve","unapprove","delete","set_visibility",
          "archive","dismiss","restore"].includes(action)){
        if(held) return conflict(`${held.by} is editing this right now — try again in a moment.`, { locked_by:held.by });
        if(body.base_updated_at != null && (o.updated_at||"") && body.base_updated_at !== o.updated_at){
          const who = o.answered_by || o.approved_by || "someone";
          return conflict(`This was just changed by ${who}. Refreshed — please redo your edit.`, { stale:true });
        }
      }
      const stamp = ()=>{ o.updated_at = nowISO(); o.locked_by = ""; o.locked_at = ""; };

      if(action === "set_visibility"){
        const v = String(body.visibility||"");
        if(!VIS.includes(v)) return text(400, "visibility must be 'customer', 'internal' or '' (unset).");
        o.visibility = v; o.visibility_by = v ? actor : ""; o.visibility_at = v ? nowISO() : "";
        stamp();
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, "visibility:"+(v||"unset"), o.id, "");
        return json(200, { ok:true });
      }
      if(action === "answer"){
        if(!body.answer) return text(400, "Missing answer.");
        if(o.status !== "unanswered" && !body.overwrite){
          return conflict(`Already answered by ${o.answered_by||"someone"} — refresh to see it.`, { stale:true });
        }
        o.answer = body.answer; o.source_link = body.source_link || "";
        o.status = "pending"; o.answered_by = actor; o.answered_at = nowISO();
        stamp();
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, "answer", o.id, body.answer);
        return json(200, { ok:true });
      }
      if(action === "edit"){
        if(body.product_id != null) o.product_id = String(body.product_id);
        if(body.product_title != null) o.product_title = String(body.product_title);
        if(body.variant_sku != null) o.variant_sku = String(body.variant_sku);
        if(body.question != null) o.question = String(body.question);
        if(body.visibility != null && VIS.includes(String(body.visibility))){
          const v = String(body.visibility);
          if(v !== o.visibility){ o.visibility = v; o.visibility_by = v?actor:""; o.visibility_at = v?nowISO():""; }
        }
        if(body.answer != null){
          const newAns = String(body.answer);
          if(newAns !== o.answer){
            o.answer = newAns; o.answered_by = actor; o.answered_at = nowISO();
            if(o.status === "approved"){ o.status = "pending"; o.approved_by = ""; o.last_verified_at = ""; }
            else if(o.status === "unanswered" && newAns){ o.status = "pending"; }
          }
        }
        stamp();
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, "edit", o.id, "");
        return json(200, { ok:true });
      }
      if(action === "approve"){
        if(process.env.LEAD_PIN && body.lead_pin !== process.env.LEAD_PIN) return text(403, "Team Lead PIN required or incorrect.");
        o.status = "approved"; o.approved_by = actor; o.last_verified_at = nowISO();
        stamp();
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, "approve", o.id, "");
        return json(200, { ok:true });
      }
      if(action === "unapprove"){
        o.status = "pending"; o.approved_by = ""; o.last_verified_at = "";
        stamp();
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, "unapprove", o.id, "");
        return json(200, { ok:true });
      }
      /* --- taking a question out of circulation ---
       * "delete" is kept as an alias for "dismiss" so older clients (and the
       * bulk bar) keep working, but it no longer removes the row. */
      if(action === "archive" || action === "dismiss" || action === "delete"){
        const mode = (action === "archive") ? "archived" : "dismissed";
        if(OUT_OF_CIRCULATION.includes(o.status) && o.status === mode){
          return json(200, { ok:true, noop:true });
        }
        o.status = mode;
        o.archived_by = actor;
        o.archived_at = nowISO();
        o.archive_reason = String(body.reason || "").slice(0, 300);
        stamp();
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, mode, o.id, o.archive_reason || o.question);
        return json(200, { ok:true });
      }

      /* Bring one back. Status is recomputed from the row rather than restored
       * from memory: a question with an answer returns to pending for
       * re-approval, never straight to approved. */
      if(action === "restore"){
        if(!OUT_OF_CIRCULATION.includes(o.status)) return json(200, { ok:true, noop:true });
        o.status = (o.answer || "").trim() ? "pending" : "unanswered";
        o.approved_by = ""; o.last_verified_at = "";
        o.archived_by = ""; o.archived_at = ""; o.archive_reason = "";
        stamp();
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, "restore", o.id, "-> " + o.status);
        return json(200, { ok:true, status:o.status });
      }
      return text(400, "Unknown action.");
    }

    return text(405, "Method not allowed.");
  } catch(e){
    return text(500, "Sheets error: " + (e.message || String(e)));
  }
};
