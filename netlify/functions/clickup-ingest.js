/* Scheduled Netlify Function: pull Q&A from the ClickUp #product_knowledge
 * channel into the FAQ sheet as pending/unanswered entries (for lead review).
 *
 * Runs on a schedule (see netlify.toml). Free — no AI at runtime.
 *
 * - New question -> appended (answered=pending, no answer yet=unanswered)
 * - A previously-unanswered question gets updated when a teammate (not a bot)
 *   answers later in the thread.
 * - Dedupes by ClickUp message id (row id = "ck_<messageId>").
 *
 * Env vars (in addition to the ones faq.js already uses):
 *   CLICKUP_TOKEN   ClickUp personal API token (starts with pk_)
 *   CLICKUP_BOT_IDS optional, comma-separated user ids to treat as bots/ignore
 */
const { google } = require("googleapis");

const WORKSPACE = "8634432";
const CHANNEL = "87g20-350617";
const CK = "https://api.clickup.com/api";
const TAB = "FAQ";
const COLS = ["id","product_id","product_title","variant_sku","question","tags",
  "status","answer","source_link","attachment_url","created_by","created_at",
  "answered_by","answered_at","approved_by","last_verified_at"];
const LASTCOL = "P";

function nowISO(d){ return (d?new Date(d):new Date()).toISOString(); }
function strip(s){ return (s||"").replace(/!\[[^\]]*\]\([^)]*\)/g,"").replace(/\s+/g," ").trim(); } // drop image md
function looksLikeQuestion(s){
  const t = strip(s);
  if(t.length < 12) return false;
  if(/^(thanks|thank you|ty|np|yep|yes|no|ok|okay|got it|perfect|great)\b/i.test(t)) return false;
  return /\?/.test(t) || /^(what|how|does|do|is|are|can|could|will|would|which|when|why|where|any|has|info|need)\b/i.test(t);
}

async function ck(path, token){
  const r = await fetch(`${CK}${path}`, { headers: { Authorization: token } });
  if(!r.ok) throw new Error(`ClickUp ${r.status} on ${path}: ${(await r.text()).slice(0,150)}`);
  return r.json();
}

