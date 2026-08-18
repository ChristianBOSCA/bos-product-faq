/* Netlify/Vercel function: rack compatibility data + writes.
 *
 * Reads three tabs the team edits by hand — Racks, Attachments, Measurements —
 * and writes two things back: measurement results, and what actually happened
 * when a customer acted on an answer.
 *
 * Env vars are the same ones faq.js already uses (SHEET_ID, GOOGLE_CLIENT_EMAIL,
 * GOOGLE_PRIVATE_KEY), so there is nothing new to configure.
 */
const { google } = require("googleapis");

const T_RACKS = "Racks", T_ATT = "Attachments", T_MEAS = "Measurements", T_OUT = "Outcomes";

const RACK_COLS = ["id","name","is_bos","tubing_class","hole_type","hole_spacing","posts",
  "internal_width","no_side_holes","flat_feet","hole_rejects_our_pin","verify_individually",
  "source","notes"];
const ATT_COLS = ["id","name","product_id","tubing_class","mount_points","min_posts",
  "needs_side_holes","needs_lower_crossmember","min_internal_width","max_internal_width",
  "verified_by","notes"];
const MEAS_COLS = ["id","status","subject_type","subject_id","subject_name","spec_key","why",
  "blocking","raised_by","raised_at","value","unit","measured_by","measured_at","photo_url","notes"];
/* Outcome logging. "confirmed_fits" and "returned_didnt_fit" are deliberately
 * not equal evidence: a customer saying it fits is an opinion about their own
 * install and can't rule out the loose-pin capacity problem, whereas a return
 * is a fact about the world. Only the second one is allowed to change data. */
const OUT_COLS = ["id","at","actor","attachment_id","rack_id","claim_text","verdict",
  "outcome","gorgias_url","customer_rack_actual","notes"];

function json(statusCode, obj){ return { statusCode, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(obj) }; }
function text(statusCode, msg){ return { statusCode, headers:{ "Content-Type":"text/plain" }, body: msg }; }
function nowISO(){ return new Date().toISOString(); }
function colLetter(n){ return String.fromCharCode(64 + n); }

function sheetsClient(){
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL, null,
    (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

async function ensureTab(sheets, id, tab, cols){
  const meta = await sheets.spreadsheets.get({ spreadsheetId:id, fields:"sheets.properties.title" });
  const exists = (meta.data.sheets||[]).some(s => s.properties.title === tab);
  if(!exists){
    await sheets.spreadsheets.batchUpdate({ spreadsheetId:id,
      requestBody:{ requests:[{ addSheet:{ properties:{ title:tab } } }] } });
  }
  const last = colLetter(cols.length);
  const hr = await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${tab}!A1:${last}1` });
  const cur = (hr.data.values && hr.data.values[0]) || [];
  if(cur.length < cols.length){
    await sheets.spreadsheets.values.update({ spreadsheetId:id, range:`${tab}!A1:${last}1`,
      valueInputOption:"RAW", requestBody:{ values:[cols] } });
  }
}

async function readTab(sheets, id, tab, cols){
  const last = colLetter(cols.length);
  const r = await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${tab}!A2:${last}` });
  return (r.data.values || [])
    .map((row, i) => {
      const o = { _row: i + 2 };
      cols.forEach((c, j) => o[c] = row[j] != null ? row[j] : "");
      return o;
    })
    .filter(o => (o.id || "").trim() || (o.name || "").trim());
}

async function appendRow(sheets, id, tab, cols, obj){
  const last = colLetter(cols.length);
  await sheets.spreadsheets.values.append({ spreadsheetId:id, range:`${tab}!A2:${last}`,
    valueInputOption:"RAW", insertDataOption:"INSERT_ROWS",
    requestBody:{ values:[cols.map(c => obj[c] != null ? String(obj[c]) : "")] } });
}

async function writeRow(sheets, id, tab, cols, rowNum, obj){
  const last = colLetter(cols.length);
  await sheets.spreadsheets.values.update({ spreadsheetId:id, range:`${tab}!A${rowNum}:${last}${rowNum}`,
    valueInputOption:"RAW", requestBody:{ values:[cols.map(c => obj[c] != null ? String(obj[c]) : "")] } });
}

/* Write a measured value back into the row it belongs to, so the rules engine
 * picks it up on the next load and every question waiting on it resolves. */
async function applyToSubject(sheets, id, m){
  const isRack = String(m.subject_type).toLowerCase() === "rack";
  const tab  = isRack ? T_RACKS : T_ATT;
  const cols = isRack ? RACK_COLS : ATT_COLS;
  if(cols.indexOf(m.spec_key) === -1) return { applied:false, why:`"${m.spec_key}" is not a column on ${tab}` };
  const rows = await readTab(sheets, id, tab, cols);
  const target = rows.find(r => String(r.id) === String(m.subject_id));
  if(!target) return { applied:false, why:`no ${tab} row with id "${m.subject_id}"` };
  target[m.spec_key] = m.value;
  await writeRow(sheets, id, tab, cols, target._row, target);
  return { applied:true, tab, row:target._row };
}

