// Minimal Upstash Redis REST emulation for CI: enough for the commands the
// server uses (HSET, HGETALL, EXPIRE). Data lives in a plain object.
const http = require("http");
const store = { hashes: {}, ttls: {} };

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let cmd, args;
    try { [cmd, ...args] = JSON.parse(body || "null"); } catch { res.writeHead(400); return res.end(); }
    if (!cmd) { res.writeHead(400); return res.end(); }
    let result = null;
    switch (cmd.toUpperCase()) {
      case "HSET": {
        const h = (store.hashes[args[0]] ||= {});
        for (let i = 1; i < args.length; i += 2) h[args[i]] = args[i + 1];
        result = 1;
        break;
      }
      case "HGETALL":
        result = store.hashes[args[0]] || null;
        break;
      case "EXPIRE":
        store.ttls[args[0]] = args[1];
        result = 1;
        break;
      default:
        res.writeHead(404);
        return res.end(JSON.stringify({ error: `unsupported ${cmd}` }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result }));
  });
}).listen(process.env.PORT || 6399, () => console.log("upstash stub up"));
