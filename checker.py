#!/usr/bin/env python3
"""
checker.py — independent re-implementation of the Margin Leak Finder spec,
written from the prompt, not from the JavaScript. Ships in the giveaway so
anyone can verify the tool's numbers.

Reads a JSON case {sales: [[...]], costs: [[...]], settings: {...}} on stdin
(or a path argument) and prints the full report as JSON.

All money is integer cents. Rounding: HALF UP, only at the four points the
spec names (card fee per order, labor cost per unit, period overhead,
annualised leak). Allocations use exact-integer largest remainder.
"""
import json, re, sys
from datetime import date

def norm(s):
    return re.sub(r"\s+", " ", ("" if s is None else str(s))).strip().lower()

def money_cents(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        import math
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        # mirror the sheet behaviour: numeric cell = dollars
        # (floor(x*100+0.5) matches JS Math.round for negatives too)
        import math as _m
        return int(_m.floor(v * 100 + 0.5))
    s = re.sub(r"[$,\s]", "", str(v))
    if not re.fullmatch(r"-?\d+(\.\d{1,2})?", s or ""):
        return None
    neg = s.startswith("-")
    if neg:
        s = s[1:]
    parts = s.split(".")
    cents = int(parts[0]) * 100
    if len(parts) == 2:
        cents += int((parts[1] + "00")[:2])
    return -cents if neg else cents

def int_strict(v):
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v) if v == int(v) else None
    s = re.sub(r"[,\s]", "", str(v))
    return int(s) if re.fullmatch(r"-?\d+", s or "") else None

def day_num(v):
    s = ("" if v is None else str(v)).strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", s)
        if not m:
            return None
        y, mo, d = int(m.group(3)), int(m.group(1)), int(m.group(2))
    try:
        return date(y, mo, d).toordinal()
    except ValueError:
        return None

def half_up(num, den=1):
    # round(num/den) half up, num >= 0
    return (num * 2 + den) // (den * 2)

def largest_remainder(total, weights):
    sw = sum(weights)
    n = len(weights)
    if sw <= 0:
        return [0] * n
    parts, rems = [], []
    for i, w in enumerate(weights):
        fl = (total * w) // sw
        parts.append(fl)
        rems.append((-(total * w - fl * sw), -w, i))  # sort: rem desc, w desc, i asc
    left = total - sum(parts)
    for (_, _, i) in sorted(rems)[:left]:
        parts[i] += 1
    return parts

REFUND_RE = re.compile(r"^(yes|y|true|refunded|1)$", re.I)

