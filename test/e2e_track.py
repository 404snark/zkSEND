# Progress bar / tracking / dev tip tests: python3 test/e2e_track.py
# Blockchair is simulated (so we can also check exactly what the browser sends it), and the
# page clock is faked so a full payment (search -> 10 confirmations -> 4 h clear) runs in seconds.
import json, subprocess, time, os, sys, urllib.parse, re
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE); from zip321_check import parse
UAS = json.load(open(os.path.join(HERE, "vectors.json")))["ua"]
DEV = "u12ggdvur6ed7ep6kp0ygcedxjlklzfr2800snnthhg0xj8yhl3ruugtmann5kqhupup3z955dn8vczrffj0d2awm9qyrwwleq0jchn5jnmzrquft85tx2vkwddj8fn490ljzcf4350ned0qaxfr037tdh2lhpjwtfxumksdy7vgth8akv"
TX = "3f" * 32
env = dict(os.environ, PORT="8770", COOKIE_SECURE="false", HSTS="false", POW_MODE="off", RATE_BURST="1000")
srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(0.8)
BASE = "http://127.0.0.1:8770/"
fails = []
def check(c, msg):
    print(("PASS " if c else "FAIL ") + msg)
    if not c: fails.append(msg)

# Blockchair simulator. chain["confs"]: None = not on the network, 0 = mempool, n = confirmations.
sent = []; chain = {"confs": None, "status": 200}
TIP = 3100000
def blockchair(route):
    req = route.request
    sent.append({"url": req.url, "method": req.method, "headers": req.headers})
    h = {"access-control-allow-origin": "*", "content-type": "application/json"}
    if chain["status"] == "abort": return route.abort()
    if chain["status"] != 200: return route.fulfill(status=chain["status"], headers=h, body="{}")
    if chain["confs"] is None: return route.fulfill(status=404, headers=h, body='{"data":null,"context":{"code":404}}')
    block = -1 if chain["confs"] == 0 else TIP - chain["confs"] + 1
    body = {"data": {TX: {"transaction": {"block_id": block, "hash": TX, "time": "2026-09-28 22:31:05"}}}, "context": {"code": 200, "state": TIP}}
    return route.fulfill(status=200, headers=h, body=json.dumps(body))

