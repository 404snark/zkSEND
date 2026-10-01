// zkSEND server: serves one static page, keeps nothing, and throttles abuse.
// Zero dependencies. No request is ever logged. Client IPs are only held in
// memory as HMACs under a random key that is replaced every hour.
"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" && Number.isFinite(+process.env[k]) ? +process.env[k] : d);
const str = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);

const CFG = {
  port: num("PORT", 8080),
  powMode: str("POW_MODE", "auto").toLowerCase(),    // off | auto | always
  powBits: num("POW_BITS", 18),
  powBitsUnderAttack: num("POW_BITS_UNDER_ATTACK", 20),
  ratePerSec: num("RATE_PER_SEC", 0.5),             // sustained page loads per visitor
  rateBurst: num("RATE_BURST", 20),                 // loads before the puzzle appears
  hardMultiplier: num("RATE_HARD_MULTIPLIER", 3),   // beyond burst * this: 429
  hopMultiplier: num("RATE_HOP_MULTIPLIER", 10),    // looser limit for the last proxy hop
  globalRps: num("GLOBAL_SOFT_RPS", 40),            // site-wide load that turns on "busy" mode
  underAttackSec: num("UNDER_ATTACK_SECONDS", 300),
  passTtlSec: num("PASS_TTL_SECONDS", 3600),
  ipSource: str("CLIENT_IP_SOURCE", "xff").toLowerCase(), // xff | x-real-ip | socket
  cookieSecure: str("COOKIE_SECURE", "true") !== "false",
  hsts: str("HSTS", "true") !== "false",
  maxKeys: num("RATE_MAX_TRACKED", 100000),
  // Payment tracking asks Blockchair from the visitor's browser. "off" removes the button and blocks the request.
  statusCheck: str("STATUS_CHECK", "on").toLowerCase(),
  // Absolute address used in link-preview tags (X, Discord, Telegram need full URLs).
  siteUrl: str("SITE_URL", "https://zksend.net").replace(/\/+$/, ""),
};
if (!["on", "off"].includes(CFG.statusCheck)) throw new Error("STATUS_CHECK must be on or off");
if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(CFG.siteUrl)) throw new Error("SITE_URL must look like https://zksend.net");
if (!["off", "auto", "always"].includes(CFG.powMode)) throw new Error("POW_MODE must be off, auto or always");
if (!["xff", "x-real-ip", "socket"].includes(CFG.ipSource)) throw new Error("CLIENT_IP_SOURCE must be xff, x-real-ip or socket");
if (!(CFG.powBits >= 8 && CFG.powBits <= 28 && CFG.powBitsUnderAttack >= CFG.powBits && CFG.powBitsUnderAttack <= 28))
  throw new Error("POW_BITS must be 8-28 and POW_BITS_UNDER_ATTACK must be >= POW_BITS and <= 28");
if (!(CFG.rateBurst >= 1 && CFG.ratePerSec > 0 && CFG.hardMultiplier >= 1 && CFG.hopMultiplier >= 1))
  throw new Error("rate limit settings must be positive");

// Set POW_SECRET (any long random string) only if you run more than one replica,
// so a puzzle issued by one replica verifies on another.
const POW_SECRET = process.env.POW_SECRET ? Buffer.from(process.env.POW_SECRET) : crypto.randomBytes(32);

