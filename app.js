/* Bells of Steel — internal Product FAQ. Frontend logic.
 * Open access (no account login): each person enters their name once for
 * attribution. Approving may optionally require a Team Lead PIN (if the site
 * is configured with one); the app asks for it the first time and remembers it. */
const API = "/.netlify/functions/faq";
let CATALOG = [];
let CURRENT = null;      // current product object
let ROWS = [];           // all FAQ rows from the sheet
let TAB = "unanswered";
let USER_NAME = localStorage.getItem("faq_name") || "";
let LEAD_PIN = localStorage.getItem("faq_leadpin") || "";

/* ---------- identity (name only) ---------- */
function initials(name){
  if(!name) return "?";
  const parts = name.replace(/@.*/,"").split(/[ ._-]+/).filter(Boolean);
  if(parts.length>=2) return (parts[0][0]+parts[1][0]).toUpperCase();
  return name.slice(0,2).toUpperCase();
}
function paintUser(){
  const box = document.getElementById("userbox");
  if(USER_NAME){
    box.innerHTML = `<span class="who">${esc(initials(USER_NAME))}</span> <span>${esc(USER_NAME)}</span> · <a href="#" id="changeName" class="link">not you?</a>`;
    document.getElementById("changeName").onclick = e => { e.preventDefault(); USER_NAME=""; localStorage.removeItem("faq_name"); paintUser(); route(); };
  } else box.innerHTML = "";
}
function route(){
  const ok = !!USER_NAME;
  document.getElementById("gate").classList.toggle("hidden", ok);
  document.getElementById("main").classList.toggle("hidden", !ok);
  paintUser();
  if(ok && CATALOG.length===0) boot();
}
function setName(){
  const v = document.getElementById("nameInput").value.trim();
  if(v.length<2){ toast("Please enter your name", true); return; }
  USER_NAME = v; localStorage.setItem("faq_name", v); route();
}
document.getElementById("enterBtn").onclick = setName;
document.getElementById("nameInput").addEventListener("keydown", e=>{ if(e.key==="Enter") setName(); });

/* ---------- boot ----------
 * Uses the bundled catalog.json (complete export of all active products,
 * including ones hidden from the public feed). If a Shopify Admin token is
 * later configured, switch the first fetch to /.netlify/functions/catalog. */
