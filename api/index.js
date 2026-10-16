// Vercel serverless entrypoint: hands every request to the same app that
// `node server.js` runs. Storage must be Upstash (set the two env vars).
const app = require("../server.js");
module.exports = (req, res) => app(req, res);
