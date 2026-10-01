THE MARGIN LEAK FINDER
Build It With AI — Episode 7
Free. No email. No server. Your sales data never leaves your spreadsheet.
=========================================================================

WHAT IT DOES
Paste a sales export into a Google Sheet and find out which of your
products still make money after TRUE costs — materials, labor minutes,
packaging, shipping, card fees (charged per order, the way processors
actually charge them), refunds (the money you spent on units that came
back), and each product's share of overhead. Every product gets a verdict:
EARNING, THIN, LEAKING, or LOW DATA. The report reconciles to your export
to the cent, and refuses to grade anything while part of your revenue is
unaccounted for.

FILES
  engine.gs          — all the calculation (this is the tool)
  main.gs            — the Sheets plumbing (menu + report writer)
  engine_v1.gs       — the FIRST build, kept so you can see what was wrong.
                       Do not install it. See CLAUDE_PROMPT.txt.
  checker.py         — an independent re-implementation in Python.
                       Run it to verify the tool's numbers yourself.
  sales_export.csv   — the fictional sample business (Copperline Candle Co.)
  product_costs.csv  — its cost sheet, including two IGNORE rows
  CLAUDE_PROMPT.txt  — the three prompts, word for word
  README.txt         — this file

SETUP (about five minutes)
1. Create a new Google Sheet.
2. Make three tabs, named exactly: "Sales Export", "Product Costs",
   "Settings".
3. Sales Export, row 1 headers:
   Date | Order ID | Product | Qty | Unit Price | Line Discount | Refunded
   Paste your export under it. Dates as YYYY-MM-DD or M/D/YYYY. Refunded
   column: YES on refunded lines, blank otherwise.
4. Product Costs, row 1 headers:
   Product | Materials / unit | Labor minutes / unit | Packaging / unit |
   Shipping / unit | Ignore
   One row per product. Put IGNORE in the last column for lines that are
   revenue but not products (gift cards, tickets, fees).
5. Settings, two columns (label, value), one row each:
   Card fee percent            2.9
   Card fee per order          0.30
   Labor rate per hour         22.00
   Monthly overhead            2150.00
   Overhead allocation basis   REVENUE      (or UNITS or LABOR)
   Card fee on refunds         KEPT         (or RETURNED)
   Thin margin threshold percent  10
   Minimum units to grade      5
   Period start                2026-03-01
   Period end                  2026-08-31
6. Extensions -> Apps Script. Delete the placeholder, add two files, paste
   engine.gs into one and main.gs into the other, save.
7. Reload the spreadsheet. A "Margin Leak Finder" menu appears. Run
   "Build Margin Report". First run asks for authorization (the script
   touches only this spreadsheet — there are no other permissions, no
   network calls, nothing leaves the sheet).

READING THE REPORT
- LEAKING: the product loses money after true costs. The summary line
  prices the leaks per year at your current run rate.
- THIN: it earns, but under your threshold. It is working for tips.
- LOW DATA: too few sales in the period to grade honestly.
- PROVISIONAL: some of your export's revenue could not be matched to a
  product. The unmatched lines are listed at the bottom with their sheet
  row and reason. Fix them (add cost rows, or mark non-products IGNORE)
  and rebuild. Verdicts are withheld until the report ties out.
- Refund cost: everything you spent on units that came back — their
  materials, labor, packaging, shipping, and (if your processor keeps fees
  on refunds, most do) their share of the card fee.

VERIFYING MY WORK
  python3 checker.py case.json
checker.py implements the same specification from scratch in Python. The
shipped engine and the checker were compared on 330 generated businesses —
72,558 report fields — with zero disagreements, plus a 43-check functional
suite against a mock spreadsheet. The first build disagreed with the
checker on 86 of 225 fields on the sample business alone; that is what
prompts 2 and 3 are about.

HONEST LIMITS
- The labor minutes are yours to estimate; the report is only as true as
  the cost sheet. Start rough, refine the products that come out THIN.
- Overhead allocation is a policy, not a fact. Try all three bases; a
  product that only earns under one of them is telling you something.
- One period is one season. A product that leaks in summer may carry
  December. Run the report per quarter before you kill anything.
- This is arithmetic you can check, not accounting advice.

The sample business (Copperline Candle Co.) and every number in it are
fictional. Sample contact addresses use @example.com.
