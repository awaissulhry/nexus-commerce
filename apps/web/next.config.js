/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Local-dev build-dir isolation. When several sessions edit this app at once,
  // any `git push` runs the pre-push hook's `rm -rf .next && next build`, which
  // nukes a running `next dev`'s build dir → 500s on the shared preview. Running
  // dev with NEXT_DEV_ISOLATED=1 puts its artifacts in `.next-dev`, which the
  // prod build never touches. No-op wherever the env var is unset (prod, Vercel,
  // the pre-push build) → safe to commit.
  // NEXT_DIST_DIR is the explicit override, and it exists for the PRE-PUSH build. The hook used
  // to `rm -rf .next && next build` into the shared dir, so two sessions pushing at once deleted
  // each other's output mid-build — observed 2026-08-06 with three concurrent pushes, each dying
  // on ENOENT for a file its own build had just written (_ssgManifest.js, pages-manifest.json).
  // Guaranteed, not flaky: any overlap fails. Unset in prod and on Vercel, so behaviour there is
  // byte-identical to before.
  distDir: process.env.NEXT_DIST_DIR || (process.env.NEXT_DEV_ISOLATED === '1' ? '.next-dev' : '.next'),
  // This prevents Turbopack from breaking the Prisma connection
  serverExternalPackages: ["@prisma/client", "pg", "@nexus/database"],
  // PERF — client-side Router Cache. Next 15 defaults staleTimes.dynamic to 0,
  // so dynamic (force-dynamic) pages are NEVER kept client-side → every Back
  // navigation re-fetches + re-renders from scratch (skeleton flash + reload).
  // Keeping visited dynamic segments for 3 min makes Back instant (restores the
  // cached page + scroll, no server round trip). Live views still refresh via
  // their own SSE/effect subscriptions.
  experimental: {
    staleTimes: {
      dynamic: 180,
      static: 300,
    },
  },
  async redirects() {
    return [
      // ── NEG.1 — the Negative Targeting tab became its own route ────────────
      //
      // `RulesAutomationClient.tsx:91-94` resolves an unknown OR ROUTED `?tab=`
      // to 'rules'. So the moment a tab is flipped to `routed: true`, every
      // existing `?tab=<key>` link silently renders Apply Rules instead — no
      // 404, no message, just the wrong page. This is a real 308 rather than a
      // one-line `redirect()` stub for the reason the ACR.6 block below gives.
      //
      // FIRST in the array, and matched on `has` rather than on the path, so it
      // cannot be swallowed by anything later.
      {
        source: '/marketing/ads/rules-automation',
        has: [{ type: 'query', key: 'tab', value: 'negative-targeting' }],
        destination: '/marketing/ads/rules-automation/negative-targeting',
        permanent: true,
      },
      // HV.1 — the same, for Keyword Harvest. One entry per routed tab; the block above explains
      // why each is needed and why `check-link-targets.mjs` cannot catch a missing one (RulesTabs
      // builds its href in a function call rather than a literal).
      {
        source: '/marketing/ads/rules-automation',
        has: [{ type: 'query', key: 'tab', value: 'keyword-harvest' }],
        destination: '/marketing/ads/rules-automation/keyword-harvest',
        permanent: true,
      },
      // BID.S0 — same mechanism, same shape. `?tab=bid` predates the route and is the URL every
      // existing link to the Bid tab uses; without this it silently renders Apply Rules.
      {
        source: '/marketing/ads/rules-automation',
        has: [{ type: 'query', key: 'tab', value: 'bid' }],
        destination: '/marketing/ads/rules-automation/bid',
        permanent: true,
      },
      // BUD.1 — the same, for Budget Rules. Verified on prod immediately before flipping the tab:
      // `?tab=budget` returned 200 (correct then — it was not routed), while `?tab=bid`,
      // `?tab=negative-targeting` and `?tab=keyword-harvest` returned an opaque redirect. Without
      // this entry, flipping `routed: true` turns every existing `?tab=budget` link into a silent
      // render of Apply Rules.
      //
      // ⚠ This is the FOURTH copy of one rule, and RD.P0 has already measured that the pattern does
      // not scale: `?tab=automations`, `?tab=dayparting` and `?tab=keyword-tracker` are all still
      // returning 200 and rendering the wrong page on prod right now, because each session has to
      // remember this separately and three did not. The generic form derived from
      // `RULES_TABS.filter(t => t.routed)` supersedes all of them and needs the routed-key list
      // lifted into a plain `.mjs` both this CommonJS config and the `'use client'` tabs module can
      // read. Left as a hand-off in locks §4 rather than taken here: a session is scoped to one
      // page, and fixing three other pages' links is not this page's change to make.
      {
        source: '/marketing/ads/rules-automation',
        has: [{ type: 'query', key: 'tab', value: 'budget' }],
        destination: '/marketing/ads/rules-automation/budget',
        permanent: true,
      },
      // BSP.0 — same mechanism, same shape, for Budget Pacing & Schedules. One literal entry rather
      // than the derived rule §4 of the locks doc proposes: deriving it needs the routed-key list
      // lifted out of `_shared/tabs.tsx` into a `.mjs` this CommonJS config can require, and four
      // sessions hold that file right now.
      {
        source: '/marketing/ads/rules-automation',
        has: [{ type: 'query', key: 'tab', value: 'budget-schedules' }],
        destination: '/marketing/ads/rules-automation/budget-schedules',
        permanent: true,
      },
      // PLC.0 — same mechanism, same shape, for Placement.
      {
        source: '/marketing/ads/rules-automation',
        has: [{ type: 'query', key: 'tab', value: 'placement' }],
        destination: '/marketing/ads/rules-automation/placement',
        permanent: true,
      },

      // Phase 4 (2026-05-06): /pim/review → /catalog/organize.
      // Page does catalog organization, not a review queue; renamed
      // so the URL matches the behaviour. Permanent because the new
      // path is the canonical one going forward.
      { source: '/pim/review', destination: '/catalog/organize', permanent: true },
      { source: '/pim/review/:path*', destination: '/catalog/organize/:path*', permanent: true },
      { source: '/pim', destination: '/catalog/organize', permanent: true },

      // ── ACR.6 (Stage 6) — /marketing/advertising is retired ────────────────
      //
      // 39 of its 41 routes are gone; /marketing/ads is the console. Every
      // destination below answers the SAME question the old page answered —
      // where it did not, the capability was ported first (see ACR.6.0 in
      // docs/2026-08-05-ads-control-room-coverage-acr.md) or the page was
      // deleted because prod proved it had never been used.
      //
      // Done here rather than as redirect() stubs so the directory can actually
      // be deleted: a tree of one-line files is a tree that gets edited back
      // into pages. These are real 308s, so bookmarks and the operator runbook
      // keep working, and search engines/browsers stop re-asking.
      //
      // ORDER MATTERS. Next matches this array top-down, so every literal
      // /automation/* path must precede /automation/:id or the parameterised
      // rule swallows them.
      //
      // NOT redirected: /marketing/advertising/ngrams and .../funnel. Both are
      // interpretation surfaces a standing operator decision assigns to
      // Analytics, which another workstream owns. They keep working where they
      // are until that owner takes them.

      // Landing + interpretation → Dashboard (which prints the same headline
      // numbers, and since ACR.6/R5 the per-SKU P&L rows behind them).
      { source: '/marketing/advertising', destination: '/marketing/ads/dashboard', permanent: true },
      { source: '/marketing/advertising/analytics', destination: '/marketing/ads/dashboard', permanent: true },
      { source: '/marketing/advertising/momentum', destination: '/marketing/ads/dashboard', permanent: true },
      { source: '/marketing/advertising/profit', destination: '/marketing/ads/dashboard', permanent: true },

      // Campaigns — ids carry across unchanged, so a deep link still lands on
      // the same campaign rather than on a list.
      { source: '/marketing/advertising/campaigns', destination: '/marketing/ads/campaigns', permanent: true },
      { source: '/marketing/advertising/campaigns/:id/ad-groups/:agId', destination: '/marketing/ads/campaigns/:id/ad-groups/:agId', permanent: true },
      { source: '/marketing/advertising/campaigns/:id', destination: '/marketing/ads/campaigns/:id', permanent: true },

      // Creation paths → the builder that does the same job.
      { source: '/marketing/advertising/create', destination: '/marketing/ads/campaign-builder/single', permanent: true },
      { source: '/marketing/advertising/architect', destination: '/marketing/ads/campaign-builder/sp-super-wizard', permanent: true },
      { source: '/marketing/advertising/goals', destination: '/marketing/ads/ai-advertising/new-goal', permanent: true },

      // Automation. Literals first — see the ordering note above.
      { source: '/marketing/advertising/automation/new', destination: '/marketing/ads/rules-automation', permanent: true },
      { source: '/marketing/advertising/automation/library', destination: '/marketing/ads/rules-automation', permanent: true },
      { source: '/marketing/advertising/automation/analytics', destination: '/marketing/ads/rules-automation', permanent: true },
      { source: '/marketing/advertising/automation/health', destination: '/marketing/ads/health', permanent: true },
      { source: '/marketing/advertising/automation/executions/:id', destination: '/marketing/ads/rules-automation/control-room?tab=activity', permanent: true },
      { source: '/marketing/advertising/automation/executions', destination: '/marketing/ads/rules-automation/control-room?tab=activity', permanent: true },
      { source: '/marketing/advertising/automation/:id', destination: '/marketing/ads/rules-automation', permanent: true },
      { source: '/marketing/advertising/automation', destination: '/marketing/ads/rules-automation', permanent: true },
      { source: '/marketing/advertising/dayparting', destination: '/marketing/ads/rules-automation/dayparting', permanent: true },
      { source: '/marketing/advertising/share-of-voice', destination: '/marketing/ads/rules-automation?tab=share-of-voice', permanent: true },

      // The five optimiser engines feed the ranked Recommendations inbox; the
      // account-level planner is now a panel on that same page (ACR.6/R3).
      { source: '/marketing/advertising/autopilot', destination: '/marketing/ads/recommendations', permanent: true },
      { source: '/marketing/advertising/bid-optimizer', destination: '/marketing/ads/recommendations', permanent: true },
      { source: '/marketing/advertising/harvest', destination: '/marketing/ads/recommendations', permanent: true },
      { source: '/marketing/advertising/pacing', destination: '/marketing/ads/recommendations', permanent: true },
      { source: '/marketing/advertising/insights', destination: '/marketing/ads/recommendations', permanent: true },
      { source: '/marketing/advertising/recommendations', destination: '/marketing/ads/recommendations', permanent: true },

      // Health already renders retail-readiness; the probe console is a panel
      // on it since ACR.6/R12.
      { source: '/marketing/advertising/retail-readiness', destination: '/marketing/ads/health', permanent: true },
      { source: '/marketing/advertising/debug', destination: '/marketing/ads/health', permanent: true },

      // Budgets. Pools are a drawer on Budget Manager since ACR.6/R9.
      { source: '/marketing/advertising/budget-manager', destination: '/marketing/ads/budget-manager', permanent: true },
      { source: '/marketing/advertising/budget-pools/:id', destination: '/marketing/ads/budget-manager', permanent: true },
      { source: '/marketing/advertising/budget-pools', destination: '/marketing/ads/budget-manager', permanent: true },

      // Reporting. iROAS is a panel on the landing page since ACR.6/R7.
      { source: '/marketing/advertising/reports', destination: '/marketing/ads/reporting/pipeline', permanent: true },
      { source: '/marketing/advertising/search-terms', destination: '/marketing/ads/reporting/search-term', permanent: true },
      { source: '/marketing/advertising/incrementality', destination: '/marketing/ads/reporting', permanent: true },

      // Change feed. Writing an operator note moved with it (ACR.6/R6).
      { source: '/marketing/advertising/events', destination: '/marketing/ads/changelog', permanent: true },

      // Deleted outright, with prod row counts as the evidence:
      //   dsp          — 0 DSP campaigns ever created; the entitlement is
      //                  refused at Amazon, so it lands on Ad Manager.
      //   audiences    — 0 audiences; AMC likewise refused, so it lands on the
      //                  console's AMC section, which is where it would live if
      //                  the entitlement ever arrives.
      //   storage-age  — 0 rows; the ingest never populated. It was an FBA
      //                  inventory surface misfiled under ads, so it lands in
      //                  fulfillment rather than anywhere in the ads console.
      { source: '/marketing/advertising/dsp', destination: '/marketing/ads/campaigns', permanent: true },
      { source: '/marketing/advertising/audiences', destination: '/marketing/ads/amc/audiences', permanent: true },
      { source: '/marketing/advertising/storage-age', destination: '/fulfillment/replenishment', permanent: true },

      // Never an ads surface — Google/Meta catalogue exports (ACR.6/R11).
      { source: '/marketing/advertising/feeds', destination: '/marketing/content/feeds', permanent: true },

      // ── NAF.SB.7 — the Agent Fleet left the ads console for /fleet ─────────
      //
      // It was never a marketing surface: the roster in docs/AGENT_FLEET.md
      // Part 6 already reaches catalog, pricing, inventory and platform-ops
      // analysts, and only the first cohort happens to be ads.
      //
      // These replace an optional catch-all page that called permanentRedirect().
      // That page DID redirect a browser, but only client-side: the ads layout
      // renders before the page, so the response has already begun streaming and
      // headers are gone by the time the redirect throws — 200 with the target in
      // the RSC payload, on dev AND on prod. Verified with curl against Vercel,
      // not assumed. Config redirects run before routing, so these are real 308s.
      //
      // NOT caught, deliberately: /marketing/ads/rules-automation/fleet/… , where
      // the components and the worker page still live. Different path, untouched.
      { source: '/marketing/ads/fleet', destination: '/fleet', permanent: true },
      { source: '/marketing/ads/fleet/:path*', destination: '/fleet/:path*', permanent: true },
    ];
  },
};

module.exports = nextConfig;
