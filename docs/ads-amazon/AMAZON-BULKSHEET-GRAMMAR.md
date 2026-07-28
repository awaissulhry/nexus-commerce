# Amazon bulksheet grammar — observed, not guessed

Source: a real Seller Central bulksheet download for the IT profile, 2026-05-29 → 2026-07-28,
provided by the owner 2026-07-29. Everything below is COPIED from that file, not inferred.
Amazon publishes no machine-readable schema and its docs site is client-rendered, so this
document is the only authority we have. Re-download and re-run
`scripts/_axie-bulksheet-inspect.mts` if Amazon changes the format.

## Two findings that change existing code

1. **Portfolios IS importable.** Amazon's Portfolios sheet carries `Product`, `Entity` and
   `Operation` as its first three columns. Ours had none of them, which is exactly why our
   importer skipped the sheet. AX-ZD.8 concluded portfolios could not round-trip; that was true
   of OUR file, not of Amazon's format.
2. **Headers are en-GB on this marketplace** — `Bid optimisation`, not `optimization`. Any
   alias table written from US documentation will silently fail to match on the IT account.

## Verified: our Sponsored Products sheet is correct

All 53 of Amazon's SP columns resolve against our schema, and we emit exactly 53 with no
extras and none missing. The AX-IE.0/.1 column work matches reality.

SHEETS (10):
- "Portfolios"  (xl/worksheets/sheet1.xml, 4,787 bytes)
- "Brand assets data (read-only)"  (xl/worksheets/sheet2.xml, 78,520 bytes)
- "Sponsored Products Campaigns"  (xl/worksheets/sheet3.xml, 7,215,312 bytes)
- "Config"  (xl/worksheets/sheet4.xml, 18,473 bytes)
- "Sponsored Brands campaigns"  (xl/worksheets/sheet5.xml, 123,858 bytes)
- "SB Multi Ad Group Campaigns"  (xl/worksheets/sheet6.xml, 174,717 bytes)
- "Sponsored Display campaigns"  (xl/worksheets/sheet7.xml, 335,281 bytes)
- "SP Search Term Report"  (xl/worksheets/sheet8.xml, 4,161,133 bytes)
- "SB Search Term Report"  (xl/worksheets/sheet9.xml, 2,977 bytes)
- "Sheet9"  (xl/worksheets/sheet10.xml, 484 bytes)

=== Portfolios — 12 columns ===
   1. Product
   2. Entity
   3. Operation
   4. Portfolio ID
   5. Portfolio name
   6. Budget amount
   7. Budget currency code
   8. Budget policy
   9. Budget start date
  10. Budget end date
  11. State (Informational only)
  12. In Budget (Informational only)

=== Brand assets data (read-only) — 2 columns ===
   1. Brand Entity ID
   2. Brand name

=== Sponsored Products Campaigns — 53 columns ===
   1. Product
   2. Entity
   3. Operation
   4. Campaign ID
   5. Ad group ID
   6. Portfolio ID
   7. Ad ID
   8. Keyword ID
   9. Product Targeting ID
  10. Campaign name
  11. Ad group name
  12. Campaign name (Informational only)
  13. Ad group name (Informational only)
  14. Portfolio name (Informational only)
  15. Start date
  16. End date
  17. Targeting type
  18. State
  19. Campaign state (Informational only)
  20. Ad Group State (Informational only)
  21. Daily budget
  22. SKU
  23. ASIN (Informational only)
  24. Eligibility status (Informational only)
  25. Reason for ineligibility (Informational only)
  26. Ad Group Default Bid
  27. Ad Group Default Bid (Informational only)
  28. Bid
  29. Keyword text
  30. Native language keyword
  31. Native language locale
  32. Match type
  33. Bidding strategy
  34. Placement
  35. Percentage
  36. Product targeting expression
  37. Resolved product targeting expression (Informational only)
  38. Audience ID
  39. Shopper Cohort Percentage
  40. Shopper Cohort Type
  41. Segment Name (Informational only)
  42. Sites
  43. Impressions
  44. Clicks
  45. Click-through rate
  46. Spend
  47. Sales
  48. Orders
  49. Units
  50. Conversion rate
  51. ACOS
  52. CPC
  53. ROAS

=== Config — 2 columns ===
   1. SponsoredProductsProductNames
   2. Sponsored Products

=== Sponsored Brands campaigns — 51 columns ===
   1. Product
   2. Entity
   3. Operation
   4. Campaign ID
   5. Draft campaign ID
   6. Portfolio ID
   7. Ad group ID
   8. Keyword ID
   9. Product Targeting ID
  10. Campaign name
  11. Campaign name (Informational only)
  12. Portfolio name (Informational only)
  13. Start date
  14. End date
  15. State
  16. Campaign state (Informational only)
  17. Campaign serving status (Informational only)
  18. Budget type
  19. Budget
  20. Bid optimisation
  21. Bid multiplier
  22. Bid
  23. Keyword text
  24. Match type
  25. Product targeting expression
  26. Resolved product targeting expression (Informational only)
  27. Ad format
  28. Ad format (Informational only)
  29. Landing page URL
  30. Landing page ASINs
  31. Landing page type (Informational only)
  32. Brand Entity ID
  33. Brand name
  34. Brand logo asset ID
  35. Brand logo URL (Informational only)
  36. Custom image asset ID
  37. Creative headline
  38. Creative ASINs
  39. Video media IDs
  40. Creative type
  41. Impressions
  42. Clicks
  43. Click-through rate
  44. Spend
  45. Sales
  46. Orders
  47. Units
  48. Conversion rate
  49. ACOS
  50. CPC
  51. ROAS

