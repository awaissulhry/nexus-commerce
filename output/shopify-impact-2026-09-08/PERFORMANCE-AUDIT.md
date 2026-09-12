# Xavia Racing storefront performance audit — 8 September 2026

## Finding

The measured storefront does not meet the requested quality target. Across 26 lab samples, layout stability is good but loading and main-thread work vary substantially. The latest product mobile sample scored 64 with 50 ms blocking time; its preceding sample scored 71. The most recent home and collection mobile samples scored 40 and 54; this is not a site-wide speed sign-off. Real app processing and the late promotional popup are material bottlenecks. These are observations, not a claim that the integration caused every existing issue.

## Method and evidence

Google PageSpeed Insights tested the public home, collection and GALE product URLs after theme `200481964359` was published. These are real Shopify pages with the store's real apps and assets. Tests ran around 20:56 Europe/Rome on 8 September, using Lighthouse 13.4.1. Mobile uses the simulated Moto G Power / slow 4G profile; desktop uses Lighthouse's desktop profile. The reports did not provide sufficient Chrome UX Report field data. Each result is one lab run, subject to server, network and third-party variation; it is not a field percentile, an INP measurement or accessibility certification.

| Page | Device | Performance | FCP | LCP | Blocking time | CLS | Speed index |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Home | Mobile | 54 | 5.2 s | 15.0 s | 170 ms | 0 | 10.7 s |
| Home | Desktop | 85 | 0.6 s | 0.9 s | 180 ms | 0.002 | 4.3 s |
| Collection | Mobile | 39 | 4.1 s | 13.8 s | 760 ms | 0 | 12.4 s |
| Collection | Desktop | 68 | 0.5 s | 2.5 s | 250 ms | 0.004 | 4.8 s |
| Product | Mobile | 37 | 3.1 s | 6.6 s | 2,410 ms | 0 | 6.3 s |
| Product | Desktop | 89 | 0.6 s | 1.0 s | 30 ms | 0.004 | 4.9 s |

