# Wallet hand-off + request expiry tests: python3 test/e2e_wallets.py
# Noir is simulated with its documented provider API (window.noirwallet.zcash.request).
import json, subprocess, time, os, sys, urllib.parse
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE); from zip321_check import parse
UAS = json.load(open(os.path.join(HERE, "vectors.json")))["ua"]
TX = "5a" * 32
env = dict(os.environ, PORT="8777", COOKIE_SECURE="false", HSTS="false", POW_MODE="off", RATE_BURST="1000")
srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(0.8)
BASE = "http://127.0.0.1:8777/"
fails = []
def check(c, msg):
    print(("PASS " if c else "FAIL ") + msg)
    if not c: fails.append(msg)

NOIR = """
window.__noir = { calls: [], mode: 'ok' };
function makeNoir() {
  window.noirwallet = { isNoirWallet: true, version: 'test', zcash: {
    on() {}, async request({ method, params }) {
      window.__noir.calls.push({ method, params: params || null });
      const m = window.__noir.mode;
      if (method === 'zcash_requestAccounts') return { shielded: 'u1test', transparent: 't1test' };
      if (method === 'zcash_sendTransaction') {
        if (m === 'cancel') { const e = new Error('User rejected'); e.code = 4001; throw e; }
        if (m === 'notx') return null;
        return '%s';
      }
      throw Object.assign(new Error('unsupported'), { code: -32601 });
    } } };
}
window.makeNoir = makeNoir;
if (!window.__lateNoir) makeNoir();
""" % TX.upper()

def blockchair(route):
    route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "application/json"},
                  body=json.dumps({"data": {TX: {"transaction": {"block_id": -1}}}, "context": {"state": 3100000}}))

