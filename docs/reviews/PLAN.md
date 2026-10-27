# Reviews area rebuild — plan v1 (2026-10-26), waits for the Owner's yes
Inputs: 01-current-map.md, 02-ds-page-recipe.md, competitor/channel research (helper 3, summarised in §9).
Base path stays /marketing/reviews (permission pages.reviews already mapped). Plain English UI, DS only.

## 1. Navigation (Owner 10-26: SUB-SIDEBAR, not rail children)
Main rail: ONE item "Reviews" (badge = reviews that need a reply). Reviews sub-sidebar (DS secondary navigation, WorkspaceSubheader /
Settings pattern): Overview · Inbox · Requests (Queue, Rules, Timing) · Insights (Themes, Products, Alerts, Fixes, Brief) ·
Channels (Amazon + markets, eBay + markets, Shopify, Etsy) · Settings. Page-level link tabs for Requests/Insights are dropped (sub-sidebar holds them).

## 2. Pages and sections
1. Overview /marketing/reviews
   PageHeader (crumbs, TimeframePicker) → MetricStrip (avg rating, new reviews, need reply, requests sent, review rate, open alerts; click = filter)
   → Banner (setup problems in words, no env names) → rating trend (PerformanceGraph) + rating bars (new RatingBars)
   → "Needs you" (top items: negative not answered, new alerts, failed requests) → channel × market table (rating, count, trend, sent, rate → channel page)
   → themes "love / fix" (Amazon topics + our categories) → products to watch (biggest drops).
2. Inbox /marketing/reviews/inbox (replaces /desk). Tabs: All · Product reviews · Seller feedback.
   MetricStrip (New, In progress, Responded, Resolved, Ignored, Overdue) → FilterBar (channel, market, stars, sentiment, theme, status, assignee, has photo, product family)
   → NexusGrid (date, channel·market, stars, snippet, product/variant, order, sentiment, themes, status, assignee, due) + saved views + Customise
   → bulk (assign, tag, set status, AI draft) → row = DetailModal (J/K): text + photos (Lightbox), product/variant/order/return links, buyer history,
   sentiment/themes, ReplyComposer (per-channel limits; AI draft in buyer language; Amazon/Etsy = copy + open Seller Central / Shop Manager), triage, Timeline.
3. Requests /marketing/reviews/requests. Link tabs: Queue · Rules · Timing.
   3a Queue: MetricStrip (Scheduled, Due now, Retrying, Sent, Failed, Skipped, review rate) → mailer state Banner + Pause/Resume + Run now (confirm)
      → FilterBar → grid (order, channel·market, product, delivered, due, status, attempts, reason, rule) → bulk (snooze, skip, send now)
      → row = DetailModal (attempt Timeline, Amazon answer code, snooze/send now/skip/unsuppress). Actions: "Package inserts" modal, "Preview email" modal.
   3b Rules /requests/rules (from /orders/reviews/rules): grid of rules (on/off, scope, markets, delay, sent, rate, A/B) + export/import/duplicate/dry run.
   3c Rule editor /requests/rules/[id] (DS Builder page): scope, markets, timing, operational exclusions only, send window, live timing preview, copy lint, dry run.
   3d Timing /requests/timing (merges /orders/.../timing + send-times): delay by product type, send windows per market (Heatmap weekday × hour),
      conversion by send time, timing tests (holdout: day 4 vs 7 vs 10, per market/product type).
4. Insights /marketing/reviews/insights. Link tabs: Themes · Products · Alerts · Fixes · Brief.
   Themes: topic board (trend, star impact, share, snippets), heatmap day × theme. Products: grid by family/variant (rating, count, sparkline,
   top negative theme, return rate) → product DetailModal (Summary, Reviews, Themes, Returns). Alerts (spikes): Acknowledge/Resolve/Generate fixes.
   Fixes: AI fixes (bullets, A+, size guide, recall flag, task) → sent as a change plan for approval (not a status flip). Brief: AI voice-of-customer brief.
5. Channel pages /marketing/reviews/amazon[/<m>], /ebay[/<m>], /shopify, /etsy = Overview with a path lock (Listings readinessScope pattern)
   + "<channel> tools" menu: Amazon (seller feedback removal helper, inserts), eBay (leave feedback for buyers, revision status), Etsy/Shopify (open shop tools).
   Tiles/links open Inbox/Requests/Insights filtered to that channel + market.
