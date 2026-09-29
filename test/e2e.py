# Browser end-to-end test: python3 test/e2e.py  (needs playwright + zxing-cpp)
import json, re, subprocess, time, urllib.parse, os, sys
import zxingcpp
from PIL import Image
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE); from zip321_check import parse, official
V = json.load(open(os.path.join(HERE, "vectors.json"))); UAS, ZS = V["ua"], V["zs"]
env = dict(os.environ, PORT="8766", COOKIE_SECURE="false", HSTS="false", POW_BITS="14", RATE_BURST="12", RATE_PER_SEC="0.01")
srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(0.8)
BASE = "http://127.0.0.1:8766/"
fails = []
def check(c, msg):
    print(("PASS " if c else "FAIL ") + msg)
    if not c: fails.append(msg)
def qr_text(page, sel):
    page.query_selector(sel).screenshot(path="/tmp/q.png")
    d = zxingcpp.read_barcodes(Image.open("/tmp/q.png")); return d[0].text if d else None
try:
  with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE.rstrip("/"))
    pg = ctx.new_page(); errors = []; reqs = []
    ctx.route("https://api.blockchair.com/**", lambda r: r.fulfill(status=404, headers={"access-control-allow-origin": "*"}, body="{}"))
    # The browser logs the simulated Blockchair 404 as "Failed to load resource"; that's expected.
    pg.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") and not m.text.startswith("Failed to load resource") else None)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("request", lambda r: reqs.append(r.url))
    pg.goto(BASE); pg.wait_for_timeout(200)
    ev = lambda js, *a: pg.evaluate(js, *a)

    # ---------- validation ----------
    for ua in UAS: check(ev("a=>ZkSend.checkAddress(a).ok", ua), "valid UA vector " + ua[:14])
    check(ev("a=>ZkSend.checkAddress(a).ok", ZS), "valid zs1 vector")
    bad = UAS[0][:40] + ("q" if UAS[0][40] != "q" else "p") + UAS[0][41:]
    check(not ev("a=>ZkSend.checkAddress(a).ok", bad), "typo rejected")
    check(not ev("a=>ZkSend.checkAddress(a).ok", "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs"), "transparent rejected")
    check(ev("a=>ZkSend.checkAddress(a).ok", UAS[0][:50] + "\n  " + UAS[0][50:]), "address with line break accepted")
    check(ev("()=>ZkSend.parseZec('0,05').zat===5000000n && ZkSend.parseZec('.5').zat===50000000n"), "decimal comma and .5 accepted")
    check(ev("()=>ZkSend.cleanText('a\u202eb\u0000c  d', 80)") == "a b c d", "bidi/control characters stripped")

    # ---------- ZIP 321 multi-payment ----------
    rows = [{"address": UAS[i], "zat": z, "memo": m} for i, (z, m) in enumerate([(150000000, "Oct design, thanks!"), (75000000, ""), (1, "ünïcode ✓")])]
    uri = ev("r=>ZkSend.multiUri(r.map(x=>({...x, zat: BigInt(x.zat)})))", rows)
    got = parse(uri)
    check(uri.startswith("zcash:?address=") and [(g["address"], g["amount"], g["memo"]) for g in got] ==
          [(UAS[0], "1.5", "Oct design, thanks!"), (UAS[1], "0.75", None), (UAS[2], "0.00000001", "ünïcode ✓")], "multi-payment URI follows ZIP 321")
    one = parse(ev("r=>ZkSend.multiUri([{...r, zat: 5000000n}])", {"address": UAS[0], "memo": "x"}))
    check(one == [{"address": UAS[0], "amount": "0.05", "memo": "x", "message": None}], "single-row list uses the simple form")

    # ---------- batch parsing ----------
    pb = lambda text, memo="": ev("([t,m])=>{const r=ZkSend.parseBatch(t,m);return {n:r.rows.length,total:r.total.toString(),errs:r.errors.map(e=>e.line+':'+e.reason),memos:r.rows.map(x=>x.memo)}}", [text, memo])
    r = pb(f"address,amount,memo\n{UAS[0]}, 1.5, design, logo\n\n# comment\n{UAS[1]},0.25")
    check(r["n"] == 2 and r["total"] == "175000000" and r["memos"] == ["design, logo", ""] and not r["errs"], "CSV with header, comment, commas in memo")
    r = pb(f"{UAS[0]}\t0,5\tOct\n{UAS[1]}\t2", "payroll")
    check(r["n"] == 2 and r["total"] == "250000000" and r["memos"] == ["Oct", "payroll"], "spreadsheet paste with decimal comma and shared memo")
    r = pb(f"{UAS[0]}, 1\n{bad}, 1\n{UAS[1]}\n{UAS[2]}, abc")
    check(r["n"] == 1 and [e.split(":")[0] for e in r["errs"]] == ["2", "3", "4"], "per-line errors reported with line numbers")
    r = pb("\n".join(f"{UAS[i % 6]}, 0.01" for i in range(51)))
    check(any("limit is 50" in e for e in r["errs"]), "more than 50 payments rejected")

    # ---------- request (invoice) flow + legacy links ----------
    pg.fill("#r-addr", UAS[0]); pg.fill("#r-amount", "0.05"); pg.fill("#r-label", "Stickers")
    memo = pg.text_content("#r-memo"); check(re.fullmatch(r"ZECINV-[0-9a-f]{6}", memo) is not None, "request memo format")
    pg.click("#form-request button[type=submit]"); link = pg.input_value("#r-link")
    q = urllib.parse.parse_qs(link.split("#", 1)[1]); x = int(q.pop("x")[0])
    check(q == {"u": [UAS[0]], "a": ["0.05"], "m": [memo], "n": ["Stickers"]} and abs(x - (time.time() + 86400)) < 120, "request link: same fields plus a default 24-hour expiry")
    html = pg.input_value("#r-html")
    check(html.startswith('<a href="http://127.0.0.1:8766/#u=') and "&amp;a=0.05" in html and 'rel="noopener noreferrer"' in html and ">Pay 0.05 ZEC</a>" in html, "HTML pay button snippet escaped correctly")
    check(pg.input_value("#r-md") == f"[Pay 0.05 ZEC]({link})", "Markdown snippet")
    pg.screenshot(path="/tmp/n-create-request.png", full_page=True)
    pg.goto(link); pg.wait_for_timeout(150)
    u = pg.text_content("#p-uri")
    check(parse(u) == [{"address": UAS[0], "amount": "0.05", "memo": memo, "message": "Stickers"}] and qr_text(pg, "#p-qr svg") == u, "request page URI + QR")
    check(official(u) == [{"address": UAS[0], "zat": 5000000, "memo": memo}], "official ZIP 321 parser accepts the request URI")
    check(pg.is_visible(".note-stuck"), "stuck-payment note on request page")
    btn = pg.locator("#p-memo + button"); btn.click(); pg.wait_for_timeout(100)
    check(ev("()=>navigator.clipboard.readText()") == memo, "copy memo")
    pg.goto(BASE + f"#u={UAS[0]}&a=12.5&m=ORDER-1042&n=Order%201042"); pg.wait_for_timeout(150)
    check(pg.text_content("#p-memo") == "ORDER-1042" and pg.text_content("#p-amount") == "12.5", "checkout link with shop order ID works")
    pg.fill("#p-sent-in", "ab" * 32); pg.click("#p-sent-form button[type=submit]"); pg.wait_for_timeout(150)
    check(pg.text_content("#rc-tx") == "ab" * 32 and pg.text_content("#rc-memo") == "ORDER-1042" and "tx=" + "ab" * 32 in pg.url, "I sent it -> progress page for that transaction")

    # ---------- tip jar ----------
    pg.goto(BASE + "#tip"); pg.wait_for_timeout(150)
    check(pg.get_attribute("#tab-tip", "aria-selected") == "true" and pg.is_visible("#form-tip"), "#tip opens the tip tab")
    pg.fill("#t-addr", UAS[1]); pg.fill("#t-label", "zkGuides"); pg.fill("#t-presets", "0.1, 0.01 0.05 0.05")
    pg.click("#form-tip button[type=submit]"); tl = pg.input_value("#t-link")
    check(urllib.parse.parse_qs(tl.split("#", 1)[1]) == {"k": ["tip"], "u": [UAS[1]], "n": ["zkGuides"], "p": ["0.01,0.05,0.1"]}, "tip link: sorted, de-duplicated presets")
    pg.screenshot(path="/tmp/n-create-tip.png", full_page=True)
    pg.goto(tl); pg.wait_for_timeout(150)
    check(pg.text_content("#tp-title") == "Tip zkGuides" and pg.text_content("#tp-amount") == "0.05", "tip page defaults to the middle preset")
    check(parse(pg.text_content("#tp-uri"))[0]["memo"] == "tip for zkGuides", "default tip memo")
    pg.click(".preset >> text=0.1 ZEC"); pg.fill("#tp-msg", "great guide ✌")
    t = parse(pg.text_content("#tp-uri"))[0]
    check(t["amount"] == "0.1" and t["memo"] == "great guide ✌" and pg.get_attribute(".preset >> nth=2", "aria-pressed") == "true", "preset + private message go into the URI")
    check(qr_text(pg, "#tp-qr svg") == pg.text_content("#tp-uri") and pg.get_attribute("#tp-open", "href") == pg.text_content("#tp-uri"), "tip QR and wallet button follow the choice")
    check(official(pg.text_content("#tp-uri")) == [{"address": UAS[1], "zat": 10000000, "memo": "great guide ✌"}], "official parser accepts the tip URI (unicode memo)")
    pg.fill("#tp-custom", "0.333")
    check(parse(pg.text_content("#tp-uri"))[0]["amount"] == "0.333" and pg.get_attribute(".preset >> nth=2", "aria-pressed") == "false", "custom amount overrides presets")
    pg.fill("#tp-custom", "abc"); check("amount like" in pg.text_content("#tp-error") and parse(pg.text_content("#tp-uri"))[0]["amount"] is None, "bad custom amount: error, no amount in URI")
    pg.screenshot(path="/tmp/n-tip.png", full_page=True)

    # ---------- pay many ----------
    pg.goto(BASE + "#batch"); pg.wait_for_timeout(150)
    pg.fill("#b-list", f"{UAS[0]}, 1.5, October design\n{UAS[1]}\t0,75\n{UAS[2]}, 0.25, bounty #12"); pg.fill("#b-label", "October payroll"); pg.fill("#b-memo", "October")
    check(pg.text_content("#b-summary") == "3 payments, 2.5 ZEC total", "live batch summary")
    pg.click("#form-batch button[type=submit]"); bl = pg.input_value("#b-link")
    pg.screenshot(path="/tmp/n-create-batch.png", full_page=True)
    pg.goto(bl); pg.wait_for_timeout(150)
    check(pg.text_content("#bp-total") == "2.5" and pg.text_content("#bp-count") == "3 payments" and pg.locator(".pay-row").count() == 3, "pay list page totals")
    bu = pg.text_content("#bp-uri"); g = parse(bu)
    check([(x["address"], x["amount"], x["memo"]) for x in g] == [(UAS[0], "1.5", "October design"), (UAS[1], "0.75", "October"), (UAS[2], "0.25", "bounty #12")], "pay list URI: all three payments, shared memo filled in")
    check(qr_text(pg, "#bp-qr svg") == bu, "pay list QR decodes")
    check([(o["address"], o["zat"], o["memo"]) for o in official(bu)] == [(UAS[0], 150000000, "October design"), (UAS[1], 75000000, "October"), (UAS[2], 25000000, "bounty #12")],
          "official ZIP 321 parser accepts the multi-payment URI")
    row2 = parse(pg.get_attribute(".pay-row >> nth=1 >> a", "href"))
    check(row2 == [{"address": UAS[1], "amount": "0.75", "memo": "October", "message": None}], "pay-this-one link for a single row")
    pg.check("#bp-done-0"); check("sent" in pg.get_attribute(".pay-row >> nth=0", "class"), "tick off a row")
    pg.screenshot(path="/tmp/n-batch.png", full_page=True)
    big = "\n".join(f"{UAS[i % 6]}, 0.0{i % 9 + 1}, payment {i}" for i in range(20))
    pg.goto(BASE + "#batch"); pg.fill("#b-list", big); pg.click("#form-batch button[type=submit]")
    pg.goto(pg.input_value("#b-link")); pg.wait_for_timeout(150)
    check(pg.is_visible(".qr-too-long") and len(parse(pg.text_content("#bp-uri"))) == 20, "20-person list: no unscannable QR, URI still complete")
    pg.goto(BASE + "#batch"); pg.fill("#b-list", f"{UAS[0]}, 1\nnope, 2"); pg.click("#form-batch button[type=submit]")
    check(pg.locator("#b-errors li").count() == 1 and "line 2" in pg.text_content("#b-errors") and pg.is_hidden("#b-result"), "batch form shows line errors, no stale link")
    pg.goto(BASE + "#request"); pg.fill("#r-addr", UAS[0]); pg.click("#form-request button[type=submit]"); pg.fill("#r-amount", "9")
    check(pg.is_hidden("#r-result"), "editing a form hides the old link")

    # ---------- hostile / broken links ----------
    for name, frag in [("xss label", {"u": UAS[0], "m": "x", "n": '<img src=x onerror="window.pwned=1">'}),
                       ("xss tip", {"k": "tip", "u": UAS[0], "n": '<img src=x onerror="window.pwned=1">'})]:
        pg.goto(BASE + "#" + urllib.parse.urlencode(frag)); pg.wait_for_timeout(100)
        check(ev("()=>!window.pwned && !document.querySelector('main img')"), "inert: " + name)
    for name, frag in [("bad addr", "u=u1abc&m=x"), ("no memo", f"u={UAS[0]}"), ("bad amt", f"u={UAS[0]}&m=x&a=-1"),
                       ("tip bad preset", f"k=tip&u={UAS[0]}&p=abc"), ("list uneven", f"k=pay&pu={UAS[0]}&pa=1"),
                       ("list bad addr", f"k=pay&pu=u1x&pa=1&pm="), ("unknown kind", f"k=zzz&u={UAS[0]}")]:
        pg.goto(BASE + "#" + frag); pg.wait_for_timeout(80)
        check(pg.is_visible("#bad") and pg.is_hidden("#pay") and pg.is_hidden("#tip") and pg.is_hidden("#batch"), "broken-link page: " + name)

    # ---------- puzzle keeps the link ----------
    for _ in range(14): pg.goto(BASE, wait_until="domcontentloaded")
    pg.goto(tl, wait_until="domcontentloaded")
    pg.wait_for_selector("#tip:not([hidden])", timeout=30000)
    check(pg.text_content("#tp-title") == "Tip zkGuides", "tip link survives the puzzle")
    outside = [u for u in reqs if not u.startswith(BASE)]
    check(all(re.fullmatch(r"https://api\.blockchair\.com/zcash/dashboards/transaction/[0-9a-f]{64}", u) for u in outside),
          "only outside requests: Blockchair lookups of a bare transaction ID " + str([u for u in outside if "blockchair" not in u][:2]))
    check(not errors, "no console errors / CSP violations " + str(errors[:3]))
    for name, url in [("dark-tip", tl), ("dark-batch", bl)]:
        d = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, color_scheme="dark"); d.goto(url); d.wait_for_timeout(150); d.screenshot(path=f"/tmp/n-{name}.png", full_page=True); d.close()
    w = b.new_page(viewport={"width": 1280, "height": 900}); w.goto(bl); w.wait_for_timeout(150); w.screenshot(path="/tmp/n-batch-wide.png", full_page=True)
    b.close()
finally:
    srv.terminate(); out = srv.stdout.read().decode()
check(out.count("\n") <= 1, "server printed only its startup line")
print("FAILURES:", fails); sys.exit(1 if fails else 0)
