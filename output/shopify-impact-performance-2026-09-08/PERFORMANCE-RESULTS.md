# Impact performance work — 8 September 2026

Status: focused theme improvements implemented and published. The overall performance target is **not met**. Repeated slow-mobile tests still show substantial app-related variability. No claim of “AAA” certification or guaranteed scores is made.

## Published release and artifacts

- Current theme: **Nexus Impact 7.2.0 - performance**, ID `200489992519`, CDN path `/t/96/`.
- Immediate rollback retained: **Nexus Impact 7.2.0 - feature cards**, ID `200486879559`.
- Original merchant themes and prior drafts retained.
- Complete ZIP: `nexus-impact-7.2.0.zip` (identical to the review ZIP).
- ZIP SHA-256: `5de9f517d2ff67de9dcdc2a321c1bca3c8986a15c787eda11f86f42c171a50b7`; 1,311,193 bytes.
- `theme.patch` and `changes.json` record the complete changes relative to the supplied Impact 7.2.0 export. That complete integration affects 72 files. This performance pass changes six files relative to the previous feature-card release.
- The previous output folder `../shopify-impact-2026-09-08/` remains the historical baseline; it was not overwritten.

## Implemented

1. **One theme stylesheet request.** The builder appends the preserved merchant/Nexus customization styles to `assets/theme.css`. The standalone customization asset remains available as a reviewable source, but is no longer separately linked. Future CSS changes must be rebuilt into the bundle.
2. **Earlier stylesheet discovery.** The stylesheet appears before app-injected head markup. Shopify's app header and checkout integrations remain intact.
3. **Selected-image resource hint.** Native and Nexus media renderers forward the existing selected-media preload flag to Shopify's `image_tag`. Public HTTP responses include a responsive image preload matching the rendered media. Responsive HTTP preload support varies by browser; this is not evidence of a guaranteed LCP improvement. Eager/high-priority rendering remains in place, and image resolution is unchanged.
4. **Size-guide content on demand.** The size-guide page stays in an inert HTML template until Impact opens its drawer. The native drawer materializes it before its existing transition/focus-trap behavior. Both large images retain full resolution. They accounted for about 316 KiB of transfers in the first lab run and are absent from the active document until opening.
5. **Variant prefetch based on intent.** Removed Impact's viewport-triggered prefetch of every unselected option. Existing pointer/touch prefetch and the native selection/cache/error flow remain. On this product, merely showing the size selector previously scheduled all nine alternative sizes.

Changed files: `layout/theme.liquid`, `assets/theme.css`, `assets/theme.js`, `snippets/media.liquid`, `snippets/nexus-impact-media.liquid`, `snippets/variant-picker.liquid`. Rebuild with `integrations/shopify/impact/build-theme.py`; do not manually append the CSS bundle again.

## Actual Shopify verification

- Initial changes tested in an unpublished duplicate, then published under the user's existing authorization. The subsequent size-guide/prefetch refinement was applied to that release and tested on the public storefront.
- Feature cards: eight retained; Show more and the native feature dialog work. No return to the interim horizontal feature rows.
- Gallery: five mobile thumbnails contained, 390 px page width with no horizontal overflow in the first draft check.
- Mobile menu: chat and loyalty surfaces removed from layout while open. Existing locale controls retained.
- Product selection: M selected; cart confirms **GALE jacket / M / EUR 99.00**, both before and after the runtime refinement. Test items removed; cart restored empty. No order placed.
- Size guide: zero active guide images before opening; two successfully loaded after opening, with original widths 2100 and 2074. Desktop drawer appearance checked. At 390 px mobile width both guide images fit at about 326 px, the page has no horizontal overflow, and Escape dismisses the drawer. Images are inserted once per drawer instance.
- Theme Check: **zero errors, 18 warnings**, matching the pre-existing warning count. JavaScript syntax check passes.
- ZIP integrity and patch round trip: contents match the built theme byte for byte.
- Editor replacement lengths verified before saving all six changed files. Shopify minifies delivered CSS, so its remote byte hash is not expected to equal the source hash.
- Editor input preference and viewport settings restored after testing.

## Lab results — keep all samples

Lighthouse 13.4.1 through PageSpeed Insights, Slow 4G/Moto G Power for mobile. These are individual runs, not a controlled experiment or field-percentile measurements. Product pass 1 desktop did not produce a completed result and is excluded.