Public reports: [home](https://pagespeed.web.dev/analysis/https-xaviaracing-it/i5d4u6iss1), [collection](https://pagespeed.web.dev/analysis/https-xaviaracing-it-collections-all/4xmghb9idv), [product](https://pagespeed.web.dev/analysis/https-xaviaracing-it-products-gale-jacket/4vmye430vg). Add `?form_factor=mobile` or `?form_factor=desktop` to select the device. Captured report text is under `evidence/pagespeed-*-before-*.txt`; the metric record is `performance-baseline.json`. Here, “before” means before the second theme refinement, not before all Nexus changes. No comparable six-page run of the original theme was taken, so a quantified original-theme regression claim would be unsupported.

## Published refinement and repeated measurements

The interim theme measured in these passes was **Nexus Impact 7.2.0 - refined**, ID `200483930439`. The current live release is feature-card theme `200486879559`. Three measurement passes followed the initial six-sample baseline: the first refinement, a repeat to investigate variance, and a pass after batching thumbnail layout work. Each pass includes the same three pages on mobile and desktop, for **24 samples total**. `performance-runs.json` records every result and stage; no unfavorable samples have been discarded. These passes include code changes and are not a controlled distribution from which to claim a statistical speedup.

The final benchmark pass reports:

| Page | Device | Performance | FCP | LCP | Blocking time | CLS | Speed index |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Home | Mobile | 40 | 2.5 s | 8.0 s | 1,100 ms | 0 | 11.1 s |
| Home | Desktop | 73 | 0.6 s | 1.0 s | 390 ms | 0.002 | 4.0 s |
| Collection | Mobile | 54 | 2.4 s | 20.8 s | 370 ms | 0 | 11.4 s |
| Collection | Desktop | 74 | 0.5 s | 2.3 s | 170 ms | 0.004 | 4.7 s |
| Product | Mobile | 71 | 2.7 s | 4.5 s | 30 ms | 0 | 11.3 s |
| Product | Desktop | 68 | 0.7 s | 1.2 s | 440 ms | 0.004 | 6.0 s |

Final benchmark reports: [home](https://pagespeed.web.dev/analysis/https-xaviaracing-it/480c2t5rz2), [collection](https://pagespeed.web.dev/analysis/https-xaviaracing-it-collections-all/r56airwu58), [product](https://pagespeed.web.dev/analysis/https-xaviaracing-it-products-gale-jacket/1zdhfnu9er). The subsequent gallery containment refinements and French/German/Spanish interface translations were verified functionally; these last cosmetic/translation edits were not separately benchmarked.

| Page | Baseline mobile / desktop | Three refinement samples: mobile | Three refinement samples: desktop |
| --- | --- | --- | --- |
| Home | 54 / 85 | 50, 57, 40 | 56, 80, 73 |
| Collection | 39 / 68 | 54, 32, 54 | 42, 79, 74 |
| Product | 37 / 89 | 52, 57, 71 | 84, 87, 68 |

Earlier refinement reports: [home](https://pagespeed.web.dev/analysis/https-xaviaracing-it/qktd0aa2qi), [collection](https://pagespeed.web.dev/analysis/https-xaviaracing-it-collections-all/ssrjll9vm5), [product](https://pagespeed.web.dev/analysis/https-xaviaracing-it-products-gale-jacket/sk1bb1734u). Repeat reports: [home](https://pagespeed.web.dev/analysis/https-xaviaracing-it/mfke6l8dsd), [collection](https://pagespeed.web.dev/analysis/https-xaviaracing-it-collections-all/ugi5v35yfx), [product](https://pagespeed.web.dev/analysis/https-xaviaracing-it-products-gale-jacket/5xqh4swdjt).

The collection's first refinement LCP was the **Klaviyo popup banner**, rather than a product card. Its diagnostic resource-load delay was 7,490 ms; the complete simulated LCP was 20.7 s. This identifies the observed late popup as a concrete loading/UX issue. A repeat also recorded 8,000 ms of blocking time, with total CPU attributed to first-party work (7,604 ms), Klaviyo (3,761 ms), Shopify hosting (3,212 ms), Loloyal (2,723 ms) and LangShop (595 ms), among others. These are diagnostic CPU totals, not additive TBT savings.

The repeated collection trace also attributed 566 ms total CPU to our thumbnail adapter. That led to the final change: measure all cards before making layout changes, and skip unchanged DOM writes. Its live hover and full-card replacement were retested successfully. The change's exact isolated saving is not established by these variable whole-page runs.

## Findings and changes

| Finding | Evidence | Action and status |
| --- | --- | --- |
| First hero waits for its reveal effect | The home LCP element is `banner-3-sm.jpg`. Its discovery already uses eager/high loading. The diagnostic LCP breakdown attributes 1,980 ms to element render delay. These diagnostic subparts are not the simulated 15 s LCP total. | Published: removed the initial reveal from the first slideshow section, retaining later-section transitions. Measured results are above. |
| First collection images lack explicit priority | The collection report identifies the AIREON Pant image and recommends high fetch priority. | Published: explicit eager loading and high priority for the first two eligible native/managed cards. Later-card lazy loading and responsive image sources are retained. A later popup, rather than a product image, became the LCP element in the first refinement run. |
| Product page spends substantial time executing and laying out app content | Product report: roughly 5,084 KiB total transfer, 554 KiB estimated unused JavaScript, 16 s main-thread work and 4.6 s script execution under the test profile. | Requires app-by-app performance work after the theme refinement is measured. No app has been removed or commerce feature disabled. |
| App CPU is material | Product total-CPU attribution includes Shopify hosting 1,796 ms, PayPal 1,271 ms, Klaviyo 901 ms, Loloyal 885 ms and LangShop 192 ms. The Shopify group includes Judge.me. The first-party document is also expensive. | These are diagnostic CPU groups, not individual TBT contributions or additive promises of savings. Review duplicate locale tools, app loading scope, reviews initialization and promotional widgets with each app's supported settings. Payment and language functionality require regression testing before changing their loading. |
| Menu adapter needlessly scans closed-menu DOM changes | Initial adapter accounts for about 130 ms total CPU, of which 8 ms is script evaluation. Native theme.js is about 346 ms total CPU in the same report. | Published: widget rescans are limited to the open menu, using the explicit menu state class. Real widget hiding/restoration and localization interactions passed. |
| Some lower-page imagery is expensive | Product audit estimates 731 KiB of image savings, including 800px content images and a locale flag sprite. | Retained native responsive sources and high-density image quality. The audit's size estimate alone is insufficient justification to halve images on high-DPI screens. Review replacement compression and the locale app's sprite separately. |
| Empty legacy slideshow throws during initialization | The real product page has an empty configured slideshow; the same error was observed on the retained original theme. | Published: guarded empty carousel initialization and reveal. Refined real product/mobile runs returned no error-level console entries. |
| New global variant-card ordering has an explicit scale cost | Managed collections aggregate filtered native pages with concurrency 3 before applying a global order. Current catalogue remains legacy, so the real tests did not exercise this path. | Bounded to 250 families / 2,000 cards / 50 native pages with visible failure/retry. Measure representative managed collections before catalogue-wide activation. A much larger catalogue needs a different indexing strategy. |

The published refinement also fixes sticky thumbnail containment and replaces Features popups/nested expansion with native inline accordions, removing the bespoke dialog controller. A final inset keeps the first thumbnail clear of the loyalty launcher. These usability changes passed real-store checks; their isolated performance contribution was not measured.

## Accessibility and search observations

| Page | Accessibility mobile / desktop | Best practices | SEO |
| --- | ---: | ---: | ---: |
| Home | 90 / 90 | 92 | 85 |
| Collection | 94 / 97 | 92 | 92 |
| Product | 94 / 94 | 92 | 100 |

The reports flag contrast and touch-target issues, among others. Automated scores cannot establish WCAG AAA compliance. Some findings involve existing brand styling and embedded apps. Manual keyboard, zoom, screen-reader and translated-content checks remain necessary. The real mobile menu passed widget hiding/restoration, US/Italy currency switching and Italian localization. The new interface keys cover the five currently offered storefront languages. Other installed theme locales retain explicit English fallbacks.

## Completion criteria and next measurements

1. Theme publication, representative real-store interactions and the 24 lab measurements are complete to the documented scope. The native upload dialog was bypassed through Shopify's supported draft code editor. The original and first-release themes remain available for rollback.
2. The user has been asked whether the mobile discount popup should open only when its teaser is tapped. No promotional behavior has been changed. This is a concrete UX/marketing decision; tap-to-open would also avoid the observed automatic late banner, but does not by itself remove all Klaviyo script costs.
3. Profile and reduce the largest app initialization costs through supported app settings, checking that reviews, promotions, localization and payments continue working. The current audit does not establish that delaying any particular app is safe.
4. Test a genuinely published Nexus family and a representative managed collection after a usable Nexus Shopify destination is connected. Verify first render, option transitions and cart identity, as well as page-load performance.
5. Monitor real-user Core Web Vitals after release. The standard good thresholds are LCP ≤2.5 s, INP ≤200 ms and CLS ≤0.1 at the 75th percentile; a single Lighthouse run cannot prove those field results. [Core Web Vitals guidance](https://web.dev/articles/vitals)

Theme optimization follows Shopify's guidance on critical rendering, responsive images and JavaScript scope. [Shopify theme performance guidance](https://shopify.dev/docs/storefronts/themes/best-practices/performance)

A complete speed sign-off is withheld. Home and collection mobile loading, variable app processing, and the new managed-family/collection performance path still need work and verification. The quality target remains open.

## Later feature-card review revision

The merchant requested restoring the original feature cards/popups after these 24 samples. The subsequently published feature-card theme (`200486879559`) restores them with a counted 48px disclosure, a small delegated controller and native dialogs. All eight full-size popup images have no `src` initially; opening one card requests only that image (observed on the actual Shopify preview). Styles reuse the existing customization asset. A later product-only benchmark is recorded below. No speed improvement is inferred from the deferred-image functional check alone.

## Published cards: additional product benchmark

Two further public-page tests bring the audit to **26 samples**. The 22:55 Europe/Rome report measures active theme `200486879559`, before the final shared-divider CSS cleanup. No separate score is claimed for that CSS correction.

| Device | Performance | FCP | LCP | Blocking time | CLS | Speed index |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Mobile | 64 | 3.2 s | 5.6 s | 50 ms | 0 | 11.4 s |
| Desktop | 81 | 0.7 s | 1.4 s | 180 ms | 0.004 | 5.1 s |

Both report accessibility 94, best practices 92 and SEO 100. The [public report](https://pagespeed.web.dev/analysis/https-xaviaracing-it-products-gale-jacket/ygk7kh1bdk) and captured report text are retained. These results still do not meet the requested speed target; the change from the preceding 71/68 scores to 64/81 is not a controlled causal comparison.
