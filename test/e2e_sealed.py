# Sealed links: python3 test/e2e_sealed.py
# Includes an independent decryptor (Python `cryptography`) to prove the format is plain PBKDF2-SHA256 + AES-256-GCM.
import json, subprocess, time, os, sys, re, base64, struct, urllib.parse
from playwright.sync_api import sync_playwright
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
UAS = json.load(open(os.path.join(HERE, "vectors.json")))["ua"]
TX = "9d" * 32
env = dict(os.environ, PORT="8781", COOKIE_SECURE="false", HSTS="false", POW_MODE="off", RATE_BURST="5000")
srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(0.8)
BASE = "http://127.0.0.1:8781/"
fails = []
def check(c, msg):
    print(("PASS " if c else "FAIL ") + msg)
    if not c: fails.append(msg)

def py_unseal(link, code):
    blob = urllib.parse.parse_qs(link.split("#", 1)[1])["s"][0]
    raw = base64.urlsafe_b64decode(blob + "=" * (-len(blob) % 4))
    ver, iters = raw[0], struct.unpack(">I", raw[1:5])[0]
    salt, iv, ct = raw[5:21], raw[21:33], raw[33:]
    k = re.sub(r"[^0-9A-Z]", "", code.upper()).replace("I", "1").replace("L", "1").replace("O", "0")
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iters).derive(k.encode())
    return ver, iters, AESGCM(key).decrypt(iv, ct, b"zksend-seal-v1").decode()

def blockchair(route):
    route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "application/json"},
                  body=json.dumps({"data": {TX: {"transaction": {"block_id": 3099998}}}, "context": {"state": 3100000}}))

def fresh(b):
    c = b.new_context(viewport={"width": 390, "height": 844}); c.route("https://api.blockchair.com/**", blockchair)
    c.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE.rstrip("/"))
    return c.new_page()

def unlock(pg, code):
    pg.fill("#unlock-code", code); pg.click("#unlock-btn"); pg.wait_for_timeout(700)

