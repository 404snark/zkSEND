# Responsive audit: every page/state at 17 screen sizes (320px phones to 2560px monitors).
# Fails on: sideways overflow, anything off screen, header items overlapping or wrapping,
# fields under 16px (iPhone zooms on those), text under 11px, and tap targets under 36px on touch-size screens.
# Run: python3 test/responsive.py
import json, subprocess, time, os, sys, collections
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UAS=json.load(open(ROOT+"/test/vectors.json"))["ua"]
TX="ab"*32
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=dict(os.environ,PORT="8787",HSTS="false",POW_MODE="off",RATE_BURST="100000"),stdout=subprocess.DEVNULL);time.sleep(0.8)
B="http://127.0.0.1:8787"
VIEWPORTS=[(320,568),(1000,700),(1060,800),(1100,800),(360,740),(375,667),(390,844),(414,896),(430,932),(844,390),(932,430),(768,1024),(1024,768),(1280,800),(1440,900),(1920,1080),(2560,1440)]
now=int(time.time())
STATES=[("home","/",None),("home-tip","/#tip",None),("home-batch","/#batch",None),
 ("pay",f"/#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&n=privacy&x={now+86000}",None),
 ("tip",f"/#k=tip&u={UAS[1]}&n=zkGuides&p=0.01,0.05,0.1",None),
 ("batch","/#"+"&".join(["k=pay","n=October%20payroll"]+[f"pu={UAS[i]}&pa=1.5&pm=memo%20{i}" for i in range(3)]),None),
 ("tracking",f"/#u={UAS[0]}&a=0.05&m=ZECINV-ab12cd&n=privacy&tx={TX}","track"),
 ("sealed","/#s="+"A"*120,None),("expired",f"/#u={UAS[0]}&a=1&m=x&x={now-10}",None),("bad","/#u=u1bad&m=x",None),
 ("guide","/guide",None),("faq","/faq","openfaq"),("security","/security",None),("terms","/terms",None),("popup","/","popup")]
JS="""(vw)=>{
 const out={overflow:false,offscreen:[],small:[],zoominputs:[],overlap:false,tiny_targets:[]};
 const de=document.documentElement; out.overflow = de.scrollWidth > de.clientWidth + 1;
 const vis=e=>{const s=getComputedStyle(e); if(s.display==='none'||s.visibility==='hidden'||+s.opacity===0) return false; const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;};
 const inScroller=e=>{for(let p=e.parentElement;p;p=p.parentElement){const o=getComputedStyle(p).overflowX; if(o==='auto'||o==='scroll'||o==='hidden') return true;} return false;};
 for(const e of document.querySelectorAll('body *')){ if(!vis(e)) continue; const r=e.getBoundingClientRect();
   if(r.right>window.innerWidth+1 && !inScroller(e) && !e.closest('[popover]:not(:popover-open)')) out.offscreen.push((e.id?'#'+e.id:e.tagName.toLowerCase()+'.'+[...e.classList].join('.'))+' r='+Math.round(r.right));
   for(const n of e.childNodes){ if(n.nodeType===3 && n.textContent.trim()){ const fs=parseFloat(getComputedStyle(e).fontSize); if(fs<11) out.small.push((e.id||e.className||e.tagName)+':'+fs.toFixed(1)); break; } } }
 for(const e of document.querySelectorAll('input:not([type=checkbox]),textarea,select')){ if(!vis(e)) continue; const fs=parseFloat(getComputedStyle(e).fontSize); if(fs<16) out.zoominputs.push((e.id||e.tagName)+':'+fs.toFixed(1)); }
 const nav=document.getElementById('nav'), cta=document.querySelector('.top-cta'), wm=document.querySelector('.wordmark');
 if(vis(nav) && getComputedStyle(nav).position!=='absolute'){ const a=[...nav.querySelectorAll('a')].filter(vis).map(x=>x.getBoundingClientRect()); const right=Math.max(...a.map(x=>x.right)); if(right>cta.getBoundingClientRect().left-8 || a.some(x=>x.top>wm.getBoundingClientRect().bottom)) out.overlap=true; }
 for(const e of [...document.querySelectorAll('.top nav a, .top-cta, .wordmark strong')].filter(vis)){ const lh=parseFloat(getComputedStyle(e).lineHeight)||parseFloat(getComputedStyle(e).fontSize)*1.4; const r=e.getBoundingClientRect(); if(getComputedStyle(document.getElementById('nav')).position!=='absolute' || !e.closest('#nav')) { const textH=[...e.getClientRects()].length; if(textH>1 || (e.closest('#nav') && r.height>lh*1.6)) out.overlap=true; } }
 if(vw<=932) for(const e of document.querySelectorAll('.act,.preset,.tabs button,.help,#menu-toggle,.switch')){ if(!vis(e)) continue; const r=e.getBoundingClientRect(); if(r.height<36) out.tiny_targets.push((e.id||e.className)+':'+Math.round(r.height)); }
 return out; }"""
issues=collections.defaultdict(list)
with sync_playwright() as p:
    b=p.chromium.launch()
    for (w,h) in VIEWPORTS:
        ctx=b.new_context(viewport={"width":w,"height":h},device_scale_factor=1)
        ctx.route("https://api.blockchair.com/**",lambda r:r.fulfill(status=200,headers={"access-control-allow-origin":"*","content-type":"application/json"},body=json.dumps({"data":{TX:{"transaction":{"block_id":3099995}}},"context":{"state":3100000}})))
        pg=ctx.new_page()
        for name,url,act in STATES:
            pg.goto(B+url); pg.wait_for_timeout(120)
            if act=="track": pg.click("#rc-go"); pg.wait_for_timeout(250)
            if act=="openfaq": pg.evaluate("()=>document.querySelectorAll('details').forEach(d=>d.open=true)")
            if act=="popup": pg.click(".switch[for=r-seal]"); pg.click("#form-request .help"); pg.wait_for_timeout(150)
            r=pg.evaluate(JS,w)
            for k in ("overflow","overlap"):
                if r[k]: issues[k].append(f"{w}x{h} {name}")
            for k in ("offscreen","small","zoominputs","tiny_targets"):
                if r[k]: issues[k].append(f"{w}x{h} {name}: {sorted(set(r[k]))[:4]}")
        ctx.close()
    b.close()
srv.terminate()
print(f"checked {len(VIEWPORTS)} screen sizes x {len(STATES)} pages/states = {len(VIEWPORTS)*len(STATES)}")
for k in ("overflow","offscreen","overlap","zoominputs","small","tiny_targets"):
    v=issues[k]; print(f"\n== {k}: {len(v)}"); [print("  ",x) for x in v[:12]]
total=sum(len(v) for v in issues.values())
print("\nFAILURES:", total); sys.exit(1 if total else 0)
