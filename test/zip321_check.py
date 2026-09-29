"""Independent ZIP 321 parser used by the e2e test to check URIs we generate."""
import base64, re
from urllib.parse import unquote

def parse(uri):
    assert uri.startswith("zcash:"), uri
    rest = uri[6:]
    path, _, query = rest.partition("?")
    payments = {}
    if path:
        payments[0] = {"address": path}
    for pair in filter(None, query.split("&")):
        k, eq, v = pair.partition("=")
        assert eq, f"param without '=': {pair}"
        m = re.fullmatch(r"([a-z]+)(?:\.([1-9]\d{0,3}))?", k)
        assert m, f"bad param name {k}"
        name, idx = m.group(1), int(m.group(2) or 0)
        assert name in ("address", "amount", "memo", "message", "label"), f"unknown param {name}"
        assert re.fullmatch(r"[A-Za-z0-9\-._~!$'()*+,;:@%]*", v), f"illegal chars in {k}"
        p = payments.setdefault(idx, {})
        assert name not in p, f"duplicate {k}"
        if name == "address" and idx == 0: assert not path, "address given twice"
        p[name] = v
    out = []
    for idx in sorted(payments):
        p = payments[idx]
        assert "address" in p, f"payment {idx} has no address"
        if "amount" in p:
            assert re.fullmatch(r"\d+(\.\d{1,8})?", p["amount"]) and not re.search(r"\.\d*0$", p["amount"]), f"bad amount {p['amount']}"
        memo = None
        if "memo" in p:
            assert "=" not in p["memo"] and re.fullmatch(r"[A-Za-z0-9_-]+", p["memo"]), "memo must be unpadded base64url"
            raw = base64.urlsafe_b64decode(p["memo"] + "=" * (-len(p["memo"]) % 4))
            assert len(raw) <= 512
            memo = raw.decode("utf-8")
        out.append({"address": p["address"], "amount": p.get("amount"), "memo": memo,
                    "message": unquote(p["message"]) if "message" in p else None})
    assert sorted(payments) == list(range(len(payments))), "payment indices must be contiguous here"
    return out


def official(uri):
    """Parse with the reference ZIP 321 implementation (Rust zip321 crate via the zcash-uri bindings)."""
    import zcash_uri
    req = zcash_uri.TransactionRequest.from_uri(uri)
    out = []
    for _, pay in sorted(req.payments().items()):
        memo = pay.memo_text() if callable(getattr(pay, "memo_text", None)) else getattr(pay, "memo_text", None)
        out.append({"address": pay.recipient_address() if callable(pay.recipient_address) else pay.recipient_address,
                    "zat": pay.amount_zatoshis() if callable(pay.amount_zatoshis) else pay.amount_zatoshis, "memo": memo})
    return out