try:
  with sync_playwright() as p:
    b = p.chromium.launch()
    # ---------- no Noir installed: button hidden ----------
    plain = b.new_context(viewport={"width": 390, "height": 844}).new_page()
    plain.goto(BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd"); plain.wait_for_timeout(150)
    check(plain.is_visible("#p-noir-btn") and "solid" not in plain.get_attribute("#p-noir-btn", "class"), "no Noir: button still shows, in the quieter style")
    plain.click("#p-noir-btn"); plain.wait_for_timeout(120)
    check(plain.is_visible("#p-noir-missing") and plain.get_attribute("#p-noir-missing a", "href") == "https://zknoir.com" and "tx=" not in plain.url,
          "no Noir: clicking explains how to get it, nothing sent")
    check(plain.is_visible(".wallet-hint") and "opens Zodl" in plain.text_content(".wallet-hint"), "wallet hint: open in wallet app works for Zodl, QR for other screens")
    check(plain.text_content("#p-amt-copy") == "0.05", "amount has its own copy button")
    # 'open in wallet app' that opens nothing -> explain
    plain.evaluate("()=>document.addEventListener('click',e=>{if(e.target.closest('a[href^=\"zcash:\"]'))e.preventDefault()},true)")
    plain.bring_to_front(); plain.click("#p-open"); plain.wait_for_timeout(1900)
    check(plain.is_visible("#p-help") and "may not support payment links" in plain.text_content("#p-help"), "open in wallet app did nothing -> help explains scanning / copying")

    # ---------- Noir installed ----------
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    ctx.add_init_script(NOIR); ctx.route("https://api.blockchair.com/**", blockchair)
    pg = ctx.new_page(); errors = []
    pg.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") and not m.text.startswith("Failed to load resource") else None)
    pg.goto(BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&n=privacy"); pg.wait_for_timeout(150)
    check(pg.is_visible("#p-noir-btn") and "solid" in pg.get_attribute("#p-noir-btn", "class") and pg.is_hidden("#p-noir-amt-row"), "Noir installed: 'pay with Noir' is a primary button")
    pg.click("#p-noir-btn"); pg.wait_for_timeout(300)
    calls = pg.evaluate("window.__noir && window.__noir.calls") or []
    send = [c for c in calls if c["method"] == "zcash_sendTransaction"]
    check([c["method"] for c in calls][:1] == ["zcash_requestAccounts"] and send and send[0]["params"] == [{"to": UAS[0], "amount": "0.05", "memo": "ZECINV-ab12cd", "fundingSource": "shielded"}],
          "Noir asked to send 0.05 ZEC, shielded, with the memo")
    q = urllib.parse.parse_qs(pg.url.split("#", 1)[1])
    check(q.get("tx") == [TX] and pg.is_visible("#rc-tracker") and pg.get_attribute("#rc-state", "data-state") in ("confirming", "searching"),
          "Noir returned the txid -> progress bar starts by itself")

    pg.goto(BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd"); pg.wait_for_timeout(120)
    pg.evaluate("window.__noir.mode='cancel'"); pg.click("#p-noir-btn"); pg.wait_for_timeout(200)
    check("cancelled" in pg.text_content("#p-noir-error") and "tx=" not in pg.url, "cancel in Noir: says so, stays on the pay page")
    pg.evaluate("window.__noir.mode='notx'"); pg.click("#p-noir-btn"); pg.wait_for_timeout(200)
    check("paste it" in pg.text_content("#p-noir-error"), "Noir sent but gave no txid: asks to paste it")

    pg.evaluate("window.__noir.mode='ok'")
    pg.goto(BASE + f"#u={UAS[0]}&m=ZECINV-ab12cd"); pg.wait_for_timeout(120)
    check(pg.is_visible("#p-noir-amt-row"), "open-amount request: Noir asks for an amount")
    pg.click("#p-noir-btn"); pg.wait_for_timeout(150)
    check("Enter the amount" in pg.text_content("#p-noir-error"), "no amount entered: nothing sent")
    pg.fill("#p-noir-amt", "0.3"); pg.click("#p-noir-btn"); pg.wait_for_timeout(250)
    last = [c for c in pg.evaluate("window.__noir.calls") if c["method"] == "zcash_sendTransaction"][-1]
    check(last["params"][0]["amount"] == "0.3" and "tx=" in pg.url, "entered amount is sent")

    pg.goto(BASE + f"#k=tip&u={UAS[1]}&n=zkGuides&p=0.01,0.05"); pg.wait_for_timeout(120)
    pg.fill("#tp-msg", "thanks!"); pg.click("#tp-noir-btn"); pg.wait_for_timeout(250)
    last = [c for c in pg.evaluate("window.__noir.calls") if c["method"] == "zcash_sendTransaction"][-1]
    q = urllib.parse.parse_qs(pg.url.split("#", 1)[1])
    check(last["params"][0] == {"to": UAS[1], "amount": "0.01", "memo": "thanks!", "fundingSource": "shielded"} and q.get("tx") == [TX] and q.get("n") == ["Tip for zkGuides"],
          "tip with Noir: amount + private message sent, progress page opens")

    # Noir that loads after the page (extension injects late)
    late = b.new_context(viewport={"width": 390, "height": 844}); late.add_init_script("window.__lateNoir = true;" + NOIR)
    lp = late.new_page(); lp.goto(BASE + f"#u={UAS[0]}&a=0.05&m=x"); lp.wait_for_timeout(150)
    quiet_before = "solid" not in lp.get_attribute("#p-noir-btn", "class")
    lp.evaluate("()=>{makeNoir(); window.dispatchEvent(new Event('noirwallet#initialized'))}"); lp.wait_for_timeout(150)
    check(quiet_before and "solid" in lp.get_attribute("#p-noir-btn", "class"), "Noir that loads late: button switches to primary")
    lp.click("#p-noir-btn"); lp.wait_for_timeout(250)
    check("tx=" in lp.url, "late-loaded Noir can pay")
    # Noir finishing its load must not interrupt a progress bar that's already running
    late2 = b.new_context(viewport={"width": 390, "height": 844}); late2.add_init_script("window.__lateNoir = true;" + NOIR)
    late2.route("https://api.blockchair.com/**", blockchair)
    l2 = late2.new_page(); l2.goto(BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd"); l2.wait_for_timeout(150)
    l2.fill("#p-sent-in", TX); l2.click("#p-sent-form button[type=submit]"); l2.wait_for_timeout(250)
    before = l2.get_attribute("#rc-state", "data-state")
    l2.evaluate("()=>{makeNoir(); window.dispatchEvent(new Event('noirwallet#initialized'))}"); l2.wait_for_timeout(200)
    check(before in ("confirming", "searching") and l2.get_attribute("#rc-state", "data-state") == before, "Noir loading late doesn't reset a running progress bar")

    # ---------- request expiry ----------
    pg.goto(BASE); pg.wait_for_timeout(120)
    pg.fill("#r-addr", UAS[0]); pg.select_option("#r-expiry", "1"); pg.click("#form-request button[type=submit]")
    x = int(urllib.parse.parse_qs(pg.input_value("#r-link").split("#", 1)[1])["x"][0])
    check(abs(x - (time.time() + 3600)) < 120, "1-hour expiry stored in the link")
    pg.select_option("#r-expiry", "0"); pg.click("#form-request button[type=submit]")
    check("x" not in urllib.parse.parse_qs(pg.input_value("#r-link").split("#", 1)[1]), "'never' adds no expiry")
    now = int(time.time())
    pg.goto(BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&n=privacy&x={now - 60}"); pg.wait_for_timeout(150)
    check(pg.is_visible("#expired") and pg.is_hidden("#pay") and "for privacy expired" in pg.text_content("#expired-msg"), "expired request: no pay page, explains")
    pg.goto(BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&x={now - 60}&tx={TX}"); pg.wait_for_timeout(150)
    check(pg.is_visible("#rc-tracker"), "tracking link still works after the request expired")
    pg.goto(BASE + f"#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&x={now + 5400}"); pg.wait_for_timeout(150)
    check(pg.is_visible("#p-expires") and pg.text_content("#p-expires").startswith("expires in 1 h 3"), "pay page shows time left")
    pg.goto(BASE + f"#u={UAS[0]}&a=0.05&m=x&x=12ab"); pg.wait_for_timeout(100)
    check(pg.is_visible("#bad"), "garbled expiry: broken-link page")
    ck = b.new_context(viewport={"width": 390, "height": 844}).new_page(); ck.clock.install()
    ck.goto(BASE + f"#u={UAS[0]}&a=0.05&m=x&x={int(time.time()) + 120}"); ck.wait_for_timeout(150)
    visible_before = ck.is_visible("#pay")
    ck.clock.run_for(125000); ck.wait_for_timeout(150)
    check(visible_before and ck.is_visible("#expired"), "an open pay page switches to 'expired' when time runs out")
    check(not errors, "no console errors " + str(errors[:2]))
    b.close()
finally:
    srv.terminate()
print("FAILURES:", fails); sys.exit(1 if fails else 0)
