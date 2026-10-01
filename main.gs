/**
 * The Margin Leak Finder — main.gs (Sheets glue)
 * Reads 'Sales Export', 'Product Costs' and 'Settings', runs the engine,
 * and writes the 'Margin Report' sheet. All calculation lives in engine.gs.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Margin Leak Finder")
    .addItem("Build Margin Report", "buildMarginReport")
    .addToUi();
}

function mlfReadSettings_(ss) {
  var sh = ss.getSheetByName("Settings");
  if (!sh) throw new Error("Missing sheet: Settings");
  var vals = sh.getDataRange().getValues();
  var map = {};
  for (var i = 0; i < vals.length; i++) {
    var k = String(vals[i][0] || "").trim().toLowerCase();
    if (k) map[k] = vals[i][1];
  }
  return {
    cardPct: map["card fee percent"],
    cardPerOrder: map["card fee per order"],
    laborRate: map["labor rate per hour"],
    overheadMonthly: map["monthly overhead"],
    basis: map["overhead allocation basis"],
    feeOnRefund: map["card fee on refunds"],
    thinPct: map["thin margin threshold percent"],
    minUnits: map["minimum units to grade"],
    periodStart: map["period start"],
    periodEnd: map["period end"]
  };
}

function buildMarginReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var salesSh = ss.getSheetByName("Sales Export");
  var costSh = ss.getSheetByName("Product Costs");
  if (!salesSh) throw new Error("Missing sheet: Sales Export");
  if (!costSh) throw new Error("Missing sheet: Product Costs");

  var sales = salesSh.getDataRange().getValues().slice(1); // drop header
  var costs = costSh.getDataRange().getValues().slice(1);
  var rep = MLF.computeMarginReport(sales, costs, mlfReadSettings_(ss));

  var out = ss.getSheetByName("Margin Report");
  if (out) out.clear(); else out = ss.insertSheet("Margin Report");

  function usd(c) {
    var neg = c < 0; if (neg) c = -c;
    var s = "$" + Math.floor(c / 100) + "." + ("0" + (c % 100)).slice(-2);
    return neg ? "-" + s : s;
  }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }

  var rows = [];
  var S = rep.summary;
  rows.push(["MARGIN LEAK FINDER — " + S.status, "", "", "", "", "", "", "", "", "", "", "", ""]);
  if (S.status === "PROVISIONAL") {
    rows.push(["REPORT INCOMPLETE: " + usd(rep.unusableRevenue) +
      " of revenue could not be matched to a product. Fix the rows listed at the bottom " +
      "(add cost rows, or mark non-products IGNORE) and rebuild. Verdicts are withheld " +
      "until the report accounts for the whole export.",
      "", "", "", "", "", "", "", "", "", "", "", ""]);
  } else {
    rows.push([S.leakCount + " of " + rep.products.length + " products are LEAKING (losing money after true costs)" +
      (S.leakCount ? " — worth " + usd(S.leakAnnualCents) + " a year at this run rate." : "."),
      "", "", "", "", "", "", "", "", "", "", "", ""]);
  }
  rows.push(["", "", "", "", "", "", "", "", "", "", "", "", ""]);
  rows.push(["Product", "Units kept", "Units refunded", "Revenue kept", "Materials", "Labor",
             "Packaging", "Shipping", "Card fees", "Refund cost", "Overhead share",
             "True profit", "True margin", "Verdict"]);

  var sorted = rep.products.slice().sort(function (a, b) { return a.trueProfit - b.trueProfit; });
  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i];
    rows.push([p.display, p.unitsKept, p.unitsRefunded, usd(p.revenueKept), usd(p.materials),
               usd(p.labor), usd(p.packaging), usd(p.shipping), usd(p.cardFees),
               usd(p.refundCost), usd(p.overheadShare), usd(p.trueProfit),
               S.status === "PROVISIONAL" ? "—" : pct(p.marginPct),
               S.status === "PROVISIONAL" ? "—" : p.verdict]);
  }
  var t = rep.totals;
  rows.push(["TOTAL", t.unitsKept, "", usd(t.revenueKept), usd(t.materials), usd(t.labor),
             usd(t.packaging), usd(t.shipping), usd(t.cardFees), usd(t.refundCost),
             usd(t.overheadShare), usd(t.trueProfit), "", ""]);
  rows.push(["", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
  rows.push(["RECONCILIATION", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
  rows.push(["Charged in export (kept)", usd(rep.reconciliation.exportCharged), "",
             "Accounted for", usd(rep.reconciliation.accounted), "",
             "Difference", usd(rep.reconciliation.delta),
             rep.reconciliation.ok ? "TIES OUT" : "DOES NOT TIE OUT", "", "", "", "", ""]);
  if (rep.ignoredLines > 0) {
    rows.push(["Ignored (marked IGNORE)", String(rep.ignoredLines) + " lines",
               usd(rep.ignoredRevenue), "", "", "", "", "", "", "", "", "", "", ""]);
  }
  if (rep.unusable.length) {
    rows.push(["", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
    rows.push(["LINES THE REPORT COULD NOT USE (sheet row, product, reason)", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
    var byReason = {};
    for (var u = 0; u < rep.unusable.length; u++) {
      var x = rep.unusable[u];
      var key = x.reason + "|" + x.product.toLowerCase();
      if (!byReason[key]) byReason[key] = { reason: x.reason, product: x.product, n: 0, rev: 0, firstRow: x.rowIndex };
      byReason[key].n++; byReason[key].rev += x.revenueCents;
    }
    Object.keys(byReason).sort().forEach(function (k) {
      var g = byReason[k];
      rows.push(["row " + g.firstRow + (g.n > 1 ? " (+" + (g.n - 1) + " more)" : ""),
                 g.product || "(blank)", g.reason, usd(g.rev), "", "", "", "", "", "", "", "", "", ""]);
    });
  }

  var width = 0;
  for (var r = 0; r < rows.length; r++) width = Math.max(width, rows[r].length);
  for (var r2 = 0; r2 < rows.length; r2++) while (rows[r2].length < width) rows[r2].push("");
  out.getRange(1, 1, rows.length, width).setValues(rows);
  return rep; // handy for tests
}