=== SB Multi Ad Group Campaigns — 75 columns ===
   1. Product
   2. Entity
   3. Operation
   4. Campaign ID
   5. Portfolio ID
   6. Ad group ID
   7. Ad ID
   8. Keyword ID
   9. Product Targeting ID
  10. Campaign name
  11. Ad group name
  12. Ad name
  13. Campaign name (Informational only)
  14. Ad group name (Informational only)
  15. Portfolio name (Informational only)
  16. Start date
  17. End date
  18. State
  19. Brand Entity ID
  20. Campaign state (Informational only)
  21. Campaign serving status (Informational only)
  22. Campaign serving status details (Informational only)
  23. Rule based budget is processing (Informational only)
  24. Rule based budget name (Informational only)
  25. Rule based budget value (Informational only)
  26. Rule based budget ID (Informational only)
  27. Ad group serving status (Informational only)
  28. Ad group serving status details (Informational only)
  29. Budget type
  30. Budget
  31. Bid optimisation
  32. Product location
  33. Bid
  34. Placement
  35. Percentage
  36. Audience ID
  37. Shopper Cohort Percentage
  38. Shopper Cohort Type
  39. Segment Name (Informational only)
  40. Keyword text
  41. Match type
  42. Native language keyword
  43. Native language locale
  44. Product targeting expression
  45. Resolved product targeting expression (Informational only)
  46. Ad serving status (Informational only)
  47. Ad serving status details (Informational only)
  48. Landing page URL
  49. Landing page ASINs
  50. Landing page type
  51. Brand name
  52. Consent to translate
  53. Brand logo asset ID
  54. Brand logo URL (Informational only)
  55. Brand logo crop
  56. Custom images
  57. Creative headline
  58. Creative ASINs
  59. Video asset IDs
  60. Original video asset IDs (Informational only)
  61. Sub-pages
  62. Product Exclusions
  63. Ad Title
  64. Sites
  65. Impressions
  66. Clicks
  67. Click-through rate
  68. Spend
  69. Sales
  70. Orders
  71. Units
  72. Conversion rate
  73. ACOS
  74. CPC
  75. ROAS

=== Sponsored Display campaigns — 47 columns ===
   1. Product
   2. Entity
   3. Operation
   4. Campaign ID
   5. Portfolio ID
   6. Ad group ID
   7. Ad ID
   8. Targeting ID
   9. Campaign name
  10. Ad group name
  11. Campaign name (Informational only)
  12. Ad group name (Informational only)
  13. Portfolio name (Informational only)
  14. Start date
  15. End date
  16. State
  17. Campaign state (Informational only)
  18. Ad Group State (Informational only)
  19. Tactic
  20. Budget type
  21. Budget
  22. SKU
  23. ASIN (Informational only)
  24. Ad Group Default Bid
  25. Ad Group Default Bid (Informational only)
  26. Bid
  27. Bid optimisation
  28. Cost type
  29. Targeting expression
  30. Resolved targeting expression (Informational only)
  31. Impressions
  32. Clicks
  33. Click-through rate
  34. Spend
  35. Sales
  36. Orders
  37. Units
  38. Conversion rate
  39. ACOS
  40. CPC
  41. ROAS
  42. Viewable impressions
  43. Sales (Views & Clicks)
  44. Orders (Views & Clicks)
  45. Units (Views & Clicks)
  46. ACOS (Views and Clicks)
  47. ROAS (Views and Clicks)

=== SP Search Term Report — 27 columns ===
   1. Product
   2. Campaign ID
   3. Ad group ID
   4. Keyword ID
   5. Product Targeting ID
   6. Campaign name (Informational only)
   7. Ad group name (Informational only)
   8. Portfolio name (Informational only)
   9. State
  10. Campaign state (Informational only)
  11. Bid
  12. Keyword text
  13. Match type
  14. Product targeting expression
  15. Resolved product targeting expression (Informational only)
  16. Customer search term
  17. Impressions
  18. Clicks
  19. Click-through rate
  20. Spend
  21. Sales
  22. Orders
  23. Units
  24. Conversion rate
  25. ACOS
  26. CPC
  27. ROAS

=== SB Search Term Report — 25 columns ===
   1. Product
   2. Campaign ID
   3. Ad group ID
   4. Keyword ID
   5. Product Targeting ID
   6. Campaign name (Informational only)
   7. Ad group name (Informational only)
   8. State
   9. Campaign state (Informational only)
  10. Bid
  11. Keyword text
  12. Match type
  13. Product targeting expression
  14. Customer search term
  15. Impressions
  16. Clicks
  17. Click-through rate
  18. Spend
  19. Sales
  20. Orders
  21. Units
  22. Conversion rate
  23. ACOS
  24. CPC
  25. ROAS

=== Sheet9 — 2 columns ===
   1. Version
   2. Version (1.0)