// ---------- static assets ----------
const DIST = path.join(__dirname, "dist");
const CSP = JSON.parse(fs.readFileSync(path.join(DIST, "csp.json"), "utf8"));
function asset(file, transform = (x) => x) {
  const raw = Buffer.from(transform(fs.readFileSync(path.join(DIST, file), "utf8")), "utf8");
  return {
    raw,
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
    gz: zlib.gzipSync(raw, { level: 9 }),
    etag: '"' + crypto.createHash("sha256").update(raw).digest("base64url").slice(0, 16) + '"',
  };
}
const STATUS_ORIGIN = "https://api.blockchair.com";
const APP = asset("index.html", (html) => {
  const tag = '<meta name="zksend-status" content="on">';
  if (!html.includes(tag)) throw new Error("dist/index.html is out of date; run node build.js");
  html = html.split("__SITE_URL__").join(CFG.siteUrl);
  return CFG.statusCheck === "on" ? html : html.replace(tag, '<meta name="zksend-status" content="off">');
});
// Link-preview image. Payment details live after the #, which no bot ever receives,
// so previews only ever show this generic card.
const OG_IMAGE = fs.readFileSync(path.join(__dirname, "img", "og.png"));
// Only link-preview bots may read pages (to build the card). Everyone else, including search engines, stays out.
const PREVIEW_BOTS = ["Twitterbot", "facebookexternalhit", "Discordbot", "TelegramBot", "Slackbot", "Slackbot-LinkExpanding", "LinkedInBot", "WhatsApp"];
const ROBOTS = PREVIEW_BOTS.map((b) => `User-agent: ${b}\nAllow: /\n`).join("\n") + "\nUser-agent: *\nDisallow: /\n";
const CHALLENGE_TEMPLATE = fs.readFileSync(path.join(DIST, "challenge.html"), "utf8");

// The app's own pages. They all serve the same file; the page picks what to show from the path.
const APP_PATHS = new Set(["/", "/index.html", ...["/guide", "/faq", "/security", "/terms"].flatMap((p) => [p, p + "/"])]);
const APP_CSP = `default-src 'none'; script-src ${CSP.app.script}; style-src ${CSP.app.style}; img-src data:; font-src data:; connect-src ${CFG.statusCheck === "on" ? STATUS_ORIGIN : "'none'"}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const POW_CSP = `default-src 'none'; script-src ${CSP.challenge.script}; style-src ${CSP.challenge.style}; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function baseHeaders(res) {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()");
  if (CFG.hsts) res.setHeader("Strict-Transport-Security", "max-age=63072000");
}

// ---------- client identification (memory only) ----------
// Railway's edge appends the connecting IP to X-Forwarded-For, and during its CDN
// rollout the last hop can be a shared CDN node. So we track two things:
//   visitor = first entry (what the client or its proxy reported)
//   hop     = last entry  (added by Railway's edge; can't be spoofed, may be shared)
// Spoofing the first entry only gets a fresh visitor bucket, and the hop bucket
// still caps it. A shared hop gets a 10x looser limit so real users aren't lumped together.
function normIp(raw) {
  let ip = String(raw || "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (/^[\d.]+:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, ""); // "1.2.3.4:5678"
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) return ip;
  if (net.isIPv6(ip)) {
    // Expand "::" and group by /64, so rotating addresses inside one network doesn't dodge limits.
    const [head, tail = ""] = ip.toLowerCase().split("::");
    const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
    const full = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
    return full.slice(0, 4).map((x) => parseInt(x, 16).toString(16)).join(":") + "::/64";
  }
  return "";
}
function clientIps(req) {
  const sock = normIp(req.socket.remoteAddress) || "unknown";
  if (CFG.ipSource === "socket") return { visitor: sock, hop: sock };
  if (CFG.ipSource === "x-real-ip") {
    const v = normIp(req.headers["x-real-ip"]) || sock;
    return { visitor: v, hop: v };
  }
  const xff = typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : "";
  const parts = xff.split(",").map(normIp).filter(Boolean);
  if (!parts.length) return { visitor: sock, hop: sock };
  return { visitor: parts[0], hop: parts[parts.length - 1] };
}

let ipKey = crypto.randomBytes(32);
const buckets = new Map();
setInterval(() => { ipKey = crypto.randomBytes(32); buckets.clear(); }, 3600 * 1000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.t + ((now - b.last) / 1000) * b.rate >= b.burst) buckets.delete(k);
}, 60 * 1000).unref();
const keyOf = (kind, ip) => crypto.createHmac("sha256", ipKey).update(kind + "|" + ip).digest("base64url").slice(0, 22);