exports.handler = async (event) => {
  const id = process.env.SHEET_ID;
  if(!id || !process.env.GOOGLE_CLIENT_EMAIL) return text(500, "Server not configured (missing SHEET_ID / service account).");
  const sheets = sheetsClient();

  let body = {};
  if(event.httpMethod === "POST"){
    try { body = JSON.parse(event.body || "{}"); } catch(e){ return text(400, "Bad JSON."); }
  }
  const actor = (body.actor ? String(body.actor) : "unknown").slice(0, 60);

  try {
    await ensureTab(sheets, id, T_RACKS, RACK_COLS);
    await ensureTab(sheets, id, T_ATT,   ATT_COLS);
    await ensureTab(sheets, id, T_MEAS,  MEAS_COLS);
    await ensureTab(sheets, id, T_OUT,   OUT_COLS);

    if(event.httpMethod === "GET"){
      const [racks, attachments, measurements] = await Promise.all([
        readTab(sheets, id, T_RACKS, RACK_COLS),
        readTab(sheets, id, T_ATT,   ATT_COLS),
        readTab(sheets, id, T_MEAS,  MEAS_COLS)
      ]);
      return json(200, { racks, attachments, measurements, generated_at: nowISO() });
    }

    if(event.httpMethod === "POST"){
      const action = body.action;

      /* Raise a measurement request, deduped. Same gap asked twice bumps the
       * blocking count instead of creating a second showroom job. */
      if(action === "request_measurement"){
        const { subject_type, subject_id, subject_name, spec_key, why } = body;
        if(!subject_type || !subject_id || !spec_key) return text(400, "Missing subject or spec_key.");
        const rows = await readTab(sheets, id, T_MEAS, MEAS_COLS);
        const dup = rows.find(r =>
          String(r.subject_type) === String(subject_type) &&
          String(r.subject_id)   === String(subject_id) &&
          String(r.spec_key)     === String(spec_key) &&
          String(r.status) !== "done");
        if(dup){
          dup.blocking = String((parseInt(dup.blocking, 10) || 0) + 1);
          await writeRow(sheets, id, T_MEAS, MEAS_COLS, dup._row, dup);
          return json(200, { ok:true, deduped:true, id:dup.id, blocking:dup.blocking });
        }
        const rec = {
          id: "m_" + Date.now().toString(36),
          status: "open", subject_type, subject_id, subject_name: subject_name || subject_id,
          spec_key, why: why || "", blocking: 1, raised_by: actor, raised_at: nowISO()
        };
        await appendRow(sheets, id, T_MEAS, MEAS_COLS, rec);
        return json(200, { ok:true, id:rec.id });
      }

      /* Record a measurement and push it into the Racks/Attachments row. */
      if(action === "save_measurement"){
        if(!body.id || body.value == null || String(body.value).trim() === "") return text(400, "Need the request id and a value.");
        const rows = await readTab(sheets, id, T_MEAS, MEAS_COLS);
        const m = rows.find(r => String(r.id) === String(body.id));
        if(!m) return text(404, "Measurement request not found.");
        m.value = String(body.value).trim();
        if(body.unit) m.unit = String(body.unit);
        if(body.photo_url) m.photo_url = String(body.photo_url);
        if(body.notes) m.notes = String(body.notes);
        m.measured_by = actor;
        m.measured_at = nowISO();
        m.status = "done";
        await writeRow(sheets, id, T_MEAS, MEAS_COLS, m._row, m);
        const applied = await applyToSubject(sheets, id, m);
        if(!applied.applied){
          m.status = "measured-not-applied";
          m.notes = (m.notes ? m.notes + " · " : "") + "not written back: " + applied.why;
          await writeRow(sheets, id, T_MEAS, MEAS_COLS, m._row, m);
        }
        return json(200, { ok:true, applied });
      }

      /* What actually happened. A return is the only outcome allowed to change
       * a rack's recorded class, and even then it's proposed, not silent —
       * reclassify:true has to be sent deliberately. */
      if(action === "log_outcome"){
        if(!body.outcome) return text(400, "Missing outcome.");
        const rec = {
          id: "o_" + Date.now().toString(36),
          at: nowISO(), actor,
          attachment_id: body.attachment_id || "", rack_id: body.rack_id || "",
          claim_text: (body.claim_text || "").slice(0, 500),
          verdict: body.verdict || "", outcome: body.outcome,
          gorgias_url: body.gorgias_url || "",
          customer_rack_actual: body.customer_rack_actual || "",
          notes: (body.notes || "").slice(0, 500)
        };
        await appendRow(sheets, id, T_OUT, OUT_COLS, rec);

        let reclassified = null;
        if(body.outcome === "returned_didnt_fit" && body.reclassify && body.rack_id){
          const racks = await readTab(sheets, id, T_RACKS, RACK_COLS);
          const r = racks.find(x => String(x.id) === String(body.rack_id));
          if(r && String(r.is_bos).toLowerCase() !== "true" && r.tubing_class !== "metric-3x3"){
            r.notes = (r.notes ? r.notes + " · " : "") +
              `reclassified metric-3x3 after return ${rec.id}` + (rec.gorgias_url ? ` (${rec.gorgias_url})` : "");
            r.tubing_class = "metric-3x3";
            r.source = "return-evidence";
            await writeRow(sheets, id, T_RACKS, RACK_COLS, r._row, r);
            reclassified = r.id;
          }
        }
        return json(200, { ok:true, id:rec.id, reclassified });
      }

      return text(400, "Unknown action.");
    }

    return text(405, "Method not allowed.");
  } catch(e){
    return text(500, "Sheets error: " + (e.message || String(e)));
  }
};
