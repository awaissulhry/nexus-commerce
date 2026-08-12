/**
 * RA.SPINE S3 — the routed-tab list, in the one format `next.config.js` can read.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────────
 *
 * `RulesAutomationClient.tsx:99` resolves an unknown **or routed** `?tab=` to `'rules'`. So the
 * moment a tab is flipped to `routed: true`, every existing `?tab=<key>` link silently renders
 * Apply Rules instead — no 404, no message, just the wrong page. Each page session has had to
 * remember a `next.config.js` entry separately, and **four of them did not**: measured 2026-08-12,
 * `?tab=automations`, `?tab=dayparting`, `?tab=keyword-tracker` and `?tab=share-of-voice` were all
 * still returning 200 and rendering the wrong page on production.
 *
 * `next.config.js` names this file in its own hand-off note — *"the generic form derived from
 * `RULES_TABS.filter(t => t.routed)` … needs the routed-key list lifted into a plain module both
 * this CommonJS config and the `'use client'` tabs module can read"*. That note guessed `.mjs`;
 * it has to be `.cjs`, because `apps/web` has no `"type": "module"` and `next.config.js` ends in
 * `module.exports`, so a CommonJS `require()` cannot load an ESM file.
 *
 * ── 🔴 This is a SECOND list, and that is a real cost ───────────────────────────────────────────
 *
 * The single source of truth for tabs is `_shared/tabs.tsx`. This file duplicates the routed subset
 * of it, because `tabs.tsx` is a `'use client'` TSX module that a CommonJS config cannot require —
 * verified, not assumed: importing it under vitest fails in the JSX transform, so it cannot even be
 * read by a test.
 *
 * The duplication is therefore unavoidable; the DRIFT is not. `rulesTabRoutes.vitest.test.ts` pins
 * the two together from both directions — every routed key in `tabs.tsx` appears here, every
 * destination here is a real page on disk, and nothing here is missing a redirect. A guard that
 * counted only one direction would let a new page ship with no redirect, which is exactly the
 * defect that has now happened four times.
 *
 * ⚠ Do not merge this into `tabs.tsx` "when someone has time". The merge direction that works is
 * the other one: `tabs.tsx` importing THIS. That edit is left to whoever next holds `tabs.tsx` with
 * a clean tree — it was dirty with another session's uncommitted work when this was written.
 */

const RULES_BASE = '/marketing/ads/rules-automation'

/**
 * Every routed tab: `[tab key, path segment]`.
 *
 * The two differ for exactly one tab. `rules` is routed at `/apply-rules` because the label is
 * "Apply Rules" while the key `rules` is read by `?tab=rules`, `RULE_TAB_ACTION_TYPES`, the index
 * client's fallback and every `active="rules"` — renaming it in a file eleven pages share is this
 * programme's highest-collision edit, so AR.S0 added an optional `path` to `tabs.tsx` instead.
 * Order matches `RULES_TABS`.
 */
const ROUTED = [
  ['rules', 'apply-rules'],
  ['automations', 'automations'],
  ['bid', 'bid'],
  ['keyword-harvest', 'keyword-harvest'],
  ['negative-targeting', 'negative-targeting'],
  ['budget', 'budget'],
  ['dayparting', 'dayparting'],
  ['budget-schedules', 'budget-schedules'],
  ['placement', 'placement'],
  ['share-of-voice', 'share-of-voice'],
  ['keyword-tracker', 'keyword-tracker'],
]

/**
 * 🔴 Routed in `tabs.tsx`, but NOT yet safe to redirect to. Key → the reason, which is displayed by
 * the guard test when it fails, so the next session reads why rather than deleting the entry.
 *
 * A redirect to a route that does not exist in the deployed bundle is a hard 404 — strictly worse
 * than today's behaviour, which is a silent render of the wrong page. So an entry stays here until
 * its `page.tsx` is COMMITTED, not merely present in someone's working tree.
 */
const PENDING = {
  // Empty, and it stayed empty for about an hour. `rules` sat here while `apply-rules/page.tsx`
  // existed on disk but was UNCOMMITTED in AR.S0's session — a 308 to a route that is not in the
  // deployed bundle is a hard 404, which is strictly worse than the silent wrong-page render it
  // would have replaced. AR.S0 committed it (`3a75485a7`, verified with `git ls-files`, not by
  // looking at the working tree), so the entry came out in this same session.
  //
  // Leave the mechanism in place. There will be a twelfth tab, and it will be routed in `tabs.tsx`
  // one commit before its page is committed.
}

/**
 * The `?tab=<key>` → route redirects, for every routed tab that is not pending.
 *
 * Matched on `has` rather than on the path, so these cannot be swallowed by a later rule and their
 * order among themselves does not matter. They must still sit BEFORE any parameterised
 * `/marketing/ads/rules-automation/:path*` rule — array order is load-bearing in Next's redirect
 * table, literal paths before parameterised ones.
 */
function tabRedirects() {
  return ROUTED
    .filter(([key]) => !PENDING[key])
    .map(([key, path]) => ({
      source: RULES_BASE,
      has: [{ type: 'query', key: 'tab', value: key }],
      destination: `${RULES_BASE}/${path}`,
      permanent: true,
    }))
}

module.exports = { RULES_BASE, ROUTED, PENDING, tabRedirects }