// Takes one token. Returns the fill level from 1 (full) down to -hardMultiplier (blocked).
function take(key, burst, rate, now) {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= CFG.maxKeys) buckets.clear();
    b = { t: burst, last: now, burst, rate };
    buckets.set(key, b);
  }
  b.t = Math.min(burst, b.t + ((now - b.last) / 1000) * rate);
  b.last = now;
  const floor = -burst * CFG.hardMultiplier;
  if (b.t > floor) b.t -= 1;
  return b.t / burst;
}
function rateCheck(ips, now) {
  const v = take(keyOf("v", ips.visitor), CFG.rateBurst, CFG.ratePerSec, now);
  const h = ips.hop === ips.visitor ? v
    : take(keyOf("h", ips.hop), CFG.rateBurst * CFG.hopMultiplier, CFG.ratePerSec * CFG.hopMultiplier, now);
  const level = Math.min(v, h);
  return { soft: level < 0, hard: level <= -CFG.hardMultiplier };
}

let win = 0, winCount = 0, busyUntil = 0;
function countGlobal(now) {
  const w = Math.floor(now / 10000);
  if (w !== win) { win = w; winCount = 0; }
  if (++winCount > CFG.globalRps * 10) busyUntil = now + CFG.underAttackSec * 1000;
}
const busy = (now) => now < busyUntil;

// ---------- proof of work ----------
const hmac = (s) => crypto.createHmac("sha256", POW_SECRET).update(s).digest("base64url").slice(0, 22);
const safeEq = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const used = new Map(); // challenge -> expiry, stops replays
setInterval(() => { const now = Date.now(); for (const [c, exp] of used) if (exp < now) used.delete(c); }, 60 * 1000).unref();

