/* Netlify Function: turn rough notes into a customer-ready CS answer.
 *
 * This is the ONLY part of the app that calls an AI at runtime, so it's the only
 * part that costs anything — and only when someone clicks Generate.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY   required
 *   ANTHROPIC_MODEL     optional (defaults to a fast, cheap model)
 *
 * POST { question, notes, product_title, skus, mode }  ->  { text }
 *   mode "cs"     : rewrite notes into a CS-ready answer (default)
 *   mode "tighten": tidy an existing answer without changing facts
 */
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOKENS = 700;

function json(c,o){ return { statusCode:c, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(o) }; }
function text(c,m){ return { statusCode:c, headers:{ "Content-Type":"text/plain" }, body:m }; }

const SYSTEM = `You write internal FAQ answers for Bells of Steel, a home-gym equipment company. Support reps paste these to customers.

Rules:
- Use ONLY the facts given. Never invent specs, dimensions, weights, prices, compatibility or policies. If a needed fact is missing, write the answer around what's known and add "[confirm: ...]" for the missing bit.
- Keep it short: 1-3 sentences, or a tight bullet list for multi-part specs. No greeting, no sign-off, no "Great question!".
- Plain, warm, confident, human. Contractions are fine. No hype, no emoji, no marketing fluff.
- Keep exact figures, units and SKUs exactly as provided (e.g. 113", 5/8", BSAW-BEN-SET).
- Answer the question directly in the first sentence.
- Output ONLY the answer text.`;