async function boot(){
  try {
    const res = await fetch("catalog.json?v=" + Date.now());
    CATALOG = (await res.json()).products || [];
  } catch(e){
    try { const r = await fetch("/.netlify/functions/catalog"); CATALOG = (await r.json()).products || []; }
    catch(e2){ toast("Could not load catalog", true); }
  }
  try { await apiGet(); } catch(e){ /* questions load for dashboard + global search */ }
  if(!checkDeepLink() && !CURRENT) renderDashboard();
  const bEl = document.querySelector(".brand");
  if(bEl){ bEl.style.cursor = "pointer"; bEl.title = "Home"; bEl.onclick = goHome; }
}
function titleFor(id){ const p = CATALOG.find(x=>x.id===id); return p ? p.title : id; }
async function goHome(){
  CURRENT = null; suggBox.classList.add("hidden"); qInput.value = ""; location.hash = "";
  try { await apiGet(); } catch(e){}
  renderDashboard();
}
function checkDeepLink(){
  const m = (location.hash||"").match(/q=([^&]+)/); if(!m) return false;
  const id = decodeURIComponent(m[1]); const r = ROWS.find(x=>x.id===id); if(!r) return false;
  openProduct(r.product_id).then(()=>{ TAB = r.status; renderTabs(); renderList();
    setTimeout(()=>{ const el = document.querySelector(`[data-qid="${(window.CSS&&CSS.escape)?CSS.escape(id):id}"]`); if(el){ el.scrollIntoView({behavior:"smooth",block:"center"}); el.classList.add("flash"); setTimeout(()=>el.classList.remove("flash"),2200); } }, 250);
  });
  return true;
}
window.addEventListener("hashchange", ()=>{ if(USER_NAME) checkDeepLink(); });
let GTAB = "unanswered", GSORT = "oldest", GTOPIC = "all", GTYPE = "all";
let _selTopics = new Set(), _topicsTouched = false;
const TOPICS = ["shipping","assembly","compatibility","specs","sizing","warranty","maintenance"];
const TOPIC_KW = {
  shipping:["ship","shipping","delivery","freight","tracking","customs","duty","arrive"],
  assembly:["assembl","install","bolt","mount","hardware","tools","setup"],
  compatibility:["compatible","compatibility","fit","fits","work with","works with","attach","adapter","interchang"],
  specs:["dimension","weight","capacity","gauge","material","spec","diameter","durometer","thickness"],
  sizing:["size","sizing","tall","height","width","depth","footprint","length"],
  warranty:["warranty","guarantee","return","refund","replace"],
  maintenance:["maintenance","lube","lubric","clean","rust","care","oil"]
};
function topicOf(r){
  const tagged = (r.tags||"").toLowerCase();
  for(const t of TOPICS){ if(tagged.split(/[,\s]+/).includes(t)) return t; }
  const q = (r.question+" "+(r.answer||"")).toLowerCase();
  for(const t of TOPICS){ if((TOPIC_KW[t]||[]).some(k=>q.includes(k))) return t; }
  return "other";
}
function typeOf(r){ const p = CATALOG.find(x=>x.id===r.product_id); return p ? (p.type||"") : ""; }
function sourceOf(r){
  const id = r.id || "";
  if(id.startsWith("ck_") || /clickup/i.test(r.source_link||"")) return { label:"ClickUp · product_knowledge", link:r.source_link };
  if(id.startsWith("app_")) return { label:"Added in tool" };
  return { label:"Legacy FAQ import" };
}
let _selRows = new Set();
function updateBulkBar(){
  const c = document.getElementById("selcount"); if(c) c.textContent = `${_selRows.size} selected`;
  const a = document.getElementById("apprSel"), d = document.getElementById("delSel");
  if(a) a.disabled = _selRows.size===0;
  if(d) d.disabled = _selRows.size===0;
}
function refresh(){ if(CURRENT){ renderTabs(); renderList(); } else renderDashboard(); }
function renderDashboard(){
  const panel = document.getElementById("panel");
  const counts = { unanswered:0, pending:0, approved:0 };
  ROWS.forEach(r=>{ if(counts[r.status]!=null) counts[r.status]++; });
  const defs = [["unanswered","Unanswered"],["pending","Pending approval"],["approved","Approved"]];
  let list = ROWS.filter(r=>r.status===GTAB);
  if(GTOPIC!=="all") list = list.filter(r=>topicOf(r)===GTOPIC);
  if(GTYPE!=="all")  list = list.filter(r=>typeOf(r)===GTYPE);
  list = list.slice().sort((a,b)=>{ const da=(a.created_at||a.answered_at||""), db=(b.created_at||b.answered_at||""); return GSORT==="oldest" ? da.localeCompare(db) : db.localeCompare(da); });
  const types = [...new Set(ROWS.map(typeOf).filter(Boolean))].sort();
  const opt = (val,cur,lab)=>`<option value="${esc(val)}" ${val===cur?"selected":""}>${esc(lab)}</option>`;
  panel.innerHTML = `
    <div class="dash">
      <div class="stats">
        ${defs.map(([k,l])=>`<div class="stat ${GTAB===k?'active':''}" data-go="${k}"><div class="n">${counts[k]}</div><div class="l">${l}</div></div>`).join("")}
      </div>
      <div class="qctl">
        <select id="fsort">${opt("oldest",GSORT,"Oldest first")}${opt("newest",GSORT,"Newest first")}</select>
        <select id="ftopic">${opt("all",GTOPIC,"All topics")}${TOPICS.concat(["other"]).map(t=>opt(t,GTOPIC,t)).join("")}</select>
        <select id="ftype">${opt("all",GTYPE,"All types")}${types.map(t=>opt(t,GTYPE,t)).join("")}</select>
        <span class="qctl-count">${list.length} shown</span>
      </div>
      <div class="bulkbar">
        <label class="check"><input type="checkbox" id="checkall"> Select all shown</label>
        <span id="selcount">0 selected</span>
        ${GTAB==="pending"?`<button class="btn sm primary" id="apprSel" disabled style="margin-left:auto">Approve selected</button>`:`<span style="margin-left:auto"></span>`}
        <button class="btn sm danger" id="delSel" disabled>Delete selected</button>
      </div>
      <div id="glist"></div>
      <div class="dashhint">Tick the boxes to approve or delete in bulk — or open any item to act on it.</div>
    </div>`;
  panel.querySelectorAll(".stat[data-go]").forEach(el=>el.onclick=()=>{ GTAB=el.dataset.go; EDITING=null; MOVING=null; _selRows.clear(); renderDashboard(); });
  document.getElementById("fsort").onchange = e=>{ GSORT=e.target.value; renderDashboard(); };
  document.getElementById("ftopic").onchange = e=>{ GTOPIC=e.target.value; renderDashboard(); };
  document.getElementById("ftype").onchange = e=>{ GTYPE=e.target.value; renderDashboard(); };
  const gl = document.getElementById("glist");
  if(!list.length){ gl.innerHTML = `<div class="spin">Nothing ${GTAB==="pending"?"pending approval":GTAB} right now.</div>`; }
  else { gl.innerHTML = list.map(r=>itemHTML(r,true,true)).join(""); wireItems(gl); }
  updateBulkBar();
  const chkAll = document.getElementById("checkall");
  if(chkAll) chkAll.onclick = ()=>{ const on=chkAll.checked; list.forEach(r=>{ on?_selRows.add(r.id):_selRows.delete(r.id); }); gl.querySelectorAll("[data-check]").forEach(c=>c.checked=on); updateBulkBar(); };
  const aS=document.getElementById("apprSel"); if(aS) aS.onclick=()=>bulkAction("approve", list);
  const dS=document.getElementById("delSel"); if(dS) dS.onclick=()=>bulkAction("delete", list);
}
async function bulkAction(kind, list){
  const shown = new Set(list.map(r=>r.id));
  const targets = [..._selRows].filter(id=>shown.has(id));
  if(!targets.length) return;
  if(!confirm(`${kind==="approve"?"Approve":"Delete"} ${targets.length} selected question(s)?${kind==="delete"?" This can't be undone.":""}`)) return;
  try {
    for(const id of targets){ await apiPost(kind==="approve" ? {action:"approve", id, lead_pin:LEAD_PIN} : {action:"delete", id}); }
    _selRows.clear(); await apiGet(); refresh(); toast(`${kind==="approve"?"Approved":"Deleted"} ${targets.length}`);
  } catch(e){
    if(kind==="approve" && /PIN/i.test(e.message)){ const pin=prompt("Team Lead PIN to approve:"); if(pin){ LEAD_PIN=pin; localStorage.setItem("faq_leadpin",pin); return bulkAction(kind,list); } }
    else toast("Bulk action failed: "+e.message, true);
  }
}
function openItem(pid, tab){ openProduct(pid).then(()=>{ TAB = tab; renderTabs(); renderList(); }); }

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, err){
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast" + (err?" err":"");
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.add("hidden"), 2800);
}

