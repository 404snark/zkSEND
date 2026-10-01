"use strict";
(function () {
  // =====================================================================
  // Pure helpers (no DOM). Exposed as window.ZkSend for tests.
  // =====================================================================
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const BECH32 = 1, BECH32M = 0x2bc830a3;
  const HRPS = { u: "bech32m", utest: "bech32m", zs: "bech32", ztestsapling: "bech32" };
  const TESTNET = { utest: 1, ztestsapling: 1 };
  const ZAT = 100000000n, MAX_ZAT = 21000000n * ZAT;
  const MEMO_BYTES = 512, LABEL_MAX = 80, MEMO_MAX = 120, MAX_RECIPIENTS = 50, MAX_PRESETS = 4;
  const TXID_RE = /^[0-9a-f]{64}$/;

  function polymod(values) {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
    }
    return chk >>> 0;
  }
  function hrpExpand(hrp) {
    const a = [];
    for (let i = 0; i < hrp.length; i++) a.push(hrp.charCodeAt(i) >> 5);
    a.push(0);
    for (let i = 0; i < hrp.length; i++) a.push(hrp.charCodeAt(i) & 31);
    return a;
  }
  // -> {ok, reason} | {ok, address, testnet}
  function checkAddress(raw) {
    const s = String(raw || "").replace(/\s+/g, "");
    if (!s) return { ok: false, reason: "Paste a shielded address." };
    if (/^(t1|t3|tm|tex1)/i.test(s))
      return { ok: false, reason: "That's a transparent address. Use a shielded one (u1… or zs1…) so the payment and memo stay private." };
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) return { ok: false, reason: "The address mixes upper and lower case, so it's mistyped." };
    const a = s.toLowerCase();
    const pos = a.lastIndexOf("1");
    const hrp = a.slice(0, pos);
    if (pos < 1 || !(hrp in HRPS)) return { ok: false, reason: "That isn't a Zcash shielded address. It should start with u1 or zs1." };
    const data = [];
    for (const c of a.slice(pos + 1)) {
      const d = CHARSET.indexOf(c);
      if (d < 0) return { ok: false, reason: `The address contains "${c}", which can't appear in a Zcash address.` };
      data.push(d);
    }
    if (data.length < 20) return { ok: false, reason: "The address is too short. Copy the whole thing." };
    if (polymod(hrpExpand(hrp).concat(data)) !== (HRPS[hrp] === "bech32m" ? BECH32M : BECH32))
      return { ok: false, reason: "The address checksum is wrong, so a character is missing or changed. Copy it again from your wallet." };
    return { ok: true, address: a, testnet: !!TESTNET[hrp] };
  }

  // "0.05" -> {ok, zat: 5000000n}; "" -> {ok, zat: null}
  function parseZec(text) {
    let t = String(text || "").trim();
    if (!t) return { ok: true, zat: null };
    if (/^\d+,\d+$/.test(t)) t = t.replace(",", ".");
    if (/^\.\d+$/.test(t)) t = "0" + t;
    if (!/^\d+(\.\d{1,8})?$/.test(t)) return { ok: false, reason: "Enter an amount like 0.05, with at most 8 decimal places." };
    const [w, f = ""] = t.split(".");
    const zat = BigInt(w) * ZAT + BigInt((f + "00000000").slice(0, 8));
    if (zat <= 0n) return { ok: false, reason: "The amount must be more than zero." };
    if (zat > MAX_ZAT) return { ok: false, reason: "That's more ZEC than exists." };
    return { ok: true, zat };
  }
  function formatZec(zat) {
    const w = zat / ZAT, f = zat % ZAT;
    return f === 0n ? w.toString() : `${w}.${f.toString().padStart(8, "0").replace(/0+$/, "")}`;
  }

  // Free text shown to people: strip control and direction-override characters.
  function cleanText(s, max) {
    return Array.from(String(s || "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim())
      .slice(0, max).join("");
  }
  const utf8Len = (s) => new TextEncoder().encode(s).length;
  function checkMemo(s) {
    const m = cleanText(s, MEMO_MAX);
    if (utf8Len(m) > MEMO_BYTES) return { ok: false, reason: "That memo is too long." };
    return { ok: true, memo: m };
  }

  function b64url(str) {
    let bin = "";
    for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const qchar = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

  // ZIP 321. One payment: zcash:<addr>?amount=&memo=&message=
  // Several: zcash:?address=&amount=&memo=&address.1=&amount.1=&memo.1=...
  function paymentUri(p) {
    const q = [];
    if (p.zat != null) q.push("amount=" + formatZec(p.zat));
    if (p.memo) q.push("memo=" + b64url(p.memo));
    if (p.label) q.push("message=" + qchar(p.label));
    return "zcash:" + p.address + (q.length ? "?" + q.join("&") : "");
  }
  function multiUri(rows, label) {
    if (rows.length === 1) return paymentUri({ ...rows[0], label });
    const q = [];
    rows.forEach((r, i) => {
      const sfx = i === 0 ? "" : "." + i;
      q.push(`address${sfx}=${r.address}`);
      q.push(`amount${sfx}=${formatZec(r.zat)}`);
      if (r.memo) q.push(`memo${sfx}=${b64url(r.memo)}`);
      if (i === 0 && label) q.push("message=" + qchar(label));
    });
    return "zcash:?" + q.join("&");
  }


  function newRef(prefix) {
    const b = crypto.getRandomValues(new Uint8Array(3));
    return prefix + "-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  // "address, amount, memo" per line; commas, tabs or semicolons. Memo may contain commas.
  function parseBatch(text, sharedMemo) {
    const rows = [], errors = [];
    const lines = String(text || "").split(/\r?\n/);
    lines.forEach((line, i) => {
      const raw = line.trim();
      if (!raw || raw.startsWith("#")) return;
      // Spreadsheet pastes use tabs; with tabs or semicolons, a decimal comma ("0,05") is fine.
      const sep = raw.includes("\t") ? "\t" : raw.includes(";") ? ";" : ",";
      const parts = raw.split(sep);
      const addrPart = parts[0], amtPart = parts[1] || "";
      if (/^(address|addr|recipient|to|wallet)\b/i.test(addrPart.trim()) && !parseZec(amtPart).zat) return; // header row
      const memo = parts.slice(2).join(sep).trim();
      const a = checkAddress(addrPart);
      if (!a.ok) return errors.push({ line: i + 1, reason: a.reason });
      const z = parseZec(amtPart);
      if (!z.ok || z.zat === null) return errors.push({ line: i + 1, reason: z.ok ? "Add an amount after the address." : z.reason });
      const m = checkMemo(memo || sharedMemo || "");
      if (!m.ok) return errors.push({ line: i + 1, reason: m.reason });
      rows.push({ address: a.address, testnet: a.testnet, zat: z.zat, memo: m.memo });
    });
    if (rows.length > MAX_RECIPIENTS) errors.push({ line: 0, reason: `That's ${rows.length} payments. The limit is ${MAX_RECIPIENTS} per batch; split the list.` });
    if (rows.length && rows.some((r) => r.testnet) && rows.some((r) => !r.testnet)) errors.push({ line: 0, reason: "The list mixes mainnet and testnet addresses." });
    return { rows, errors, total: rows.reduce((s, r) => s + r.zat, 0n) };
  }

  // ---------- link fragments ----------
  // request: #u=&a=&m=&n=[&tx=]     (the original format, unchanged)
  // tip:     #k=tip&u=&n=&p=0.01,0.05,0.1
  // batch:   #k=pay&n=&pu=&pa=&pm=&pu=&pa=&pm=...
  function fragRequest(r, tx) {
    const q = new URLSearchParams();
    q.set("u", r.address);
    if (r.zat != null) q.set("a", formatZec(r.zat));
    q.set("m", r.memo);
    if (r.label) q.set("n", r.label);
    if (r.expires) q.set("x", String(r.expires));
    if (tx) q.set("tx", tx);
    return "#" + q.toString();
  }
  function fragTip(t) {
    const q = new URLSearchParams({ k: "tip", u: t.address });
    if (t.label) q.set("n", t.label);
    if (t.presets.length) q.set("p", t.presets.map(formatZec).join(","));
    return "#" + q.toString();
  }
  function fragBatch(b, tx) {
    const q = new URLSearchParams({ k: "pay" });
    if (b.label) q.set("n", b.label);
    for (const r of b.rows) { q.append("pu", r.address); q.append("pa", formatZec(r.zat)); q.append("pm", r.memo || ""); }
    if (tx) q.set("tx", tx);
    return "#" + q.toString();
  }

  // Every fragment is untrusted: anyone can craft a link.
  function parseFragment(hash) {
    const h = String(hash || "").replace(/^#/, "");
    if (!h) return null;
    if (/^[a-z][a-z-]{0,20}$/.test(h)) return { kind: "section", section: h };
    let q;
    try { q = new URLSearchParams(h); } catch (_) { return { error: "This link couldn't be read." }; }
    if (q.has("s")) {
      const blob = q.get("s");
      if ([...q.keys()].length !== 1 || !/^[A-Za-z0-9_-]{65,16000}$/.test(blob)) return { error: "This sealed link is damaged. Ask for a fresh one." };
      return { kind: "sealed", blob };
    }
    const label = cleanText(q.get("n"), LABEL_MAX);
    const kind = q.get("k") || "request";

    if (kind === "tip") {
      const a = checkAddress(q.get("u"));
      if (!a.ok) return { error: "This link's address isn't valid. " + a.reason };
      const presets = [];
      for (const p of String(q.get("p") || "").split(",").filter(Boolean).slice(0, MAX_PRESETS)) {
        const z = parseZec(p);
        if (!z.ok || z.zat === null) return { error: "This tip link has an invalid preset amount." };
        presets.push(z.zat);
      }
      return { kind: "tip", address: a.address, testnet: a.testnet, label, presets };
    }

    if (kind === "pay") {
      const us = q.getAll("pu"), as = q.getAll("pa"), ms = q.getAll("pm");
      if (!us.length || us.length !== as.length || us.length !== ms.length) return { error: "This payment list is incomplete." };
      if (us.length > MAX_RECIPIENTS) return { error: `This payment list has more than ${MAX_RECIPIENTS} payments.` };
      const rows = [];
      for (let i = 0; i < us.length; i++) {
        const a = checkAddress(us[i]);
        if (!a.ok) return { error: `Payment ${i + 1} has an invalid address. ` + a.reason };
        const z = parseZec(as[i]);
        if (!z.ok || z.zat === null) return { error: `Payment ${i + 1} has an invalid amount.` };
        const m = checkMemo(ms[i]);
        if (!m.ok) return { error: `Payment ${i + 1} has an invalid memo.` };
        rows.push({ address: a.address, testnet: a.testnet, zat: z.zat, memo: m.memo });
      }
      if (rows.some((r) => r.testnet) !== rows.every((r) => r.testnet)) return { error: "This payment list mixes mainnet and testnet addresses." };
      const tx = String(q.get("tx") || "").toLowerCase();
      if (tx && !TXID_RE.test(tx)) return { error: "This tracking link's transaction ID isn't valid." };
      return { kind: "pay", label, rows, total: rows.reduce((s, r) => s + r.zat, 0n), tx };
    }

    if (kind !== "request") return { error: "This link type isn't supported." };
    const a = checkAddress(q.get("u"));
    if (!a.ok) return { error: "This link's address isn't valid. " + a.reason };
    const z = parseZec(q.get("a"));
    if (!z.ok) return { error: "This link's amount isn't valid. " + z.reason };
    const m = checkMemo(q.get("m"));
    const tx = String(q.get("tx") || "").toLowerCase();
    if (tx && !TXID_RE.test(tx)) return { error: "This tracking link's transaction ID isn't valid." };
    if (!m.ok || (!m.memo && !tx)) return { error: "This link is missing its memo." };
    const xs = q.get("x");
    if (xs !== null && !/^\d{9,11}$/.test(xs)) return { error: "This link's expiry time isn't valid." };
    return { kind: "request", address: a.address, testnet: a.testnet, zat: z.zat, memo: m.memo, label, tx, expires: xs ? Number(xs) : null };
  }

  // ---------- sealed links ----------
  // The whole fragment is encrypted with a code: PBKDF2-SHA256 -> AES-256-GCM (WebCrypto).
  // Format: #s=base64url( 0x01 | iterations u32 BE | salt[16] | iv[12] | ciphertext+tag )
  // Generated codes: 12 random characters (60 bits), 200k iterations. Codes people choose: 8-12 characters, 600k.
  const SEAL_V = 1, ITER_GENERATED = 200000, ITER_CUSTOM = 600000, ITER_MIN = 10000, ITER_MAX = 2000000;
  const SEAL_AAD = new TextEncoder().encode("zksend-seal-v1");
  const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const canSeal = () => !!(window.crypto && crypto.subtle && window.isSecureContext !== false);
  function newCode() {
    const b = crypto.getRandomValues(new Uint8Array(12)); // 256 % 32 === 0, so x & 31 is uniform
    return prettyCode(Array.from(b, (x) => CODE_ALPHABET[x & 31]).join(""));
  }
  const prettyCode = (k) => (k.match(/.{1,4}/g) || []).join("-");
  // Codes are forgiving: case, spaces, dashes and I/L/O look-alikes don't matter.
  function codeKey(code) {
    return String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  }
  function normCode(code) { const key = codeKey(code); return { key, pretty: prettyCode(key) }; }
  // For codes people choose: 8-12 letters or numbers, and not obviously guessable.
  function checkCode(code) {
    const key = codeKey(code);
    if (key.length < 8 || key.length > 12) return { ok: false, reason: "Codes are 8 to 12 letters or numbers." };
    const seq = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    if (new Set(key).size < 4 || seq.includes(key) || [...seq].reverse().join("").includes(key) || /^(.{1,4})\1+$/.test(key))
      return { ok: false, reason: "That code is too easy to guess. Use the generated one, or mix more letters and numbers." };
    // Show the code the way it was typed (letter O stays O); look-alikes only merge inside the key.
    return { ok: true, key, pretty: prettyCode(String(code).toUpperCase().replace(/[^0-9A-Z]/g, "")) };
  }
  const bytesToB64u = (u8) => { let s = ""; for (const x of u8) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const b64uToBytes = (str) => { const b = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  async function sealKey(codeKey, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(codeKey), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  // plain: fragment without "#". Returns "#s=...".
  async function seal(plain, code, iterations = ITER_CUSTOM) {
    const c = normCode(code);
    if (c.key.length < 8) throw new Error("code too short");
    if (!(iterations >= ITER_MIN && iterations <= ITER_MAX)) throw new Error("bad iterations");
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await sealKey(c.key, salt, iterations);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: SEAL_AAD }, key, new TextEncoder().encode(plain)));
    const out = new Uint8Array(1 + 4 + 16 + 12 + ct.length);
    out[0] = SEAL_V; new DataView(out.buffer).setUint32(1, iterations); out.set(salt, 5); out.set(iv, 21); out.set(ct, 33);
    return "#s=" + bytesToB64u(out);
  }
  // Returns { plain, iterations }, or null if the code is wrong or the link was altered.
  async function unseal(blob, code) {
    let bytes;
    try { bytes = b64uToBytes(blob); } catch (_) { return null; }
    if (bytes.length < 33 + 16 || bytes[0] !== SEAL_V) return null;
    const iterations = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1);
    if (iterations < ITER_MIN || iterations > ITER_MAX) return null;
    const attempt = async (k) => {
      try {
        const key = await sealKey(k, bytes.slice(5, 21), iterations);
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(21, 33), additionalData: SEAL_AAD }, key, bytes.slice(33));
        return { plain: new TextDecoder().decode(pt), iterations };
      } catch (_) { return null; }
    };
    const k = codeKey(code);
    return k.length >= 8 ? attempt(k) : null;
  }

  // The developer's tip jar, linked at the bottom of every page.
  const DEV_TIP = {
    address: "u12ggdvur6ed7ep6kp0ygcedxjlklzfr2800snnthhg0xj8yhl3ruugtmann5kqhupup3z955dn8vczrffj0d2awm9qyrwwleq0jchn5jnmzrquft85tx2vkwddj8fn490ljzcf4350ned0qaxfr037tdh2lhpjwtfxumksdy7vgth8akv",
    label: "the zkSEND dev",
    presets: [],
  };

  // Transaction status, fetched by the visitor's browser straight from Blockchair.
  // zkSEND's server is never involved. Only the txid is sent: no cookies, no referrer.
  const STATUS_API = "https://api.blockchair.com/zcash/dashboards/transaction/";
  async function fetchStatus(txid, fetchImpl = fetch) {
    if (!TXID_RE.test(txid)) return { state: "error" };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    let r;
    try {
      r = await fetchImpl(STATUS_API + txid, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", mode: "cors", signal: ctl.signal });
    } catch (_) { return { state: "offline" }; } finally { clearTimeout(timer); }
    if (r.status === 404) return { state: "unseen" };
    if (r.status === 402 || r.status === 429 || r.status === 430 || r.status === 503) return { state: "limited" };
    if (!r.ok) return { state: "offline" };
    let j;
    try { j = await r.json(); } catch (_) { return { state: "offline" }; }
    const entry = j && j.data && !Array.isArray(j.data) ? j.data[txid] : null;
    if (!entry || !entry.transaction) return { state: "unseen" };
    const block = Number(entry.transaction.block_id), tip = Number(j.context && j.context.state);
    if (block === -1) return { state: "pending" };
    if (!Number.isInteger(block) || block < 1 || !Number.isInteger(tip) || tip < block) return { state: "offline" };
    const time = /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(entry.transaction.time || "") ? entry.transaction.time.slice(0, 16) : "";
    return { state: "confirmed", confirmations: tip - block + 1, height: block, time };
  }

  // Noir (browser-extension wallet): send through its injected provider and get the txid back.
  // API: github.com/NoirWallet/zcash-wallet-adapter (zcash_requestAccounts, zcash_sendTransaction).
  function noirProvider() {
    const w = window.noirwallet;
    return w && w.isNoirWallet && w.zcash && typeof w.zcash.request === "function" ? w.zcash : null;
  }
  async function noirSend(provider, pay) {
    try {
      await provider.request({ method: "zcash_requestAccounts" });
      const res = await provider.request({ method: "zcash_sendTransaction",
        params: [{ to: pay.address, amount: formatZec(pay.zat), ...(pay.memo ? { memo: pay.memo } : {}), fundingSource: "shielded" }] });
      const tx = String((res && (res.txid || res.txHash)) || res || "").trim().toLowerCase().replace(/^0x/, "");
      return TXID_RE.test(tx) ? { ok: true, tx } : { ok: true, tx: null };
    } catch (e) {
      const code = e && typeof e.code === "number" ? e.code : null;
      if (code === 4001 || code === 5000) return { ok: false, reason: "You cancelled the payment in Noir." };
      if (code === -32002) return { ok: false, reason: "Noir already has a request open. Check the extension." };
      return { ok: false, reason: "Noir couldn't send it" + (e && e.message ? ": " + String(e.message).slice(0, 160) : ".") };
    }
  }

  window.ZkSend = { seal, unseal, newCode, normCode, checkCode, codeKey, ITER_GENERATED, ITER_CUSTOM, noirProvider, noirSend, fetchStatus, DEV_TIP, checkAddress, parseZec, formatZec, cleanText, checkMemo, b64url, paymentUri, multiUri, parseBatch,
    fragRequest, fragTip, fragBatch, parseFragment, newRef, polymod };
  if (!document.getElementById("app")) return;

  // =====================================================================
  // DOM
  // =====================================================================
  const $ = (id) => document.getElementById(id);
  const baseUrl = () => location.origin + "/";
  const QR_MAX = 1200; // characters; beyond this a QR code gets too dense to scan phone-to-phone

  function qrSvg(text) {
    const qr = qrcode(0, text.length > 1000 ? "L" : "M");
    qr.addData(text, "Byte");
    qr.make();
    const n = qr.getModuleCount(), NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `-2 -2 ${n + 4} ${n + 4}`);
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "QR code for this payment");
    const bg = document.createElementNS(NS, "rect");
    for (const [k, v] of [["x", -2], ["y", -2], ["width", n + 4], ["height", n + 4], ["class", "qr-bg"]]) bg.setAttribute(k, v);
    svg.appendChild(bg);
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "qr-fg");
    svg.appendChild(path);
    return svg;
  }
  function setQr(box, uri) {
    if (uri.length > QR_MAX) {
      const p = document.createElement("p");
      p.className = "qr-too-long";
      p.textContent = "This is too much for one QR code. Use \u201copen in wallet\u201d on this device, or pay one at a time below.";
      box.replaceChildren(p);
    } else box.replaceChildren(qrSvg(uri));
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function copyButton(getText, label = "copy") {
    const b = el("button", "act");
    b.type = "button";
    b.append(glyph("□"), label);
    b.addEventListener("click", () => doCopy(b, getText()));
    return b;
  }
  function glyph(g) { const s = el("span", null, g); s.setAttribute("aria-hidden", "true"); return s; }
  async function doCopy(b, text, src) {
    if (!b._orig) b._orig = [...b.childNodes].map((n) => n.cloneNode(true));
    const flash = (label, ok) => {
      clearTimeout(b._t);
      b.textContent = label;
      b.classList.toggle("done", ok);
      b._t = setTimeout(() => { b.replaceChildren(...b._orig.map((n) => n.cloneNode(true))); b.classList.remove("done"); }, 1600);
    };
    try { await navigator.clipboard.writeText(text); flash("copied", true); }
    catch (_) {
      if (src && src.select) src.select();
      else if (src) { const r = document.createRange(); r.selectNodeContents(src); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      flash(src ? "selected, press copy" : "couldn't copy", false);
    }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy-from]");
    if (!b) return;
    const src = $(b.dataset.copyFrom);
    doCopy(b, src.tagName === "TEXTAREA" || src.tagName === "INPUT" ? src.value : src.textContent, src);
  });

  const statusMeta = document.querySelector('meta[name="zksend-status"]');
  const STATUS_ON = !statusMeta || statusMeta.getAttribute("content") !== "off";

  // "tip the dev" at the very end of every page
  if (checkAddress(DEV_TIP.address).ok) for (const id of ["devtip-link", "nav-tip", "foot-tip"]) $(id).href = "/" + fragTip(DEV_TIP);
  else for (const id of ["devtip", "nav-tip", "foot-tip"]) $(id).hidden = true;

  // header: mobile menu + current-page highlight
  const topBar = document.querySelector(".top");
  const setMenu = (open) => { topBar.classList.toggle("open", open); $("menu-toggle").setAttribute("aria-expanded", String(open)); };
  $("menu-toggle").onclick = () => setMenu(!topBar.classList.contains("open"));
  $("nav").addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  function markNav(key) {
    document.querySelectorAll("#nav a").forEach((a) => {
      if (a.dataset.nav === key) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }

  // ---------------- progress: pay -> sent -> on the network -> confirming -> complete ----------------
  const STAGES = ["pay", "sent", "on the network", "confirming", "complete"];
  const STAGES_SHORT = ["pay", "sent", "network", "confirm", "done"];
  const FINAL_CONFS = 10, SEARCH_GIVE_UP_MS = 60 * 60 * 1000, CLEAR_AFTER_MS = 4 * 60 * 60 * 1000;
  function drawSteps(ol, active, complete) {
    ol.replaceChildren(...STAGES.map((label, i) => {
      const done = complete || i < active;
      const li = el("li", done ? "done" : i === active ? "active" : "todo");
      if (!complete && i === active) li.setAttribute("aria-current", "step");
      const n = el("span", "n", done ? "✓" : String(i + 1)); n.setAttribute("aria-hidden", "true");
      const short = el("span", "ls", STAGES_SHORT[i]); short.setAttribute("aria-hidden", "true");
      li.append(n, el("span", "l", label), short);
      if (done) li.append(el("span", "sr", " (done)"));
      return li;
    }));
  }

  let trackGen = 0;       // bumps on every navigation, so old timers stop
  let autoStartTx = null; // set when the payer taps "I sent it", so tracking starts without a second tap
  function clearPage() {
    trackGen++;
    history.replaceState(null, "", location.pathname + location.search);
    route();
  }
  function tracker(p, txid, testnet) {
    const gen = ++trackGen;
    const alive = () => gen === trackGen;
    const steps = $(p + "-steps"), meter = $(p + "-meter"), fill = $(p + "-fill"), stateEl = $(p + "-state"), detail = $(p + "-detail"), go = $(p + "-go");
    $(p + "-tx").textContent = txid;
    $(p + "-clear").onclick = clearPage;
    let started = 0, checks = 0, timer = 0;
    function paint(st, active, complete, confs, state, label, text) {
      drawSteps(steps, active, complete);
      const n = Math.max(0, Math.min(FINAL_CONFS, confs));
      meter.setAttribute("aria-valuenow", String(complete ? FINAL_CONFS : n));
      meter.classList.toggle("searching", state === "searching");
      fill.style.width = (complete ? 100 : n * 10) + "%";
      stateEl.dataset.state = state;
      stateEl.textContent = label;
      detail.textContent = text;
    }
    const problem = (label, text) => { stateEl.dataset.state = "error"; stateEl.textContent = label; detail.textContent = text; };
    go.hidden = false; go.disabled = false;
    go.replaceChildren(glyph("↻"), "start tracking");
    if (!STATUS_ON || testnet) {
      go.hidden = true;
      paint(null, 2, false, 0, "idle", "tracking unavailable", !STATUS_ON
        ? "Live tracking is turned off on this site. The recipient can confirm the payment by finding the memo in their wallet."
        : "Live tracking works for mainnet payments only.");
      return;
    }
    paint(null, 2, false, 0, "idle", "ready to track", "Tap start tracking to follow this payment until it's complete. Your browser checks Blockchair about once a minute while this page is open.");
    function later(ms) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!alive()) return;
        if (!document.hidden) return run();
        const once = () => { if (document.hidden) return; document.removeEventListener("visibilitychange", once); run(); };
        document.addEventListener("visibilitychange", once);
      }, ms);
    }
    async function run() {
      if (!alive()) return;
      clearTimeout(timer);
      if (!started) started = Date.now();
      checks++;
      go.disabled = true;
      go.replaceChildren(glyph("↻"), "check now");
      if (checks === 1) paint(null, 2, false, 0, "searching", "searching the network…", "Looking for this transaction.");
      const st = await fetchStatus(txid);
      if (!alive()) return;
      go.disabled = false;
      const n = st.confirmations || 0;
      if (st.state === "confirmed" && n >= FINAL_CONFS) {
        go.hidden = true;
        paint(st, 4, true, FINAL_CONFS, "complete", "complete",
          `${n.toLocaleString()} confirmations. This payment is final. zkSEND stored nothing about it, and this tab clears itself in 4 hours, or clear it now.`);
        setTimeout(() => { if (alive()) clearPage(); }, CLEAR_AFTER_MS);
        return;
      }
      if (st.state === "confirmed") {
        paint(st, 3, false, n, "confirming", `confirming: ${n} of ${FINAL_CONFS}`,
          `In block ${st.height.toLocaleString()}. A new block arrives about every 75 seconds, so this takes roughly ${Math.max(1, Math.round(((FINAL_CONFS - n) * 75) / 60))} more minute${FINAL_CONFS - n === 1 ? "" : "s"}.`);
        return later(45000);
      }
      if (st.state === "pending") {
        paint(st, 3, false, 0, "confirming", `confirming: 0 of ${FINAL_CONFS}`, "Found it on the network. Waiting for the first confirmation, usually a few minutes.");
        return later(30000);
      }
      if (st.state === "unseen") {
        if (Date.now() - started > SEARCH_GIVE_UP_MS) {
          paint(st, 2, false, 0, "lost", "can't find this transaction",
            "It's been over an hour. The payment most likely expired and the funds went back to the payer's wallet, or the transaction ID is wrong. Tap check now to look again.");
          return;
        }
        paint(st, 2, false, 0, "searching", "searching the network…", "Not found yet. Wallets can take a minute to send it out. Still looking every 30 seconds.");
        return later(30000);
      }
      if (st.state === "limited") problem("busy, retrying", "Blockchair is limiting requests right now. Trying again in a minute.");
      else problem("connection problem, retrying", "Couldn't reach Blockchair. Check your connection; a content blocker may also be stopping it. Trying again in a minute.");
      later(60000);
    }
    go.onclick = () => {
      if (stateEl.dataset.state === "lost") {
        started = 0;
        paint(null, 2, false, 0, "searching", "searching the network…", "Looking again for this transaction.");
      }
      run();
    };
    if (autoStartTx === txid) { autoStartTx = null; run(); }
  }

  // Noir button on a pay page. getPay() returns {address, zat, memo} or {error}.
  let noirReady = !!noirProvider();
  if (!noirReady) window.addEventListener("noirwallet#initialized", () => {
    noirReady = !!noirProvider();
    // Only redraw a pay page that isn't tracking; never interrupt a progress bar that's running.
    const onPayPage = (!$("pay").hidden && $("pay").dataset.mode === "request") || !$("tip").hidden;
    if (noirReady && onPayPage) route();
  }, { once: true });
  function wireNoir(prefix, getPay, onTx) {
    const btn = $(prefix + "-noir-btn"), missing = $(prefix + "-noir-missing");
    showError(prefix + "-noir-error");
    missing.hidden = true;
    btn.disabled = false;
    btn.classList.toggle("solid", noirReady); // quieter until Noir is detected
    btn.onclick = async () => {
      showError(prefix + "-noir-error");
      if (!noirProvider()) { missing.hidden = false; return; }
      missing.hidden = true;
      const pay = getPay();
      if (pay.error) return showError(prefix + "-noir-error", pay.error);
      btn.disabled = true;
      const res = await noirSend(noirProvider(), pay);
      btn.disabled = false;
      if (!res.ok) return showError(prefix + "-noir-error", res.reason);
      if (!res.tx) return showError(prefix + "-noir-error", "Sent. Noir didn't return the transaction ID, so paste it from Noir's history below to track it.");
      autoStartTx = res.tx;
      onTx(res.tx);
    };
  }
  // "Open in wallet app" can silently do nothing when no wallet handles zcash: links. Explain if so.
  function wireOpen(prefix) {
    const help = $(prefix + "-help");
    help.hidden = true;
    $(prefix + "-open").onclick = () => {
      setTimeout(() => { if (!document.hidden && document.hasFocus()) help.hidden = false; }, 1600);
    };
  }

  // "I sent it" forms on the pay pages
  function sentForm(prefix, onTx) {
    const form = $(prefix + "-sent-form");
    form.reset(); showError(prefix + "-sent-error");
    form.onsubmit = (e) => {
      e.preventDefault();
      const tx = $(prefix + "-sent-in").value.replace(/\s+/g, "").toLowerCase();
      if (!TXID_RE.test(tx)) {
        showError(prefix + "-sent-error", "A transaction ID is 64 characters of 0-9 and a-f. Open the payment in your wallet's history and copy it from there.");
        return $(prefix + "-sent-in").focus();
      }
      showError(prefix + "-sent-error");
      autoStartTx = tx;
      onTx(tx);
    };
  }

  const VIEWS = ["create", "page-guide", "page-faq", "page-security", "page-terms", "pay", "tip", "batch", "sealed", "expired", "bad"];
  const PAGES = {
    "/guide": { view: "page-guide", title: "Guide" },
    "/faq": { view: "page-faq", title: "FAQ" },
    "/security": { view: "page-security", title: "Security" },
    "/terms": { view: "page-terms", title: "Terms" },
  };
  const LEGACY_SECTIONS = { how: "/guide", guide: "/guide", faq: "/faq", terms: "/terms", security: "/security" };

  // Opened sealed links, kept in memory for this tab only: blob -> { plain, code }.
  const opened = new Map();
  let currentSeal = null; // the code of the sealed link on screen, so its tracking links stay sealed
  // Navigate to a plain fragment, sealing it first when we're inside a sealed link.
  async function go(frag) {
    if (!currentSeal) { location.hash = frag; return; }
    const plain = frag.replace(/^#/, "");
    const sealed = await seal(plain, currentSeal.code, currentSeal.iterations);
    opened.set(sealed.slice(3), { plain, code: currentSeal.code, iterations: currentSeal.iterations });
    location.hash = sealed;
  }
  function showSealBadge(id) { $(id).hidden = !currentSeal; }

  let unlockBlob = null;
  $("unlock-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!unlockBlob) return;
    const code = $("unlock-code").value;
    showError("unlock-error");
    if (!code.trim()) return showError("unlock-error", "Enter the code you were given.");
    if (!canSeal()) return showError("unlock-error", "This browser can't decrypt sealed links here. Open the link over https in an up-to-date browser.");
    const btn = $("unlock-btn");
    btn.disabled = true; btn.lastChild.textContent = "unlocking…";
    const res = await unseal(unlockBlob, code);
    btn.disabled = false; btn.lastChild.textContent = "unlock";
    if (res === null) return showError("unlock-error", "That code doesn't open this link. Check it and try again.");
    opened.set(unlockBlob, { plain: res.plain, code, iterations: res.iterations });
    $("unlock-code").value = "";
    route();
  };
  function show(id) {
    VIEWS.forEach((v) => ($(v).hidden = v !== id));
    window.scrollTo(0, 0);
  }
  function showError(id, msg) { $(id).textContent = msg || ""; }
  function snippets(link, what) {
    return {
      html: `<a href="${link.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${what}</a>`,
      md: `[${what}](${link})`,
    };
  }
  function fillResult(prefix, link, buttonText) {
    $(prefix + "-link").value = link;
    $(prefix + "-open").href = link;
    const s = snippets(link, buttonText);
    $(prefix + "-html").value = s.html;
    $(prefix + "-md").value = s.md;
    $(prefix + "-result").hidden = false;
    $(prefix + "-link").focus(); $(prefix + "-link").select();
  }

  // ---------------- create: tabs ----------------
  const MODES = ["request", "tip", "batch"];
  function setMode(mode) {
    MODES.forEach((m) => {
      const on = m === mode;
      $("tab-" + m).setAttribute("aria-selected", on ? "true" : "false");
      $("tab-" + m).tabIndex = on ? 0 : -1;
      $("form-" + m).hidden = !on;
    });
  }
  MODES.forEach((m, i) => {
    const t = $("tab-" + m);
    t.addEventListener("click", () => { setMode(m); });
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      const next = MODES[(i + d + MODES.length) % MODES.length];
      setMode(next); $("tab-" + next).focus();
    });
  });

  function renderCreate(section) {
    const wasHidden = $("create").hidden;
    VIEWS.forEach((v) => ($(v).hidden = v !== "create"));
    document.title = "zkSEND";
    if (section === "tip" || section === "batch" || section === "request") {
      setMode(section);
      $("modes").scrollIntoView();
      return;
    }
    if (wasHidden || !section) window.scrollTo(0, 0);
  }

  // "seal this link" toggles
  document.querySelectorAll(".code-input").forEach((input) => {
    const max = input.id === "unlock-code" ? 16 : 12;
    input.addEventListener("input", () => {
      const key = input.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, max);
      const next = prettyCode(key);
      if (next !== input.value) { input.value = next; input.setSelectionRange(next.length, next.length); }
    });
  });

  // Help popups: native popover where supported, a simple toggle elsewhere.
  if (!HTMLElement.prototype.hasOwnProperty("popover")) {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[popovertarget]");
      if (!btn) return;
      const pop = document.getElementById(btn.getAttribute("popovertarget"));
      pop.classList.toggle("pop-open", btn.getAttribute("popovertargetaction") !== "hide" && !pop.classList.contains("pop-open"));
    });
  }

  const generated = {}; // the code we generated per form, so a typed code gets the stronger stretching
  for (const p of ["r", "t", "b"]) {
    const box = $(p + "-seal"), codeBox = $(p + "-seal-box");
    if (!canSeal()) {
      box.disabled = true;
      const why = box.closest(".seal-opt").querySelector(".seal-why");
      why.textContent = "Sealing needs a secure (https) connection."; why.hidden = false;
    }
    const fresh = () => { generated[p] = newCode(); $(p + "-code").value = generated[p]; };
    box.onchange = () => {
      codeBox.hidden = !box.checked;
      if (box.checked && !$(p + "-code").value.trim()) fresh();
    };
    $(p + "-code-new").onclick = () => { fresh(); $(p + "-result").hidden = true; };
    box.form.addEventListener("reset", () => setTimeout(() => { codeBox.hidden = true; $(p + "-code").value = ""; $(p + "-sealed-out").hidden = true; }, 0));
  }
  // Seal a freshly made link if the toggle is on, then show it. Returns false if the code is unusable.
  async function finishLink(p, frag, buttonText, submitBtn) {
    let link = baseUrl() + frag;
    const out = $(p + "-sealed-out");
    out.hidden = true;
    if ($(p + "-seal").checked) {
      const isGenerated = codeKey($(p + "-code").value) === codeKey(generated[p]);
      const c = isGenerated ? { ok: true, pretty: prettyCode(codeKey(generated[p])) } : checkCode($(p + "-code").value);
      if (!c.ok) { showError(p + "-error", c.reason); $(p + "-code").focus(); return false; }
      const label = submitBtn.firstChild.textContent;
      submitBtn.disabled = true; submitBtn.firstChild.textContent = "sealing… ";
      try { link = baseUrl() + (await seal(frag.replace(/^#/, ""), c.pretty, isGenerated ? ITER_GENERATED : ITER_CUSTOM)); }
      finally { submitBtn.disabled = false; submitBtn.firstChild.textContent = label; }
      $(p + "-code-out").textContent = c.pretty;
      out.hidden = false;
    }
    fillResult(p, link, buttonText);
    return true;
  }

  // A link on screen must always match the form. Any edit hides the old one.
  for (const [form, prefix] of [["form-request", "r"], ["form-tip", "t"], ["form-batch", "b"]])
    $(form).addEventListener("input", (e) => { if (!e.target.closest(".result")) $(prefix + "-result").hidden = true; });

  // ---------------- create: request ----------------
  let reqMemo = newRef("ZECINV");
  $("r-memo").textContent = reqMemo;
  $("r-regen").onclick = () => { reqMemo = newRef("ZECINV"); $("r-memo").textContent = reqMemo; $("r-result").hidden = true; };
  $("form-request").onsubmit = async (e) => {
    e.preventDefault();
    $("r-result").hidden = true;
    showError("r-error");
    const a = checkAddress($("r-addr").value);
    if (!a.ok) { showError("r-error", a.reason); return $("r-addr").focus(); }
    const z = parseZec($("r-amount").value);
    if (!z.ok) { showError("r-error", z.reason); return $("r-amount").focus(); }
    const label = cleanText($("r-label").value, LABEL_MAX);
    const hours = Number($("r-expiry").value) || 0;
    const expires = hours ? Math.floor(Date.now() / 1000) + hours * 3600 : null;
    $("r-testnet").hidden = !a.testnet;
    await finishLink("r", fragRequest({ address: a.address, zat: z.zat, memo: reqMemo, label, expires }),
      z.zat != null ? `Pay ${formatZec(z.zat)} ZEC` : "Pay with ZEC", e.submitter || $("form-request").querySelector("[type=submit]"));
  };
  $("r-clear").onclick = () => {
    $("form-request").reset(); showError("r-error"); $("r-result").hidden = true;
    reqMemo = newRef("ZECINV"); $("r-memo").textContent = reqMemo;
  };

  // ---------------- create: tip jar ----------------
  $("form-tip").onsubmit = async (e) => {
    e.preventDefault();
    $("t-result").hidden = true;
    showError("t-error");
    const a = checkAddress($("t-addr").value);
    if (!a.ok) { showError("t-error", a.reason); return $("t-addr").focus(); }
    const presets = [];
    for (const raw of $("t-presets").value.split(/[\s,;]+/).filter(Boolean)) {
      const z = parseZec(raw);
      if (!z.ok || z.zat === null) { showError("t-error", `"${raw}" isn't an amount. List amounts like 0.01 0.05 0.1.`); return $("t-presets").focus(); }
      if (!presets.some((p) => p === z.zat)) presets.push(z.zat);
    }
    if (presets.length > MAX_PRESETS) { showError("t-error", `Use at most ${MAX_PRESETS} suggested amounts.`); return $("t-presets").focus(); }
    presets.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const label = cleanText($("t-label").value, LABEL_MAX);
    $("t-testnet").hidden = !a.testnet;
    await finishLink("t", fragTip({ address: a.address, label, presets }), "Tip in ZEC", e.submitter || $("form-tip").querySelector("[type=submit]"));
  };
  $("t-clear").onclick = () => { $("form-tip").reset(); showError("t-error"); $("t-result").hidden = true; };

  // ---------------- create: pay many ----------------
  function batchPreview() {
    const b = parseBatch($("b-list").value, cleanText($("b-memo").value, MEMO_MAX));
    const s = $("b-summary");
    if (!b.rows.length && !b.errors.length) { s.textContent = ""; return b; }
    s.textContent = `${b.rows.length} payment${b.rows.length === 1 ? "" : "s"}, ${formatZec(b.total)} ZEC total` +
      (b.errors.length ? `, ${b.errors.length} line${b.errors.length === 1 ? "" : "s"} to fix` : "");
    return b;
  }
  $("b-list").addEventListener("input", batchPreview);
  $("b-memo").addEventListener("input", batchPreview);
  $("form-batch").onsubmit = async (e) => {
    e.preventDefault();
    $("b-result").hidden = true;
    const b = batchPreview();
    const box = $("b-errors");
    box.replaceChildren();
    if (!b.rows.length && !b.errors.length) { showError("b-error", "Paste at least one line: address, amount, memo."); return $("b-list").focus(); }
    if (b.errors.length) {
      showError("b-error", "Fix these lines first:");
      for (const er of b.errors) box.append(el("li", null, (er.line ? `line ${er.line}: ` : "") + er.reason));
      return $("b-list").focus();
    }
    showError("b-error");
    const label = cleanText($("b-label").value, LABEL_MAX);
    await finishLink("b", fragBatch({ label, rows: b.rows }), `Pay ${b.rows.length} people in ZEC`, e.submitter || $("form-batch").querySelector("[type=submit]"));
  };
  $("b-clear").onclick = () => { $("form-batch").reset(); showError("b-error"); $("b-errors").replaceChildren(); $("b-summary").textContent = ""; $("b-result").hidden = true; };

  // ---------------- pay: single request / receipt ----------------
  function fingerprint(addr) { return addr.slice(0, 8) + " … " + addr.slice(-8); }
  let expiryTimer = 0;
  function whenText(sec) {
    return new Date(sec * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function leftText(ms) {
    const m = Math.round(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d >= 2 ? `${d} days` : h >= 1 ? `${h} h ${m % 60} min` : `${Math.max(1, m)} min`;
  }
  function renderPay(r) {
    clearTimeout(expiryTimer);
    if (!r.tx && r.expires && Date.now() >= r.expires * 1000) {
      show("expired");
      document.title = "expired request · zkSEND";
      $("expired-msg").textContent = `This payment request${r.label ? " for " + r.label : ""} expired on ${whenText(r.expires)}.`;
      return;
    }
    show("pay");
    showSealBadge("p-sealed");
    const exp = $("p-expires");
    exp.hidden = !(r.expires && !r.tx);
    if (r.expires && !r.tx) {
      const ms = r.expires * 1000 - Date.now();
      exp.textContent = `expires in ${leftText(ms)} · ${whenText(r.expires)}`;
      exp.classList.toggle("soon", ms < 3600 * 1000);
      if (ms < 2 ** 31 - 1) expiryTimer = setTimeout(route, ms + 500);
    }
    $("pay").dataset.mode = r.tx ? "receipt" : "request";
    document.title = (r.tx ? "tracking: " : "pay: ") + (r.label || r.memo || "payment") + " · zkSEND";
    $("p-kicker").textContent = r.tx ? "payment progress" : "payment request";
    $("p-title").textContent = r.label || "zcash payment";
    $("p-amount").textContent = r.zat === null ? "any amount" : formatZec(r.zat);
    $("p-unit").hidden = r.zat === null;
    $("p-testnet").hidden = !r.testnet;
    const uri = paymentUri(r);
    $("p-open").href = uri;
    setQr($("p-qr"), uri);
    $("p-memo").textContent = r.memo;
    $("p-amt-row").hidden = r.zat === null;
    $("p-amt-copy").textContent = r.zat === null ? "" : formatZec(r.zat);
    $("p-addr").textContent = r.address;
    wireOpen("p");
    $("p-noir-amt-row").hidden = r.zat !== null || !noirReady;
    $("p-noir-amt").value = "";
    wireNoir("p", () => {
      let zat = r.zat;
      if (zat === null) {
        const z = parseZec($("p-noir-amt").value);
        if (!z.ok || z.zat === null) return { error: z.ok ? "Enter the amount you want to send." : z.reason };
        zat = z.zat;
      }
      return { address: r.address, zat, memo: r.memo };
    }, (tx) => go(fragRequest(r, tx)));
    $("p-fp").textContent = fingerprint(r.address);
    $("p-uri").textContent = uri;
    drawSteps($("p-steps"), 0, false);
    $("rc-memo").textContent = r.memo;
    $("rc-memo-row").hidden = !r.memo;
    $("rc-share-copy").onclick = (e) => doCopy(e.currentTarget, location.href);
    if (r.tx) tracker("rc", r.tx, r.testnet);
    sentForm("p", (tx) => go(fragRequest(r, tx)));
  }

  // ---------------- pay: tip jar ----------------
  function renderTip(t) {
    show("tip");
    document.title = "tip " + (t.label || "") + " · zkSEND";
    $("tp-title").textContent = t.label ? `Tip ${t.label}` : "Send a tip";
    $("tp-official").hidden = t.address !== DEV_TIP.address;
    showSealBadge("tp-sealed");
    let current = { zat: null, memo: "" };
    $("tp-testnet").hidden = !t.testnet;
    $("tp-fp").textContent = fingerprint(t.address);
    $("tp-addr").textContent = t.address;
    const presets = t.presets.length ? t.presets : [];
    const wrap = $("tp-presets");
    wrap.replaceChildren();
    wrap.hidden = !presets.length;
    let chosen = presets.length ? presets[Math.floor((presets.length - 1) / 2)] : null;
    $("tp-custom").value = "";
    $("tp-custom-label").textContent = presets.length ? "other amount" : "amount";
    $("tp-msg").value = "";
    showError("tp-error");

    const update = () => {
      [...wrap.children].forEach((b) => b.setAttribute("aria-pressed", String(b._zat === chosen && !$("tp-custom").value.trim())));
      const custom = $("tp-custom").value.trim();
      let zat = chosen, invalid = false;
      if (custom) {
        const z = parseZec(custom);
        if (!z.ok || z.zat === null) { showError("tp-error", z.ok ? "" : z.reason); zat = null; invalid = true; }
        else { showError("tp-error"); zat = z.zat; }
      } else showError("tp-error");
      const msg = cleanText($("tp-msg").value, 200);
      const memo = msg || "tip" + (t.label ? " for " + t.label : "");
      current = { zat, memo: utf8Len(memo) <= MEMO_BYTES ? memo : "tip", invalid };
      const uri = paymentUri({ address: t.address, ...current });
      $("tp-amount").textContent = invalid ? "—" : zat === null ? "you choose" : formatZec(zat);
      $("tp-unit").hidden = zat === null;
      $("tp-open").href = uri;
      $("tp-uri").textContent = uri;
      setQr($("tp-qr"), uri);
    };
    for (const z of presets) {
      const b = el("button", "preset", formatZec(z) + " ZEC");
      b.type = "button"; b._zat = z;
      b.onclick = () => { chosen = z; $("tp-custom").value = ""; update(); };
      wrap.append(b);
    }
    $("tp-custom").oninput = update;
    $("tp-msg").oninput = update;
    update();
    drawSteps($("tp-steps"), 0, false);
    wireOpen("tp");
    const tipTrack = (tx) => go(fragRequest({ address: t.address, zat: current.zat, memo: current.memo, label: t.label ? `Tip for ${t.label}` : "Tip", testnet: t.testnet }, tx));
    wireNoir("tp", () => current.invalid ? { error: "Fix the amount first." } : current.zat === null ? { error: "Choose or enter an amount first." }
      : { address: t.address, zat: current.zat, memo: current.memo }, tipTrack);
    sentForm("tp", (tx) => {
      if (current.invalid) {
        showError("tp-sent-error", "Fix the tip amount above first, so the tracking page shows what you sent.");
        return $("tp-custom").focus();
      }
      tipTrack(tx);
    });
  }

  // ---------------- pay: batch ----------------
  function renderBatch(b) {
    show("batch");
    $("batch").dataset.mode = b.tx ? "receipt" : "request";
    showSealBadge("bp-sealed");
    $("bp-kicker").textContent = b.tx ? "pay list progress" : "pay list";
    document.title = (b.tx ? "tracking: " : "") + (b.label || "pay list") + " · zkSEND";
    $("bp-title").textContent = b.label || "pay list";
    $("bp-count").textContent = `${b.rows.length} payment${b.rows.length === 1 ? "" : "s"}`;
    $("bp-testnet").hidden = !b.rows[0].testnet;
    $("bp-total").textContent = formatZec(b.total);
    const uri = multiUri(b.rows);
    $("bp-open").href = uri;
    $("bp-uri").textContent = uri;
    setQr($("bp-qr"), uri);
    const list = $("bp-rows");
    list.replaceChildren();
    b.rows.forEach((r, i) => {
      const li = el("li", "pay-row");
      const head = el("div", "pay-row-head");
      const done = el("input"); done.type = "checkbox"; done.id = "bp-done-" + i;
      done.setAttribute("aria-label", `mark payment ${i + 1} as sent`);
      done.onchange = () => li.classList.toggle("sent", done.checked);
      head.append(done, el("strong", "pay-amt", formatZec(r.zat) + " ZEC"), el("code", "fp", fingerprint(r.address)));
      li.append(head);
      if (r.memo) li.append(el("p", "pay-memo", "memo: " + r.memo));
      const acts = el("div", "row");
      const open = el("a", "act");
      open.href = paymentUri(r);
      open.append(glyph("▣"), "pay this one");
      acts.append(open, copyButton(() => r.address, "copy address"));
      li.append(acts);
      list.append(li);
    });
    drawSteps($("bp-steps"), 0, false);
    sentForm("bp", (tx) => go(fragBatch(b, tx)));
    if (b.tx) {
      $("bt-memo-row").hidden = true;
      $("bt-sealed-note").hidden = !currentSeal;
      const out = $("bt-links");
      out.replaceChildren();
      tracker("bt", b.tx, b.rows[0].testnet);
      const gen = trackGen, sealedList = !!currentSeal; // after tracker(), which bumps trackGen
      (async () => {
        for (const r of b.rows) {
          const frag = fragRequest({ address: r.address, zat: r.zat, memo: r.memo, label: b.label }, b.tx);
          let link = baseUrl() + frag, code = null;
          if (sealedList) { code = newCode(); link = baseUrl() + (await seal(frag.slice(1), code, ITER_GENERATED)); }
          if (gen !== trackGen) return; // navigated away
          const li = el("li");
          li.append(el("strong", "pay-amt", formatZec(r.zat) + " ZEC"), el("code", "fp", fingerprint(r.address)), copyButton(() => link, "copy their link"));
          if (code) { li.append(el("code", "code-small", code), copyButton(() => code, "copy code")); }
          out.append(li);
        }
      })();
    }
  }

  function route() {
    trackGen++;
    clearTimeout(expiryTimer);
    setMenu(false);
    const path = location.pathname.replace(/\/+$/, "") || "/";
    const page = PAGES[path];
    if (page) {
      VIEWS.forEach((v) => ($(v).hidden = v !== page.view));
      document.title = page.title + " · zkSEND";
      markNav(path.slice(1));
      return;
    }
    let p = parseFragment(location.hash);
    // Old in-page links (#faq, #how, ...) now live on their own pages.
    if (p && p.kind === "section" && LEGACY_SECTIONS[p.section]) { location.replace(LEGACY_SECTIONS[p.section]); return; }
    currentSeal = null;
    if (p && p.kind === "sealed") {
      const hit = opened.get(p.blob);
      if (!hit) {
        unlockBlob = p.blob;
        markNav("");
        show("sealed");
        document.title = "sealed link · zkSEND";
        showError("unlock-error");
        if (!canSeal()) showError("unlock-error", "This browser can't decrypt sealed links here. Open the link over https in an up-to-date browser.");
        setTimeout(() => $("unlock-code").focus(), 50);
        return;
      }
      p = parseFragment("#" + hit.plain);
      if (!p || p.kind === "sealed" || p.kind === "section") p = { error: "This sealed link doesn't contain a payment." };
      else currentSeal = { code: hit.code, iterations: hit.iterations };
    }
    markNav(!p || p.kind === "section" ? "home"
      : p.kind === "tip" && p.address === DEV_TIP.address ? "tip" : "");
    if (!p) return renderCreate();
    if (p.kind === "section") return renderCreate(p.section);
    if (p.error) { show("bad"); $("bad-msg").textContent = p.error; return; }
    if (p.kind === "tip") return renderTip(p);
    if (p.kind === "pay") return renderBatch(p);
    return renderPay(p);
  }
  window.addEventListener("hashchange", route);
  route();
})();
