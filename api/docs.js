const adapt = require("./_adapt");
module.exports = adapt(require("../netlify/functions/docs.js").handler);
