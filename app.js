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
  if(!CURRENT) renderDashboard();
  const bEl = document.querySelector(".brand");
  if(bEl){ bEl.style.cursor = "pointer"; bEl.title = "Home"; bEl.onclick = goHome; }
}
function titleFor(id){ const p = CATALOG.find(x=>x.id===id); return p ? p.title : id; }
async function goHome(){
  CURRENT = null; suggBox.classList.add("hidden"); qInput.value = "";
  try { await apiGet(); } catch(e){}
  renderDashboard();
}
function renderDashboard(){
  const pend = ROWS.filter(r=>r.status==="pending");
  const un   = ROWS.filter(r=>r.status==="unanswered");
  const appr = ROWS.filter(r=>r.status==="approved");
  const panel = document.getElementById("panel");
  panel.innerHTML = `
    <div class="dash">
      <div class="stats">
        <div class="stat" data-go="pending"><div class="n">${pend.length}</div><div class="l">Pending approval</div></div>
        <div class="stat" data-go="unanswered"><div class="n">${un.length}</div><div class="l">Unanswered</div></div>
        <div class="stat"><div class="n">${appr.length}</div><div class="l">Approved</div></div>
      </div>
      ${pend.length ? `<div class="queue"><div class="qh">Waiting for a lead's approval</div>${pend.slice(0,25).map(r=>`<div class="qrow" data-pid="${esc(r.product_id)}" data-tab="pending"><span class="qq">${esc(r.question)}</span><span class="qp">${esc(titleFor(r.product_id))}</span></div>`).join("")}${pend.length>25?`<div class="more">+ ${pend.length-25} more — open a product to see the rest</div>`:""}</div>` : `<div class="queue"><div class="qh">Nothing waiting for approval right now.</div></div>`}
      <div class="dashhint">Search above for a product or a question, or click an item to open it.</div>
    </div>`;
  panel.querySelectorAll(".qrow").forEach(el=>el.onclick=()=>openItem(el.dataset.pid, el.dataset.tab));
  panel.querySelectorAll(".stat[data-go]").forEach(el=>el.onclick=()=>{
    const first = (el.dataset.go==="pending"?pend:un)[0];
    if(first) openItem(first.product_id, el.dataset.go);
  });
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
  CURRENT = CATALOG.find(p=>p.id===id); TAB = "unanswered"; SELVAR = null;
  renderProductShell();
  loadDocs(CURRENT.handle);
  document.getElementById("qlist").innerHTML = '<div class="spin">Loading questions…</div>';
  try { await apiGet(); } catch(e){ toast("Could not load questions", true); }
  renderTabs(); renderList();
}
async function loadDocs(handle){
  const el = document.getElementById("docs");
  if(!el || !handle) return;
  try {
    const res = await fetch(`/.netlify/functions/docs?handle=${encodeURIComponent(handle)}`);
    if(!res.ok) return;
    const d = await res.json();
    let html = "";
    if(d.dims) html += `<div class="docdims"><b>Box:</b> ${esc(d.dims)} <span class="hint">— full dimensions in the Box Contents PDF</span></div>`;
    if(d.manuals && d.manuals.length){
      html += `<div class="doclinks">` + d.manuals.map(m=>`<a class="link doclink" href="${esc(m.url)}" target="_blank" rel="noopener"><span class="pdftag">PDF</span> ${esc(m.label)}</a>`).join("") + `</div>`;
    }
    el.innerHTML = html;
  } catch(e){ /* docs are best-effort */ }
}
function rowsForProduct(){ return ROWS.filter(r=>r.product_id===CURRENT.id); }
function counts(){ const l=visibleRows(); return { unanswered:l.filter(r=>r.status==="unanswered").length, pending:l.filter(r=>r.status==="pending").length, approved:l.filter(r=>r.status==="approved").length }; }

function renderProductShell(){
  const p = CURRENT;
  document.getElementById("panel").innerHTML = `
    <div class="card">
      <div class="prodhead">${p.handle ? `<a class="name pdplink" href="https://bellsofsteel.com/products/${esc(p.handle)}" target="_blank" rel="noopener">${esc(p.title)} <span class="ext" aria-hidden="true">&#8599;</span></a>` : `<span class="name">${esc(p.title)}</span>`}<span class="type">${esc(p.type)}</span><span class="src">${esc(p.src)}</span></div>
      <div class="varlabel">Variants / SKUs <span class="varhint">— click a SKU to see only its questions</span></div>
      <div class="varlist">
        <div class="variant varall selected" data-sku=""><span class="sku skuall">All variants</span><span>show every question for this product</span></div>
        ${p.variants.map(v=>`<div class="variant" data-sku="${esc(v.sku)}"><span class="sku">${esc(v.sku)}</span><span>${esc(v.title)}</span>${v.weight_lb?`<span class="wt">${v.weight_lb} lb</span>`:""}${/attach|band|strap|\+/i.test(v.title)?'<span class="attflag">attachment</span>':''}</div>`).join("")}
      </div>
      <div id="docs" class="docs"></div>
    </div>
    <div class="tabs" id="tabs"></div>
    <div class="qhead"><span class="lab" id="tablab"></span><button class="btn addbtn" id="addbtn">+ Log question</button></div>
    <div class="addbox hidden" id="addbox">
      <input id="newq" type="text" placeholder="Type the question…" />
      <div class="flag dup hidden" id="dup"></div>
      <div class="flag route hidden" id="route"></div>
      <button class="btn primary" id="saveq">Add to Unanswered</button>
    </div>
    <div id="qlist"></div>`;
  document.getElementById("addbtn").onclick = () => document.getElementById("addbox").classList.toggle("hidden");
  document.getElementById("newq").addEventListener("input", onNewQInput);
  document.getElementById("saveq").onclick = saveQuestion;
  document.querySelectorAll(".varlist .variant").forEach(el=>el.onclick=()=>selectVariant(el.dataset.sku||""));
}
let SELVAR = null;   // selected variant SKU, or null = all
function visibleRows(){
  const l = rowsForProduct();
  if(!SELVAR) return l;
  return l.filter(r => r.variant_sku === SELVAR || !r.variant_sku);  // SKU-specific + whole-product
}
function selectVariant(sku){
  SELVAR = sku || null;
  document.querySelectorAll(".varlist .variant").forEach(el =>
    el.classList.toggle("selected", (el.dataset.sku||"") === (SELVAR||"")));
  renderTabs(); renderList();
}
function renderTabs(){
  const c = counts();
  const defs = [["unanswered","Unanswered"],["pending","Pending approval"],["approved","Approved"]];
  document.getElementById("tabs").innerHTML = defs.map(([k,lab])=>`<button class="tab ${TAB===k?'active':''}" data-tab="${k}">${lab}<span class="ct">${c[k]}</span></button>`).join("");
  document.getElementById("tabs").querySelectorAll(".tab").forEach(b=>b.onclick=()=>{ TAB=b.dataset.tab; renderTabs(); renderList(); });
  document.getElementById("tablab").textContent = defs.find(d=>d[0]===TAB)[1];
}
let _routeVsku;
function onNewQInput(){
  const v = document.getElementById("newq").value;
  const dup = document.getElementById("dup"), route = document.getElementById("route");
  const words = v.toLowerCase().split(/\s+/).filter(w=>w.length>3);
  const sim2 = rowsForProduct().filter(r=>{ const iw=r.question.toLowerCase(); return words.filter(w=>iw.includes(w)).length>=2; });
  if(v.trim().length>6 && sim2.length){ dup.classList.remove("hidden"); dup.innerHTML = "Possible duplicate — is this the same as:<br>" + sim2.map(s=>"• "+esc(s.question)).join("<br>"); }
  else dup.classList.add("hidden");
  const hit = routeVariant(CURRENT, v);
  if(hit){ route.classList.remove("hidden"); route.innerHTML = `Looks specific to <b>${esc(hit.sku)}</b>. <a id="rt">Scope to it</a> · <a id="rb">Keep on whole product</a>`;
    document.getElementById("rt").onclick=()=>{ _routeVsku=hit.sku; route.innerHTML="Scoped to "+esc(hit.sku); };
    document.getElementById("rb").onclick=()=>{ _routeVsku=""; route.innerHTML="Kept on whole product"; };
  } else { route.classList.add("hidden"); _routeVsku=undefined; }
}
async function saveQuestion(){
  const v = document.getElementById("newq").value.trim(); if(!v) return;
  const btn = document.getElementById("saveq"); btn.disabled = true;
  try {
    const vsku = (_routeVsku !== undefined) ? _routeVsku : (SELVAR || "");
    await apiPost({ action:"add", product_id:CURRENT.id, product_title:CURRENT.title, variant_sku:vsku, question:v });
    document.getElementById("newq").value=""; document.getElementById("addbox").classList.add("hidden"); _routeVsku=undefined;
    await apiGet(); TAB="unanswered"; renderTabs(); renderList(); toast("Question logged");
  } catch(e){ toast("Save failed: "+e.message, true); } finally { btn.disabled=false; }
}

/* ---------- question list ---------- */
function skuChip(s){ return s ? `<span class="sku">${esc(s)}</span>` : `<span class="stamp" style="margin-left:0">whole product</span>`; }
let EDITING = null;
function fmt(a){ return esc(a).replace(/\n/g,"<br>"); }
function staleBadge(r){
  if(r.status!=="approved" || !r.last_verified_at) return "";
  const d = new Date(r.last_verified_at); if(isNaN(d)) return "";
  const days = (Date.now()-d.getTime())/86400000;
  if(days>182){ const mo=Math.max(1,Math.round(days/30)); return `<span class="stale">&#9888; review — verified ${mo} mo ago</span>`; }
  return "";
}
function renderList(){
  const list = visibleRows().filter(r=>r.status===TAB);
  const ql = document.getElementById("qlist");
  if(!list.length){ ql.innerHTML = `<div class="spin">Nothing in ${TAB==="pending"?"pending approval":TAB}.</div>`; return; }
  ql.innerHTML = list.map(r=>{
    if(EDITING===r.id){
      return `<div class="qitem editing">
        <label class="edlbl">Question</label>
        <input class="ed-q" data-eq="${r.id}" value="${esc(r.question)}" />
        <label class="edlbl">Answer</label>
        <textarea class="ed-a" data-ea="${r.id}" rows="4" placeholder="Answer…">${esc(r.answer)}</textarea>
        <div class="qctrls"><button class="btn sm primary" data-save="${r.id}">Save</button><button class="btn sm" data-cancel="1">Cancel</button>${r.status==="approved"?'<span class="hint">editing the answer sends it back for re-approval</span>':''}</div>
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
    if(r.status!=="unanswered") ctrls += `<button class="btn sm" data-copy="${r.id}">Copy</button>`;
    return `<div class="qitem ${r.status==='pending'?'pending':''}">
      <div class="qtop"><span class="qtext">${esc(r.question)}</span>${skuChip(r.variant_sku)}</div>
      ${ans}
      <div class="qmeta">${staleBadge(r)}<span class="stamp">${r.answered_by?esc(initials(r.answered_by))+" · ":""}${esc((r.last_verified_at||r.answered_at||r.created_at||"").slice(0,10))}${r.last_verified_at?" · last verified":""}</span></div>
      <div class="qctrls">${ctrls}<button class="btn sm danger" data-del="${r.id}" style="margin-left:auto">Delete</button></div>
    </div>`;
  }).join("");

  ql.querySelectorAll("[data-ans]").forEach(inp=>inp.addEventListener("keydown", e=>{
    if(e.key==="Enter" && inp.value.trim()){ const src=ql.querySelector(`[data-src="${inp.dataset.ans}"]`); submitAnswer(inp.dataset.ans, inp.value.trim(), src?src.value.trim():""); }
  }));
  ql.querySelectorAll("[data-appr]").forEach(c=>c.onchange=()=>approve(c.dataset.appr));
  ql.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>{ EDITING=b.dataset.edit; renderList(); });
  ql.querySelectorAll("[data-cancel]").forEach(b=>b.onclick=()=>{ EDITING=null; renderList(); });
  ql.querySelectorAll("[data-save]").forEach(b=>b.onclick=()=>{ const id=b.dataset.save; const q=ql.querySelector(`[data-eq="${id}"]`).value.trim(); const a=ql.querySelector(`[data-ea="${id}"]`).value.trim(); editItem(id,q,a); });
  ql.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>{ const r=ROWS.find(x=>x.id===b.dataset.copy); if(r) navigator.clipboard.writeText(r.answer||"").then(()=>toast("Answer copied")).catch(()=>toast("Copy failed",true)); });
  ql.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ if(confirm("Delete this question?")) mutate({action:"delete", id:b.dataset.del}, null, "Deleted"); });
}
async function editItem(id,q,a){
  if(!q){ toast("Question can't be empty", true); return; }
  try { await apiPost({action:"edit", id, question:q, answer:a}); EDITING=null; await apiGet(); renderTabs(); renderList(); toast("Saved"); }
  catch(e){ toast("Save failed: "+e.message, true); }
}
async function submitAnswer(id, answer, source_link){
  try { await apiPost({ action:"answer", id, answer, source_link }); await apiGet(); TAB="pending"; renderTabs(); renderList(); toast("Answer saved — pending approval"); }
  catch(e){ toast("Save failed: "+e.message, true); }
}
async function approve(id){
  try {
    await apiPost({ action:"approve", id, lead_pin: LEAD_PIN });
    await apiGet(); TAB="approved"; renderTabs(); renderList(); toast("Approved");
  } catch(e){
    if(/PIN/i.test(e.message)){
      const pin = prompt("Team Lead PIN required to approve:");
      if(pin){ LEAD_PIN = pin; localStorage.setItem("faq_leadpin", pin); return approve(id); }
      renderList();
    } else { toast("Approve failed: "+e.message, true); renderList(); }
  }
}
async function mutate(body, gotoTab, okMsg){
  try { await apiPost(body); await apiGet(); if(gotoTab) TAB=gotoTab; renderTabs(); renderList(); toast(okMsg); }
  catch(e){ toast("Action failed: "+e.message, true); }
}

/* ---------- start ---------- */
route();
