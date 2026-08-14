const adapt = require("./_adapt");
module.exports = adapt(require("../netlify/functions/clickup-backfill-background.js").handler);
