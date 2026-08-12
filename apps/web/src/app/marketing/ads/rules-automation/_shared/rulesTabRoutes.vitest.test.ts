/**
 * RA.SPINE S3 — the redirect table, pinned from BOTH directions.
 *
 * `rulesTabRoutes.cjs` is necessarily a second copy of the routed subset of `tabs.tsx`, because a
 * CommonJS `next.config.js` cannot require a `'use client'` TSX module. The duplication is
 * unavoidable; drift between the two is what this file exists to make impossible.
 *
 * Six sessions hand-wrote one redirect each and **four later ones forgot**, so `?tab=automations`,
 * `?tab=dayparting`, `?tab=keyword-tracker` and `?tab=share-of-voice` sat on production returning
 * 200 and rendering Apply Rules. SOV.1 fixed those four (`f4bc68eb7`) — as four more literals, the
 * seventh through tenth copies of one rule — so the outstanding defect is gone and what remains is
 * the pattern that produced it.
 *
 * A guard that checked only "does every redirect point somewhere real" would have passed through
 * all four omissions. It has to also check the other direction — "does every routed page have a
 * redirect" — or it shares neither denominator with the defect it is supposed to catch.
 *
 * ⚠ `tabs.tsx` is read as SOURCE TEXT rather than imported. That is not a preference: importing it
 * under vitest fails in the JSX transform (verified 2026-08-12 — this repo has no vitest config, so
 * `.tsx` is not transformed and `@/` does not resolve). If a reformat of `RULES_TABS` breaks the
 * scan below, that is the guard failing loudly, which is the correct direction to fail in.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ROUTED, PENDING, tabRedirects, RULES_BASE } = require('./rulesTabRoutes.cjs') as {
  ROUTED: Array<[string, string]>
  PENDING: Record<string, string>
  tabRedirects: () => Array<{ source: string; has: Array<{ type: string; key: string; value: string }>; destination: string; permanent: boolean }>
  RULES_BASE: string
}

/** `…/rules-automation` — this test file's own directory is `_shared/` inside it. */
const SECTION_DIR = join(__dirname, '..')
/** `apps/web` — five levels up from the section (ads · marketing · app · src · web). */
const WEB_ROOT = join(SECTION_DIR, '..', '..', '..', '..', '..')
const TABS_SRC = readFileSync(join(SECTION_DIR, '_shared', 'tabs.tsx'), 'utf8')

interface NextRedirect { source: string; destination: string; has?: unknown }
const loadRedirects = async (): Promise<NextRedirect[]> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(join(WEB_ROOT, 'next.config.js')) as { redirects: () => Promise<NextRedirect[]> }
  return cfg.redirects()
}

/**
 * Every `key: '<x>'` in `tabs.tsx`. The `RulesTab` interface declares `key: string` (no quotes), so
 * a quoted value only ever appears inside a `RULES_TABS` entry. Global and unanchored on purpose:
 * a regex anchored at both ends would match the first entry and swallow the rest of the list.
 */
const tabKeysInSource = (): string[] => [...TABS_SRC.matchAll(/\bkey: '([^']+)'/g)].map((m) => m[1]!)

/** A tab is routed when its entry carries `routed: true` — same object, so scan per entry block. */
const routedKeysInSource = (): string[] => {
  const start = TABS_SRC.indexOf('export const RULES_TABS')
  const body = TABS_SRC.slice(start, TABS_SRC.indexOf('\n]', start))
  // Split on the top-level entry boundary: every entry starts with `key:` or `{ key:`.
  return [...body.matchAll(/\bkey: '([^']+)'([\s\S]*?)(?=\bkey: '|$)/g)]
    .filter((m) => /routed:\s*true/.test(m[2]!))
    .map((m) => m[1]!)
}

describe('the source scan reads what it thinks it reads', () => {
  it('finds eleven tabs in tabs.tsx', () => {
    expect(tabKeysInSource()).toHaveLength(11)
  })

  it('finds the two keys whose spelling this whole file turns on', () => {
    expect(tabKeysInSource()).toContain('rules')
    expect(tabKeysInSource()).toContain('share-of-voice')
  })
})