/* ---------- fuzzy search ---------- */
function lev(a,b){const m=a.length,n=b.length;if(!m)return n;if(!n)return m;const dp=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);for(let j=0;j<=n;j++)dp[0][j]=j;for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1));}return dp[m][n];}
function tok(s){return s.toLowerCase().replace(/[^a-z0-9]+/g," ").split(" ").filter(Boolean);}
function sim(a,b){if(a===b)return 1;if(b.length>=3&&a.length>=3&&(b.includes(a)||a.includes(b)))return .92;return 1-lev(a,b)/Math.max(a.length,b.length);}
function norm(s){return s.toLowerCase().replace(/[^a-z0-9]/g,"");}
function score(p,query){
  const qt=tok(query); if(!qt.length) return 0;
  const titleToks=tok(p.title);
  const hay=tok(p.title+" "+p.type+" "+p.variants.map(v=>v.sku+" "+v.title).join(" "));
  let total=0,matched=0;
  for(const q of qt){let best=0;for(const h of hay){const s=sim(q,h);if(s>best)best=s;}if(best>=.6){matched++;total+=best;}}
  if(!matched) return 0;
  const nq=norm(query), nt=norm(p.title);
  let bonus=0;
  if(nt===nq) bonus+=10;                       // exact title match wins outright
  else if(nt.startsWith(nq)) bonus+=4;          // title starts with the query
  else if(nt.includes(nq)) bonus+=1.5;          // title merely contains the query
  // coverage: how much of the title the query accounts for (favors the concise, on-point product)
  const tset=new Set(titleToks), qset=new Set(qt);
  if(tset.size){ bonus += 2.5 * ([...qset].filter(w=>tset.has(w)).length / tset.size); }
  const skuhit = p.variants.some(v=>norm(query).length>=2 && norm(v.sku).includes(nq))?0.8:0;
  return total/qt.length + bonus + skuhit;
}
const qInput = document.getElementById("q");
const suggBox = document.getElementById("sugg");
qInput.addEventListener("input", () => {
  const t = qInput.value.trim();
  if(!t){ suggBox.classList.add("hidden"); return; }
  const phits = CATALOG.map(p=>[p,score(p,t)]).filter(x=>x[1]>=.45).sort((a,b)=>b[1]-a[1]).slice(0,5);
  // global question search across all logged Q&A
  const qtoks = tok(t), need = Math.max(1, Math.ceil(qtoks.length*0.6));
  const qhits = ROWS.map(r=>{
    const hay = (r.question+" "+(r.answer||"")).toLowerCase();
    let m=0; qtoks.forEach(w=>{ if(hay.includes(w)) m++; });
    return [r,m];
  }).filter(x=>x[1]>=need).sort((a,b)=>b[1]-a[1]).slice(0,6);
  let html="";
  if(phits.length) html += `<div class="sgsec">Products</div>` + phits.map(([p])=>`<div class="row" data-id="${p.id}"><span class="ttl">${esc(p.title)}</span><span class="meta">${p.variants.length} SKUs · ${esc(p.type)}</span></div>`).join("");
  if(qhits.length) html += `<div class="sgsec">Questions</div>` + qhits.map(([r])=>`<div class="row qrowsg" data-pid="${esc(r.product_id)}" data-tab="${esc(r.status)}"><span class="ttl">${esc(r.question)}</span><span class="meta">${esc(titleFor(r.product_id))}</span></div>`).join("");
  if(!html) html = '<div class="row"><span class="meta">No match — try fewer letters</span></div>';
  suggBox.innerHTML = html; suggBox.classList.remove("hidden");
  suggBox.querySelectorAll(".row[data-id]").forEach(n=>n.onclick=()=>{ openProduct(n.dataset.id); suggBox.classList.add("hidden"); qInput.value=""; });
  suggBox.querySelectorAll(".qrowsg").forEach(n=>n.onclick=()=>{ openItem(n.dataset.pid, n.dataset.tab); suggBox.classList.add("hidden"); qInput.value=""; });
});
qInput.addEventListener("keydown", e => {
  if(e.key==="Enter"){ const first = suggBox.querySelector(".row[data-id], .qrowsg"); if(first){ e.preventDefault(); first.click(); } }
});
document.addEventListener("click", e => { if(!suggBox.contains(e.target) && e.target!==qInput) suggBox.classList.add("hidden"); });

