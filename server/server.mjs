// Local price server for the Albion Recipe Book: listens to the Albion Data Project's live Europe feed, keeps every
// order it sees, and serves the site plus the same /api/v2/stats URLs the site already calls. Only binds to this PC.
import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, StringCodec } from "nats";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, ".."), DATA = join(HERE, "data");
const PORT = 8740, API = "https://europe.albion-online-data.com/api/v2/stats/";
const NATS = { servers: "nats.albion-online-data.com:34222", user: "public", pass: "thenewalbiondata" }; // public, from albion-online-data.com/developer
const LOC = { 7: "Thetford", 1002: "Lymhurst", 2004: "Bridgewatch", 3008: "Martlock", 4002: "Fort Sterling", 3005: "Caerleon", 5003: "Brecilien", 3003: "Black Market" };
const CITIES = Object.values(LOC);
const HOUR = 36e5, ORDER_TTL = 24 * HOUR, RESWEEP = 6 * 6e4, HIST_TTL = 6 * HOUR, FILL_EVERY = 6 * HOUR;

await mkdir(DATA, { recursive: true });
const log = m => { const line = new Date().toISOString() + " " + m + "\n"; process.stdout.write(line); appendFile(join(DATA, "server.log"), line).catch(() => {}) };
const iso = t => new Date(t).toISOString().slice(0, 19);

// ---------- state ----------
// orders: Id -> [item, city, quality, price, amount, 0 offer / 1 request, expires ms, last seen ms]
const orders = new Map(), byKey = new Map();
const baseline = new Map();  // "city|item|quality" -> { s, sd, b, bd } from the price API
const fetched = new Map();   // item -> when the price API was last asked about it
const history = new Map();   // "city|item" -> { t, rows }
let messages = 0, feedUp = false, startedAt = Date.now();

const keyOf = o => o[1] + "|" + o[0] + "|" + o[2] + "|" + o[5];
function addOrder(id, o) {
  const old = orders.get(id);
  if (old) byKey.get(keyOf(old))?.delete(id);
  orders.set(id, o);
  const k = keyOf(o);
  let set = byKey.get(k);
  if (!set) byKey.set(k, set = new Set());
  set.add(id);
  return set;
}
function dropOrder(id) {
  const o = orders.get(id);
  if (!o) return;
  byKey.get(keyOf(o))?.delete(id);
  orders.delete(id);
}
function onOrder(m) {
  const city = LOC[m.LocationId];
  if (!city || !m.ItemTypeId) return;
  if (!m.Amount) return dropOrder(m.Id);
  const now = Date.now(), type = m.AuctionType === "request" ? 1 : 0;
  const set = addOrder(m.Id, [m.ItemTypeId, city, m.QualityLevel, m.UnitPriceSilver, m.Amount, type, new Date(m.Expires + "Z").getTime(), now]);
  // The feed never says an order is gone. But a player's market page lists the best prices first, so when a worse
  // order arrives, a better one last seen over 6 minutes ago (the feed repeats an order at most every 5) has sold.
  for (const id of set) {
    const x = orders.get(id);
    if (x && x[7] < now - RESWEEP && (type ? x[3] > m.UnitPriceSilver : x[3] < m.UnitPriceSilver)) dropOrder(id);
  }
}
function liveOrders(city, item, q, type) {
  const now = Date.now(), out = [];
  for (const id of byKey.get(city + "|" + item + "|" + q + "|" + type) || []) {
    const o = orders.get(id);
    if (o && o[6] > now && o[7] > now - ORDER_TTL) out.push(o);
  }
  return out;
}