describe('every routed tab has a destination, and every destination is real', () => {
  it('🔴 every tab routed in tabs.tsx appears in ROUTED — the direction four sessions missed', () => {
    const known = new Set(ROUTED.map(([k]) => k))
    const missing = routedKeysInSource().filter((k) => !known.has(k))
    expect(missing, `routed in tabs.tsx but absent from rulesTabRoutes.cjs: ${missing.join(', ')}`).toEqual([])
  })

  it('and nothing in ROUTED is routed nowhere', () => {
    const routed = new Set(routedKeysInSource())
    expect(ROUTED.map(([k]) => k).filter((k) => !routed.has(k))).toEqual([])
  })

  it('🔴 every emitted destination is a real page.tsx on disk — a redirect can never 404', () => {
    for (const r of tabRedirects()) {
      const seg = r.destination.slice(RULES_BASE.length + 1)
      expect(existsSync(join(SECTION_DIR, seg, 'page.tsx')), `${r.destination} has no page.tsx`).toBe(true)
    }
  })

  it('a tab held back names its reason, so the next session reads it instead of deleting the entry', () => {
    for (const [key, reason] of Object.entries(PENDING)) {
      expect(ROUTED.map(([k]) => k)).toContain(key)
      expect(String(reason).length).toBeGreaterThan(40)
    }
  })

  it('🔴 nothing is held — and ?tab=rules reaches Apply Rules, not Automations', () => {
    // `rules` was held while `apply-rules/page.tsx` was uncommitted. AR.S0 landed it in `3a75485a7`
    // mid-session, so this is now the eleventh redirect rather than the outstanding one.
    expect(Object.keys(PENDING)).toEqual([])
    const byKey = Object.fromEntries(tabRedirects().map((r) => [r.has[0]!.value, r.destination]))
    expect(byKey['rules']).toBe(`${RULES_BASE}/apply-rules`)
  })
})

describe('the ten destinations already on production are byte-identical', () => {
  // Regression pin, and the reason this change is safe to make at all. These ten were hand-written
  // — six by NEG.1/HV.1/BID.S0/BUD.1/BSP.0/PLC.0, four by SOV.1 — and are live. The derived output
  // was diffed against the committed `next.config.js` as a SET before this landed: 54 redirects
  // each, zero on either side only. Deriving them must never move one.
  const SHIPPED: Record<string, string> = {
    'negative-targeting': `${RULES_BASE}/negative-targeting`,
    'keyword-harvest': `${RULES_BASE}/keyword-harvest`,
    bid: `${RULES_BASE}/bid`,
    budget: `${RULES_BASE}/budget`,
    'budget-schedules': `${RULES_BASE}/budget-schedules`,
    placement: `${RULES_BASE}/placement`,
    automations: `${RULES_BASE}/automations`,
    dayparting: `${RULES_BASE}/dayparting`,
    'keyword-tracker': `${RULES_BASE}/keyword-tracker`,
    'share-of-voice': `${RULES_BASE}/share-of-voice`,
  }

  it('every one still resolves to exactly where it did', () => {
    const byKey = Object.fromEntries(tabRedirects().map((r) => [r.has[0]!.value, r.destination]))
    for (const [key, dest] of Object.entries(SHIPPED)) expect(byKey[key]).toBe(dest)
  })

  it('and `rules` is the eleventh — one more than production carries today', () => {
    expect(tabRedirects()).toHaveLength(11)
    expect(Object.keys(SHIPPED)).toHaveLength(10)
  })

  it('all of them are 308s matched on the query, not on the path', () => {
    for (const r of tabRedirects()) {
      expect(r.source).toBe(RULES_BASE)
      expect(r.permanent).toBe(true)
      expect(r.has[0]).toMatchObject({ type: 'query', key: 'tab' })
    }
  })
})

describe('array order in next.config.js is load-bearing', () => {
  it('🔴 no legacy path redirects INTO a ?tab= URL — that would 308 twice', async () => {
    // Found by this test: `/marketing/advertising/share-of-voice` pointed at
    // `…/rules-automation?tab=share-of-voice`, which was harmless while that key had no redirect
    // (it rendered the wrong page) and became a two-hop chain the moment S3 added one. Pointed at
    // the route directly instead.
    const all = await loadRedirects()
    const chained = all.filter((r) => r.destination.includes(`${RULES_BASE}?tab=`))
    expect(chained.map((r) => r.source), 'these 308 into a URL that immediately 308s again').toEqual([])
  })

  it('the tab redirects precede every parameterised rules-automation rule', async () => {
    const all = await loadRedirects()
    const lastTab = all.map((r, i) => ({ r, i })).filter((x) => x.r.has).map((x) => x.i).pop() ?? -1
    const firstParam = all.findIndex((r) => r.source.startsWith(RULES_BASE) && r.source.includes(':'))
    if (firstParam >= 0) expect(lastTab).toBeLessThan(firstParam)
  })

  it('the bare index still renders — the landing redirect is deliberately NOT here yet', () => {
    // Held with `?tab=rules`: `/rules-automation` → `/automations` would send `?tab=rules` and the
    // three `/marketing/advertising/automation/*` legacy paths to Automations, which is the wrong
    // page, until `/apply-rules` is committed. Both land in the same follow-up.
    return loadRedirects().then((all) => {
      expect(all.filter((r) => r.source === RULES_BASE && !r.has)).toEqual([])
    })
  })
})
