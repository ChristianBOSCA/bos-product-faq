/* Netlify Function: smart search.
 *
 * Given a question in the searcher's own words plus a shortlist of existing
 * Q&A (pre-filtered in the browser), pick the entries that actually answer it.
 *
 * Grounded by design: the model may ONLY return ids from the candidate list, so
 * it can never invent an answer. If nothing fits, it says so.
 *
 * One AI call per click (not per keystroke), on a cheap model.
 *
 * POST { query, candidates:[{id,q,a,product,status}] } -> { matches:[{id,why}] }
 */
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

function json(c,o){ return { statusCode:c, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(o) }; }
function text(c,m){ return { statusCode:c, headers:{ "Content-Type":"text/plain" }, body:m }; }

const SYSTEM = `You match a support rep's question to existing FAQ entries for Bells of Steel, a home-gym equipment company.

You are given a QUESTION and a numbered list of CANDIDATE entries. Choose the candidates that genuinely answer the question.

Rules:
- Return ONLY ids from the candidate list. Never write your own answer.
- Return at most 3, best first. Usually 1 is right.
- Only include a candidate if it really answers the question. A candidate about a different product or a different spec is NOT a match — it is better to return nothing than something misleading.
- Prefer entries whose status is "approved".
- "why" must be a short phrase (under 12 words) saying how it matches, e.g. "same spec, same product" or "answers it for the plate-loaded version".

Return ONLY a JSON object, no prose, no code fence:
{"matches":[{"id":"<candidate id>","why":"<short phrase>"}]}
If nothing matches, return {"matches":[]}`;

exports.handler = async (event) => {
  if(event.httpMethod !== "POST") return text(405, "POST only.");
  const key = process.env.ANTHROPIC_API_KEY;
  if(!key) return text(503, "AI not configured — add ANTHROPIC_API_KEY in Netlify.");

  let body = {};
  try { body = JSON.parse(event.body||"{}"); } catch(e){ return text(400, "Bad JSON."); }
  const query = String(body.query||"").trim();
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0,30) : [];
  if(!query) return text(400, "No question given.");
  if(!candidates.length) return json(200, { matches: [] });

  const valid = new Set(candidates.map(c=>String(c.id)));
  const list = candidates.map(c =>
    `id: ${c.id}\nstatus: ${c.status||"?"}\nproduct: ${(c.product||"").slice(0,80)}\nQ: ${String(c.q||"").slice(0,250)}\nA: ${String(c.a||"").slice(0,200)}`
  ).join("\n---\n");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "content-type":"application/json", "x-api-key":key, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 400, system: SYSTEM,
        messages: [{ role:"user", content: `QUESTION:\n${query}\n\nCANDIDATES:\n${list}` }]
      })
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
    const raw = (parsed && Array.isArray(parsed.matches)) ? parsed.matches : [];
    // hard guard: drop anything that isn't a real candidate id
    const matches = raw
      .filter(m => m && valid.has(String(m.id)))
      .slice(0,3)
      .map(m => ({ id:String(m.id), why:String(m.why||"").slice(0,80) }));
    return json(200, { matches, model: MODEL });
  } catch(e){
    return text(500, "Smart search failed: " + (e.message||String(e)));
  }
};
