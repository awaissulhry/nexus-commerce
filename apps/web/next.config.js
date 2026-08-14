// RA.SPINE S3 — the routed Rules & Automation tabs, in the one format this CommonJS config can
// read. See that file's header for why it exists and why it is a `.cjs` and not the `.mjs` the
// hand-off note below guessed.
const { tabRedirects, bareIndexRedirect } = require('./src/app/marketing/ads/rules-automation/_shared/rulesTabRoutes.cjs');

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
      // ── RA.SPINE S3 — one derived rule, replacing six hand-written copies ──────────────────
      //
      // `RulesAutomationClient.tsx:99` resolves an unknown OR ROUTED `?tab=` to 'rules'. So the
      // moment a tab is flipped to `routed: true`, every existing `?tab=<key>` link silently
      // renders Apply Rules instead — no 404, no message, just the wrong page. These are real 308s
      // rather than one-line `redirect()` stubs for the reason the ACR.6 block below gives.
      //
      // NEG.1, HV.1, BID.S0, BUD.1, BSP.0 and PLC.0 each hand-wrote one, and BUD.1's own comment
      // recorded that the pattern does not scale: four MORE tabs were routed with no entry, so
      // `?tab=automations`, `?tab=dayparting`, `?tab=keyword-tracker` and `?tab=share-of-voice` all
      // sat on production returning 200 and rendering Apply Rules. **SOV.1 fixed those four**
      // (`f4bc68eb7`, landed mid-session) as four more literals — the seventh, eighth, ninth and
      // tenth copies of one rule.
      //
      // So this is not that fix; it is the collapse the file's own hand-off note asked for. The ten
      // destinations are IDENTICAL to SOV.1's — the derived output was diffed against the committed
      // config entry by entry, and `rulesTabRoutes.vitest.test.ts` pins all ten. What changes is
      // that the ELEVENTH cannot be forgotten: the guard fails when a tab is routed in `tabs.tsx`
      // with no entry here, and when an entry points at a directory with no `page.tsx`.
      //
      // ⚠ Order is load-bearing: these are literal-path rules and must stay ahead of anything
      // parameterised. They match on `has` rather than on the path, so their order among themselves
      // does not matter and nothing later can swallow them.
      ...tabRedirects(),
      // …and the bare index lands on Apply Rules (operator decision 2026-08-15). AFTER the `?tab=`
      // rules on purpose — no `has`, so ahead of them it would swallow all eleven.
      ...bareIndexRedirect(),

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
      // NEG.6 — the n-gram surface folded into Negative Targeting, which is the only place that can
      // act on a word rather than merely report it. Literal path, ahead of any parameterised one.
      { source: '/marketing/advertising/ngrams', destination: '/marketing/ads/rules-automation/negative-targeting#wasteful-words', permanent: true },

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
      // The five that pointed at the bare index now name the Automations page directly — the bare
      // index 308s to /apply-rules (landing decision 2026-08-15), and these URLs were automation
      // pages, so riding the landing redirect would be both a two-hop chain and the wrong page.
      { source: '/marketing/advertising/automation/new', destination: '/marketing/ads/rules-automation/builder', permanent: true },
      { source: '/marketing/advertising/automation/library', destination: '/marketing/ads/rules-automation/automations', permanent: true },
      { source: '/marketing/advertising/automation/analytics', destination: '/marketing/ads/rules-automation/automations', permanent: true },
      { source: '/marketing/advertising/automation/health', destination: '/marketing/ads/health', permanent: true },
      { source: '/marketing/advertising/automation/executions/:id', destination: '/marketing/ads/rules-automation/control-room?tab=activity', permanent: true },
      { source: '/marketing/advertising/automation/executions', destination: '/marketing/ads/rules-automation/control-room?tab=activity', permanent: true },
      { source: '/marketing/advertising/automation/:id', destination: '/marketing/ads/rules-automation/automations', permanent: true },
      { source: '/marketing/advertising/automation', destination: '/marketing/ads/rules-automation/automations', permanent: true },
      { source: '/marketing/advertising/dayparting', destination: '/marketing/ads/rules-automation/dayparting', permanent: true },
      // SOV.1 — pointed at the route rather than at `?tab=share-of-voice`. It still worked via the
      // entry added above, but as a two-hop chain through a query param that only exists to be
      // redirected away from. One hop, and the legacy URL now names the page it means.
      { source: '/marketing/advertising/share-of-voice', destination: '/marketing/ads/rules-automation/share-of-voice', permanent: true },

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