// ---------- persistence ----------
async function saveJson(name, value) { const f = join(DATA, name); await writeFile(f + ".tmp", JSON.stringify(value)); await rename(f + ".tmp", f) }
function loadJson(name) { try { const f = join(DATA, name); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null } catch (e) { log("could not read " + name + ": " + e.message); return null } }
for (const [id, o] of loadJson("orders.json") || []) addOrder(id, o);
for (const [k, v] of loadJson("baseline.json") || []) baseline.set(k, v);
for (const [k, v] of loadJson("fetched.json") || []) fetched.set(k, v);
for (const [k, v] of loadJson("history.json") || []) history.set(k, v);
log(`loaded ${orders.size} orders, ${baseline.size} baseline prices, ${history.size} histories`);
async function saveAll() {
  try { await saveJson("orders.json", [...orders]); await saveJson("baseline.json", [...baseline]); await saveJson("fetched.json", [...fetched]); await saveJson("history.json", [...history]) }
  catch (e) { log("save failed: " + e.message) }
}
function prune() {
  const now = Date.now();
  for (const [id, o] of orders) if (o[6] < now || o[7] < now - 2 * ORDER_TTL) dropOrder(id);
  for (const [k, set] of byKey) if (!set.size) byKey.delete(k);
  for (const [k, v] of history) if (v.t < now - 4 * HIST_TTL) history.delete(k);
}
setInterval(() => { prune(); saveAll() }, 5 * 6e4);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await saveAll(); process.exit(0) });
process.on("uncaughtException", e => log("uncaught: " + e.stack));
process.on("unhandledRejection", e => log("unhandled: " + (e && e.stack || e)));

// ---------- the price API, one call at a time; requests from the page go ahead of the background fill ----------
const urgent = [], background = [];
let working = false;
function enqueue(queue, job) { return new Promise((res, rej) => { queue.push({ job, res, rej }); work() }) }
async function work() {
  if (working) return;
  working = true;
  for (let t; (t = urgent.shift() || background.shift());) {
    try { t.res(await t.job()) } catch (e) { t.rej(e) }
    await new Promise(r => setTimeout(r, urgent.length ? 350 : 700));
  }
  working = false;
}
async function getJson(url) {
  for (let tries = 0; ; tries++) {
    const res = await fetch(url);
    if (res.status === 429 && tries < 5) { log("rate limited, waiting 30s"); await new Promise(r => setTimeout(r, 30000)); continue }
    if (!res.ok) throw new Error(res.status + " from " + url.slice(0, 80));
    return res.json();
  }
}
function chunks(ids, max = 3000) {
  const out = [[]];
  let len = 0;
  for (const id of ids) {
    const l = encodeURIComponent(id).length + 1;
    if (len + l > max && out.at(-1).length) { out.push([]); len = 0 }
    out.at(-1).push(id); len += l;
  }
  return out;
}
async function loadBaseline(ids) {
  const rows = await getJson(API + "prices/" + ids.map(encodeURIComponent).join(",") + ".json?locations=" + CITIES.map(encodeURIComponent).join(","));
  const now = Date.now();
  for (const id of ids) fetched.set(id, now);
  for (const r of rows) baseline.set(r.city + "|" + r.item_id + "|" + r.quality, {
    s: r.sell_price_min || null, sd: r.sell_price_min ? r.sell_price_min_date : null, b: r.buy_price_max || null, bd: r.buy_price_max ? r.buy_price_max_date : null });
}
// Every craftable item and material, refilled slowly in the background.
async function fill() {
  const R = JSON.parse(await readFile(join(ROOT, "recipes.json"), "utf8")), ids = new Set();
  for (const [id, it] of Object.entries(R.items)) for (const [l, recs] of Object.entries(it.r)) {
    ids.add(l === "0" ? id : id + "@" + l);
    for (const r of recs) { r.m.forEach(m => ids.add(m[0])); if (r.u) ids.add(r.u[0]) }
  }
  const todo = [...ids].filter(id => (fetched.get(id) || 0) < Date.now() - FILL_EVERY), parts = chunks(todo);
  log(`background fill: ${todo.length} items in ${parts.length} requests`);
  for (const c of parts) enqueue(background, () => loadBaseline(c)).catch(e => log("fill: " + e.message));
}
setTimeout(fill, 3000);
setInterval(fill, FILL_EVERY);

