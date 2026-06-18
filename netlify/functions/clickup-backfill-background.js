/* One-time backfill: pull ~1 year of ClickUp #product_knowledge Q&A into the
 * FAQ sheet. Runs as a Netlify *background* function (up to 15 min), throttled
 * to respect ClickUp rate limits. Trigger once:
 *   /.netlify/functions/clickup-backfill-background
 * It returns 202 immediately and keeps working; check the sheet / function logs.
 * The daily clickup-ingest handles everything ongoing and shares the same
 * "ck_<id>" dedupe, so re-running is safe.
 */
const { google } = require("googleapis");
const WORKSPACE="8634432", CHANNEL="87g20-350617", CK="https://api.clickup.com/api";
const TAB="FAQ", LASTCOL="P";
const COLS=["id","product_id","product_title","variant_sku","question","tags","status","answer","source_link","attachment_url","created_by","created_at","answered_by","answered_at","approved_by","last_verified_at"];
const DAYS_BACK=365, THROTTLE_MS=650, MAX_PAGES=60;

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const nowISO = d => (d?new Date(d):new Date()).toISOString();
const strip = s => (s||"").replace(/!\[[^\]]*\]\([^)]*\)/g,"").replace(/\s+/g," ").trim();
const cText = c => typeof c==="string" ? c : ((c && (c.text||c.md||c.content))||"");
const uOf = x => x.user_id || (x.user&&x.user.id) || x.author_id || "";
const dOf = x => x.date || x.created_at || x.created || x.timestamp;
const arr = r => r.messages || r.data || r.replies || (Array.isArray(r)?r:[]);
const nextOf = r => r.next_cursor || (r.meta&&r.meta.next_cursor) || (r.pagination&&r.pagination.next_cursor) || "";
function looksLikeQuestion(s){ const t=strip(s); if(t.length<12) return false; if(/^(thanks|thank you|ty|np|yep|yes|no|ok|okay|got it|perfect|great)\b/i.test(t)) return false; return /\?/.test(t) || /^(what|how|does|do|is|are|can|could|will|would|which|when|why|where|any|has|info|need)\b/i.test(t); }

async function ck(path, token){ const r=await fetch(`${CK}${path}`,{headers:{Authorization:token}}); if(!r.ok) throw new Error(`ClickUp ${r.status} ${path}: ${(await r.text()).slice(0,120)}`); return r.json(); }
function sheetsClient(){ const auth=new google.auth.JWT(process.env.GOOGLE_CLIENT_EMAIL,null,(process.env.GOOGLE_PRIVATE_KEY||"").replace(/\\n/g,"\n"),["https://www.googleapis.com/auth/spreadsheets"]); return google.sheets({version:"v4",auth}); }
function buildMatcher(catalog){
  const skuMap={}; catalog.forEach(p=>(p.variants||[]).forEach(v=>{ if(v.sku) skuMap[v.sku.toUpperCase()]={p,sku:v.sku}; }));
  const STOP=new Set("the a of to and is are for do does with on in it this that what how can could will".split(" "));
  const toks=s=>(s||"").toLowerCase().match(/[a-z0-9]+/g)?.filter(w=>w.length>2&&!STOP.has(w))||[];
  return text=>{
    for(const s of (text.match(/\b[A-Z0-9]{2,}(?:-[A-Z0-9.]+)+\b/g)||[])){ const h=skuMap[s.toUpperCase()]; if(h) return {product_id:h.p.id,product_title:h.p.title,variant_sku:h.sku}; }
    const qt=new Set(toks(text)); let best=null,bs=0;
    for(const p of catalog){ if(p.id==="_general") continue; let s=0; new Set(toks(p.title)).forEach(w=>{ if(qt.has(w)) s++; }); if(s>bs){bs=s;best=p;} }
    return (best&&bs>=2)?{product_id:best.id,product_title:best.title,variant_sku:""}:{product_id:"_general",product_title:"General & Policies",variant_sku:""};
  };
}