/* ---------- helpers ---------- */
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
const GENERIC = new Set(["bench","attachment","attachments","adapter","set","pair","only","with","the","and","bundle","ultimate","full","length","shaft","single","pack","save","holes","steel","sleeves","title","default","this","that","does","what","when","include","included"]);
function variantTokens(v){ return tok(v.title).filter(w=>w.length>3 && !GENERIC.has(w)); }
function routeVariant(product, text){
  const qt = tok(text).filter(w=>w.length>3 && !GENERIC.has(w));
  if(!qt.length) return null;
  const freq = {};
  product.variants.forEach(v=>{ new Set(variantTokens(v)).forEach(w=>freq[w]=(freq[w]||0)+1); });
  let best=null, bestScore=0, bestFrac=0;
  for(const v of product.variants){
    const vt = variantTokens(v), vset = new Set(vt);
    let s=0, m=0;
    qt.forEach(w=>{ if(vset.has(w)){ s += 1/(freq[w]||1); m++; } });
    if(s<=0) continue;
    const frac = m/Math.max(vt.length,1);
    if(s > bestScore+1e-9 || (Math.abs(s-bestScore)<1e-9 && frac>bestFrac)){ best=v; bestScore=s; bestFrac=frac; }
  }
  return bestScore >= 0.5 ? best : null;
}

/* ---------- API ---------- */
async function apiGet(){
  const res = await fetch(API);
  if(!res.ok) throw new Error(await res.text());
  ROWS = (await res.json()).rows || [];
}
async function apiPost(body){
  const res = await fetch(API, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ actor: USER_NAME, ...body }) });
  if(!res.ok){ throw new Error((await res.text()) || res.status); }
  return res.json();
}

