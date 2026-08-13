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
  if(!notes) return text(400, "Nothing to work with — type the facts first.");

  const mode = body.mode === "tighten" ? "tighten" : "cs";
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
