/* Netlify Function: live product catalog from Shopify (read-only).
 *
 * Two modes, auto-selected:
 *   • No token  → reads the public storefront feed  /products.json  (no app,
 *     no credentials; returns products PUBLISHED to the online store).
 *   • With token → uses the Admin API (also returns unpublished/active products).
 *
 * Cached in memory for 10 minutes so most page loads are instant. If Shopify
 * isn't reachable, the app falls back to the bundled catalog.json.
 *
 * Env vars:
 *   SHOPIFY_STORE         your-store.myshopify.com  (or your primary domain)
 *   SHOPIFY_ADMIN_TOKEN   OPTIONAL — Admin API token with read_products.
 */
const API_VERSION = "2024-10";
const TTL_MS = 10 * 60 * 1000;
let CACHE = null;

function json(c, o){ return { statusCode:c, headers:{ "Content-Type":"application/json", "Cache-Control":"public, max-age=300" }, body: JSON.stringify(o) }; }
function text(c, m){ return { statusCode:c, headers:{ "Content-Type":"text/plain" }, body: m }; }

/* ---- public storefront feed: no token needed ---- */
async function fetchPublic(store){
  const products = [];
  for(let page = 1; page <= 40; page++){
    const res = await fetch(`https://${store}/products.json?limit=250&page=${page}`, { headers:{ "Accept":"application/json" } });
    if(!res.ok) throw new Error(`Storefront ${res.status} on ${store}`);
    const list = (await res.json()).products || [];
    if(!list.length) break;
    for(const p of list){
      const variants = (p.variants || []).map(v => ({ sku: v.sku || "", title: v.title || "" })).filter(v => v.sku);
      if(!variants.length) continue;
      products.push({ id: String(p.id), title: p.title, type: p.product_type || "", src: "Shopify (live)", variants });
    }
    if(list.length < 250) break;
  }
  return products;
}

/* ---- Admin API: needs a read_products token ---- */
const QUERY = `query($cursor: String) {
  products(first: 250, after: $cursor, query: "status:active") {
    edges { node { id title productType variants(first: 100) { edges { node { sku title } } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
async function fetchAdmin(store, token){
  const products = []; let cursor = null;
  for(let pages = 0; pages < 40; pages++){
    const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method:"POST", headers:{ "Content-Type":"application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: QUERY, variables: { cursor } })
    });
    if(!res.ok) throw new Error(`Admin ${res.status}: ${(await res.text()).slice(0,160)}`);
    const data = await res.json();
    if(data.errors) throw new Error("Admin GraphQL: " + JSON.stringify(data.errors).slice(0,160));
    const conn = data.data.products;
    for(const e of conn.edges){
      const n = e.node;
      const variants = n.variants.edges.map(v => ({ sku: v.node.sku || "", title: v.node.title || "" })).filter(v => v.sku);
      if(!variants.length) continue;
      products.push({ id: n.id.split("/").pop(), title: n.title, type: n.productType || "", src: "Shopify (live)", variants });
    }
    if(!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return products;
}

exports.handler = async () => {
  const store = process.env.SHOPIFY_STORE, token = process.env.SHOPIFY_ADMIN_TOKEN;
  if(!store) return text(503, "Shopify not configured");

  if(CACHE && (Date.now() - CACHE.at) < TTL_MS)
    return json(200, { products: CACHE.products, count: CACHE.products.length, cached: true });

  try {
    const products = token ? await fetchAdmin(store, token) : await fetchPublic(store);
    CACHE = { at: Date.now(), products };
    return json(200, { products, count: products.length, mode: token ? "admin" : "public", cached: false });
  } catch(e){
    if(CACHE) return json(200, { products: CACHE.products, count: CACHE.products.length, cached: true, stale: true });
    return text(502, "Catalog fetch failed: " + (e.message || String(e)));
  }
};
