// Filament Locator: lists spools from Spoolman and lights their rack slot on a WLED strip.
// No dependencies; needs Node 18+ (built-in fetch).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = +process.env.PORT || 7920;
const SPOOLMAN_URL = (process.env.SPOOLMAN_URL || "http://localhost:7912").replace(/\/+$/, "");
const WLED_HOST = process.env.WLED_HOST || "wled.local";
const SLOTS_FILE = process.env.SLOTS_FILE || path.join(__dirname, "data", "filament-slots.json");
const AUTO_OFF_SECONDS = +(process.env.AUTO_OFF_SECONDS ?? 120);
const BRIGHTNESS = +process.env.BRIGHTNESS || 150;
// "filament" lights the slot in the spool's own color; or set a fixed hex like FFFFFF
const LIGHT_COLOR = (process.env.LIGHT_COLOR || "filament").replace("#", "");

const INDEX_HTML = path.join(__dirname, "public", "index.html");
const MAPPER_HTML = path.join(__dirname, "public", "mapper.html");

// ---- Slot map (re-read on each use so a new export takes effect without a restart) ----
function loadSlots() {
  const data = JSON.parse(fs.readFileSync(SLOTS_FILE, "utf8"));
  return {
    totalLeds: data.totalLeds,
    slots: data.slots.map(s => ({
      location: s.location, rack: s.rack, shelf: s.shelf, position: s.position, start: s.start, end: s.end
    }))
  };
}

// Saves a slot map from the mapper. The previous map is kept as filament-slots.previous.json.
function saveSlots(data) {
  const ok = data && data.version === 2 && Array.isArray(data.slots) && data.slots.length > 0 &&
    Number.isInteger(data.totalLeds) && data.slots.every(s =>
      typeof s.location === "string" && Number.isInteger(s.start) && Number.isInteger(s.end) &&
      s.start >= 0 && s.end >= s.start && s.end < data.totalLeds);
  if (!ok) throw new Error("That isn't a valid slot map");

  const dir = path.dirname(SLOTS_FILE);
  if (fs.existsSync(SLOTS_FILE)) fs.copyFileSync(SLOTS_FILE, path.join(dir, "filament-slots.previous.json"));
  const tmp = SLOTS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, SLOTS_FILE);
  // Inside Docker this runs as root; give the files to the data folder's owner so they stay editable.
  try {
    const { uid, gid } = fs.statSync(dir);
    for (const f of [SLOTS_FILE, path.join(dir, "filament-slots.previous.json")]) {
      if (fs.existsSync(f)) fs.chownSync(f, uid, gid);
    }
  } catch {}
}

// ---- WLED ----
let offTimer = null;

