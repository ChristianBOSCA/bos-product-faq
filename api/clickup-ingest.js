const adapt = require("./_adapt");
module.exports = adapt(require("../netlify/functions/clickup-ingest.js").handler);
