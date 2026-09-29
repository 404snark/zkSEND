// Inlines CSS + JS into each page and records the CSP hashes the server sends.
// Usage: node build.js   (runs automatically in the Docker build)
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const r = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const h = (s) => `'sha256-${crypto.createHash("sha256").update(s, "utf8").digest("base64")}'`;

function page(template, css, js) {
  if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error("closing tag inside inline asset");
  return {
    html: template.replace("__SCRIPT_HASH__", h(js)).replace("__STYLE_HASH__", h(css))
      .replace("__STYLE__", () => css).replace("__SCRIPT__", () => js),
    scriptHash: h(js), styleHash: h(css),
  };
}

// Fonts are embedded so visitors never contact a font host (JetBrains Mono, SIL OFL 1.1; see fonts/).
const font = (w) => fs.readFileSync(path.join(__dirname, "fonts", `jetbrains-mono-latin-${w}-normal.woff2`)).toString("base64");
const appCss = r("style.css").replace("__FONT_400__", font(400)).replace("__FONT_700__", font(700));
const img = (f) => fs.readFileSync(path.join(__dirname, "img", f)).toString("base64");
const pfp = img("pfp-404snark.png"), favicon = img("favicon-52.png"), touchIcon = img("apple-touch-icon-182.png");
const withIcons = (html) => html.replace("__FAVICON__", favicon).replace("__TOUCHICON__", touchIcon);
const app = page(withIcons(r("template.html")).replace("__PFP__", pfp), appCss, r("qrlib.min.js") + "\n" + r("app.js"));
const pow = page(withIcons(r("challenge.template.html")), r("challenge.css"), r("challenge.js"));
const out = path.join(__dirname, "dist");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), app.html);
fs.writeFileSync(path.join(out, "challenge.html"), pow.html);
fs.writeFileSync(path.join(out, "csp.json"), JSON.stringify({
  app: { script: app.scriptHash, style: app.styleHash },
  challenge: { script: pow.scriptHash, style: pow.styleHash },
}, null, 2));
console.log(`built dist/index.html (${Buffer.byteLength(app.html)} B), dist/challenge.html (${Buffer.byteLength(pow.html)} B)`);