// ---------- answers ----------
function bestOf(list, type) { let b = null; for (const o of list) if (!b || (type ? o[3] > b[3] : o[3] < b[3])) b = o; return b }
// The newest information wins: a live order, or the price API if it saw something more recent.
function priceRow(city, item, q) {
  const base = baseline.get(city + "|" + item + "|" + q) || {}, offer = bestOf(liveOrders(city, item, q, 0), 0), req = bestOf(liveOrders(city, item, q, 1), 1);
  let s = base.s || 0, sd = base.sd, b = base.b || 0, bd = base.bd;
  if (offer && (!sd || iso(offer[7]) >= sd)) { s = offer[3]; sd = iso(offer[7]) }
  if (req && (!bd || iso(req[7]) >= bd)) { b = req[3]; bd = iso(req[7]) }
  return { item_id: item, city, quality: q, sell_price_min: s, sell_price_min_date: sd || "0001-01-01T00:00:00", buy_price_max: b, buy_price_max_date: bd || "0001-01-01T00:00:00" };
}
async function prices(ids, locs, quals) {
  const missing = ids.filter(id => !fetched.has(id));
  await Promise.all(chunks(missing).filter(c => c.length).map(c => enqueue(urgent, () => loadBaseline(c)).catch(e => log("prices: " + e.message))));
  const out = [];
  for (const id of ids) for (const l of locs) for (const q of quals) out.push(priceRow(l, id, q));
  return out;
}
async function histories(ids, locs, scale) {
  const now = Date.now(), stale = ids.filter(id => locs.some(l => { const h = history.get(l + "|" + id); return !h || h.t < now - HIST_TTL }));
  await Promise.all(chunks(stale, 2000).filter(c => c.length).map(c => enqueue(urgent, async () => {
    const rows = await getJson(API + "history/" + c.map(encodeURIComponent).join(",") + ".json?locations=" + CITIES.map(encodeURIComponent).join(",") + "&time-scale=" + scale), got = {};
    for (const r of rows) (got[r.location + "|" + r.item_id] ??= []).push(r);
    for (const id of c) for (const l of CITIES) history.set(l + "|" + id, { t: Date.now(), rows: got[l + "|" + id] || [] });
  }).catch(e => log("history: " + e.message))));
  return ids.flatMap(id => locs.flatMap(l => history.get(l + "|" + id)?.rows || []));
}

const TYPES = { html: "text/html; charset=utf-8", json: "application/json" };
const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)) };
const list = v => (v || "").split(",").map(x => x.trim()).filter(Boolean);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"), path = decodeURIComponent(url.pathname);
    if (path === "/" || path === "/index.html") return send(res, 200, await readFile(join(ROOT, "index.html")), TYPES.html);
    if (path === "/recipes.json") return send(res, 200, await readFile(join(ROOT, "recipes.json")));
    let m;
    if ((m = /^\/api\/v2\/stats\/prices\/(.+)\.json$/.exec(path))) {
      const locs = list(url.searchParams.get("locations")), quals = list(url.searchParams.get("qualities")).map(Number);
      return send(res, 200, await prices(list(m[1]), locs.length ? locs : CITIES, quals.length ? quals : [1, 2, 3, 4, 5]));
    }
    if ((m = /^\/api\/v2\/stats\/history\/(.+)\.json$/.exec(path))) {
      const locs = list(url.searchParams.get("locations"));
      return send(res, 200, await histories(list(m[1]), locs.length ? locs : CITIES, url.searchParams.get("time-scale") || "24"));
    }
    if (path === "/local/orders") {
      // Every live order for one item, best price first: { p, a, seen }
      const type = url.searchParams.get("type") === "request" ? 1 : 0, l = liveOrders(url.searchParams.get("city"), url.searchParams.get("id"), +url.searchParams.get("q") || 1, type);
      l.sort((a, b) => type ? b[3] - a[3] : a[3] - b[3]);
      return send(res, 200, l.map(o => ({ p: o[3], a: o[4], seen: iso(o[7]) })));
    }
    if (path === "/local/status") return send(res, 200, { feedUp, messages, orders: orders.size, baseline: baseline.size, filling: background.length, startedAt });
    send(res, 404, { error: "not found" });
  } catch (e) { log("request failed: " + e.stack); send(res, 500, { error: e.message }) }
}).on("error", e => { log("server error: " + e.message); process.exit(1) }) // e.g. port in use: exit so the launcher retries
  .listen(PORT, "127.0.0.1", () => log("serving on http://localhost:" + PORT));

// ---------- the live feed ----------
const sc = StringCodec();
const nc = await connect({ ...NATS, maxReconnectAttempts: -1, reconnectTimeWait: 5000, waitOnFirstConnect: true });
feedUp = true;
log("connected to the live feed");
(async () => { for await (const s of nc.status()) { if (s.type === "disconnect") feedUp = false; if (s.type === "reconnect") feedUp = true; if (s.type !== "pingTimer") log("feed: " + s.type) } })();
for await (const msg of nc.subscribe("marketorders.deduped")) {
  try { messages++; const d = JSON.parse(sc.decode(msg.data)); for (const o of Array.isArray(d) ? d : [d]) onOrder(o) }
  catch (e) { log("bad message: " + e.message) }
}
