/* Netlify-style handler -> Vercel serverless function.
 *
 * The function bodies still live in netlify/functions/ and still speak the
 * Netlify event/response shape. Rather than rewrite eight files by hand — and
 * risk changing behaviour while also changing hosts — this translates at the
 * boundary. There stays exactly one copy of each function's logic, so there is
 * nothing to keep in sync.
 *
 * Files in api/ that start with "_" are not routed as endpoints.
 */
module.exports = (handler) => async (req, res) => {
  // Vercel parses JSON bodies for us; the handlers expect the raw string.
  let raw = "";
  if (req.body !== undefined && req.body !== null) {
    raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  const event = {
    httpMethod: req.method,
    body: raw,
    queryStringParameters: req.query || {},
    headers: req.headers || {},
    rawUrl: req.url
  };
  try {
    const out = (await handler(event, {})) || {};
    // Plain Node response API on purpose: Vercel's res.status()/send() sugar is
    // not portable, and it made this adapter impossible to test outside Vercel.
    res.writeHead(out.statusCode || 200, out.headers || {});
    res.end(out.body === undefined || out.body === null ? "" : out.body);
  } catch (e) {
    const msg = "Function failed: " + (e && e.message ? e.message : String(e));
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(msg);
  }
};
