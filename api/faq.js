const adapt = require("./_adapt");
module.exports = adapt(require("../netlify/functions/faq.js").handler);