def compute(case):
    raw = case["settings"]

    def fnum(x, d):
        if x is None or x == "":
            return d
        try:
            return float(re.sub(r"[%,\s]", "", str(x)))
        except ValueError:
            return d

    basis = norm(raw.get("basis") or "revenue").upper()
    if basis not in ("REVENUE", "UNITS", "LABOR"):
        basis = "REVENUE"
    fee_ref = norm(raw.get("feeOnRefund") or "kept").upper()
    if fee_ref not in ("KEPT", "RETURNED"):
        fee_ref = "KEPT"
    card_pct = fnum(raw.get("cardPct"), 2.9) / 100.0
    per_order = money_cents(raw.get("cardPerOrder") if raw.get("cardPerOrder") not in (None, "") else 0.30) or 0
    labor_rate = money_cents(raw.get("laborRate") if raw.get("laborRate") not in (None, "") else 22) or 2200
    overhead_m = money_cents(raw.get("overheadMonthly") if raw.get("overheadMonthly") not in (None, "") else 0) or 0
    thin = fnum(raw.get("thinPct"), 10) / 100.0
    min_units = max(0, int_strict(raw.get("minUnits") if raw.get("minUnits") not in (None, "") else 5) or 5)
    p0, p1 = day_num(raw.get("periodStart")), day_num(raw.get("periodEnd"))
    if p0 is None or p1 is None or p1 < p0:
        raise SystemExit("bad period")
    period_days = p1 - p0 + 1

    costs = {}
    for row in case["costs"]:
        if not row or norm(row[0]) == "":
            continue
        key = norm(row[0])
        try:
            lab = float(row[2]) if row[2] not in (None, "") else 0.0
        except (TypeError, ValueError):
            lab = 0.0
        costs[key] = {
            "display": re.sub(r"\s+", " ", str(row[0])).strip(),
            "mat": money_cents(row[1]) or 0,
            "labmin": lab,
            "pack": money_cents(row[3]) or 0,
            "ship": money_cents(row[4]) or 0,
            "ignore": (norm(row[5] if len(row) > 5 else "") == "ignore") or (len(row) > 5 and row[5] is True),
        }
    labor_per_unit = {k: half_up(int(round(c["labmin"] * 1000)) * labor_rate, 60 * 1000) for k, c in costs.items()}
    # NOTE: labmin may be fractional; engine rounds labmin/60*rate half-up.
    # We scale by 1000 to keep it integer-exact for up to 3 decimals of minutes.

    lines, unusable = [], []
    ignored_rev = 0
    ignored_lines = 0
    for idx, r in enumerate(case["sales"]):
        if not r or "".join("" if x is None else str(x) for x in r) == "":
            continue
        when = day_num(r[0])
        oid = ("" if r[1] is None else str(r[1])).strip()
        pkey = norm(r[2])
        qty = int_strict(r[3])
        unit = money_cents(r[4])
        disc = 0 if (len(r) < 6 or r[5] in (None, "")) else money_cents(r[5])
        refunded = bool(REFUND_RE.match(("" if len(r) < 7 or r[6] is None else str(r[6])).strip()))
        charged = None
        if qty is not None and unit is not None and disc is not None:
            charged = max(0, qty * unit - disc)
        reason = None
        if when is None:
            reason = "bad date"
        elif when < p0 or when > p1:
            reason = "outside period"
        elif pkey == "":
            reason = "no product name"
        elif qty is None or qty <= 0:
            reason = "bad quantity"
        elif unit is None or unit < 0 or disc is None or disc < 0:
            reason = "bad money value"
        elif oid == "":
            reason = "no order id"
        elif pkey not in costs:
            reason = "no cost row for product"
        if reason:
            unusable.append({
                "rowIndex": idx + 2,
                "product": ("" if r[2] is None else str(r[2])).strip(),
                "reason": reason,
                "revenueCents": 0 if reason == "outside period" else (charged or 0),
            })
            continue
        if costs[pkey]["ignore"]:
            ignored_lines += 1
            if not refunded:
                ignored_rev += charged
        lines.append({"oid": oid, "pkey": pkey, "qty": qty, "charged": charged,
                      "refunded": refunded, "ignore": costs[pkey]["ignore"]})

    # card fee per order, split by charged amount
    orders = {}
    for L in lines:
        orders.setdefault(L["oid"], []).append(L)
    for oid, ols in orders.items():
        oc = sum(x["charged"] for x in ols)
        fee = (half_up(int(round(card_pct * 1_000_000)) * oc, 1_000_000) + per_order) if oc > 0 else 0
        split = largest_remainder(fee, [x["charged"] for x in ols])
        for x, f in zip(ols, split):
            x["fee"] = f

    prods = {}
    def P(key):
        if key not in prods:
            prods[key] = dict(key=key, display=costs[key]["display"], unitsSold=0, unitsRefunded=0,
                              unitsKept=0, revenueKept=0, revenueRefunded=0, materials=0, labor=0,
                              packaging=0, shipping=0, cardFees=0, refundCost=0, overheadShare=0,
                              laborMinKept=0.0)
        return prods[key]

    for L in lines:
        if L["ignore"]:
            continue
        X = P(L["pkey"]); C = costs[L["pkey"]]
        unit_costs = C["mat"] + labor_per_unit[L["pkey"]] + C["pack"] + C["ship"]
        X["unitsSold"] += L["qty"]
        if L["refunded"]:
            X["unitsRefunded"] += L["qty"]
            X["revenueRefunded"] += L["charged"]
            X["refundCost"] += unit_costs * L["qty"] + (L["fee"] if fee_ref == "KEPT" else 0)
        else:
            X["unitsKept"] += L["qty"]
            X["revenueKept"] += L["charged"]
            X["materials"] += C["mat"] * L["qty"]
            X["labor"] += labor_per_unit[L["pkey"]] * L["qty"]
            X["packaging"] += C["pack"] * L["qty"]
            X["shipping"] += C["ship"] * L["qty"]
            X["cardFees"] += L["fee"]
            X["laborMinKept"] += C["labmin"] * L["qty"]

    plist = [prods[k] for k in sorted(prods.keys())]
    period_overhead = half_up(overhead_m * period_days * 10000, int(30.4375 * 10000))
    if basis == "UNITS":
        weights = [p["unitsKept"] for p in plist]
    elif basis == "LABOR":
        weights = [int(round(p["laborMinKept"] * 1000)) for p in plist]
    else:
        weights = [p["revenueKept"] for p in plist]
    for p, ov in zip(plist, largest_remainder(period_overhead, weights)):
        p["overheadShare"] = ov
    over_unalloc = period_overhead - sum(p["overheadShare"] for p in plist)

    totals = dict(unitsKept=0, revenueKept=0, materials=0, labor=0, packaging=0, shipping=0,
                  cardFees=0, refundCost=0, overheadShare=0, trueProfit=0)
    leak_annual_raw = 0
    leak = thin_n = low = 0
    for X in plist:
        X["trueProfit"] = (X["revenueKept"] - X["materials"] - X["labor"] - X["packaging"]
                           - X["shipping"] - X["cardFees"] - X["refundCost"] - X["overheadShare"])
        X["marginPct"] = (X["trueProfit"] / X["revenueKept"]) if X["revenueKept"] > 0 else (-1 if X["trueProfit"] < 0 else 0)
        if X["unitsKept"] < min_units:
            X["verdict"] = "LOW DATA"; low += 1
        elif X["trueProfit"] < 0:
            X["verdict"] = "LEAKING"; leak += 1; leak_annual_raw += -X["trueProfit"]
        elif X["marginPct"] < thin:
            X["verdict"] = "THIN"; thin_n += 1
        else:
            X["verdict"] = "EARNING"
        for f in totals:
            if f != "trueProfit":
                totals[f] += X[f]
        totals["trueProfit"] += X["trueProfit"]
    leak_annual = half_up(leak_annual_raw * 365, period_days)

    # reconciliation from the RAW export — no product logic at all
    export_charged = 0
    for r in case["sales"]:
        if not r or "".join("" if x is None else str(x) for x in r) == "":
            continue
        when = day_num(r[0])
        if when is None or when < p0 or when > p1:
            continue
        qty = int_strict(r[3]); unit = money_cents(r[4])
        disc = 0 if (len(r) < 6 or r[5] in (None, "")) else money_cents(r[5])
        if qty is None or unit is None or disc is None or qty <= 0 or unit < 0 or disc < 0:
            continue
        if REFUND_RE.match(("" if len(r) < 7 or r[6] is None else str(r[6])).strip()):
            continue
        export_charged += max(0, qty * unit - disc)
    unusable_rev = sum(u["revenueCents"] for u in unusable)
    accounted = totals["revenueKept"] + ignored_rev + unusable_rev
    delta = export_charged - accounted
    dark = (unusable_rev / export_charged) if export_charged > 0 else 0
    status = "PROVISIONAL" if (delta != 0 or dark > 0.005) else "READY"

    for X in plist:
        del X["laborMinKept"]
    return {
        "periodDays": period_days,
        "products": plist,
        "totals": totals,
        "periodOverhead": period_overhead,
        "overheadUnallocated": over_unalloc,
        "unusable": unusable,
        "unusableRevenue": unusable_rev,
        "ignoredLines": ignored_lines,
        "ignoredRevenue": ignored_rev,
        "reconciliation": {"exportCharged": export_charged, "accounted": accounted, "delta": delta, "ok": delta == 0},
        "summary": {"status": status, "leakCount": leak, "thinCount": thin_n, "lowDataCount": low,
                    "leakAnnualCents": leak_annual},
    }

if __name__ == "__main__":
    src = open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin
    print(json.dumps(compute(json.load(src)), indent=1))
