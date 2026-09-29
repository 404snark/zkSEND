"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

Object.assign(process.env, {
  POW_MODE: "auto", POW_BITS: "10", POW_BITS_UNDER_ATTACK: "12", RATE_BURST: "5", RATE_PER_SEC: "0.001",
  RATE_HARD_MULTIPLIER: "2", RATE_HOP_MULTIPLIER: "3", GLOBAL_SOFT_RPS: "1000", COOKIE_SECURE: "false",
});
const { server, leadingZeroBits } = require("../server.js");
let base;
before(() => new Promise((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => server.close());

// Simulates Railway: the edge appends the connecting IP to X-Forwarded-For.
const xff = (visitor, hop = visitor) => (visitor === hop ? visitor : `${visitor}, ${hop}`);
const get = (p, visitor, headers = {}, hop) => fetch(base + p, { headers: { "x-forwarded-for": xff(visitor, hop), ...headers } });
const post = (visitor, body, type = "application/json") =>
  fetch(base + "/__pow", { method: "POST", headers: { "x-forwarded-for": visitor, "content-type": type }, body });
const isApp = async (r) => /<section id="create"/.test(await r.text());
const isPuzzle = async (r) => /checking your browser/.test(await r.text());
function solve(c, bits) {
  for (let n = 0; ; n++) if (leadingZeroBits(crypto.createHash("sha256").update(`${c}:${n}`).digest()) >= bits) return n;
}
async function earnPass(ip) {
  let html = "";
  for (let i = 0; i < 8 && !/data-c=/.test(html); i++) html = await (await get("/", ip)).text();
  const [, c, bits] = html.match(/data-c="([^"]+)" data-bits="(\d+)"/);
  const r = await post(ip, JSON.stringify({ c, n: solve(c, +bits) }));
  assert.equal(r.status, 204);
  return { cookie: r.headers.get("set-cookie"), c, bits };
}

test("serves the app with strict headers and no cookies", async () => {
  const r = await get("/", "10.0.0.1", { "accept-encoding": "gzip, br" });
  assert.equal(r.status, 200);
  assert.ok(await r.text());
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /connect-src https:\/\/api\.blockchair\.com;/, "the page may contact Blockchair and nothing else");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal((await get("/", "10.0.0.1", { "if-none-match": r.headers.get("etag") })).status, 304);
});

test("header CSP hashes match the inline script and style", async () => {
  const r = await get("/", "10.0.0.9");
  const html = await r.text(), csp = r.headers.get("content-security-policy");
  const js = html.match(/<script>([\s\S]*)<\/script>/)[1], css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const h = (s) => `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`;
  assert.ok(csp.includes(h(js)) && csp.includes(h(css)));
});

test("burst -> puzzle -> pass -> app; flood -> 429", async () => {
  const ip = "203.0.113.7";
  for (let i = 0; i < 5; i++) assert.ok(await isApp(await get("/", ip)));
  const { cookie, c, bits } = await earnPass(ip);
  assert.match(cookie, /^zks_pass=\d+\.[\w-]{22}; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal((await post(ip, JSON.stringify({ c, n: solve(c, +bits) }))).status, 403, "no replay");
  const pass = cookie.split(";")[0];
  assert.ok(await isApp(await get("/", ip, { cookie: pass })));
  let last;
  for (let i = 0; i < 12; i++) last = await get("/", ip, { cookie: pass });
  assert.equal(last.status, 429);
  assert.equal(last.headers.get("retry-after"), "60");
});

test("a pass earned on one network doesn't work on another", async () => {
  const { cookie } = await earnPass("198.51.100.20");
  const other = "198.51.100.21";
  for (let i = 0; i < 6; i++) await get("/", other);
  assert.ok(await isPuzzle(await get("/", other, { cookie: cookie.split(";")[0] })));
});

test("forged pass and forged challenge are rejected", async () => {
  const ip = "198.51.100.3";
  for (let i = 0; i < 6; i++) await get("/", ip);
  assert.ok(await isPuzzle(await get("/", ip, { cookie: "zks_pass=1.AAAAAAAAAAAAAAAAAAAAAA" })));
  const forged = `${Math.floor(Date.now() / 1000)}.abc.10.AAAAAAAAAAAAAAAAAAAAAA`;
  assert.equal((await post(ip, JSON.stringify({ c: forged, n: solve(forged, 10) }))).status, 403);
});

test("many real visitors behind one shared CDN hop aren't lumped together", async () => {
  const hop = "157.52.64.10";
  // 12 visitors x 1 load = 12 loads through the hop: within its looser limit (5 x 3 = 15).
  for (let i = 0; i < 12; i++) assert.ok(await isApp(await get("/", `100.64.1.${i}`, {}, hop)), `visitor ${i}`);
});

test("spoofing the first X-Forwarded-For entry is still capped by the hop", async () => {
  const hop = "192.0.2.50";
  let r;
  for (let i = 0; i < 16; i++) r = await get("/", `1.1.${i}.1`, {}, hop);
  assert.ok(await isPuzzle(r), "hop bucket (15) exhausted -> puzzle despite fresh fake IPs");
});

test("IPv6 visitors are grouped by /64", async () => {
  for (let i = 0; i < 5; i++) await get("/", `2001:db8:aa:bb::${i + 1}`);
  assert.ok(await isPuzzle(await get("/", "2001:db8:aa:bb:ffff::9")));
});

test("other routes and bad input", async () => {
  assert.equal((await get("/healthz", "10.1.1.1")).status, 200);
  assert.equal((await get("/robots.txt", "10.1.1.1")).status, 200);
  assert.equal((await get("/nope", "10.1.1.1")).status, 404);
  assert.equal((await fetch(base + "/", { method: "POST", headers: { "x-forwarded-for": "10.1.1.2" } })).status, 405);
  assert.equal((await post("10.1.1.3", "{}", "text/plain")).status, 415);
  assert.equal((await post("10.1.1.4", "not json")).status, 400);
  const big = await post("10.1.1.5", JSON.stringify({ c: "x".repeat(5000) })).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});


test("STATUS_CHECK=off blocks the status request and hides the button", async () => {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, ["server.js"], { cwd: require("path").join(__dirname, ".."),
    env: { ...process.env, PORT: "8791", STATUS_CHECK: "off", POW_MODE: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((r) => child.stdout.once("data", r));
  try {
    const r = await fetch("http://127.0.0.1:8791/");
    assert.match(r.headers.get("content-security-policy"), /connect-src 'none'/);
    assert.match(await r.text(), /<meta name="zksend-status" content="off">/);
  } finally { child.kill(); }
});
