# zkSEND

Shielded payment links for Zcash. Make a request, a tip jar, or a pay-many list, and share it as a
link. The payer scans the QR code (or opens their wallet) and the amount and memo are already filled in.

Live at [zksend.net](https://zksend.net). Built for the Zecathon shielded payments track by
[@404snark_](https://x.com/404snark_).

## Why

Asking for ZEC in Discord or on X usually means pasting an address, guessing an amount, forgetting
the memo, and then arguing about whether the payment landed. zkSEND puts all of that in one link,
and it keeps nothing on the server.

## What it does

- **Requests**: one payment with an amount, a label and a memo. Links expire after 24 hours by default (you can pick anything from 1 hour to never).
- **Tip jars**: a permanent link you can pin in a bio. Tippers pick an amount and can add a private message, which goes in the encrypted memo.
- **Pay many**: paste `address, amount, memo` lines (straight from a spreadsheet works) and pay everyone in one ZIP 321 transaction. There's a per-person fallback for wallets that don't support multi-payment links.
- **Progress bar**: after paying, the payer pastes the transaction ID and the page follows it from the mempool through 10 confirmations. Both sides can open the same tracking link.
- **Noir**: if the Noir browser wallet is installed, "pay with Noir" sends directly and the tracking starts by itself.
- **Pay buttons**: HTML and Markdown snippets, so a request can go on a site or in a Discord post.

## Privacy

Everything about a payment lives in the URL fragment (the part after `#`), which browsers never send
to the server. The server only ever serves one static page. There's no database, no accounts, no
analytics, and it never holds keys or funds.

The one outside request the page can make is the status check. When you track a payment, your browser
asks Blockchair about that transaction ID directly. Blockchair sees your IP and the ID, not amounts,
addresses or memos. Set `STATUS_CHECK=off` to remove it.

Railway (or whatever host you use) still logs page loads with IPs, like any website. Those logs never
contain payment details.

## Wallet support

Links follow [ZIP 321](https://zips.z.cash/zip-0321), and the test suite checks every generated link
against the reference parser. "Open in wallet app" works with wallets that register `zcash:` links,
including current Zodl on iOS and Android. If nothing opens, the page suggests scanning the QR code
from inside the wallet instead.

## Bot protection

The server rate-limits per visitor and per proxy hop, and shows a small proof-of-work puzzle when
someone floods it or the site gets busy. There's no third-party captcha. IPs are only held in memory as
HMACs under a key that rotates every hour.

## Running it

Node 20+, no dependencies.

```bash
node build.js     # inlines CSS/JS/fonts into dist/ and computes the CSP hashes
npm start         # http://localhost:8080  (use COOKIE_SECURE=false HSTS=false over plain http)
npm test          # server tests
```

The browser tests need Python with `playwright`, `zxing-cpp` and `zcash-uri`:

```bash
python3 test/e2e.py && python3 test/e2e_track.py && python3 test/e2e_wallets.py
```

Edit `template.html`, `style.css` and `app.js`, not `dist/`. The build regenerates the CSP hashes,
and a hand-edited `dist/` will break them.

## Deploying on Railway

Push the repo and create a Railway project from it. It picks up the `Dockerfile` and `railway.json`
on its own. Generate a domain (or add your own under Networking) and check `/healthz` returns `ok`.
Keep it at one replica. One instance handles far more traffic than this will ever see.

If you move to a new repo, reconnect the existing service under Settings → Source rather than
starting a new project, so the custom domain carries over.

Optional settings:

| variable | default | what it does |
|---|---|---|
| `STATUS_CHECK` | `on` | `off` removes live tracking and blocks all outside requests |
| `POW_MODE` | `auto` | `always` makes everyone solve the puzzle once an hour, `off` just returns 429 |
| `POW_BITS` | `18` | puzzle difficulty (each +1 doubles the work) |
| `RATE_BURST` | `20` | page loads per visitor before the puzzle |
| `CLIENT_IP_SOURCE` | `xff` | try `x-real-ip` if everyone suddenly gets the puzzle at once |
| `POW_SECRET` | random | only needed if you run more than one replica |

There are a few more knobs in the `CFG` block at the top of `server.js`.

## Before launch

- Pay a small real request from each wallet you expect people to use, and check the memo arrives.
- Watch the progress bar go all the way to complete on the live site.
- Try pay many with two recipients in each wallet.
- Check that an expired link and a broken link both show the right page.

## Credits

- [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (SIL OFL 1.1, see `fonts/`)
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT)
- Transaction status from the [Blockchair API](https://blockchair.com/api)

MIT licensed. See `LICENSE`.
