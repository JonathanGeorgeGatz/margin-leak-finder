/**
 * The Margin Leak Finder — engine.gs (v2, shipped)
 * Build It With AI — Episode 7 giveaway.
 *
 * Pure calculation engine. No SpreadsheetApp calls in this file — main.gs
 * reads the sheets and hands plain arrays in, so this exact code can be
 * tested outside Google Sheets.
 *
 * MONEY RULE (written down, on purpose): all money is integer CENTS.
 * The only rounding rule anywhere is ROUND HALF UP, applied at exactly
 * these points: a card fee per order, a labor cost per unit, the period
 * overhead, and the annualised leak. Everything else is integer arithmetic.
 * Allocations (card fee across an order's lines, overhead across products)
 * use the largest-remainder method so the parts always sum to the whole.
 */

var MLF = (function () {
  "use strict";

  // ---------- helpers ----------

  function roundHalfUp(x) {
    // x may be fractional cents; negative values do not occur at rounding
    // points by construction (fees, costs and overhead are non-negative).
    return Math.floor(x + 0.5);
  }

  function normName(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
  }

  function parseMoneyCents(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") {
      if (!isFinite(v)) return null;
      return Math.round(v * 100);
    }
    var s = String(v).replace(/[$,\s]/g, "");
    if (s === "" || !/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
    var neg = s.charAt(0) === "-";
    if (neg) s = s.slice(1);
    var parts = s.split(".");
    var cents = parseInt(parts[0], 10) * 100;
    if (parts.length === 2) cents += parseInt((parts[1] + "00").slice(0, 2), 10);
    return neg ? -cents : cents;
  }

  function parseIntStrict(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) && v === Math.floor(v) ? v : null;
    var s = String(v).replace(/[,\s]/g, "");
    if (!/^-?\d+$/.test(s)) return null;
    return parseInt(s, 10);
  }

  function parseDateISO(v) {
    // Accepts Date objects, "YYYY-MM-DD", "M/D/YYYY".
    if (v instanceof Date && !isNaN(v)) {
      return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
    }
    var s = String(v == null ? "" : v).trim();
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
    return null;
  }

  function largestRemainder(total, weights) {
    // Split integer `total` in proportion to non-negative `weights`.
    // Parts are integers and sum exactly to `total`.
    var sumW = 0;
    for (var i = 0; i < weights.length; i++) sumW += weights[i];
    var parts = new Array(weights.length);
    if (sumW <= 0) {
      for (var j = 0; j < weights.length; j++) parts[j] = 0;
      return parts;
    }
    var floors = 0, rems = [];
    for (var k = 0; k < weights.length; k++) {
      var fl = Math.floor(total * weights[k] / sumW);
      // integer remainder (exact below 2^53): total*w - fl*sumW
      var rInt = total * weights[k] - fl * sumW;
      if (rInt < 0) { fl -= 1; rInt += sumW; }         // guard fp edge
      if (rInt >= sumW) { fl += 1; rInt -= sumW; }
      parts[k] = fl;
      floors += fl;
      rems.push({ i: k, r: rInt, w: weights[k] });
    }
    var left = total - floors;
    rems.sort(function (a, b) { return b.r - a.r || b.w - a.w || a.i - b.i; });
    for (var t = 0; t < left; t++) parts[rems[t % rems.length].i] += 1;
    return parts;
  }

  // ---------- settings ----------

  function readSettings(raw) {
    // raw: object of user-entered values; returns typed settings or throws.
    function num(x, dflt) {
      if (x == null || x === "") return dflt;
      var n = typeof x === "number" ? x : parseFloat(String(x).replace(/[%,\s]/g, ""));
      return isFinite(n) ? n : dflt;
    }
    var basis = normName(raw.basis || "revenue").toUpperCase();
    if (basis !== "REVENUE" && basis !== "UNITS" && basis !== "LABOR") basis = "REVENUE";
    var feeOnRefund = normName(raw.feeOnRefund || "kept").toUpperCase();
    if (feeOnRefund !== "KEPT" && feeOnRefund !== "RETURNED") feeOnRefund = "KEPT";
    var s = {
      cardPct: num(raw.cardPct, 2.9) / 100,          // e.g. 2.9 (%)
      cardPerOrderCents: parseMoneyCents(raw.cardPerOrder != null && raw.cardPerOrder !== "" ? raw.cardPerOrder : 0.30) || 0,
      laborRateCentsPerHour: parseMoneyCents(raw.laborRate != null && raw.laborRate !== "" ? raw.laborRate : 22) || 2200,
      overheadMonthlyCents: parseMoneyCents(raw.overheadMonthly != null && raw.overheadMonthly !== "" ? raw.overheadMonthly : 0) || 0,
      basis: basis,                                   // REVENUE | UNITS | LABOR
      feeOnRefund: feeOnRefund,                       // KEPT | RETURNED
      thinPct: num(raw.thinPct, 10) / 100,            // margin below this = THIN
      minUnits: Math.max(0, parseIntStrict(raw.minUnits != null && raw.minUnits !== "" ? raw.minUnits : 5) || 5),
      periodStart: parseDateISO(raw.periodStart),
      periodEnd: parseDateISO(raw.periodEnd)
    };
    if (s.periodStart == null || s.periodEnd == null || s.periodEnd < s.periodStart) {
      throw new Error("Settings: period start/end missing or reversed.");
    }
    return s;
  }

  // ---------- the engine ----------

  /**
   * salesRows: [[Date, OrderID, Product, Qty, UnitPrice, LineDiscount, Refunded], ...]
   * costRows:  [[Product, MaterialsPerUnit, LaborMinutes, PackagingPerUnit, ShippingPerUnit_or_blank, IgnoreFlag], ...]
   * settingsRaw: {cardPct, cardPerOrder, laborRate, overheadMonthly, basis,
   *               feeOnRefund, thinPct, minUnits, periodStart, periodEnd}
   */
  function computeMarginReport(salesRows, costRows, settingsRaw) {
    var S = readSettings(settingsRaw);
    var periodDays = Math.round((S.periodEnd - S.periodStart) / 86400000) + 1;

    // --- cost table ---
    var costs = {};   // key -> {display, matC, laborMin, packC, shipC, ignore}
    for (var c = 0; c < costRows.length; c++) {
      var row = costRows[c];
      if (!row || normName(row[0]) === "") continue;
      var key = normName(row[0]);
      var ignore = normName(row[5]) === "ignore" || row[5] === true;
      costs[key] = {
        display: String(row[0]).replace(/\s+/g, " ").trim(),
        matC: parseMoneyCents(row[1]) || 0,
        laborMin: (function (v) { var n = v == null || v === "" ? 0 : parseFloat(v); return isFinite(n) ? n : 0; })(row[2]),
        packC: parseMoneyCents(row[3]) || 0,
        shipC: parseMoneyCents(row[4]) || 0,
        ignore: ignore
      };
    }

    // --- parse sales lines ---
    var lines = [];        // usable lines
    var unusable = [];     // {rowIndex, reason, revenueCents}
    var ignoredRevenue = 0, ignoredLines = 0;
    for (var i = 0; i < salesRows.length; i++) {
      var r = salesRows[i];
      if (!r || r.join("") === "") continue;                       // truly blank
      var when = parseDateISO(r[0]);
      var orderId = String(r[1] == null ? "" : r[1]).trim();
      var pkey = normName(r[2]);
      var qty = parseIntStrict(r[3]);
      var unitC = parseMoneyCents(r[4]);
      var discC = r[5] == null || r[5] === "" ? 0 : parseMoneyCents(r[5]);
      var refunded = /^(yes|y|true|refunded|1)$/i.test(String(r[6] == null ? "" : r[6]).trim());
      var charged = (qty != null && unitC != null && discC != null) ? qty * unitC - discC : null;
      if (charged != null && charged < 0) charged = 0;
      var reason = null;
      if (when == null) reason = "bad date";
      else if (when < S.periodStart || when > S.periodEnd) reason = "outside period";
      else if (pkey === "") reason = "no product name";
      else if (qty == null || qty <= 0) reason = "bad quantity";
      else if (unitC == null || unitC < 0 || discC == null || discC < 0) reason = "bad money value";
      else if (orderId === "") reason = "no order id";
      else if (!costs[pkey]) reason = "no cost row for product";
      if (reason) {
        unusable.push({ rowIndex: i + 2, product: String(r[2] == null ? "" : r[2]).trim(), reason: reason, revenueCents: reason === "outside period" ? 0 : (charged || 0) });
        continue;
      }
      if (costs[pkey].ignore) { ignoredLines++; ignoredRevenue += refunded ? 0 : charged; }
      lines.push({ orderId: orderId, pkey: pkey, qty: qty, charged: charged, refunded: refunded, ignore: costs[pkey].ignore });
    }

    // --- card fee per ORDER, split over its lines by charged amount ---
    var orders = {};
    for (var l = 0; l < lines.length; l++) {
      (orders[lines[l].orderId] = orders[lines[l].orderId] || []).push(lines[l]);
    }
    var pctMicro = Math.round(S.cardPct * 1e6); // e.g. 2.9% -> 29000 micro-units
    Object.keys(orders).forEach(function (oid) {
      var ols = orders[oid];
      var orderCharged = 0;
      for (var a = 0; a < ols.length; a++) orderCharged += ols[a].charged;
      var fee = orderCharged > 0 ? Math.floor((pctMicro * orderCharged * 2 + 1e6) / 2e6) + S.cardPerOrderCents : 0;
      var weights = ols.map(function (x) { return x.charged; });
      var split = largestRemainder(fee, weights);
      for (var b = 0; b < ols.length; b++) ols[b].feeShare = split[b];
    });

    // --- aggregate per product ---
    var byProd = {};
    function acc(key) {
      if (!byProd[key]) {
        var ct = costs[key];
        byProd[key] = {
          key: key, display: ct.display,
          unitsSold: 0, unitsRefunded: 0, unitsKept: 0,
          revenueKept: 0, revenueRefunded: 0,
          materials: 0, labor: 0, packaging: 0, shipping: 0,
          cardFees: 0, refundCost: 0, overheadShare: 0,
          laborMinKept: 0
        };
      }
      return byProd[key];
    }
    var laborPerUnit = {};
    Object.keys(costs).forEach(function (k) {
      var laborMilli = Math.round(costs[k].laborMin * 1000);
      laborPerUnit[k] = Math.floor((laborMilli * S.laborRateCentsPerHour * 2 + 60000) / 120000);
    });

    for (var m = 0; m < lines.length; m++) {
      var L = lines[m];
      if (L.ignore) continue;
      var P = acc(L.pkey), CT = costs[L.pkey];
      var unitCosts = CT.matC + laborPerUnit[L.pkey] + CT.packC + CT.shipC;
      P.unitsSold += L.qty;
      if (L.refunded) {
        P.unitsRefunded += L.qty;
        P.revenueRefunded += L.charged;
        // money burnt by the refunded units: their direct costs, plus the
        // card fee share if the processor keeps fees on refunds.
        P.refundCost += unitCosts * L.qty + (S.feeOnRefund === "KEPT" ? L.feeShare : 0);
      } else {
        P.unitsKept += L.qty;
        P.revenueKept += L.charged;
        P.materials += CT.matC * L.qty;
        P.labor += laborPerUnit[L.pkey] * L.qty;
        P.packaging += CT.packC * L.qty;
        P.shipping += CT.shipC * L.qty;
        P.cardFees += L.feeShare;
        P.laborMinKept += CT.laborMin * L.qty;
      }
    }

    var prods = Object.keys(byProd).map(function (k) { return byProd[k]; });
    prods.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });

    // --- overhead for the period, allocated over KEPT activity ---
    // 30.4375 days per month = 487/16 exactly
    var periodOverhead = Math.floor((S.overheadMonthlyCents * periodDays * 16 * 2 + 487) / (487 * 2));
    var weights = prods.map(function (p) {
      if (S.basis === "UNITS") return p.unitsKept;
      if (S.basis === "LABOR") return p.laborMinKept;
      return p.revenueKept;
    });
    var ovSplit = largestRemainder(periodOverhead, weights);
    var allocated = 0;
    for (var o = 0; o < prods.length; o++) { prods[o].overheadShare = ovSplit[o]; allocated += ovSplit[o]; }
    var overheadUnallocated = periodOverhead - allocated; // non-zero only if nothing sold

    // --- profit, margin, verdicts ---
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

    // --- reconciliation: every charged dollar in the export must be
    //     accounted for: kept by a product, refunded, ignored, or listed
    //     as unusable with a reason. ---
    var exportCharged = 0;
    for (var q = 0; q < salesRows.length; q++) {
      var rr = salesRows[q];
      if (!rr || rr.join("") === "") continue;
      var w2 = parseDateISO(rr[0]);
      if (w2 == null || w2 < S.periodStart || w2 > S.periodEnd) continue;
      var q2 = parseIntStrict(rr[3]), u2 = parseMoneyCents(rr[4]);
      var d2 = rr[5] == null || rr[5] === "" ? 0 : parseMoneyCents(rr[5]);
      if (q2 == null || u2 == null || d2 == null || q2 <= 0 || u2 < 0 || d2 < 0) continue;
      var ch2 = q2 * u2 - d2; if (ch2 < 0) ch2 = 0;
      var refunded2 = /^(yes|y|true|refunded|1)$/i.test(String(rr[6] == null ? "" : rr[6]).trim());
      if (!refunded2) exportCharged += ch2;
    }
    var unusableRevenue = 0;
    for (var u = 0; u < unusable.length; u++) unusableRevenue += unusable[u].revenueCents;
    var accounted = t.revenueKept + ignoredRevenue + unusableRevenue;
    var reconDelta = exportCharged - accounted;
    var reconOk = reconDelta === 0;

    // The tool refuses to grade the business while a meaningful slice of
    // revenue is dark: unusable revenue above 0.5% of the export, or a
    // reconciliation gap, blocks the summary verdict.
    var darkShare = exportCharged > 0 ? unusableRevenue / exportCharged : 0;
    var status = (!reconOk || darkShare > 0.005) ? "PROVISIONAL" : "READY";

    return {
      settings: S, periodDays: periodDays,
      products: prods,
      totals: t,
      periodOverhead: periodOverhead,
      overheadUnallocated: overheadUnallocated,
      unusable: unusable, unusableRevenue: unusableRevenue,
      ignoredLines: ignoredLines, ignoredRevenue: ignoredRevenue,
      reconciliation: { exportCharged: exportCharged, accounted: accounted, delta: reconDelta, ok: reconOk },
      summary: { status: status, leakCount: leakCount, thinCount: thinCount, lowDataCount: lowDataCount, leakAnnualCents: leakAnnual }
    };
  }

  return {
    computeMarginReport: computeMarginReport,
    _internal: { roundHalfUp: roundHalfUp, normName: normName, parseMoneyCents: parseMoneyCents, largestRemainder: largestRemainder, parseDateISO: parseDateISO, readSettings: readSettings }
  };
})();

if (typeof module !== "undefined") module.exports = MLF;
