// Zero-dependency party server: serves the invite, collects RSVPs, relays live locations.
// Run directly: node server.js  (set PORT=8080 to override, default 3000)
// Serverless: set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (and optionally
// PARTY_CONFIG, a JSON string, since serverless filesystems are read-only).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "rsvp.json");

// party config: env JSON wins (serverless), else config.json, seeded from the
// example on first run so a fresh clone or one-click deploy boots.
const CONFIG_PATH = process.env.CONFIG_FILE || path.join(__dirname, "config.json");
let cfg;
try {
  cfg = process.env.PARTY_CONFIG ? JSON.parse(process.env.PARTY_CONFIG) : null;
} catch { throw new Error("PARTY_CONFIG is not valid JSON"); }
if (!cfg) {
  if (!fs.existsSync(CONFIG_PATH))
    fs.copyFileSync(path.join(__dirname, "config.example.json"), CONFIG_PATH);
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
const PARTY_MS = Date.parse(cfg.datetime);
if (isNaN(PARTY_MS)) throw new Error("party config: datetime is unparseable");

// the invite page, templated once at boot
const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8")
  .replaceAll("/*__PARTY__*/", `window.PARTY = ${JSON.stringify(cfg)};`)
  .replaceAll("__TITLE__", cfg.title)
  .replaceAll("__TAGLINE__", cfg.tagline)
  .replaceAll("__DATE_ROW__", cfg.dateRow)
  .replaceAll("__TIME_ROW__", cfg.timeRow)
  .replaceAll("__ADDRESS__", cfg.address)
  .replaceAll("__COSTUME__", cfg.costumeRow)
  .replaceAll("__OG_DESC__", cfg.ogDescription)
  .replaceAll("__OG_URL__", cfg.url)
  .replaceAll("__OG_IMAGE__", cfg.url.replace(/\/$/, "") + "/og.png");

// Storage: SQLite on a disk (default), or Upstash Redis over REST when the env
// vars are set (serverless: no disk, instances don't share memory). Both stay
// zero npm dependencies.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const upstash = UPSTASH_URL && UPSTASH_TOKEN ? async (cmd) => {
  const r = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`upstash ${r.status}`);
  return (await r.json()).result;
} : null;

let saveGuest, loadGuests, savePing, loadPings;
if (upstash) {
  saveGuest = (n, s) => upstash(["HSET", "party:guests", n, JSON.stringify({ status: s, ts: Date.now() })]);
  loadGuests = async () => {
    const h = (await upstash(["HGETALL", "party:guests"])) || {};
    return Object.entries(h)
      .map(([name, v]) => { const j = JSON.parse(v); return { name, status: j.status, rsvped_at: new Date(j.ts).toISOString() }; })
      .sort((a, b) => (a.rsvped_at < b.rsvped_at ? -1 : 1));
  };
  // race pings live in the shared store with a 12h TTL so every serverless
  // instance sees them; they expire on their own after the party night
  savePing = async (n, lat, lng) => {
    await upstash(["HSET", "race:pings", n, JSON.stringify({ lat, lng, ts: Date.now() })]);
    await upstash(["EXPIRE", "race:pings", 43200]);
  };
  loadPings = async () => {
    const h = (await upstash(["HGETALL", "race:pings"])) || {};
    return Object.fromEntries(Object.entries(h).map(([n, v]) => [n, JSON.parse(v)]));
  };
} else {
  const { DatabaseSync } = require("node:sqlite");
  const DB_PATH = process.env.DB_PATH || STATE_FILE.replace(/\.json$/, "") + ".db";
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS guests (
    name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    rsvped_at TEXT NOT NULL)`);
  // one-time import from the old flat-file format, if one is present
  try {
    const legacy = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).guests || [];
    const ins = db.prepare("INSERT OR REPLACE INTO guests (name, status, rsvped_at) VALUES (?, ?, ?)");
    for (const g of legacy) ins.run(String(g.name).slice(0, 40), g.status, new Date().toISOString());
    if (legacy.length) fs.renameSync(STATE_FILE, STATE_FILE + ".migrated");
    console.log(`migrated ${legacy.length} legacy RSVP(s) into ${DB_PATH}`);
  } catch {}
  const stmt = db.prepare(
    "INSERT INTO guests (name, status, rsvped_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(name) DO UPDATE SET status = excluded.status");
  saveGuest = (n, s) => stmt.run(n, s, new Date().toISOString());
  loadGuests = () => db.prepare("SELECT name, status, rsvped_at FROM guests ORDER BY rsvped_at").all();
  // without a shared store, pings stay process-local and memory-only
  savePing = async (n, lat, lng) => { state.pings[n] = { lat, lng, ts: Date.now() }; };
  loadPings = async () => state.pings;
}

const state = { guests: [], pings: {} };
const sseClients = new Set();

// Race window: ±12h around party time from the party config
const RACE_OPEN = PARTY_MS - 12 * 3600e3;
const RACE_CLOSE = PARTY_MS + 12 * 3600e3;
// RACE_FORCE=1 is for local testing only; never set on the production service
const RACE_FORCE = process.env.RACE_FORCE === "1";
const raceOpen = () => RACE_FORCE || (Date.now() >= RACE_OPEN && Date.now() < RACE_CLOSE);

let ready;
const init = () => (ready ||= Promise.resolve(loadGuests()).then((g) => { state.guests = g; }));

function broadcast() {
  const data = JSON.stringify(state);
  for (const res of sseClients) res.write(`data: ${data}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
}

const sanitize = (s) => String(s || "").trim().slice(0, 40).replace(/[<>&"]/g, "");

async function app(req, res) {
  await init();
  if (req.url === "/api/state") {
    state.pings = await loadPings();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(state));
  }
  if (req.url === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(":keepalive\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (req.method === "POST" && req.url === "/api/rsvp") {
    try {
      const { name, status } = await readBody(req);
      const n = sanitize(name);
      if (!n || !["yes", "no"].includes(status)) { res.writeHead(400); return res.end(); }
      await saveGuest(n, status);
      state.guests = await loadGuests();
      broadcast();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    } catch { res.writeHead(400); return res.end(); }
  }
  if (req.method === "POST" && req.url === "/api/ping") {
    if (!raceOpen()) { res.writeHead(403); return res.end("race closed"); }
    try {
      const { name, lat, lng } = await readBody(req);
      const n = sanitize(name);
      if (!n || typeof lat !== "number" || typeof lng !== "number") { res.writeHead(400); return res.end(); }
      await savePing(n, lat, lng);
      state.pings = await loadPings();
      broadcast();
      res.writeHead(200); return res.end();
    } catch { res.writeHead(400); return res.end(); }
  }
  // static: only the invite page, favicon and share card, nothing else exposed
  const STATIC = { "/": "index.html", "/index.html": "index.html", "/favicon.svg": "favicon.svg", "/og.png": "og.png" };
  const MIME = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
  let file = STATIC[req.url.split("?")[0]];
  if (!file) { res.writeHead(404); return res.end(); }
  // no custom share card built yet (og.png is a local artifact): use the preview
  if (file === "og.png" && !fs.existsSync(path.join(__dirname, file))) file = "preview.png";
  const fp = path.join(__dirname, file);
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] });
    res.end(file.endsWith(".html") ? page : buf);
  });
}

if (require.main === module) {
  init().then(() => http.createServer(app).listen(PORT, () => console.log(`🕯️  The lair is open: http://localhost:${PORT}`)));
}
module.exports = app;
