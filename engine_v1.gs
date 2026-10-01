/**
 * engine_v1.gs — the FIRST build, kept for the record (Episode 7).
 * This is what the first prompt produced. It looks right. Three things in
 * it are wrong, and the cross-implementation comparison found all three:
 *   (1) refunded lines are dropped at parse time — refunds simply vanish;
 *   (2) the per-order card fee is charged on every LINE (no order grouping);
 *   (3) a line whose product has no cost row is skipped silently.
 * Do not use this file for anything except seeing the difference.
 */

var MLFv1 = (function () {
  "use strict";

  function roundHalfUp(x) { return Math.floor(x + 0.5); }
  function normName(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase(); }
  function parseMoneyCents(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") { return isFinite(v) ? Math.round(v * 100) : null; }
    var s = String(v).replace(/[$,\s]/g, "");
    if (s === "" || !/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
    var neg = s.charAt(0) === "-"; if (neg) s = s.slice(1);
    var parts = s.split("."); var cents = parseInt(parts[0], 10) * 100;
    if (parts.length === 2) cents += parseInt((parts[1] + "00").slice(0, 2), 10);
    return neg ? -cents : cents;
  }
  function parseIntStrict(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) && v === Math.floor(v) ? v : null;
    var s = String(v).replace(/[,\s]/g, ""); if (!/^-?\d+$/.test(s)) return null;
    return parseInt(s, 10);
  }
  function parseDateISO(v) {
    if (v instanceof Date && !isNaN(v)) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
    var s = String(v == null ? "" : v).trim();
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
    return null;
  }
  function largestRemainder(total, weights) {
    var sumW = 0, i; for (i = 0; i < weights.length; i++) sumW += weights[i];
    var parts = new Array(weights.length);
    if (sumW <= 0) { for (i = 0; i < weights.length; i++) parts[i] = 0; return parts; }
    var floors = 0, rems = [];
    for (i = 0; i < weights.length; i++) {
      var fl = Math.floor(total * weights[i] / sumW);
      var rInt = total * weights[i] - fl * sumW;
      if (rInt < 0) { fl -= 1; rInt += sumW; }
      if (rInt >= sumW) { fl += 1; rInt -= sumW; }
      parts[i] = fl; floors += fl; rems.push({ i: i, r: rInt, w: weights[i] });
    }
    var left = total - floors;
    rems.sort(function (a, b) { return b.r - a.r || b.w - a.w || a.i - b.i; });
    for (var t = 0; t < left; t++) parts[rems[t % rems.length].i] += 1;
    return parts;
  }
  function readSettings(raw) {
    function num(x, dflt) {
      if (x == null || x === "") return dflt;
      var n = typeof x === "number" ? x : parseFloat(String(x).replace(/[%,\s]/g, ""));
      return isFinite(n) ? n : dflt;
    }
    var basis = normName(raw.basis || "revenue").toUpperCase();
    if (basis !== "REVENUE" && basis !== "UNITS" && basis !== "LABOR") basis = "REVENUE";
    var feeOnRefund = normName(raw.feeOnRefund || "kept").toUpperCase();
    if (feeOnRefund !== "KEPT" && feeOnRefund !== "RETURNED") feeOnRefund = "KEPT";
    return {
      cardPct: num(raw.cardPct, 2.9) / 100,
      cardPerOrderCents: parseMoneyCents(raw.cardPerOrder != null && raw.cardPerOrder !== "" ? raw.cardPerOrder : 0.30) || 0,
      laborRateCentsPerHour: parseMoneyCents(raw.laborRate != null && raw.laborRate !== "" ? raw.laborRate : 22) || 2200,
      overheadMonthlyCents: parseMoneyCents(raw.overheadMonthly != null && raw.overheadMonthly !== "" ? raw.overheadMonthly : 0) || 0,
      basis: basis, feeOnRefund: feeOnRefund,
      thinPct: num(raw.thinPct, 10) / 100,
      minUnits: Math.max(0, parseIntStrict(raw.minUnits != null && raw.minUnits !== "" ? raw.minUnits : 5) || 5),
      periodStart: parseDateISO(raw.periodStart), periodEnd: parseDateISO(raw.periodEnd)
    };
  }

  function computeMarginReport(salesRows, costRows, settingsRaw) {
    var S = readSettings(settingsRaw);
    var periodDays = Math.round((S.periodEnd - S.periodStart) / 86400000) + 1;

    var costs = {};
    for (var c = 0; c < costRows.length; c++) {
      var row = costRows[c]; if (!row || normName(row[0]) === "") continue;
      costs[normName(row[0])] = {
        display: String(row[0]).replace(/\s+/g, " ").trim(),
        matC: parseMoneyCents(row[1]) || 0,
        laborMin: (function (v) { var n = v == null || v === "" ? 0 : parseFloat(v); return isFinite(n) ? n : 0; })(row[2]),
        packC: parseMoneyCents(row[3]) || 0,
        shipC: parseMoneyCents(row[4]) || 0
      };
    }
    var laborPerUnit = {};
    Object.keys(costs).forEach(function (k) {
      var laborMilli = Math.round(costs[k].laborMin * 1000);
      laborPerUnit[k] = Math.floor((laborMilli * S.laborRateCentsPerHour * 2 + 60000) / 120000);
    });
    var pctMicro = Math.round(S.cardPct * 1e6);

    var byProd = {};
    function acc(key) {
      if (!byProd[key]) byProd[key] = {
        key: key, display: costs[key].display,
        unitsSold: 0, unitsRefunded: 0, unitsKept: 0,
        revenueKept: 0, revenueRefunded: 0,
        materials: 0, labor: 0, packaging: 0, shipping: 0,
        cardFees: 0, refundCost: 0, overheadShare: 0, laborMinKept: 0
      };
      return byProd[key];
    }

    for (var i = 0; i < salesRows.length; i++) {
      var r = salesRows[i]; if (!r || r.join("") === "") continue;
      var when = parseDateISO(r[0]);
      if (when == null || when < S.periodStart || when > S.periodEnd) continue;
      var refunded = /^(yes|y|true|refunded|1)$/i.test(String(r[6] == null ? "" : r[6]).trim());
      if (refunded) continue;                       // BUG 1: refunds vanish
      var pkey = normName(r[2]);
      if (!costs[pkey]) continue;                   // BUG 3: silent skip
      var qty = parseIntStrict(r[3]); var unitC = parseMoneyCents(r[4]);
      var discC = r[5] == null || r[5] === "" ? 0 : parseMoneyCents(r[5]);
      if (qty == null || qty <= 0 || unitC == null || unitC < 0 || discC == null || discC < 0) continue;
      var charged = qty * unitC - discC; if (charged < 0) charged = 0;
      var P = acc(pkey), CT = costs[pkey];
      P.unitsSold += qty; P.unitsKept += qty; P.revenueKept += charged;
      P.materials += CT.matC * qty; P.labor += laborPerUnit[pkey] * qty;
      P.packaging += CT.packC * qty; P.shipping += CT.shipC * qty;
      // BUG 2: each line treated as its own card charge
      P.cardFees += charged > 0 ? Math.floor((pctMicro * charged * 2 + 1e6) / 2e6) + S.cardPerOrderCents : 0;
      P.laborMinKept += CT.laborMin * qty;
    }

    var prods = Object.keys(byProd).map(function (k) { return byProd[k]; });
    prods.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });

    var periodOverhead = Math.floor((S.overheadMonthlyCents * periodDays * 16 * 2 + 487) / (487 * 2));
    var weights = prods.map(function (p) {
      if (S.basis === "UNITS") return p.unitsKept;
      if (S.basis === "LABOR") return p.laborMinKept;
      return p.revenueKept;
    });
    var ovSplit = largestRemainder(periodOverhead, weights);
    for (var o = 0; o < prods.length; o++) prods[o].overheadShare = ovSplit[o];

    var t = { unitsKept: 0, revenueKept: 0, materials: 0, labor: 0, packaging: 0, shipping: 0, cardFees: 0, refundCost: 0, overheadShare: 0, trueProfit: 0 };
    var leakAnnual = 0, leakCount = 0, thinCount = 0, lowDataCount = 0;
    for (var p = 0; p < prods.length; p++) {
      var X = prods[p];
      X.trueProfit = X.revenueKept - X.materials - X.labor - X.packaging - X.shipping - X.cardFees - X.refundCost - X.overheadShare;
      X.marginPct = X.revenueKept > 0 ? X.trueProfit / X.revenueKept : (X.trueProfit < 0 ? -1 : 0);
      if (X.unitsKept < S.minUnits) { X.verdict = "LOW DATA"; lowDataCount++; }
      else if (X.trueProfit < 0) { X.verdict = "LEAKING"; leakCount++; leakAnnual += -X.trueProfit; }
      else if (X.marginPct < S.thinPct) { X.verdict = "THIN"; thinCount++; }
      else X.verdict = "EARNING";
      t.unitsKept += X.unitsKept; t.revenueKept += X.revenueKept; t.materials += X.materials;
      t.labor += X.labor; t.packaging += X.packaging; t.shipping += X.shipping;
      t.cardFees += X.cardFees; t.refundCost += X.refundCost; t.overheadShare += X.overheadShare;
      t.trueProfit += X.trueProfit;
    }
    leakAnnual = Math.floor((leakAnnual * 365 * 2 + periodDays) / (2 * periodDays));

    return {
      settings: S, periodDays: periodDays, products: prods, totals: t,
      periodOverhead: periodOverhead,
      summary: { status: "READY", leakCount: leakCount, thinCount: thinCount, lowDataCount: lowDataCount, leakAnnualCents: leakAnnual }
    };
  }

  return { computeMarginReport: computeMarginReport };
})();

if (typeof module !== "undefined") module.exports = MLFv1;