/* ---------- product view ---------- */
async function openProduct(id){
  CURRENT = CATALOG.find(p=>p.id===id); TAB = "unanswered"; SELVARS = new Set();
  renderProductShell();
  loadDocs(CURRENT.handle);
  document.getElementById("qlist").innerHTML = '<div class="spin">Loading questions…</div>';
  try { await apiGet(); } catch(e){ toast("Could not load questions", true); }
  renderTabs(); renderList();
}
async function loadDocs(handle){
  if(!CURRENT) return;
  CURRENT._docs = [];
  if(handle){
    try { const res = await fetch(`/.netlify/functions/docs?handle=${encodeURIComponent(handle)}`); if(res.ok){ const d = await res.json(); CURRENT._docs = d.manuals || []; } }
    catch(e){ /* best-effort */ }
  }
  renderDocs();
}
function parseDims(label){
  const m = (label||"").match(/(\d+(?:\.\d+)?\s*"\s*[xX×]\s*\d+(?:\.\d+)?\s*"(?:\s*[xX×]\s*\d+(?:\.\d+)?\s*")?|\d+(?:\.\d+)?\s*"\s*\|\s*\d+\s*cm)/);
  return m ? m[1].replace(/\s+/g," ").trim() : "";
}
function renderDocs(){
  const el = document.getElementById("docs"); if(!el) return;
  const docs = (CURRENT && CURRENT._docs) || [];
  if(!docs.length){ el.innerHTML=""; return; }
  const manuals = docs.filter(d=>/manual|assembl/i.test(d.label) && !/box\s*content/i.test(d.label));
  const boxes = docs.filter(d=>/box\s*content/i.test(d.label));
  const sel = [...SELVARS];
  let html = "";
  if(sel.length===1 && boxes.length){
    const v = CURRENT.variants.find(x=>x.sku===sel[0]);
    let best = boxes[0], bs = -1;
    if(v){ const vt = tok(v.title); for(const d of boxes){ const lt=d.label.toLowerCase(); const s=vt.filter(w=>lt.includes(w)).length; if(s>bs){ bs=s; best=d; } } }
    const dims = parseDims(best.label);
    html += `<div class="docdims"><b>Box${v?` · ${esc(v.sku)}`:""}:</b> ${dims?esc(dims):"see PDF"} — <a class="link" href="${esc(best.url)}" target="_blank" rel="noopener">box contents PDF ↗</a></div>`;
  } else if(boxes.length){
    html += `<div class="docdims"><span class="hint">Select a single variant above to see its box dimensions.</span></div>`;
  }
  if(manuals.length) html += `<div class="doclinks">` + manuals.map(m=>`<a class="link doclink" href="${esc(m.url)}" target="_blank" rel="noopener"><span class="pdftag">PDF</span> ${esc(m.label)}</a>`).join("") + `</div>`;
  el.innerHTML = html;
}
function rowsForProduct(){ return ROWS.filter(r=>r.product_id===CURRENT.id); }
function counts(){ const l=visibleRows(); return { unanswered:l.filter(r=>r.status==="unanswered").length, pending:l.filter(r=>r.status==="pending").length, approved:l.filter(r=>r.status==="approved").length }; }

function renderProductShell(){
  const p = CURRENT;
  document.getElementById("panel").innerHTML = `
    <div class="card">
      <div class="prodhead">${p.handle ? `<a class="name pdplink" href="https://bellsofsteel.com/products/${esc(p.handle)}" target="_blank" rel="noopener">${esc(p.title)} <span class="ext" aria-hidden="true">&#8599;</span></a>` : `<span class="name">${esc(p.title)}</span>`}<span class="type">${esc(p.type)}</span><span class="src">${esc(p.src)}</span></div>
      <div class="varlabel">Variants / SKUs <span class="varhint">— click to filter; pick more than one for multi-variant questions</span></div>
      <div class="varlist">
        <div class="variant varall selected" data-sku=""><span class="sku skuall">All variants</span><span>show every question for this product</span></div>
        ${p.variants.map(v=>`<div class="variant" data-sku="${esc(v.sku)}"><span class="sku">${esc(v.sku)}</span><span>${esc(v.title)}</span>${/attach|band|strap|\+/i.test(v.title)?'<span class="attflag">attachment</span>':''}</div>`).join("")}
      </div>
      <div id="docs" class="docs"></div>
    </div>
    <div class="tabs" id="tabs"></div>
    <div class="qhead"><span class="lab" id="tablab"></span><button class="btn addbtn" id="addbtn">+ Log question</button></div>
    <div class="addbox hidden" id="addbox">
      <input id="newq" type="text" placeholder="Type the question…" />
      <div class="flag dup hidden" id="dup"></div>
      <div class="applies"><span class="applylbl">Applies to:</span> <span id="scopenote" class="scopenote"></span> <span class="varhint">— change by selecting variants above</span></div>
      <div class="applies"><span class="applylbl">Topics:</span><span id="topicchips"></span></div>
      <button class="btn primary" id="saveq">Add</button>
    </div>
    <div id="qlist"></div>`;
  document.getElementById("addbtn").onclick = () => {
    const box = document.getElementById("addbox");
    const opening = box.classList.contains("hidden");
    box.classList.toggle("hidden");
    if(opening){ _selTopics = new Set(); _topicsTouched=false; renderTopics(); renderScopeNote(); document.getElementById("newq").focus(); }
  };
  document.getElementById("newq").addEventListener("input", onNewQInput);
  document.getElementById("saveq").onclick = saveQuestion;
  document.querySelectorAll(".varlist .variant").forEach(el=>el.onclick=()=>selectVariant(el.dataset.sku||""));
}
let SELVARS = new Set();   // selected variant SKUs: viewing filter + scope for new questions; empty = all / whole product
function skuListOf(r){ return (r.variant_sku||"").split(",").map(s=>s.trim()).filter(Boolean); }
function visibleRows(){
  const l = rowsForProduct();
  if(!SELVARS.size) return l;
  return l.filter(r => { const cs = skuListOf(r); return cs.length ? cs.some(x=>SELVARS.has(x)) : true; });  // any selected sku + whole-product
}
function renderScopeNote(){
  const el = document.getElementById("scopenote"); if(!el) return;
  el.innerHTML = SELVARS.size ? [...SELVARS].map(s=>`<span class="sku">${esc(s)}</span>`).join(" ") : `<span class="stamp" style="margin-left:0">whole product</span>`;
}
function renderTopics(){
  const box = document.getElementById("topicchips"); if(!box) return;
  box.innerHTML = TOPICS.map(t=>`<button class="achip ${_selTopics.has(t)?'on':''}" data-topic="${t}">${t}</button>`).join("");
  box.querySelectorAll(".achip").forEach(b=>b.onclick=()=>{ const t=b.dataset.topic; _selTopics.has(t)?_selTopics.delete(t):_selTopics.add(t); _topicsTouched=true; renderTopics(); });
}
function selectVariant(sku){
  if(!sku){ SELVARS.clear(); } else { SELVARS.has(sku) ? SELVARS.delete(sku) : SELVARS.add(sku); }
  document.querySelectorAll(".varlist .variant").forEach(el=>{
    const s = el.dataset.sku||"";
    el.classList.toggle("selected", s ? SELVARS.has(s) : SELVARS.size===0);
  });
  renderTabs(); renderList(); renderScopeNote(); renderDocs();
}
function renderTabs(){
  const c = counts();
  const defs = [["unanswered","Unanswered"],["pending","Pending approval"],["approved","Approved"]];
  document.getElementById("tabs").innerHTML = defs.map(([k,lab])=>`<button class="tab ${TAB===k?'active':''}" data-tab="${k}">${lab}<span class="ct">${c[k]}</span></button>`).join("");
  document.getElementById("tabs").querySelectorAll(".tab").forEach(b=>b.onclick=()=>{ TAB=b.dataset.tab; renderTabs(); renderList(); });
  document.getElementById("tablab").textContent = defs.find(d=>d[0]===TAB)[1];
}
function onNewQInput(){
  const v = document.getElementById("newq").value;
  if(!_topicsTouched){ const t = topicOf({question:v, tags:""}); _selTopics = new Set(t!=="other"?[t]:[]); renderTopics(); }
  // duplicate detection — only flag questions that share a SKU (or are whole-product)
  const dup = document.getElementById("dup");
  const words = v.toLowerCase().split(/\s+/).filter(w=>w.length>3);
  const tgt = [...SELVARS];
  const cands = rowsForProduct().filter(r=>{
    const iw = r.question.toLowerCase();
    if(words.filter(w=>iw.includes(w)).length < 2) return false;
    const cs = skuListOf(r);
    if(!cs.length || !tgt.length) return true;      // either side is whole-product
    return cs.some(x=>tgt.includes(x));             // same specific SKU
  });
  if(v.trim().length>6 && cands.length){
    dup.classList.remove("hidden");
    dup.innerHTML = "Possible duplicate — is this the same as:<br>" + cands.slice(0,6).map(s=>
      `• <a href="#q=${encodeURIComponent(s.id)}" target="_blank" rel="noopener" class="duplink">${esc(s.question)}</a> ${s.variant_sku?`<span class="dupsku">${esc(s.variant_sku)}</span>`:`<span class="dupsku wp">whole product</span>`}`
    ).join("<br>");
  } else dup.classList.add("hidden");
}
async function saveQuestion(){
  const v = document.getElementById("newq").value.trim(); if(!v) return;
  const btn = document.getElementById("saveq"); btn.disabled = true;
  try {
    const vsku = [...SELVARS].join(",");   // "" = whole product, "A,B" = applies to A and B
    await apiPost({ action:"add", product_id:CURRENT.id, product_title:CURRENT.title, variant_sku:vsku, question:v, tags:[..._selTopics].join(",") });
    document.getElementById("newq").value=""; document.getElementById("addbox").classList.add("hidden");
    await apiGet(); TAB="unanswered"; renderTabs(); renderList(); toast("Question logged");
  } catch(e){ toast("Save failed: "+e.message, true); } finally { btn.disabled=false; }
}

/* ---------- question list ---------- */
function skuChip(s){ const list=(s||"").split(",").map(x=>x.trim()).filter(Boolean); return list.length ? list.map(x=>`<span class="sku">${esc(x)}</span>`).join(" ") : `<span class="stamp" style="margin-left:0">whole product</span>`; }
let EDITING = null;
let MOVING = null;
function fmt(a){ return esc(a).replace(/\n/g,"<br>"); }
function staleBadge(r){
  if(r.status!=="approved" || !r.last_verified_at) return "";
  const d = new Date(r.last_verified_at); if(isNaN(d)) return "";
  const days = (Date.now()-d.getTime())/86400000;
  if(days>182){ const mo=Math.max(1,Math.round(days/30)); return `<span class="stale">&#9888; review — verified ${mo} mo ago</span>`; }
  return "";
}
function prodChip(r){ return `<a class="prodchip" data-open="${esc(r.product_id)}">${esc(r.product_title||r.product_id)}</a>`; }
function itemHTML(r, showProduct, selectable){
  if(EDITING===r.id){
    return `<div class="qitem editing">
      ${showProduct?`<div class="prodline">in ${prodChip(r)}</div>`:""}
      <label class="edlbl">Question</label>
      <input class="ed-q" data-eq="${r.id}" value="${esc(r.question)}" />
      <label class="edlbl">Answer</label>
      <textarea class="ed-a" data-ea="${r.id}" rows="4" placeholder="Answer…">${esc(r.answer)}</textarea>
      <div class="qctrls"><button class="btn sm primary" data-save="${r.id}">Save</button><button class="btn sm" data-cancel="1">Cancel</button>${r.status==="approved"?'<span class="hint">editing the answer sends it back for re-approval</span>':''}</div>
    </div>`;
  }
  if(MOVING===r.id){
    return `<div class="qitem editing">
      <div class="qtop"><span class="qtext">${esc(r.question)}</span></div>
      <label class="edlbl">Move to which product?</label>
      <input class="mv-q" data-mvq="${r.id}" placeholder="Search a product…" autocomplete="off" />
      <div class="mv-results" data-mvr="${r.id}"></div>
      <div class="qctrls"><button class="btn sm" data-mvcancel="1">Cancel</button><span class="hint">currently under: ${esc(r.product_title||r.product_id)}</span></div>
    </div>`;
  }
  let ans;
  if(r.status==="unanswered"){
    ans = `<div class="ansrow"><input data-ans="${r.id}" placeholder="Know this? Answer it…" />
      <div class="srcrow"><input data-src="${r.id}" placeholder="Source link (ClickUp, Drive…) — optional" /></div></div>`;
  } else {
    ans = `<div class="ans">${fmt(r.answer)}</div>${r.source_link?`<div style="margin-top:4px"><a class="link" href="${esc(r.source_link)}" target="_blank" rel="noopener">source ↗</a></div>`:""}`;
  }
  let ctrls = "";
  if(r.status==="pending") ctrls += `<label class="check"><input type="checkbox" data-appr="${r.id}"> Approve</label>`;
  ctrls += `<button class="btn sm" data-edit="${r.id}">Edit</button>`;
  ctrls += `<button class="btn sm" data-move="${r.id}">Move</button>`;
  if(r.status!=="unanswered") ctrls += `<button class="btn sm" data-copy="${r.id}">Copy</button>`;
  const src = sourceOf(r);
  return `<div class="qitem ${r.status==='pending'?'pending':''}" data-qid="${esc(r.id)}">
    <div class="qtop">${selectable?`<input type="checkbox" class="rowchk" data-check="${esc(r.id)}" ${_selRows.has(r.id)?"checked":""}>`:""}<span class="qtext">${esc(r.question)}</span>${skuChip(r.variant_sku)}</div>
    ${showProduct?`<div class="prodline">in ${prodChip(r)}</div>`:""}
    ${ans}
    <div class="qmeta">${topicOf(r)!=="other"?`<span class="topic">${esc(topicOf(r))}</span>`:""}${src.link?`<a class="src2" href="${esc(src.link)}" target="_blank" rel="noopener">${esc(src.label)} ↗</a>`:`<span class="src2">${esc(src.label)}</span>`}${staleBadge(r)}<span class="stamp">${r.answered_by?esc(initials(r.answered_by))+" · ":""}${esc((r.last_verified_at||r.answered_at||r.created_at||"").slice(0,10))}${r.last_verified_at?" · last verified":""}</span></div>
    <div class="qctrls">${ctrls}<button class="btn sm danger" data-del="${r.id}" style="margin-left:auto">Delete</button></div>
  </div>`;
}
function wireItems(ql){
  ql.querySelectorAll("[data-ans]").forEach(inp=>inp.addEventListener("keydown", e=>{
    if(e.key==="Enter" && inp.value.trim()){ const src=ql.querySelector(`[data-src="${inp.dataset.ans}"]`); submitAnswer(inp.dataset.ans, inp.value.trim(), src?src.value.trim():""); }
  }));
  ql.querySelectorAll("[data-appr]").forEach(c=>c.onchange=()=>approve(c.dataset.appr));
  ql.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>{ EDITING=b.dataset.edit; MOVING=null; refresh(); });
  ql.querySelectorAll("[data-cancel]").forEach(b=>b.onclick=()=>{ EDITING=null; refresh(); });
  ql.querySelectorAll("[data-move]").forEach(b=>b.onclick=()=>{ MOVING=b.dataset.move; EDITING=null; refresh(); });
  ql.querySelectorAll("[data-mvcancel]").forEach(b=>b.onclick=()=>{ MOVING=null; refresh(); });
  ql.querySelectorAll("[data-open]").forEach(a=>a.onclick=()=>openProduct(a.dataset.open));
  const mvIn = ql.querySelector("[data-mvq]");
  if(mvIn){
    mvIn.focus();
    mvIn.addEventListener("input", ()=>{
      const t=mvIn.value.trim(), res=ql.querySelector(`[data-mvr="${mvIn.dataset.mvq}"]`);
      if(!t){ res.innerHTML=""; return; }
      const hits=CATALOG.map(p=>[p,score(p,t)]).filter(x=>x[1]>=.45).sort((a,b)=>b[1]-a[1]).slice(0,6);
      res.innerHTML = hits.length ? hits.map(([p])=>`<div class="mvrow" data-mvpick="${esc(p.id)}">${esc(p.title)} <span class="meta">${esc(p.type)}</span></div>`).join("") : '<div class="meta" style="padding:7px 10px">No match</div>';
      res.querySelectorAll("[data-mvpick]").forEach(el=>el.onclick=()=>{ const p=CATALOG.find(x=>x.id===el.dataset.mvpick); reassign(mvIn.dataset.mvq, p); });
    });
  }
  ql.querySelectorAll("[data-save]").forEach(b=>b.onclick=()=>{ const id=b.dataset.save; const q=ql.querySelector(`[data-eq="${id}"]`).value.trim(); const a=ql.querySelector(`[data-ea="${id}"]`).value.trim(); editItem(id,q,a); });
  ql.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>{ const r=ROWS.find(x=>x.id===b.dataset.copy); if(r) navigator.clipboard.writeText(r.answer||"").then(()=>toast("Answer copied")).catch(()=>toast("Copy failed",true)); });
  ql.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ if(confirm("Delete this question?")) mutate({action:"delete", id:b.dataset.del}, "Deleted"); });
  ql.querySelectorAll("[data-check]").forEach(c=>c.onchange=()=>{ c.checked ? _selRows.add(c.dataset.check) : _selRows.delete(c.dataset.check); updateBulkBar(); });
}
function renderList(){
  const list = visibleRows().filter(r=>r.status===TAB);
  const ql = document.getElementById("qlist");
  if(!list.length){ ql.innerHTML = `<div class="spin">Nothing in ${TAB==="pending"?"pending approval":TAB}.</div>`; return; }
  ql.innerHTML = list.map(r=>itemHTML(r,false)).join("");
  wireItems(ql);
}
async function editItem(id,q,a){
  if(!q){ toast("Question can't be empty", true); return; }
  try { await apiPost({action:"edit", id, question:q, answer:a}); EDITING=null; await apiGet(); refresh(); toast("Saved"); }
  catch(e){ toast("Save failed: "+e.message, true); }
}
async function reassign(id, p){
  if(!p) return;
  try { await apiPost({action:"edit", id, product_id:p.id, product_title:p.title, variant_sku:""}); MOVING=null; await apiGet(); refresh(); toast("Moved to "+p.title); }
  catch(e){ toast("Move failed: "+e.message, true); }
}
async function submitAnswer(id, answer, source_link){
  try { await apiPost({ action:"answer", id, answer, source_link }); await apiGet(); refresh(); toast("Answer saved — pending approval"); }
  catch(e){ toast("Save failed: "+e.message, true); }
}
async function approve(id){
  try { await apiPost({ action:"approve", id, lead_pin: LEAD_PIN }); await apiGet(); refresh(); toast("Approved"); }
  catch(e){
    if(/PIN/i.test(e.message)){ const pin = prompt("Team Lead PIN required to approve:"); if(pin){ LEAD_PIN = pin; localStorage.setItem("faq_leadpin", pin); return approve(id); } refresh(); }
    else { toast("Approve failed: "+e.message, true); refresh(); }
  }
}
async function approveAll(ids){
  if(!ids || !ids.length) return;
  if(!confirm(`Approve all ${ids.length} shown?`)) return;
  try { for(const id of ids){ await apiPost({ action:"approve", id, lead_pin: LEAD_PIN }); } await apiGet(); refresh(); toast(`Approved ${ids.length}`); }
  catch(e){
    if(/PIN/i.test(e.message)){ const pin = prompt("Team Lead PIN required to approve:"); if(pin){ LEAD_PIN = pin; localStorage.setItem("faq_leadpin", pin); return approveAll(ids); } }
    else toast("Bulk approve failed: "+e.message, true);
  }
}
async function mutate(body, okMsg){
  try { await apiPost(body); await apiGet(); refresh(); toast(okMsg); }
  catch(e){ toast("Action failed: "+e.message, true); }
}

/* ---------- start ---------- */
route();
