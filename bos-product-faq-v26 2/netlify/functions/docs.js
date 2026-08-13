/* Netlify Function: product docs (manuals, box-contents) for one product.
 *
 * Fetches the live product page and extracts the PDF links shown in the
 * "Shipping Details" / "Manuals and Assembly" sections, plus any dimension
 * string embedded in a link label. Cached per handle for a day.
 *
 * Call: /.netlify/functions/docs?handle=buzz-saw-bench
 * Env: SHOPIFY_STORE (defaults to www.bellsofsteel.com)
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE = new Map();

function json(c, o){ return { statusCode:c, headers:{ "Content-Type":"application/json", "Cache-Control":"public, max-age=3600" }, body: JSON.stringify(o) }; }

function decode(s){
  return s.replace(/&quot;/g,'"').replace(/&#34;/g,'"').replace(/&#8243;/g,'"').replace(/″/g,'"')
          .replace(/&amp;/g,"&").replace(/&#124;/g,"|").replace(/&nbsp;/g," ")
          .replace(/&#39;/g,"'").replace(/&apos;/g,"'");
}
function stripTags(s){ return decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(); }

function parse(html){
  const manuals = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]+\.pdf[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m = re.exec(html)) && manuals.length < 10){
    let url = m[1].replace(/&amp;/g, "&");
    if(!/\/cdn\/shop\/files\//i.test(url)) continue;   // only product docs, skip policy PDFs
    if(seen.has(url)) continue; seen.add(url);
    let label = stripTags(m[2]) || "Document";
    manuals.push({ label, url });
  }
  // Best-effort: a dimension like  80.75" | 205cm  from any label
  let dims = "";
  for(const d of manuals){
    const dm = d.label.match(/(\d+(?:\.\d+)?\s*"\s*\|\s*\d+\s*cm|\d+(?:\.\d+)?\s*"\s*[xX×]\s*\d+(?:\.\d+)?\s*"(?:\s*[xX×]\s*\d+(?:\.\d+)?\s*")?)/);
    if(dm){ dims = dm[1].replace(/\s+/g, " ").trim(); break; }
  }
  return { manuals, dims };
}

exports.handler = async (event) => {
  const handle = (event.queryStringParameters && event.queryStringParameters.handle || "").trim();
  if(!handle) return json(400, { error: "handle required" });
  const store = process.env.SHOPIFY_STORE || "www.bellsofsteel.com";

  const hit = CACHE.get(handle);
  if(hit && (Date.now() - hit.at) < TTL_MS) return json(200, { ...hit.data, cached: true });

  try {
    const res = await fetch(`https://${store}/products/${encodeURIComponent(handle)}`, { headers: { "User-Agent": "Mozilla/5.0 (BoS-FAQ docs)" } });
    if(!res.ok) return json(200, { manuals: [], dims: "", note: `page ${res.status}` });
    const data = parse(await res.text());
    CACHE.set(handle, { at: Date.now(), data });
    return json(200, data);
  } catch(e){
    return json(200, { manuals: [], dims: "", note: String(e.message || e) });
  }
};
