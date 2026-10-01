# Desktop layout check: every page/state at 1060, 1190, 1440 and 1920px. Any content box narrower than
# the column must be centered in it, and the header and footer must line up with the content.
# Run: python3 test/desktop_balance.py
# Desktop balance check: any content box narrower than the column must be centered in it.
import json, subprocess, time, os, sys
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); UAS=json.load(open(ROOT+"/test/vectors.json"))["ua"]; TX="ab"*32; now=int(time.time())
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=dict(os.environ,PORT="8799",HSTS="false",POW_MODE="off",RATE_BURST="100000"),stdout=subprocess.DEVNULL);time.sleep(0.8)
B="http://127.0.0.1:8799"
batch="/#"+"&".join(["k=pay","n=October%20payroll"]+[f"pu={UAS[i]}&pa=1.5&pm=m{i}" for i in range(3)])
STATES=[("home","/",None),("home-tip","/#tip",None),("home-batch","/#batch",None),("sealed-result","/","sealresult"),
 ("pay",f"/#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&n=privacy&x={now+86000}",None),("tip",f"/#k=tip&u={UAS[1]}&n=zkGuides&p=0.01,0.05,0.1",None),
 ("batch",batch,None),("tracking",f"/#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&tx={TX}","track"),("batch-tracking",batch+f"&tx={TX}",None),
 ("unlock","/","unlock"),("expired",f"/#u={UAS[0]}&a=1&m=x&x={now-10}",None),("bad","/#u=u1bad&m=x",None),("popup","/","popup"),
 ("guide","/guide",None),("faq","/faq",None),("security","/security",None),("terms","/terms",None)]
JS="""()=>{const m=document.querySelector('main').getBoundingClientRect(); const cs=getComputedStyle(document.querySelector('main'));
 const L=m.left+parseFloat(cs.paddingLeft), R=m.right-parseFloat(cs.paddingRight), W=R-L; const bad=[];
 const vis=e=>{const s=getComputedStyle(e); if(s.display==='none'||s.visibility==='hidden') return false; const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;};
 for(const e of document.querySelectorAll('main .box, main .unlock, main .tracker, main .pay-grid, main .page-sec, main .page-head, main .steps, main .tabs, main #modes > form, main .amount, main .intro, main .check, main .sent-box, main .pay-rows')){
   if(!vis(e)) continue; const r=e.getBoundingClientRect(); const lg=r.left-L, rg=R-r.right;
   if(r.width<W*0.9 && Math.abs(lg-rg)>24) bad.push((e.id||e.className).toString().slice(0,30)+` w=${Math.round(r.width)}/${Math.round(W)} gaps ${Math.round(lg)}|${Math.round(rg)}`);
 }
 const top=document.querySelector('.top-inner').getBoundingClientRect(); const ft=document.querySelector('.foot').getBoundingClientRect();
 if(Math.abs(top.left-m.left)>2 || Math.abs(ft.left-m.left)>2) bad.push('header/footer not aligned with content');
 return bad;}"""
fails=0
with sync_playwright() as p:
    b=p.chromium.launch()
    for w,h in ((1060,800),(1190,760),(1440,900),(1920,1080)):
        ctx=b.new_context(viewport={"width":w,"height":h})
        ctx.route("https://api.blockchair.com/**",lambda r:r.fulfill(status=200,headers={"access-control-allow-origin":"*","content-type":"application/json"},body=json.dumps({"data":{TX:{"transaction":{"block_id":3099995}}},"context":{"state":3100000}})))
        pg=ctx.new_page(); sealed=None
        for name,url,act in STATES:
            if act=="unlock":
                pg.goto(B+"/"); pg.wait_for_timeout(100); pg.fill("#r-addr",UAS[0]); pg.click(".switch[for=r-seal]"); pg.click("#form-request button[type=submit]"); pg.wait_for_timeout(1500)
                url=pg.input_value("#r-link").replace(B,""); pg.goto(B+"/guide"); pg.wait_for_timeout(50)
            pg.goto(B+url); pg.wait_for_timeout(150)
            if act=="track": pg.click("#rc-go"); pg.wait_for_timeout(250)
            if act=="popup": pg.click(".switch[for=r-seal]"); pg.click("#form-request .help"); pg.wait_for_timeout(150)
            if act=="sealresult":
                pg.fill("#r-addr",UAS[0]); pg.fill("#r-amount","0.05"); pg.click(".switch[for=r-seal]"); pg.click("#form-request button[type=submit]"); pg.wait_for_timeout(1500)
            r=pg.evaluate(JS)
            if r: fails+=1; print(f"{w}px {name}: {r[:3]}")
            if len(sys.argv)>1 and w==1190: pg.screenshot(path=f"/tmp/bal/{sys.argv[1]}_{name}.png")
        ctx.close()
    b.close()
srv.terminate(); print(f"views checked: {len(STATES)*4}, unbalanced: {fails}"); print("FAILURES:", fails); sys.exit(1 if fails else 0)
