/* Netlify Function: FAQ data API backed by Google Sheets.
 *
 * Auth: requires a valid Netlify Identity token. The signed-in user's email
 * is used for attribution (created_by / answered_by / approved_by). Approving
 * requires the "teamlead" role (granted in Netlify Identity).
 *
 * Env vars (set in Netlify → Site settings → Environment):
 *   GOOGLE_CLIENT_EMAIL   service-account email
 *   GOOGLE_PRIVATE_KEY    service-account private key (keep the \n escapes)
 *   SHEET_ID              the spreadsheet id (the long string in the Sheet URL)
 *
 * Sheet must have a tab named "FAQ". Headers are auto-created on first call.
 */
const { google } = require("googleapis");

const TAB = "FAQ";
const AUDIT = "Audit";
const COLS = ["id","product_id","product_title","variant_sku","question","tags",
  "status","answer","source_link","attachment_url","created_by","created_at",
  "answered_by","answered_at","approved_by","last_verified_at"];
const LASTCOL = "P"; // 16 columns

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
function genId(){ return "q_" + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

async function ensureHeaders(sheets, id){
  const r = await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${TAB}!A1:${LASTCOL}1` });
  if(!r.data.values || !r.data.values.length){
    await sheets.spreadsheets.values.update({ spreadsheetId:id, range:`${TAB}!A1:${LASTCOL}1`,
      valueInputOption:"RAW", requestBody:{ values:[COLS] } });
  }
}
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
let _gidCache;
async function tabGid(sheets, id){
  if(_gidCache!=null) return _gidCache;
  const meta = await sheets.spreadsheets.get({ spreadsheetId:id, fields:"sheets.properties" });
  const s = (meta.data.sheets||[]).find(s=>s.properties.title===TAB);
  _gidCache = s ? s.properties.sheetId : 0;
  return _gidCache;
}
async function deleteRow(sheets, id, rowNum){
  const gid = await tabGid(sheets, id);
  await sheets.spreadsheets.batchUpdate({ spreadsheetId:id, requestBody:{ requests:[
    { deleteDimension:{ range:{ sheetId:gid, dimension:"ROWS", startIndex:rowNum-1, endIndex:rowNum } } }
  ] } });
}
async function audit(sheets, id, actor, action, qid, detail){
  try { await sheets.spreadsheets.values.append({ spreadsheetId:id, range:`${AUDIT}!A:E`,
    valueInputOption:"RAW", insertDataOption:"INSERT_ROWS",
    requestBody:{ values:[[nowISO(), actor, action, qid, detail||""]] } }); } catch(e){ /* Audit tab optional */ }
}

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if(!user) return text(401, "Sign in required.");
  const actor = (user.user_metadata && user.user_metadata.full_name) || user.email || "unknown";
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  const lead = roles.includes("teamlead");

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
      const body = JSON.parse(event.body || "{}");
      const action = body.action;

      if(action === "add"){
        if(!body.question || !body.product_id) return text(400, "Missing question or product.");
        const obj = { id:genId(), product_id:String(body.product_id), product_title:body.product_title||"",
          variant_sku:body.variant_sku||"", question:body.question, tags:body.tags||"",
          status:"unanswered", answer:"", source_link:"", attachment_url:"",
          created_by:actor, created_at:nowISO(), answered_by:"", answered_at:"", approved_by:"", last_verified_at:"" };
        await appendRow(sheets, id, obj);
        await audit(sheets, id, actor, "add", obj.id, obj.question);
        return json(200, { ok:true });
      }

      // remaining actions target an existing row by id
      const rows = await readAll(sheets, id);
      const target = rows.find(r=>r.obj.id === body.id);
      if(!target) return text(404, "Question not found.");
      const o = target.obj;

      if(action === "answer"){
        if(!body.answer) return text(400, "Missing answer.");
        o.answer = body.answer; o.source_link = body.source_link || "";
        o.status = "pending"; o.answered_by = actor; o.answered_at = nowISO();
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, "answer", o.id, body.answer);
        return json(200, { ok:true });
      }
      if(action === "approve"){
        if(!lead) return text(403, "Only a Team Lead can approve.");
        o.status = "approved"; o.approved_by = actor; o.last_verified_at = nowISO();
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, "approve", o.id, "");
        return json(200, { ok:true });
      }
      if(action === "unapprove"){
        o.status = "pending"; o.approved_by = ""; o.last_verified_at = "";
        await writeRow(sheets, id, target._row, o);
        await audit(sheets, id, actor, "unapprove", o.id, "");
        return json(200, { ok:true });
      }
      if(action === "delete"){
        await deleteRow(sheets, id, target._row);
        await audit(sheets, id, actor, "delete", o.id, o.question);
        return json(200, { ok:true });
      }
      return text(400, "Unknown action.");
    }

    return text(405, "Method not allowed.");
  } catch(e){
    return text(500, "Sheets error: " + (e.message || String(e)));
  }
};
