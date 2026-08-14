/* Netlify Function: re-assign questions to the right product (AI-assisted).
 *
 * The original bulk import matched on word overlap, so many questions landed on
 * accessory listings ("Cables for…", "Footplate for…", "Rubber Flooring Gym Mat")
 * instead of the product actually being asked about.
 *
 * Per call it processes a window of rows:
 *   1. score the catalog locally to shortlist ~6 candidate products per row
 *   2. ask the model to pick the right one (or "keep") for a batch of rows
 *   3. write only the rows that change, in one batch
 *
 *   /.netlify/functions/remap?start=0&count=24          -> dry run
 *   /.netlify/functions/remap?start=0&count=24&apply=1  -> writes
 *
 * Returns { next } so the caller can loop until done.
 */
const { google } = require("googleapis");
// Netlify exposed the site address as URL; Vercel exposes the host as VERCEL_URL.
const SITE = process.env.URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

const TAB = "FAQ", LASTCOL = "V";
const C_ID=0, C_PID=1, C_PTITLE=2, C_Q=4, C_A=7;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const ACCESSORY = /(^cables? for|^footplate|part #|parts #|spare part|^roll of|^rubber flooring|gym mat|on clearance|old version|^pad for|^casters|training app|hardware$)/i;
const STOP = new Set(("the a an of to and is are for do does did with on in it its this that what how can could will would i my you your we our from at by as be been has have not no yes any all "+
  "hey team anyone know someone please thanks thank customer asking wondering question").split(/\s+/));

function json(c,o){ return { statusCode:c, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(o) }; }
function text(c,m){ return { statusCode:c, headers:{ "Content-Type":"text/plain" }, body:m }; }
const toks = s => ((s||"").toLowerCase().match(/[a-z0-9]+/g)||[]).filter(w=>w.length>2 && !STOP.has(w));

function sheetsClient(){
  const auth = new google.auth.JWT(process.env.GOOGLE_CLIENT_EMAIL, null,
    (process.env.GOOGLE_PRIVATE_KEY||"").replace(/\\n/g,"\n"), ["https://www.googleapis.com/auth/spreadsheets"]);
  return google.sheets({ version:"v4", auth });
}

const SYSTEM = `You file support FAQ entries under the correct product for Bells of Steel, a home-gym equipment company.

For each ITEM you get the question, its answer, the product it is currently filed under, and a list of CANDIDATE products.

Choose the product the question is really about.
- Prefer the actual machine/product being asked about, NOT an accessory, spare part, cable kit, footplate, flooring or "Parts #" listing — unless the question is specifically about that accessory.
- If the question names a product or SKU, that wins — even if it asks about one of that product's parts. "the pulley wheels on the Functional Trainer" belongs to the Functional Trainer, not to a pulley-wheel listing.
- Keep an entry with its product when it is product-specific (assembly video, box dimensions, warranty for that product). Only use "_general" for company-wide policy (shipping times, returns, payment).
- If the current product is already correct, choose "keep".
- If the question is generic (shipping, returns, policy, or no product is identifiable), choose "_general".
- If no candidate is clearly right, choose "keep". Never guess.

Return ONLY a JSON array, no prose, no code fence:
[{"id":"<item id>","choose":"<product id | keep | _general>"}]`;

exports.handler = async (event) => {
  const sheetId = process.env.SHEET_ID, key = process.env.ANTHROPIC_API_KEY;
  if(!sheetId || !process.env.GOOGLE_CLIENT_EMAIL) return text(500, "Sheets not configured.");
  if(!key) return text(503, "AI not configured — add ANTHROPIC_API_KEY.");
  const p = event.queryStringParameters||{};
  const start = Math.max(0, parseInt(p.start||"0",10));
  const count = Math.min(30, Math.max(1, parseInt(p.count||"24",10)));
  const apply = p.apply === "1";

  try {
    const cat = (await (await fetch(`${SITE}/catalog.json`)).json()).products || [];
    const products = cat.filter(x=>x.id !== "_general");
    const byId = {}; cat.forEach(x=>byId[x.id]=x);

    const df={}; products.forEach(x=>new Set(toks(x.title)).forEach(w=>df[w]=(df[w]||0)+1));
    const idf = w => Math.log(1 + products.length/(1+(df[w]||0)));
    const skuMap={}; products.forEach(x=>(x.variants||[]).forEach(v=>{ if(v.sku) skuMap[v.sku.toUpperCase()]=x; }));
    const prep = products.map(x=>{ const tt=[...new Set(toks(x.title))];
      return { x, tt, weight: tt.reduce((a,w)=>a+idf(w),0)||1, acc: ACCESSORY.test(x.title) }; });

    function shortlist(t){
      const out=[]; const up=(t||"").toUpperCase();
      for(const sku of Object.keys(skuMap)){
        if(sku.length>=4 && new RegExp(`(^|[^A-Z0-9])${sku.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}([^A-Z0-9]|$)`).test(up)){ out.push(skuMap[sku]); break; }
      }
      const set=new Set(toks(t)); const scored=[];
      for(const e of prep){ let hit=0; for(const w of e.tt) if(set.has(w)) hit+=idf(w);
        if(!hit) continue; let s=(hit/e.weight)*3+hit; if(e.acc) s*=0.6; scored.push([e.x,s]); }
      scored.sort((a,b)=>b[1]-a[1]);
      for(const [x] of scored.slice(0,6)) if(!out.includes(x)) out.push(x);
      return out.slice(0,7);
    }

    const sheets = sheetsClient();
    const got = await sheets.spreadsheets.values.get({ spreadsheetId:sheetId, range:`${TAB}!A2:${LASTCOL}` });
    const rows = got.data.values || [];
    const win = rows.map((r,i)=>({ r, row:i+2 })).slice(start, start+count).filter(o=>o.r[C_Q]);

    const items = win.map(o=>{
      const txt = (o.r[C_Q]||"") + " " + (o.r[C_A]||"");
      const cands = shortlist(txt);
      return { id:o.r[C_ID], row:o.row, cur:o.r[C_PID]||"", curTitle:o.r[C_PTITLE]||"",
               q:(o.r[C_Q]||"").slice(0,220), a:(o.r[C_A]||"").slice(0,140), cands };
    });
    if(!items.length) return json(200, { done:true, next:null, processed:0, changes:[] });

    const payload = items.map(it =>
      `ITEM id: ${it.id}\ncurrently: ${it.curTitle||it.cur||"(none)"}\nQ: ${it.q}\nA: ${it.a}\nCANDIDATES:\n` +
      it.cands.map(c=>`  ${c.id} = ${c.title}`).join("\n")
    ).join("\n\n");

    const rr = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{ "content-type":"application/json", "x-api-key":key, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:MODEL, max_tokens:1500, system:SYSTEM, messages:[{ role:"user", content:payload }] })
    });
    if(!rr.ok) return text(502, "AI error "+rr.status+": "+(await rr.text()).slice(0,200));
    let out = ((await rr.json()).content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    out = out.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
    let picks=[]; try { picks=JSON.parse(out); } catch(e){ const m=out.match(/\[[\s\S]*\]/); if(m){ try{ picks=JSON.parse(m[0]); }catch(e2){} } }
    if(!Array.isArray(picks)) picks=[];

    const changes=[];
    for(const pk of picks){
      const it = items.find(x=>String(x.id)===String(pk && pk.id)); if(!it) continue;
      const choose = String((pk&&pk.choose)||"keep");
      if(choose==="keep" || choose===it.cur) continue;
      const target = byId[choose]; if(!target) continue;
      if(choose!=="_general" && !it.cands.some(c=>c.id===choose)) continue;
      changes.push({ row:it.row, id:it.id, from:it.curTitle||it.cur, to:target.title, toId:target.id, q:it.q.slice(0,70) });
    }

    if(apply && changes.length){
      const now = new Date().toISOString();
      const data=[];
      changes.forEach(c=>{ data.push({ range:`${TAB}!B${c.row}:C${c.row}`, values:[[c.toId, c.to]] });
                           data.push({ range:`${TAB}!S${c.row}`, values:[[now]] }); });
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId:sheetId, requestBody:{ valueInputOption:"RAW", data } });
    }
    const next = (start + count < rows.length) ? start + count : null;
    return json(200, { dryRun:!apply, processed:items.length, changed:changes.length, next, total:rows.length, changes });
  } catch(e){
    return text(500, "Remap failed: " + (e.message||String(e)));
  }
};