async function wled(body) {
  const r = await fetch(`http://${WLED_HOST}/json/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000)
  });
  if (!r.ok) throw new Error(`WLED returned HTTP ${r.status}`);
}

// Makes a filament color bright enough to see on an LED; very dark filament lights white.
function ledColor(hex) {
  if (LIGHT_COLOR !== "filament") return LIGHT_COLOR.toUpperCase();
  const m = /^#?([0-9a-f]{6})/i.exec(hex || "");
  if (!m) return "FFFFFF";
  const rgb = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  const max = Math.max(...rgb);
  if (max < 40) return "FFFFFF";
  return rgb.map(v => Math.round(v * 255 / max).toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function lightLocations(items) {
  const { totalLeds, slots } = loadSlots();
  const byLoc = new Map(slots.map(s => [s.location, s]));
  const i = [0, totalLeds, "000000"];
  const lit = [];
  for (const item of items) {
    const s = byLoc.get(item.location);
    if (!s) continue;
    i.push(s.start, s.end + 1, ledColor(item.color));
    lit.push(s.location);
  }
  if (!lit.length) throw new Error("None of those locations are on the slot map");
  await wled({ on: true, bri: BRIGHTNESS, seg: { id: 0, fx: 0, i } });
  clearTimeout(offTimer);
  if (AUTO_OFF_SECONDS > 0) offTimer = setTimeout(() => lightsOff().catch(() => {}), AUTO_OFF_SECONDS * 1000);
  return lit;
}

async function lightsOff() {
  clearTimeout(offTimer);
  await wled({ on: false });
}

// ---- Spoolman ----
async function spoolman(pathname, options = {}) {
  const r = await fetch(SPOOLMAN_URL + pathname, {
    ...options,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(6000)
  });
  if (!r.ok) throw new Error(`Spoolman returned HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getSpools() {
  const raw = await spoolman("/api/v1/spool");
  return raw.map(s => ({
    id: s.id,
    name: s.filament?.name || "",
    vendor: s.filament?.vendor?.name || "",
    material: s.filament?.material || "",
    color: s.filament?.color_hex || "",
    multiColors: s.filament?.multi_color_hexes || "",
    remaining: s.remaining_weight != null ? Math.round(s.remaining_weight) : null,
    location: s.location || "",
    comment: s.comment || ""
  }));
}

async function setSpoolLocation(id, location, clearOther) {
  location = (location || "").trim();
  if (location && clearOther) {
    const others = (await getSpools()).filter(s => s.location === location && s.id !== id);
    for (const o of others) {
      await spoolman(`/api/v1/spool/${o.id}`, { method: "PATCH", body: JSON.stringify({ location: null }) });
    }
  }
  await spoolman(`/api/v1/spool/${id}`, { method: "PATCH", body: JSON.stringify({ location: location || null }) });
}

// ---- HTTP server ----
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function check(fn) {
  try { await fn(); return true; } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/mapper")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(url.pathname === "/" ? INDEX_HTML : MAPPER_HTML).pipe(res);
    }

    // ---- Slot mapper support: the stored slot map, and a pass-through to WLED's JSON API ----
    if (req.method === "GET" && url.pathname === "/api/slots") {
      if (!fs.existsSync(SLOTS_FILE)) return send(res, 404, { error: "No slot map yet" });
      res.writeHead(200, { "Content-Type": "application/json" });
      return fs.createReadStream(SLOTS_FILE).pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/slots") {
      saveSlots(await readBody(req));
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/wled/info") {
      const r = await fetch(`http://${WLED_HOST}/json/info`, { signal: AbortSignal.timeout(4000) });
      return send(res, r.status, await r.json());
    }
    if (req.method === "POST" && url.pathname === "/api/wled/state") {
      clearTimeout(offTimer);  // don't let a locate's auto-off blank the strip mid-mapping
      await wled(await readBody(req));
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/data") {
      const [spools, slotMap] = [await getSpools(), loadSlots()];
      return send(res, 200, { spools, slots: slotMap.slots, autoOffSeconds: AUTO_OFF_SECONDS });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const [spoolmanOk, wledOk] = await Promise.all([
        check(() => spoolman("/api/v1/info")),
        check(async () => {
          const r = await fetch(`http://${WLED_HOST}/json/info`, { signal: AbortSignal.timeout(3000) });
          if (!r.ok) throw new Error();
        })
      ]);
      return send(res, 200, { spoolman: spoolmanOk, wled: wledOk });
    }
    if (req.method === "POST" && url.pathname === "/api/locate") {
      const { items } = await readBody(req);
      const lit = await lightLocations(items || []);
      return send(res, 200, { lit, autoOffSeconds: AUTO_OFF_SECONDS });
    }
    if (req.method === "POST" && url.pathname === "/api/off") {
      await lightsOff();
      return send(res, 200, { ok: true });
    }
    const m = /^\/api\/spools\/(\d+)\/location$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const { location, clearOther } = await readBody(req);
      await setSpoolLocation(+m[1], location, clearOther);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Filament Locator on port ${PORT}`);
  console.log(`  Spoolman: ${SPOOLMAN_URL}`);
  console.log(`  WLED:     ${WLED_HOST}`);
  console.log(`  Slots:    ${SLOTS_FILE}`);
});
