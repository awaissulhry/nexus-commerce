# First night on the new code (2026-09-25) — PREDICTIONS, written 2026-09-24 ~15:20 UTC before any nightly run
Baseline: nightly-BEFORE.txt (read only, production, after the deploy).
- readiness-reconcile 02:17 UTC: SUCCESS for both businesses, stopped: complete (yesterday 356 s, 9,741 rows Xavia; 22 Motovento).
  Motovento may gain rows now that it has markets (its eBay/Etsy coordinates resolve).
- A-50 (R-64): Xavia non-Italian avg % DROPS (de 60.4, en 59.4, es 60.6, fr 60.7, nl 70.9; pl/sv/tr 100) where an Italian fallback
  was counted as filled; required_filled falls on those languages. Italian (it 75.7 %, 5,068/10,995) unchanged within a small margin.
- content-drift 03:37 UTC: its FIRST CronRun line; SUCCESS; checks up to its budget of the 235 Amazon listings due (reads only);
  ChannelDrift gains AMAZON rows with checkedBySource 'amazon-content'. A run refused by an Amazon credential is a finding, not a pass.