function sheetsClient(){
  const auth = new google.auth.JWT(process.env.GOOGLE_CLIENT_EMAIL, null,
    (process.env.GOOGLE_PRIVATE_KEY||"").replace(/\\n/g,"\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]);
  return google.sheets({ version:"v4", auth });
}

// crude SKU + product matcher against the bundled catalog
function buildMatcher(catalog){
  const skuMap = {};            // SKU(upper) -> {product, sku}
  catalog.forEach(p => (p.variants||[]).forEach(v => { if(v.sku) skuMap[v.sku.toUpperCase()] = { p, sku:v.sku }; }));
  const STOP = new Set("the a of to and is are for do does with on in it this that what how can could will".split(" "));
  const toks = s => (s||"").toLowerCase().match(/[a-z0-9]+/g)?.filter(w=>w.length>2 && !STOP.has(w)) || [];
  return function match(text){
    const skus = (text.match(/\b[A-Z0-9]{2,}(?:-[A-Z0-9.]+)+\b/g) || []);
    for(const s of skus){ const hit = skuMap[s.toUpperCase()]; if(hit) return { product_id:hit.p.id, product_title:hit.p.title, variant_sku:hit.sku }; }
    const qt = new Set(toks(text));
    let best=null, bs=0;
    for(const p of catalog){
      if(p.id==="_general") continue;
      const tt = new Set(toks(p.title));
      let s=0; tt.forEach(w=>{ if(qt.has(w)) s++; });
      if(s>bs){ bs=s; best=p; }
    }
    if(best && bs>=2) return { product_id:best.id, product_title:best.title, variant_sku:"" };
    return { product_id:"_general", product_title:"General & Policies", variant_sku:"" };
  };
}

exports.handler = async () => {
  const token = process.env.CLICKUP_TOKEN;
  const sheetId = process.env.SHEET_ID;
  if(!token || !sheetId || !process.env.GOOGLE_CLIENT_EMAIL) return { statusCode:500, body:"Not configured (CLICKUP_TOKEN / sheet creds)." };
  const botIds = new Set((process.env.CLICKUP_BOT_IDS||"").split(",").map(s=>s.trim()).filter(Boolean));

  try {
    // catalog (for product matching)
    let catalog = [];
    try { const c = await fetch(`${process.env.URL||""}/catalog.json`); catalog = (await c.json()).products || []; } catch(e){}
    const match = buildMatcher(catalog);

    // team members -> names + bot detection
    const names = {};
    try {
      const team = await ck(`/v2/team`, token);
      const t = (team.teams||[]).find(x=>String(x.id)===WORKSPACE) || (team.teams||[])[0];
      (t?.members||[]).forEach(m=>{
        const u=m.user||{}; names[u.id]=u.username||u.email||("user "+u.id);
        if(/bot|\bai\b|clickbot/i.test((u.username||"")+" "+(u.email||"")) ) botIds.add(String(u.id));
      });
    } catch(e){}
    const nameOf = id => names[id] || ("user "+id);

    // existing rows -> dedup + update map (id -> {row, status, answer})
    const sheets = sheetsClient();
    const got = await sheets.spreadsheets.values.get({ spreadsheetId:sheetId, range:`${TAB}!A2:${LASTCOL}` });
    const rows = (got.data.values||[]).map((r,i)=>({ _row:i+2, id:r[0]||"", status:r[6]||"", answer:r[7]||"" }));
    const byId = {}; rows.forEach(r=>byId[r.id]=r);

    // pull recent channel messages
    const msgs = (await ck(`/v3/workspaces/${WORKSPACE}/chat/channels/${CHANNEL}/messages?limit=100`, token)).messages || [];
    const appends = []; let updated=0, created=0;

    for(const m of msgs){
      if(m.type && m.type!=="message") continue;
      const q = strip(m.content);
      if(!looksLikeQuestion(q)) continue;
      const cid = "ck_"+m.id;

      // find a teammate answer in the thread (skip asker + bots)
      let ans="", ansBy="", ansAt="";
      if(m.has_replies){
        try {
          const reps = (await ck(`/v3/workspaces/${WORKSPACE}/chat/channels/${CHANNEL}/messages/${m.id}/replies?limit=50`, token)).replies || [];
          // replies are newest-first; take the latest substantive non-asker, non-bot reply
          for(const rp of reps){
            const rt = strip(rp.content);
            if(String(rp.user_id)===String(m.user_id)) continue;
            if(botIds.has(String(rp.user_id))) continue;
            if(rt.length<3 || /^(thanks|ty|np|ok|okay|yep|yes|no problem)\b/i.test(rt)) continue;
            ans=rt; ansBy=nameOf(rp.user_id); ansAt=nowISO(rp.date); break;
          }
        } catch(e){}
      }

      const existing = byId[cid];
      if(existing){
        if(existing.status==="unanswered" && ans){
          const o = await readRow(sheets, sheetId, existing._row);
          o[7]=ans; o[6]="pending"; o[12]=ansBy; o[13]=ansAt;
          await writeRow(sheets, sheetId, existing._row, o);
          updated++;
        }
        continue;
      }
      const mt = match(m.content);
      const row = ["ck_"+m.id, mt.product_id, mt.product_title, mt.variant_sku, q, "clickup",
        ans?"pending":"unanswered", ans, `https://app.clickup.com/${WORKSPACE}/v/c/${CHANNEL}`, "",
        nameOf(m.user_id), nowISO(m.date), ansBy, ansAt, "", ""];
      appends.push(row); created++;
    }

    if(appends.length){
      await sheets.spreadsheets.values.append({ spreadsheetId:sheetId, range:`${TAB}!A2:${LASTCOL}`,
        valueInputOption:"RAW", insertDataOption:"INSERT_ROWS", requestBody:{ values:appends } });
    }
    const summary = `ClickUp ingest: ${created} new, ${updated} updated, ${msgs.length} scanned.`;
    console.log(summary);
    return { statusCode:200, body:summary };
  } catch(e){
    console.error("clickup-ingest error:", e.message);
    return { statusCode:500, body:"Error: "+(e.message||String(e)) };
  }
};

async function readRow(sheets, id, n){
  const r = await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${TAB}!A${n}:${LASTCOL}${n}` });
  const v = (r.data.values||[[]])[0]; while(v.length<COLS.length) v.push(""); return v;
}
async function writeRow(sheets, id, n, vals){
  await sheets.spreadsheets.values.update({ spreadsheetId:id, range:`${TAB}!A${n}:${LASTCOL}${n}`,
    valueInputOption:"RAW", requestBody:{ values:[vals] } });
}
