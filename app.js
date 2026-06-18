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

/* ---------- boot ---------- */
async function boot(){
  // Prefer the live Shopify catalog; fall back to the bundled snapshot.
  try {
    const res = await fetch("/.netlify/functions/catalog");
    if(res.ok){
      const data = await res.json();
      if(data.products && data.products.length){ CATALOG = data.products; return; }
    }
  } catch(e){ /* fall through to snapshot */ }
  try { const res = await fetch("catalog.json"); CATALOG = (await res.json()).products || []; toast("Using offline catalog snapshot"); }
  catch(e){ toast("Could not load catalog", true); }
}

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
  const hay=tok(p.title+" "+p.type+" "+p.variants.map(v=>v.sku+" "+v.title).join(" "));
  let total=0,matched=0;
  for(const q of qt){let best=0;for(const h of hay){const s=sim(q,h);if(s>best)best=s;}if(best>=.6){matched++;total+=best;}}
  if(!matched) return 0;
  const bonus = norm(p.title).includes(norm(query))?1.2:0;
  const skuhit = p.variants.some(v=>norm(query).length>=2 && norm(v.sku).includes(norm(query)))?0.8:0;
  return total/qt.length + bonus + skuhit;
}
const qInput = document.getElementById("q");
const suggBox = document.getElementById("sugg");
qInput.addEventListener("input", () => {
  const t = qInput.value.trim();
  if(!t){ suggBox.classList.add("hidden"); return; }
  const hits = CATALOG.map(p=>[p,score(p,t)]).filter(x=>x[1]>=.45).sort((a,b)=>b[1]-a[1]).slice(0,6);
  if(!hits.length){ suggBox.innerHTML='<div class="row"><span class="meta">No close match — try fewer letters</span></div>'; suggBox.classList.remove("hidden"); return; }
  suggBox.innerHTML = hits.map(([p])=>`<div class="row" data-id="${p.id}"><span class="ttl">${esc(p.title)}</span><span class="meta">${p.variants.length} SKUs · ${esc(p.type)}</span></div>`).join("");
  suggBox.classList.remove("hidden");
  suggBox.querySelectorAll(".row[data-id]").forEach(r=>r.onclick=()=>{ openProduct(r.dataset.id); suggBox.classList.add("hidden"); qInput.value=""; });
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
  CURRENT = CATALOG.find(p=>p.id===id); TAB = "unanswered";
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
function counts(){ const l=rowsForProduct(); return { unanswered:l.filter(r=>r.status==="unanswered").length, pending:l.filter(r=>r.status==="pending").length, approved:l.filter(r=>r.status==="approved").length }; }

function renderProductShell(){
  const p = CURRENT;
  document.getElementById("panel").innerHTML = `
    <div class="card">
      <div class="prodhead"><span class="name">${esc(p.title)}</span><span class="type">${esc(p.type)}</span><span class="src">${esc(p.src)}</span></div>
      <div class="varlabel">Variants / SKUs</div>
      ${p.variants.map(v=>`<div class="variant"><span class="sku">${esc(v.sku)}</span><span>${esc(v.title)}</span>${v.weight_lb?`<span class="wt">${v.weight_lb} lb</span>`:""}${/attach|band|strap|\+/i.test(v.title)?'<span class="attflag">attachment</span>':''}</div>`).join("")}
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
    await apiPost({ action:"add", product_id:CURRENT.id, product_title:CURRENT.title, variant_sku:_routeVsku||"", question:v });
    document.getElementById("newq").value=""; document.getElementById("addbox").classList.add("hidden"); _routeVsku=undefined;
    await apiGet(); TAB="unanswered"; renderTabs(); renderList(); toast("Question logged");
  } catch(e){ toast("Save failed: "+e.message, true); } finally { btn.disabled=false; }
}

/* ---------- question list ---------- */
function skuChip(s){ return s ? `<span class="sku">${esc(s)}</span>` : `<span class="stamp" style="margin-left:0">whole product</span>`; }
function renderList(){
  const list = rowsForProduct().filter(r=>r.status===TAB);
  const ql = document.getElementById("qlist");
  if(!list.length){ ql.innerHTML = `<div class="spin">Nothing in ${TAB==="pending"?"pending approval":TAB}.</div>`; return; }
  ql.innerHTML = list.map(r=>{
    let ans;
    if(r.status==="unanswered"){
      ans = `<div class="ansrow"><input data-ans="${r.id}" placeholder="Know this? Answer it…" />
        <div class="srcrow"><input data-src="${r.id}" placeholder="Source link (ClickUp, Drive…) — optional" /></div></div>`;
    } else {
      ans = `<div class="ans">${esc(r.answer)}</div>${r.source_link?`<div style="margin-top:4px"><a class="link" href="${esc(r.source_link)}" target="_blank" rel="noopener">source ↗</a></div>`:""}`;
    }
    let ctrls = "";
    if(r.status==="pending") ctrls = `<label class="check"><input type="checkbox" data-appr="${r.id}"> Approve</label>`;
    if(r.status==="approved") ctrls = `<button class="btn sm" data-edit="${r.id}">Edit (re-approval)</button>`;
    return `<div class="qitem ${r.status==='pending'?'pending':''}">
      <div class="qtop"><span class="qtext">${esc(r.question)}</span>${skuChip(r.variant_sku)}</div>
      ${ans}
      <div class="qmeta"><span class="stamp">${r.answered_by?esc(initials(r.answered_by))+" · ":""}${esc((r.last_verified_at||r.answered_at||r.created_at||"").slice(0,10))}${r.last_verified_at?" · last verified":""}</span></div>
      <div class="qctrls">${ctrls}<button class="btn sm danger" data-del="${r.id}" style="margin-left:auto">Delete</button></div>
    </div>`;
  }).join("");

  ql.querySelectorAll("[data-ans]").forEach(inp=>inp.addEventListener("keydown", e=>{
    if(e.key==="Enter" && inp.value.trim()){ const src=ql.querySelector(`[data-src="${inp.dataset.ans}"]`); submitAnswer(inp.dataset.ans, inp.value.trim(), src?src.value.trim():""); }
  }));
  ql.querySelectorAll("[data-appr]").forEach(c=>c.onchange=()=>approve(c.dataset.appr));
  ql.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>mutate({action:"unapprove", id:b.dataset.edit}, "pending", "Moved back to pending"));
  ql.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ if(confirm("Delete this question?")) mutate({action:"delete", id:b.dataset.del}, null, "Deleted"); });
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