| Page / stage | Device | Score | LCP | TBT | CLS |
| --- | --- | ---: | ---: | ---: | ---: |
| Previous feature-card product baseline | Mobile | 64 | 5.6 s | 50 ms | 0 |
| Previous feature-card product baseline | Desktop | 81 | 1.4 s | 180 ms | 0.004 |
| Home, first performance pass | Mobile | 67 | 5.8 s | 50 ms | 0 |
| Home, first performance pass | Desktop | 60 | 1.4 s | 800 ms | 0.002 |
| Collection, first performance pass | Mobile | 63 | 22.0 s | 70 ms | 0 |
| Collection, first performance pass | Desktop | 54 | 2.5 s | 540 ms | 0.004 |
| Product, stylesheet/preload pass | Mobile | 62 | 6.4 s | 330 ms | 0 |
| Product, size-guide/prefetch refinement | Mobile | 66 | 4.9 s | 120 ms | 0 |
| Product, size-guide/prefetch refinement | Desktop | 89 | 0.9 s | 80 ms | 0.004 |
| Product, same final code repeated | Mobile | 50 | 4.8 s | 1,370 ms | 0 |
| Product, same final code repeated | Desktop | 88 | 1.0 s | 110 ms | 0.004 |

The product's final LCP samples are lower than its earlier baseline, while mobile blocking time is inconsistent. The score target remains unmet. Do not present only the best sample.

Reports:
- [Home](https://pagespeed.web.dev/analysis/https-xaviaracing-it/gnprpv4wep)
- [Collection](https://pagespeed.web.dev/analysis/https-xaviaracing-it-collections-all/mr3oonoitu)
- [Product before size-guide refinement](https://pagespeed.web.dev/analysis/https-xaviaracing-it-products-gale-jacket/oom67cmxry)
- [Product final refinement](https://pagespeed.web.dev/analysis/https-xaviaracing-it-products-gale-jacket/vqxu9pekdg)

[Repeated final product report](https://pagespeed.web.dev/analysis/https-xaviaracing-it-products-gale-jacket/4b5kzg2at2). Raw snapshots and all completed samples are in `evidence/` and `performance-runs.json`.

## Remaining measured causes and decisions

**Promotion timing:** the collection LCP element is Klaviyo's “Xavia Racing Banner,” which appears in a delayed popup. Its diagnostic resource-load delay was 6,720 ms; Lighthouse's simulated LCP was 22 seconds. These timings are different measurements and must not be added together. The English form (`YqXPJw`) is configured to open after **5 seconds**, on all devices, with a 3-day repeat delay after dismissal. It excludes the Italian, German, Spanish and French URL paths; localized forms are separate. No promotion settings were changed or published during this pass. A switch to opening the full offer when its compact button is tapped is awaiting the user's decision and must preserve localized targeting and the signup/discount flow.

Klaviyo initially presented an access-update screen, but subsequently became accessible in the browser. It is **not currently an access blocker** for inspecting the promotion. The agent did not click its access-update button.

**App CPU:** the repeated mobile product report attributes 517 ms of main-thread activity to PayPal, 517 ms to Loloyal, and 287 ms to Klaviyo, among other costs. These are diagnostic main-thread totals, not additive TBT savings. Payments, chat, reviews, tracking, loyalty and translations were kept enabled. Do not claim that disabling an app has been approved.

**Loyalty configuration:** CWILL Loyalty currently presents a Shopify data-access update instead of its settings. It requests customer/device/activity data, staff/contributor data, products, orders, discounts, web-pixel editing and Online Store access. That new grant was not approved. It requires the merchant's review before further app-specific configuration can be inspected.

**Review app:** Judge.me settings and its published performance guidance were reviewed. No supported lazy-loading toggle was found in the inspected Advanced settings. No review settings or data were changed.

**Other remaining work:** app-specific loading configuration and further repeatable tests after the promotion decision; image compression opportunities that preserve visual quality; real Nexus publisher verification and native-family migration remain separate from this storefront performance pass.

## Field data context

Shopify's dashboard, observed with its **30-day** window, reported store-wide LCP P75 **1,704 ms**, INP P75 **112 ms**, and CLS **0**. Those historical figures are healthy, but are not a mobile-only cohort, do not isolate this release, and cannot substitute for new-release verification. PageSpeed reported no public CrUX field data for the tested URLs.

Primary implementation guidance: [Shopify performance](https://shopify.dev/docs/storefronts/themes/best-practices/performance), [Shopify image preload](https://shopify.dev/docs/api/liquid/filters/image_tag#preload), [responsive preload limitations](https://web.dev/articles/preload-responsive-images), [Klaviyo display rules](https://help.klaviyo.com/hc/en-us/articles/4413544555547), [Judge.me loading behavior](https://judge.me/help/en/articles/8415544-understanding-judge-me-loading-speed-and-performance).