try:
  with sync_playwright() as p:
    b = p.chromium.launch()
    pg = fresh(b); reqs = []; errors = []
    pg.on("request", lambda r: reqs.append(r.url))
    pg.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") and not m.text.startswith("Failed to load resource") else None)
    pg.goto(BASE); pg.wait_for_timeout(200)

    # ---------- create a sealed request ----------
    check(pg.is_hidden("#r-seal-box") and not pg.is_checked("#r-seal"), "seal toggle is off by default")
    pg.fill("#r-addr", UAS[0]); pg.fill("#r-amount", "0.05"); pg.fill("#r-label", "secret sticker")
    memo = pg.text_content("#r-memo")
    pg.click(".switch[for=r-seal]"); pg.wait_for_timeout(100)
    code = pg.input_value("#r-code")
    check(pg.is_visible("#r-seal-box") and re.fullmatch(r"([0-9A-HJKMNP-TV-Z]{4}-){2}[0-9A-HJKMNP-TV-Z]{4}", code) is not None, "turning it on generates a 12-character (60-bit) code " + code)
    pg.click("#form-request button[type=submit]"); pg.wait_for_timeout(800)
    link = pg.input_value("#r-link")
    frag = link.split("#", 1)[1]
    check(list(urllib.parse.parse_qs(frag).keys()) == ["s"], "sealed link carries only #s=…")
    check(all(x not in link for x in (UAS[0][:12], memo, "secret", "0.05", "u1")), "address, memo, label and amount are not readable in the link")
    check(pg.is_visible("#r-sealed-out") and pg.text_content("#r-code-out") == code, "result shows the code to send separately")
    check("secret sticker" in pg.input_value("#r-md") or "Pay 0.05 ZEC" in pg.input_value("#r-md"), "pay-button snippets use the sealed link")
    ver, iters, plain = py_unseal(link, code)
    q = urllib.parse.parse_qs(plain)
    check(ver == 1 and iters == 200000 and q["u"] == [UAS[0]] and q["a"] == ["0.05"] and q["m"] == [memo] and q["n"] == ["secret sticker"],
          "independent Python decryptor opens it: PBKDF2-SHA256 (200k) + AES-256-GCM")
    check(not [u for u in reqs if not u.startswith(BASE)], "sealing is fully local: no network requests")

    # ---------- open it as the payer ----------
    pay = fresh(b); pay.goto(link); pay.wait_for_timeout(300)
    check(pay.is_visible("#sealed") and pay.is_hidden("#pay"), "opening a sealed link asks for the code")
    unlock(pay, "WRONG-CODE-0000-0000")
    check("doesn't open" in pay.text_content("#unlock-error") and pay.is_visible("#sealed"), "wrong code: refused")
    unlock(pay, code.lower().replace("-", " ").replace("0", "o"))
    check(pay.is_visible("#pay") and pay.text_content("#p-title") == "secret sticker" and pay.text_content("#p-memo") == memo, "right code (any case, spaces, O for 0) opens the pay page")
    check(pay.is_visible("#p-sealed") and "s=" in pay.url and UAS[0][:12] not in pay.url, "sealed badge shows; address bar still only has scrambled text")
    pay.fill("#p-sent-in", TX); pay.click("#p-sent-form button[type=submit]"); pay.wait_for_timeout(900)
    track = pay.url
    check(list(urllib.parse.parse_qs(track.split("#", 1)[1]).keys()) == ["s"] and TX not in track and pay.is_visible("#rc-tracker"),
          "I sent it: tracking page opens, its link is sealed too (txid hidden)")
    check(py_unseal(track, code)[2].endswith("tx=" + TX), "tracking link is sealed with the same code")
    pay.go_back(); pay.wait_for_timeout(500)
    check(pay.is_visible("#pay") and pay.is_hidden("#sealed"), "back button: no re-entering the code in the same tab")
    pay.reload(); pay.wait_for_timeout(500)
    check(pay.is_visible("#sealed"), "reload: asks again (nothing is stored)")

    # recipient opens the sealed tracking link
    rec = fresh(b); rec.goto(track); rec.wait_for_timeout(300); unlock(rec, code)
    check(rec.is_visible("#rc-tracker") and rec.text_content("#rc-tx") == TX, "recipient opens the sealed tracking link with the same code")

    # tampering
    blob = urllib.parse.parse_qs(link.split("#", 1)[1])["s"][0]
    bad = blob[:60] + ("A" if blob[60] != "A" else "B") + blob[61:]
    t = fresh(b); t.goto(BASE + "#s=" + bad); t.wait_for_timeout(200); unlock(t, code)
    check("doesn't open" in t.text_content("#unlock-error"), "a link altered by even one character won't open")
    t.goto(BASE + "#s=abc"); t.wait_for_timeout(150)
    check(t.is_visible("#bad"), "a truncated sealed link shows the broken-link page")

    # ---------- codes you choose: 8-12 characters, dashes appear as you type ----------
    pg.goto(BASE + "#request"); pg.wait_for_timeout(150)
    pg.fill("#r-addr", UAS[0]); pg.fill("#r-amount", "1")
    if not pg.is_checked("#r-seal"): pg.click(".switch[for=r-seal]")
    pg.fill("#r-code", ""); pg.locator("#r-code").press_sequentially("sun set 42 moon!", delay=20)
    check(pg.input_value("#r-code") == "SUNS-ET42-MOON", "dashes appear as you type; lowercase, spaces and symbols are tidied " + pg.input_value("#r-code"))
    pg.fill("#r-code", ""); pg.locator("#r-code").press_sequentially("abcdefghijklmnop", delay=10)
    check(len(pg.input_value("#r-code").replace("-", "")) == 12, "can't type more than 12 characters")
    for bad, why in [("SHORT7", "8 to 12"), ("11111111", "too easy"), ("12345678", "too easy"), ("ABABABAB", "too easy")]:
        pg.fill("#r-code", bad); pg.click("#form-request button[type=submit]"); pg.wait_for_timeout(250)
        check(why in pg.text_content("#r-error") and pg.is_hidden("#r-result"), f"rejected: {bad} ({why})")
    pg.fill("#r-code", "SUNSET42MOON"); pg.click("#form-request button[type=submit]"); pg.wait_for_timeout(1500)
    l2 = pg.input_value("#r-link")
    check(pg.text_content("#r-code-out") == "SUNS-ET42-MOON" and py_unseal(l2, "SUNSET42MOON")[1] == 600000, "a chosen code works and gets 600k iterations")
    o = fresh(b); o.goto(l2); o.wait_for_timeout(200); unlock(o, "sunset42moon"); o.wait_for_timeout(900)
    check(o.is_visible("#pay"), "it opens when typed in lowercase without dashes")
    # links sealed with the previous 16-character generated codes still open
    old_code = "NYPT-P3EJ-HK6E-9PBR"
    old_link = pg.evaluate("([p,c])=>ZkSend.seal(p,c,100000)", [f"u={UAS[0]}&a=0.05&m=legacy", old_code])
    ol = fresh(b); ol.goto(BASE + old_link); ol.wait_for_timeout(200)
    ol.locator("#unlock-code").press_sequentially(old_code.replace("-", "").lower(), delay=10)
    check(ol.input_value("#unlock-code") == old_code, "unlock field accepts the older 16-character codes")
    ol.click("#unlock-btn"); ol.wait_for_timeout(800)
    check(ol.is_visible("#pay") and ol.text_content("#p-memo") == "legacy", "links sealed with older codes still open")

    # ---------- expired + sealed ----------
    pg.goto(BASE + "#request"); pg.wait_for_timeout(100)
    plain_expired = f"u={UAS[0]}&a=0.05&m=x&x={int(time.time()) - 60}"
    sealed_expired = pg.evaluate("([p,c])=>ZkSend.seal(p,c,ZkSend.ITER_GENERATED)", [plain_expired, code])
    e = fresh(b); e.goto(BASE + sealed_expired); e.wait_for_timeout(200); unlock(e, code)
    check(e.is_visible("#expired"), "expiry still applies inside sealed links")

    # ---------- tip jar ----------
    pg.goto(BASE + "#tip"); pg.wait_for_timeout(150)
    pg.fill("#t-addr", UAS[1]); pg.fill("#t-label", "private jar")
    pg.click(".switch[for=t-seal]"); tcode = pg.input_value("#t-code")
    pg.click("#form-tip button[type=submit]"); pg.wait_for_timeout(800)
    tl = pg.input_value("#t-link")
    tp = fresh(b); tp.goto(tl); tp.wait_for_timeout(200); unlock(tp, tcode)
    check(tp.is_visible("#tip") and tp.is_visible("#tp-sealed") and tp.text_content("#tp-title") == "Tip private jar", "sealed tip jar opens with its code")
    tp.fill("#tp-msg", "hush"); tp.fill("#tp-sent-in", TX); tp.click("#tp-sent-form button[type=submit]"); tp.wait_for_timeout(900)
    check("s=" in tp.url and "hush" not in tp.url and "m=hush" in py_unseal(tp.url, tcode)[2], "tip tracking link stays sealed")

    # ---------- pay many ----------
    pg.goto(BASE + "#batch"); pg.wait_for_timeout(150)
    pg.fill("#b-list", f"{UAS[0]}, 1, a\n{UAS[1]}, 2, b\n{UAS[2]}, 3, c"); pg.fill("#b-label", "quiet payroll")
    pg.click(".switch[for=b-seal]"); bcode = pg.input_value("#b-code")
    pg.click("#form-batch button[type=submit]"); pg.wait_for_timeout(800)
    bl = pg.input_value("#b-link")
    bp = fresh(b); bp.goto(bl); bp.wait_for_timeout(200); unlock(bp, bcode)
    check(bp.is_visible("#batch") and bp.is_visible("#bp-sealed") and bp.text_content("#bp-total") == "6", "sealed pay list opens")
    bp.fill("#bp-sent-in", TX); bp.click("#bp-sent-form button[type=submit]"); bp.wait_for_timeout(1500)
    bp.wait_for_function("()=>document.querySelectorAll('#bt-links li').length===3")
    check("s=" in bp.url and bp.is_visible("#bt-sealed-note"), "list tracking link is sealed")
    codes = bp.locator("#bt-links .code-small").all_text_contents()
    check(len(codes) == 3 and len(set(codes)) == 3 and bcode not in codes, "each person gets a different code (not the list code)")
    bp.click("#bt-links li >> nth=1 >> button >> nth=0"); bp.wait_for_timeout(100)
    l_person = bp.evaluate("()=>navigator.clipboard.readText()")
    v, it, plain_person = py_unseal(l_person, codes[1])
    check(urllib.parse.parse_qs(plain_person).get("u") == [UAS[1]] and UAS[0] not in plain_person and UAS[2] not in plain_person, "person 2's link holds only their payment")
    pp = fresh(b); pp.goto(l_person); pp.wait_for_timeout(200); unlock(pp, bcode)
    check(pp.is_visible("#sealed"), "the list code does not open a person's link")
    unlock(pp, codes[1]); pp.wait_for_timeout(500)
    check(pp.is_visible("#rc-tracker") and pp.text_content("#rc-tx") == TX, "their own code does")

    # ---------- unsealed flow untouched + clear resets ----------
    pg.goto(BASE + "#request"); pg.wait_for_timeout(100); pg.click("#r-clear"); pg.wait_for_timeout(100)
    check(not pg.is_checked("#r-seal") and pg.is_hidden("#r-seal-box"), "clear turns sealing off")
    pg.fill("#r-addr", UAS[0]); pg.click("#form-request button[type=submit]"); pg.wait_for_timeout(300)
    check("u=" in pg.input_value("#r-link") and pg.is_hidden("#r-sealed-out"), "unsealed links work exactly as before")
    check(not errors, "no console errors " + str(errors[:2]))
    pg.goto(BASE + "#request"); pg.wait_for_timeout(100)
    pg.fill("#r-addr", UAS[0]); pg.fill("#r-amount", "0.05"); pg.fill("#r-label", "privacy"); pg.click(".switch[for=r-seal]"); pg.wait_for_timeout(100)
    pg.click("#form-request button[type=submit]"); pg.wait_for_timeout(800)
    pg.locator("#form-request").screenshot(path="/tmp/s-create.png")
    u = fresh(b); u.goto(pg.input_value("#r-link")); u.wait_for_timeout(300); u.screenshot(path="/tmp/s-unlock.png")
    unlock(u, pg.input_value("#r-code")); u.wait_for_timeout(400); u.screenshot(path="/tmp/s-pay.png")
    b.close()
finally:
    srv.terminate()
print("FAILURES:", fails); sys.exit(1 if fails else 0)