exports.handler = async (event) => {
  if(event.httpMethod !== "POST") return text(405, "POST only.");
  const key = process.env.ANTHROPIC_API_KEY;
  if(!key) return text(503, "AI not configured — add ANTHROPIC_API_KEY in Netlify.");

  let body = {};
  try { body = JSON.parse(event.body||"{}"); } catch(e){ return text(400, "Bad JSON."); }
  const notes = String(body.notes||"").trim();
  const question = String(body.question||"").trim();
  const mode = ["tighten","polish"].includes(body.mode) ? body.mode : "cs";
  // polish can run on a messy question alone (no answer yet); other modes need notes
  if(mode === "polish"){
    if(!notes && !question) return text(400, "Nothing to work with — add a question or some facts.");
  } else if(!notes){
    return text(400, "Nothing to work with — type the facts first.");
  }

  /* polish mode: clean up BOTH the question and the answer, returned as JSON */
  if(mode === "polish"){
    const sys = `You tidy up internal FAQ entries for Bells of Steel, a home-gym equipment company. Entries often come from a team chat, so questions are conversational and messy.

Rewrite the QUESTION as a clean, neutral FAQ question:
- Strip greetings, names, filler and chatter ("Hey team", "does anyone know", "Thanks!", "Not a question I've seen before").
- Strip "SKU: XXX" prefixes and "customer is asking" framing — keep the actual subject.
- Do NOT put SKU codes in the question. The SKU is recorded separately on the entry, so it is implicit. Name the product in plain words instead ("the Aluminum Handles with Bearings", not "(SHRT-ALN-HA)"). Report any SKU you found in the separate "sku" field instead.
- Exception: keep the SKU in the question only when the question is literally about the code itself (e.g. "what is the SKU for the new pulley kit?").
- Strip pasted URLs, tracking parameters and markdown link soup entirely, but keep any SKU, product name or figure they contained.
- If the entry quotes existing copy or a previous answer, don't repeat it — capture only what is being ASKED.
- Phrase it as the customer would ask it, in one sentence, ending in a question mark. If it genuinely asks two things, use one sentence with "and".
- Keep the specific product/part and any figures or SKUs mentioned in the question.
- If it's already clean, return it unchanged.

You may also be given PRODUCT PAGE REFERENCE — text from our own live product page. It is trustworthy.
- If the internal answer is incomplete or trails off, and the PRODUCT PAGE REFERENCE contains the missing fact, use it to complete the answer.
- Only use facts that literally appear in the reference. Do not infer, estimate or average.
- THE TEAM'S NOTES WIN. Never replace a figure, SKU, product name, dimension or spec that appears in the notes with a different value from the reference. The reference may only FILL a gap the notes leave open — it may never overrule, correct or substitute a fact the team already gave you.
- If the reference contradicts the notes, keep the notes exactly as given and append: [our page says <value from page> — confirm which is right]
- If the needed fact is NOT in the notes and NOT in the reference, do not guess. End the answer with exactly: [not in our knowledge base — confirm with the product team]

Rewrite the ANSWER as a customer-ready reply:
- If no answer was provided, return an empty string for "answer" — never invent one.
- Use ONLY the facts given (notes + product page reference). Never invent specs, dimensions, weights, prices, compatibility or policies. If a needed fact is missing, write around it and add "[confirm: ...]".
- 1-3 sentences, or a tight bullet list for multi-part specs. No greeting, no sign-off.
- Plain, warm, confident. Keep exact figures, units and SKUs verbatim.
- Answer the question directly in the first sentence.

Return ONLY a JSON object, no prose, no code fence:
{"question": "...", "answer": "...", "sku": "<any SKU code the original question referred to, comma-separated, or empty>"}`;
    let pdp = "";
    const handle = String(body.handle||"").trim();
    if(handle && handle !== "_general" && /^[a-z0-9-]+$/i.test(handle)){
      try {
        const store = process.env.SHOPIFY_STORE || "www.bellsofsteel.com";
        const pr = await fetch(`https://${store}/products/${encodeURIComponent(handle)}.json`);
        if(pr.ok){
          const p = (await pr.json()).product || {};
          const desc = String(p.body_html||"")
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi,"")
            .replace(/<li>/gi,"\n- ").replace(/<\/(p|div|tr|h\d)>/gi,"\n").replace(/<br\s*\/?>/gi,"\n")
            .replace(/<[^>]+>/g," ")
            .replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
            .replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();
          const vars = (p.variants||[]).map(v=>`${v.sku||"?"} — ${v.title||""}${v.weight?` — ${v.weight}${v.weight_unit||"lb"}`:""}`).join("\n");
          pdp = [`Product page: ${p.title||handle}`, vars ? `Variants:\n${vars}` : "", desc ? `Description:\n${desc.slice(0,3500)}` : ""].filter(Boolean).join("\n\n");
        }
      } catch(e){ }
    }

    const payload = [
      body.product_title ? `Product: ${body.product_title}` : "",
      body.skus ? `Applies to SKU(s): ${body.skus}` : "",
      `Original question:\n${question || "(none)"}`,
      `Original answer:\n${notes || "(none yet — leave \"answer\" empty)"}`,
      pdp ? `PRODUCT PAGE REFERENCE (our own published page — trustworthy):\n${pdp}` : ""
    ].filter(Boolean).join("\n\n");
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{ "content-type":"application/json", "x-api-key":key, "anthropic-version":"2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: sys, messages:[{ role:"user", content: payload }] })
      });
      if(!r.ok){
        if(r.status === 401) return text(401, "Anthropic rejected the API key.");
        if(r.status === 429) return text(429, "Rate limited — try again in a few seconds.");
        return text(502, "AI error: " + (await r.text()).slice(0,200));
      }
      const data = await r.json();
      let out = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
      out = out.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
      let parsed = null;
      try { parsed = JSON.parse(out); } catch(e){
        const m = out.match(/\{[\s\S]*\}/);
        if(m){ try { parsed = JSON.parse(m[0]); } catch(e2){} }
      }
      if(!parsed || typeof parsed.answer !== "string") return text(502, "AI returned an unexpected format — try again.");
      return json(200, { question: String(parsed.question||question||"").trim(), answer: String(parsed.answer).trim(),
                         sku: String(parsed.sku||"").trim(), model: MODEL });
    } catch(e){ return text(500, "AI request failed: " + (e.message||String(e))); }
  }
  const ctx = [
    question ? `Question: ${question}` : "",
    body.product_title ? `Product: ${body.product_title}` : "",
    body.skus ? `Applies to SKU(s): ${body.skus}` : "",
    mode === "tighten" ? `Existing answer to tidy up (keep every fact identical):\n${notes}`
                       : `Notes / facts from the team:\n${notes}`
  ].filter(Boolean).join("\n");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type":"application/json", "x-api-key":key, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM,
        messages: [{ role:"user", content: ctx }]
      })
    });
    if(!r.ok){
      const t = (await r.text()).slice(0,300);
      if(r.status === 401) return text(401, "Anthropic rejected the API key.");
      if(r.status === 429) return text(429, "Rate limited — try again in a few seconds.");
      return text(502, "AI error: " + t);
    }
    const data = await r.json();
    const out = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    if(!out) return text(502, "AI returned nothing — try rephrasing your notes.");
    return json(200, { text: out, model: MODEL });
  } catch(e){
    return text(500, "AI request failed: " + (e.message||String(e)));
  }
};