exports.handler = async () => {
  const token=process.env.CLICKUP_TOKEN, sheetId=process.env.SHEET_ID;
  if(!token||!sheetId||!process.env.GOOGLE_CLIENT_EMAIL){ console.error("backfill not configured"); return; }
  const botIds=new Set((process.env.CLICKUP_BOT_IDS||"").split(",").map(s=>s.trim()).filter(Boolean));
  const cutoff=Date.now()-DAYS_BACK*86400000;
  try{
    let catalog=[]; try{ catalog=(await (await fetch(`${process.env.URL||""}/catalog.json`)).json()).products||[]; }catch(e){}
    const match=buildMatcher(catalog);
    const names={}; try{ const team=await ck(`/v2/team`,token); const t=(team.teams||[]).find(x=>String(x.id)===WORKSPACE)||(team.teams||[])[0]; (t?.members||[]).forEach(m=>{ const u=m.user||{}; names[u.id]=u.username||u.email||("user "+u.id); if(/bot|\bai\b|clickbot/i.test((u.username||"")+" "+(u.email||""))) botIds.add(String(u.id)); }); }catch(e){}
    const nameOf=id=>names[id]||("user "+id);

    const sheets=sheetsClient();
    const got=await sheets.spreadsheets.values.get({spreadsheetId:sheetId,range:`${TAB}!A2:A`});
    const seen=new Set((got.data.values||[]).map(r=>r[0]));

    let cursor="", page=0, created=0, scanned=0, stop=false; const appends=[];
    while(page<MAX_PAGES && !stop){
      const mr=await ck(`/v3/workspaces/${WORKSPACE}/chat/channels/${CHANNEL}/messages?limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,token);
      const msgs=arr(mr); if(!msgs.length) break;
      for(const m of msgs){
        scanned++;
        const mdate=dOf(m); if(mdate && new Date(mdate).getTime()<cutoff){ stop=true; break; }
        if(m.type && m.type!=="message") continue;
        const content=cText(m.content), uid=uOf(m); const q=strip(content);
        if(!looksLikeQuestion(q)) continue;
        const cid="ck_"+m.id; if(seen.has(cid)) continue; seen.add(cid);
        let ans="",ansBy="",ansAt="";
        const hasReplies=(m.has_replies!=null)?m.has_replies:((m.reply_count||m.replies_count||0)>0);
        if(hasReplies){ await sleep(THROTTLE_MS);
          try{ const reps=arr(await ck(`/v3/workspaces/${WORKSPACE}/chat/channels/${CHANNEL}/messages/${m.id}/replies?limit=50`,token));
            for(const rp of reps){ const ruid=uOf(rp), rt=strip(cText(rp.content)); if(String(ruid)===String(uid))continue; if(botIds.has(String(ruid)))continue; if(rt.length<3||/^(thanks|ty|np|ok|okay|yep|yes)\b/i.test(rt))continue; ans=rt; ansBy=nameOf(ruid); ansAt=nowISO(dOf(rp)); break; }
          }catch(e){}
        }
        const mt=match(content);
        appends.push([cid,mt.product_id,mt.product_title,mt.variant_sku,q,"clickup",ans?"pending":"unanswered",ans,`https://app.clickup.com/${WORKSPACE}/v/c/${CHANNEL}`,"",nameOf(uid),nowISO(mdate),ansBy,ansAt,"",""]);
        created++;
        if(appends.length>=50){ await sheets.spreadsheets.values.append({spreadsheetId:sheetId,range:`${TAB}!A2:${LASTCOL}`,valueInputOption:"RAW",insertDataOption:"INSERT_ROWS",requestBody:{values:appends.splice(0)}}); }
      }
      cursor=nextOf(mr); page++; if(!cursor) break;
      await sleep(THROTTLE_MS);
    }
    if(appends.length) await sheets.spreadsheets.values.append({spreadsheetId:sheetId,range:`${TAB}!A2:${LASTCOL}`,valueInputOption:"RAW",insertDataOption:"INSERT_ROWS",requestBody:{values:appends}});
    console.log(`Backfill done: ${created} imported, ${scanned} scanned, ${page} pages.`);
  }catch(e){ console.error("backfill error:",e.message); }
};