function issueChallenge(now) {
  const bits = busy(now) ? CFG.powBitsUnderAttack : CFG.powBits;
  const payload = `${Math.floor(now / 1000)}.${crypto.randomBytes(9).toString("base64url")}.${bits}`;
  return { c: `${payload}.${hmac("c:" + payload)}`, bits };
}
function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) { if (byte === 0) { n += 8; continue; } n += Math.clz32(byte) - 24; break; }
  return n;
}
function verifyPow(c, n, now) {
  if (typeof c !== "string" || c.length > 120 || !/^\d{1,12}$/.test(String(n))) return false;
  const parts = c.split(".");
  if (parts.length !== 4) return false;
  const [ts, , bitsStr, mac] = parts;
  if (!safeEq(mac, hmac("c:" + parts.slice(0, 3).join(".")))) return false;
  const age = now / 1000 - Number(ts);
  const bits = Number(bitsStr);
  if (!(age >= -5 && age <= 300) || !(bits >= CFG.powBits && bits <= 28)) return false;
  if (used.has(c)) return false;
  if (leadingZeroBits(crypto.createHash("sha256").update(`${c}:${n}`).digest()) < bits) return false;
  if (used.size >= 200000) used.clear();
  used.set(c, now + 310 * 1000);
  return true;
}
// The pass is tied to the visitor's network for up to two hours, so a bot can't solve once and
// hand it to a botnet. It's a keyed hash, not a record: nothing is stored server-side.
const slotOf = (now) => Math.floor(now / 1000 / CFG.passTtlSec);
const passFor = (slot, visitor) => `${slot}.${hmac(`pass:${slot}:${visitor}`)}`;
function hasPass(req, visitor, now) {
  const m = /(?:^|;\s*)zks_pass=(\d{1,12}\.[A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const slot = Number(m[1].split(".")[0]), cur = slotOf(now);
  return (slot === cur || slot === cur - 1) && safeEq(m[1], passFor(slot, visitor));
}

// ---------- responses ----------
function send(req, res, status, body, type, extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(req.method === "HEAD" ? undefined : body);
}
const accepts = (ae, enc) => new RegExp(`(?:^|,)\\s*${enc}\\s*(?:;\\s*q=(?!0(?:\\.0*)?\\s*(?:,|$))[\\d.]+)?\\s*(?:,|$)`, "i").test(ae);
function sendApp(req, res) {
  res.setHeader("Content-Security-Policy", APP_CSP);
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("ETag", APP.etag);
  res.setHeader("Vary", "Accept-Encoding");
  if (req.headers["if-none-match"] === APP.etag) { res.writeHead(304); return res.end(); }
  const ae = req.headers["accept-encoding"] || "";
  let body = APP.raw, enc = null;
  if (accepts(ae, "br")) { body = APP.br; enc = "br"; } else if (accepts(ae, "gzip")) { body = APP.gz; enc = "gzip"; }
  const h = { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length };
  if (enc) h["Content-Encoding"] = enc;
  res.writeHead(200, h);
  res.end(req.method === "HEAD" ? undefined : body);
}
function sendChallenge(req, res, now) {
  const { c, bits } = issueChallenge(now);
  res.setHeader("Content-Security-Policy", POW_CSP);
  send(req, res, 200, CHALLENGE_TEMPLATE.replace("__CHALLENGE__", c).replace("__BITS__", String(bits)), "text/html; charset=utf-8");
}
const tooMany = (req, res) =>
  send(req, res, 429, "too many requests. wait a minute and try again.\n", "text/plain; charset=utf-8", { "Retry-After": "60" });

function handlePow(req, res, visitor) {
  const type = req.headers["content-type"] || "";
  if (!type.startsWith("application/json")) return send(req, res, 415, "unsupported\n", "text/plain");
  let size = 0, aborted = false; const chunks = [];
  req.on("data", (d) => {
    size += d.length;
    if (size > 1024 && !aborted) { aborted = true; send(req, res, 413, "too large\n", "text/plain", { Connection: "close" }); req.destroy(); return; }
    if (!aborted) chunks.push(d);
  });
  req.on("end", () => {
    if (aborted) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(req, res, 400, "bad request\n", "text/plain"); }
    const now = Date.now();
    if (!body || !verifyPow(body.c, body.n, now)) return send(req, res, 403, "check failed\n", "text/plain");
    const cookie = `zks_pass=${passFor(slotOf(now), visitor)}; Max-Age=${CFG.passTtlSec}; Path=/; HttpOnly; SameSite=Strict${CFG.cookieSecure ? "; Secure" : ""}`;
    res.writeHead(204, { "Set-Cookie": cookie, "Cache-Control": "no-store" });
    res.end();
  });
}

function handler(req, res) {
  const now = Date.now();
  baseHeaders(res);
  const url = (req.url || "/").split("?")[0];

  if (url === "/healthz") return send(req, res, 200, "ok\n", "text/plain");

  countGlobal(now);
  const ips = clientIps(req);
  const rl = rateCheck(ips, now);
  if (rl.hard) return tooMany(req, res);

  if (url === "/__pow") {
    if (req.method !== "POST") return send(req, res, 405, "method not allowed\n", "text/plain", { Allow: "POST" });
    return handlePow(req, res, ips.visitor);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, "method not allowed\n", "text/plain", { Allow: "GET, HEAD" });
  if (url === "/robots.txt") return send(req, res, 200, ROBOTS, "text/plain");
  if (url === "/og.png") {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"); // previews are shown on other sites
    return send(req, res, 200, OG_IMAGE, "image/png", { "Cache-Control": "public, max-age=86400", "Content-Length": OG_IMAGE.length });
  }
  if (!APP_PATHS.has(url)) return send(req, res, 404, "not found\n", "text/plain");

  if (CFG.powMode === "off") return rl.soft ? tooMany(req, res) : sendApp(req, res);
  const gate = CFG.powMode === "always" || rl.soft || busy(now);
  if (gate && !hasPass(req, ips.visitor, now)) return sendChallenge(req, res, now);
  return sendApp(req, res);
}

const server = http.createServer(handler);
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;
server.maxRequestsPerSocket = 200;
server.on("clientError", (err, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); else socket.destroy(); });

if (require.main === module) {
  // Crash loudly (without request data) and let Railway restart us, rather than limp on in a bad state.
  process.on("uncaughtException", (e) => { console.error("fatal:", e && e.message); process.exit(1); });
  server.listen(CFG.port, () => {
    console.log(`zkSEND listening on ${CFG.port} (pow=${CFG.powMode}, bits=${CFG.powBits}, burst=${CFG.rateBurst}, rate=${CFG.ratePerSec}/s, ip=${CFG.ipSource}, status=${CFG.statusCheck}). No requests are logged.`);
  });
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
module.exports = { server, CFG, verifyPow, issueChallenge, leadingZeroBits, passFor, slotOf, normIp, clientIps, accepts };