6. Settings /marketing/reviews/settings: Sources per channel (state in words), Emails & unsubscribes (EmailSuppression list), Reply templates & brand voice,
   Alerts (new negative, rating drop), Automations (domain=reviews list; editor stays in the rules builder for now), Pipeline health.
Pop-ups (not pages): review detail, request detail, product reviews, Import reviews (Modal + Stepper), Package inserts, Email preview/test.

## 3. Moves from Orders (Orders page rebuilt later)
Move: /orders/reviews/rules, /timing, /send-times; Orders "Reviews" lens history + "Run engine now". Old URLs redirect.
Stay on Orders for now as entry points linking into Reviews: review-status column, "Request review" on an order, bulk "Request reviews", order request card.

## 4. Retire (redirect to new home)
/desk→Inbox, /advanced→Overview, /spikes→Insights/Alerts, /actions→Insights/Fixes, /spotlight→Insights/Brief, /by-product + /products/[id]→Insights/Products,
/heatmap→Insights/Themes, /automation→Settings, /import→Inbox (Import modal), /inserts→Requests (modal), /requests/test/preview→modal,
/performance/feedback (dead)→Inbox Seller feedback. Unused SpikeFeed.tsx, IngestHealthStrip.tsx deleted.

## 5. New DS parts (DS first, catalog + CHANGELOG + DS-GAPS line)
StarRating (from grid MetafieldValue stars), RatingBars (1-5 distribution), ReplyComposer (limit + counter + templates + AI draft slot), Lightbox (MediaPreview + prev/next),
FilterBar date kind (if needed). ReviewCard only if Inbox needs a card view.

## 6. Fixes found on the way
- One sender: "Run now" calls the mailer; retire POST /review-engine/tick (no pause, no sentiment check, marks non-Amazon SKIPPED).
- Review gating: sentiment check NEGATIVE suppresses the Amazon request (review-request-mailer.job.ts:186-191). Read-only check if any rule has it on;
  fix = sentiment check never stops a marketplace request (own-shop email only). Needs Owner's word (changes live Amazon sends).
- Studio Reviews card real data (product-analytics.service.ts:248 hard-codes 0). Copy that contradicts code (rules page, MCP request-review text).
- Sandbox fixture reviews must not show (filter ingestSource FIXTURE). Env names never shown to users.
- segments review-request writes a missing field (triggeredBy) → fix or remove.

## 7. New data (phase 3)
eBay REST Feedback API (photos, AI topics, 500-char replies; today Trading 80 chars), Etsy getReviewsByShop (read only; reply in Shop Manager),
Amazon GET_SELLER_FEEDBACK_DATA (1-3 star feedback) + removal helper (createNegativeFeedbackRemoval = Amazon write, per-action Owner word),
Shopify review app (Judge.me/Okendo API — which app is used: check), Review media fields (additive migration), fit/size direction (runs small/large),
defect loop (themes + return reasons per family), timing tests.

## 8. Build order (max 3 helpers at once; uptime + ps check before each start; nice -n 15; vitest --maxWorkers=2; one typecheck at a time)
Phase 1: (A) DS parts + area shell/nav/lock + Overview; (B) Inbox + detail + reply; (C) Requests Queue/Rules/Editor/Timing + moves + one sender. Then Settings + retire/redirects.
Phase 2: Insights (5 tabs), channel pages + tools, studio card.
Phase 3: new data (§7) + differentiators.
Each phase: light local checks table → PR → merge only on "Merge #N".

## 9. Research essentials (helper 3)
Table stakes: Amazon request automation (delay, filters), negative alerts, dashboard; store apps: photos/video, widgets, AI summaries, AI reply drafts.
Differentiators to beat: one inbox across channels linked to catalog (variant/order/return); defect loop reviews+returns; measured timing tests;
compliance by construction (operational exclusions only; per-channel reply rules: Etsy once/100 days/no edit, eBay one reply 500 chars, Amazon no API reply);
insights → proposed listing changes through approval. Amazon has NO API for review text; Customer Feedback API = topics/snippets/trends weekly, EN only.
