/**
 * Meta step 34 — the catalog rules load in either order without main's sleeping import cycle (meta-settings-rules.ts ↔
 * meta-calls.ts): meta-catalog-rules.ts imports no value from either (only the leaf text patterns of meta-write-text.ts and
 * the leaf lists of services/meta/meta-catalog-lists.ts). Loaded first, and loaded through meta-calls.ts first, every text
 * pattern of every catalog rule is a RegExp and the gateway judges with them. (A settings-first case is not here: main's
 * cycle fails it today; lane C4 fixes that root in its #713 merge pass.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const patternsOf = (rules: ReadonlyArray<{ name: string; text?: Readonly<Record<string, RegExp>> }>) =>
  rules.flatMap((r) => Object.entries(r.text ?? {}).map(([key, pattern]) => ({ rule: r.name, key, pattern })))

describe('step 34 — meta-catalog-rules.ts in either load order', () => {
  beforeEach(() => { vi.resetModules() })

  it('loaded first: every text pattern is a RegExp', async () => {
    const rules = await import('./meta-catalog-rules.js')
    const patterns = patternsOf(rules.META_CATALOG_WRITE_RULES)
    expect(patterns.length).toBeGreaterThan(5)
    for (const p of patterns) expect(p.pattern, `${p.rule}.${p.key}`).toBeInstanceOf(RegExp)
    expect(rules.metaCatalogTextOk('Catalog A', 100)).toBe(true)
  })

  it('loaded through meta-calls.ts first: the same, and the gateway judges a catalog change with them', async () => {
    const calls = await import('./meta-calls.js')
    const rules = await import('./meta-catalog-rules.js')
    const { META_DEFAULT_GRAPH_API_VERSION } = await import('../meta/api-version.js')
    for (const p of patternsOf(rules.META_CATALOG_WRITE_RULES)) expect(p.pattern, `${p.rule}.${p.key}`).toBeInstanceOf(RegExp)
    const verdict = calls.metaWriteVerdict({ method: 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/120000000000100`, kind: 'write', body: 'name=Catalog+A', objectKind: 'catalog' })
    expect(verdict).toMatchObject({ write: { rule: 'catalog.update' } })
  })
})