try:
  with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.route("https://api.blockchair.com/**", blockchair)
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE.rstrip("/"))
    pg = ctx.new_page(); errors = []
    pg.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") and not m.text.startswith("Failed to load resource") else None)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.clock.install()
    steps = lambda sel: pg.evaluate(f"()=>[...document.querySelectorAll('{sel} li')].map(li=>li.className)")
    state = lambda pfx: (pg.get_attribute(f"#{pfx}-state", "data-state"), pg.text_content(f"#{pfx}-state"))
    def tick(ms):
        pg.clock.run_for(ms); pg.wait_for_timeout(120)

    # ---------- payer: pay -> "I sent it" -> searching -> confirming 0..10 -> complete ----------
    pg.goto(BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&n=Stickers"); pg.wait_for_timeout(150)
    check(steps("#p-steps") == ["active", "todo", "todo", "todo", "todo"], "pay page: step 1 (pay) is active")
    check([x.strip() for x in pg.locator("#p-steps li .l").all_text_contents()] == ["pay", "sent", "on the network", "confirming", "complete"], "five stages named")
    pg.fill("#p-sent-in", "nope"); pg.click("#p-sent-form button[type=submit]")
    check("64 characters" in pg.text_content("#p-sent-error") and not sent, "bad transaction ID: explained, nothing sent")
    pg.fill("#p-sent-in", TX.upper()); pg.click("#p-sent-form button[type=submit]"); pg.wait_for_timeout(200)
    check(urllib.parse.parse_qs(pg.url.split("#", 1)[1]).get("tx") == [TX] and pg.is_visible("#rc-tracker"), "I sent it -> progress page (link now carries the txid)")
    check(len(sent) == 1 and state("rc") == ("searching", "searching the network…"), "tracking starts right away, searching")
    check(steps("#rc-steps") == ["done", "done", "active", "todo", "todo"] and "searching" in pg.get_attribute("#rc-meter", "class"), "stepper at 'on the network', searching animation")
    q = sent[-1]
    check(q["url"] == "https://api.blockchair.com/zcash/dashboards/transaction/" + TX and q["method"] == "GET" and "cookie" not in q["headers"] and "referer" not in q["headers"],
          "only the txid is sent: plain GET, no cookies, no referrer")

    tick(29000); check(len(sent) == 1, "waits ~30 s between searches")
    chain["confs"] = 0; tick(2000)
    check(state("rc") == ("confirming", "confirming: 0 of 10") and steps("#rc-steps") == ["done", "done", "done", "active", "todo"], "found on the network -> confirming 0 of 10")
    chain["confs"] = 1; tick(30000)
    check(state("rc")[1] == "confirming: 1 of 10" and pg.get_attribute("#rc-meter", "aria-valuenow") == "1"
          and pg.evaluate("()=>document.getElementById('rc-fill').style.width") == "10%", "1 confirmation: bar at 10%")
    for n in range(2, 10):
        chain["confs"] = n; tick(45000)
    check(state("rc")[1] == "confirming: 9 of 10" and pg.evaluate("()=>document.getElementById('rc-fill').style.width") == "90%", "bar follows confirmations up to 9 of 10")
    chain["confs"] = 10; tick(45000)
    check(state("rc") == ("complete", "complete") and steps("#rc-steps") == ["done"] * 5 and pg.is_hidden("#rc-go"), "10 confirmations -> complete, every step done")
    check("stored nothing" in pg.text_content("#rc-detail") and "4 hours" in pg.text_content("#rc-detail"), "complete message: nothing stored, clears in 4 hours")
    n = len(sent); tick(30 * 60 * 1000)
    check(len(sent) == n, "tracking stops once complete")
    tick(4 * 60 * 60 * 1000)
    check(pg.is_visible("#create") and "#" not in pg.url.rstrip("#"), "4 hours after completion the tab clears itself")

    # ---------- recipient opens the shared link: nothing sent until they tap start ----------
    link = BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&n=Stickers&tx={TX}"
    sent.clear(); chain["confs"] = 4
    pg.goto(link); pg.wait_for_timeout(200)
    check(not sent and state("rc") == ("idle", "ready to track") and steps("#rc-steps") == ["done", "done", "active", "todo", "todo"], "recipient's view: ready, nothing sent yet")
    pg.click("#rc-share-copy"); pg.wait_for_timeout(100)
    check(pg.evaluate("()=>navigator.clipboard.readText()") == link, "copy tracking link = this page")
    pg.click("#rc-go"); pg.wait_for_timeout(200)
    check(state("rc")[1] == "confirming: 4 of 10" and len(sent) == 1, "start tracking picks up where the payment is")
    pg.click("#rc-clear"); pg.wait_for_timeout(150)
    check(pg.is_visible("#create") and "tx=" not in pg.url, "clear this page removes it from the address bar")
    n = len(sent); tick(10 * 60 * 1000)
    check(len(sent) == n, "leaving the page stops tracking")

    # ---------- can't find it after an hour; busy / offline retry ----------
    sent.clear(); chain["confs"] = None
    pg.goto(link); pg.wait_for_timeout(150); pg.click("#rc-go")
    pg.wait_for_function("()=>document.getElementById('rc-detail').textContent.includes('Still looking')")  # first answer is in
    for _ in range(123):  # 61.5 minutes, in the page's own 30 s polling steps
        pg.clock.run_for(30000); pg.wait_for_timeout(60)
        if pg.get_attribute("#rc-state", "data-state") == "lost": break
    check(state("rc")[0] == "lost" and "expired" in pg.text_content("#rc-detail"), "after an hour unseen: explains it probably expired")
    n = len(sent); tick(10 * 60 * 1000)
    check(len(sent) == n and pg.is_visible("#rc-go"), "stops searching, offers check now")
    pg.click("#rc-go"); pg.wait_for_timeout(250)
    check(pg.get_attribute("#rc-state", "data-state") == "searching", "check now after 'can't find it' starts a fresh search")
    chain["status"] = 430; pg.click("#rc-go"); pg.wait_for_timeout(150)
    check(state("rc") == ("error", "busy, retrying"), "rate limited: says busy, keeps going")
    chain["status"] = "abort"; tick(60000)
    check(state("rc")[1] == "connection problem, retrying", "offline: says so, keeps going")
    chain["status"] = 200; chain["confs"] = 12; tick(60000)
    check(state("rc")[0] == "complete", "recovers when the connection is back")

    # ---------- tip: "I sent the tip" carries the chosen amount and message ----------
    sent.clear(); chain["confs"] = 0
    pg.goto(BASE + f"#k=tip&u={UAS[1]}&n=zkGuides&p=0.01,0.05,0.1"); pg.wait_for_timeout(150)
    check(steps("#tp-steps")[0] == "active", "tip page shows the stepper")
    pg.click(".preset >> nth=2"); pg.fill("#tp-msg", "love the guide")
    pg.fill("#tp-sent-in", TX); pg.click("#tp-sent-form button[type=submit]"); pg.wait_for_timeout(200)
    check(urllib.parse.parse_qs(pg.url.split("#", 1)[1]) == {"u": [UAS[1]], "a": ["0.1"], "m": ["love the guide"], "n": ["Tip for zkGuides"], "tx": [TX]}
          and state("rc")[1] == "confirming: 0 of 10", "tip -> progress page with amount and message, tracking started")

    # ---------- pay many: payer tracks the whole list, each person gets their own link ----------
    sent.clear(); chain["confs"] = 2
    rows = [(UAS[0], "1.5", "Oct"), (UAS[1], "0.75", ""), (UAS[2], "0.25", "bounty")]
    frag = urllib.parse.urlencode([("k", "pay"), ("n", "October payroll")] + [x for r in rows for x in (("pu", r[0]), ("pa", r[1]), ("pm", r[2]))])
    pg.goto(BASE + "#" + frag); pg.wait_for_timeout(150)
    pg.fill("#bp-sent-in", TX); pg.click("#bp-sent-form button[type=submit]"); pg.wait_for_timeout(200)
    check(pg.is_visible("#bt-tracker") and pg.is_hidden("#bp-qr") and state("bt")[1] == "confirming: 2 of 10", "I sent everyone -> list progress page, tracking started")
    check(pg.locator("#bt-links li").count() == 3, "one tracking link per person")
    pg.click("#bt-links li >> nth=1 >> button"); pg.wait_for_timeout(100)
    l2 = pg.evaluate("()=>navigator.clipboard.readText()")
    check(urllib.parse.parse_qs(l2.split("#", 1)[1]) == {"u": [UAS[1]], "a": ["0.75"], "n": ["October payroll"], "tx": [TX]} and UAS[0] not in l2 and UAS[2] not in l2,
          "person 2's link shows only their own payment")
    pg.screenshot(path="/tmp/t-batch-track.png", full_page=True)
    pg.goto(l2); pg.wait_for_timeout(150)
    check(pg.is_visible("#rc-tracker") and pg.is_hidden("#rc-memo-row"), "their link opens their own progress page")

    # ---------- tip the dev, at the very end ----------
    pg.goto(BASE); pg.wait_for_timeout(150)
    check(pg.evaluate("()=>!!(document.getElementById('devtip').compareDocumentPosition(document.querySelector('main')) & Node.DOCUMENT_POSITION_PRECEDING)"), "tip the dev sits after all content")
    href = pg.get_attribute("#devtip-link", "href")
    check(href.startswith("/#") and urllib.parse.parse_qs(href.split("#", 1)[1]) == {"k": ["tip"], "u": [DEV], "n": ["the zkSEND dev"]}, "tip-the-dev link points at the dev address, no suggested amounts")
    pg.click("#devtip-link"); pg.wait_for_timeout(150)
    check(pg.is_visible("#tp-official") and parse(pg.get_attribute("#tp-open", "href"))[0]["address"] == DEV, "dev tip jar: official badge, pays the dev")
    check(pg.is_hidden("#tp-presets") and pg.text_content("#tp-custom-label") == "amount" and pg.text_content("#tp-amount") == "you choose", "dev tip jar: tipper enters their own amount")
    pg.fill("#tp-custom", "0.2"); check(parse(pg.get_attribute("#tp-open", "href"))[0]["amount"] == "0.2", "dev tip jar: typed amount goes into the payment link")
    pg.goto(BASE + "#k=tip&u=" + UAS[0] + "&n=the%20zkSEND%20dev"); pg.wait_for_timeout(100)
    check(pg.is_hidden("#tp-official"), "lookalike tip jar with another address gets no badge")

    # ---------- fixes from the final bug check ----------
    pg.goto(BASE + f"#k=tip&u={UAS[1]}&n=zkGuides&p=0.01,0.05"); pg.wait_for_timeout(120)
    pg.fill("#tp-custom", "abc"); pg.fill("#tp-sent-in", TX); pg.click("#tp-sent-form button[type=submit]"); pg.wait_for_timeout(120)
    check("tx=" not in pg.url and "Fix the tip amount" in pg.text_content("#tp-sent-error"), "tip: invalid amount blocks the tracking link")
    pg.click(".preset >> nth=0"); pg.click("#tp-sent-form button[type=submit]"); pg.wait_for_timeout(150)
    check("tx=" in pg.url and "a=0.01" in pg.url, "tip: fixed amount then works")
    pg.goto(BASE + "#k=tip&u=" + UAS[1]); pg.wait_for_timeout(80); pg.goto(BASE + "#batch"); pg.wait_for_timeout(80)
    pg.click(".top-cta"); pg.wait_for_timeout(120)
    check(pg.get_attribute("#tab-request", "aria-selected") == "true", "header 'new request' opens the request tab")

    # ---------- pages: guide, faq, security, terms ----------
    for path, view, h1 in [("guide", "#page-guide", "How zkSEND works"), ("faq", "#page-faq", "Questions"),
                           ("security", "#page-security", "Threat model"), ("terms", "#page-terms", "Terms of use")]:
        pg.goto(BASE + path); pg.wait_for_timeout(150)
        check(pg.is_visible(view) and pg.is_hidden("#create") and pg.text_content(view + " h1") == h1
              and pg.get_attribute(f'#nav a[data-nav="{path}"]', "aria-current") == "page", f"/{path} is its own page, highlighted in the nav")
    pg.goto(BASE + "faq/"); pg.wait_for_timeout(120)
    check(pg.is_visible("#page-faq"), "trailing slash works too")
    for old, new in [("#how", "guide"), ("#guide", "guide"), ("#faq", "faq"), ("#terms", "terms")]:
        pg.goto(BASE + old); pg.wait_for_timeout(250)
        check(pg.url == BASE + new, f"old {old} links redirect to /{new}")
    wide = b.new_page(viewport={"width": 1440, "height": 900}); wide.goto(BASE + "guide"); wide.wait_for_timeout(150)
    hs = wide.evaluate("()=>[...document.querySelectorAll('#page-guide .steps-list li')].map(li=>Math.round(li.getBoundingClientRect().height))")
    wide.close()
    # Normal paragraphs: 1-3 lines each on desktop. The old grid bug squeezed text into a 3rem column (up to ~360px).
    check(len(hs) == 5 and max(hs) < 150, f"guide steps read as paragraphs on desktop {hs}")
    check(pg.get_attribute(".foot .credit", "href") == "https://x.com/404snark_" and "noreferrer" in pg.get_attribute(".foot .credit", "rel")
          and pg.evaluate("()=>document.querySelector('.foot .pfp').naturalWidth") == 26, "footer: created by 404snark_ with pfp, links to X")
    links = [(a.strip().lower()) for a in pg.locator(".foot-links a").all_text_contents()]
    hrefs = [pg.get_attribute(f".foot-links a >> nth={i}", "href") for i in range(len(links))]
    check(links == ["home", "guide", "faq", "security", "terms", "tip the dev"] and hrefs[:5] == ["/", "/guide", "/faq", "/security", "/terms"] and hrefs[5].startswith("/#k=tip"),
          "footer has every menu link, like terms")
    pg.goto(BASE + "security"); pg.wait_for_timeout(120)
    sec = pg.text_content("#page-security")
    check(pg.locator("#page-security .tm tbody tr").count() == 7 and all(x in sec for x in ["zkSEND's server", "The hosting provider", "Blockchair", "Chat apps",
          "The Zcash blockchain", "How it's enforced", "can't protect against", "Report a problem"]), "security page: who-sees-what table, enforcement, limits, reporting")
    icon = pg.evaluate("()=>new Promise(r=>{const i=new Image();i.onload=()=>r([i.naturalWidth,i.naturalHeight]);i.onerror=()=>r(null);i.src=document.querySelector('link[rel=icon]').href})")
    touch = pg.evaluate("()=>new Promise(r=>{const i=new Image();i.onload=()=>r(i.naturalWidth);i.onerror=()=>r(null);i.src=document.querySelector('link[rel=apple-touch-icon]').href})")
    check(icon == [52, 52] and touch == 182, "tab icon is the pfp (52px), home-screen icon 182px")

    # ---------- mobile menu ----------
    pg.goto(BASE); pg.wait_for_timeout(100)
    check(pg.is_hidden("#nav a >> nth=1") and pg.is_visible("#create"), "mobile: menu closed by default; home shows the create form")
    pg.click("#menu-toggle"); pg.wait_for_timeout(80)
    check(pg.is_visible("#nav a >> nth=1") and pg.get_attribute("#menu-toggle", "aria-expanded") == "true", "mobile: menu opens")
    pg.click('#nav a[data-nav="guide"]'); pg.wait_for_timeout(300)
    check(pg.url == BASE + "guide" and pg.is_hidden("#nav a >> nth=1") and pg.get_attribute('#nav a[data-nav="guide"]', "aria-current") == "page", "mobile: menu link opens the page, menu closed, highlighted")
    check([t.strip().lower() for t in pg.locator("#nav a").all_text_contents()] == ["home", "guide", "faq", "security", "terms", "tip the dev"], "nav: home, guide, faq, security, terms, tip the dev")

    # ---------- FAQ promises; every answer starts collapsed ----------
    pg.goto(BASE + "faq"); pg.wait_for_timeout(150)
    faq = pg.text_content("#page-faq")
    check(all(x in faq for x in ["Does zkSEND store any data?", "There is no database", "Can the developers see my payments?", "Who made zkSEND?", "404snark_",
                                  "no access to any payment, address, amount, memo or transaction", "Does zkSEND ever touch my funds?", "Never."]), "FAQ states: no data stored, devs can't see payments, never touches funds")
    check(pg.locator("#page-faq details").count() == 16 and pg.evaluate("()=>[...document.querySelectorAll('#page-faq details')].every(d=>!d.open)"), "all 16 FAQ answers start collapsed")
    pg.goto(BASE + "terms"); pg.wait_for_timeout(120)
    check("The short version" not in pg.text_content("#page-terms"), "terms: short-version line removed")
    pg.goto(BASE); pg.wait_for_timeout(120)
    check(pg.get_attribute("#r-label", "placeholder") == "privacy", "request 'for' placeholder says privacy")
    # help popup next to "seal this link"
    pg.click(".switch[for=r-seal]"); pg.wait_for_timeout(80)
    check(pg.is_hidden("#seal-help"), "seal help is closed until asked")
    pg.click("#form-request .help"); pg.wait_for_timeout(200)
    check(pg.is_visible("#seal-help") and "Only people with the code" in pg.text_content("#seal-help"), "circled ? opens the sealed-link explanation")
    pg.click("#seal-help .act"); pg.wait_for_timeout(150)
    check(pg.is_hidden("#seal-help"), "'got it' closes it")
    pg.click("#form-request .help"); pg.wait_for_timeout(150); pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    check(pg.is_hidden("#seal-help"), "Escape closes it too")

    other = b.new_page(); other.goto(BASE); other.wait_for_timeout(100)
    check(other.evaluate("()=>fetch('https://example.com/x').then(()=>'sent',()=>'blocked')") == "blocked", "the page can't contact any other site")
    other.close()
    check(not errors, "no console errors " + str(errors[:2]))

    d = ctx.new_page(); d.clock.install(); chain["confs"] = 6
    d.goto(link); d.wait_for_timeout(150); d.click("#rc-go"); d.wait_for_timeout(200); d.screenshot(path="/tmp/t-progress.png", full_page=True)
    d.goto(BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&n=Stickers"); d.wait_for_timeout(150); d.screenshot(path="/tmp/t-paypage.png", full_page=True)
    b.close()
finally:
    srv.terminate()
print("FAILURES:", fails); sys.exit(1 if fails else 0)
