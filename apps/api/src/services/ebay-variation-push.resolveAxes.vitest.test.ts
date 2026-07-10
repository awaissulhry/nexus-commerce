/**
 * EFX Phase 2 — unit tests for the authoritative variation-axis resolver.
 *
 * Covers:
 *   • parseThemeAxes (D4 — one parser, splits on , / | ;)
 *   • resolveVariationAxes LEGACY mode is byte-identical to the pre-EFX inline
 *     inference (proven against an embedded reference copy of the old logic)
 *   • resolveVariationAxes DECLARED mode (D2/D7/D8): declared theme is
 *     authoritative for the axis SET, strays suppressed/kept+warned, missing/
 *     single-value declared axes warned, synonym matching, picture-axis exempt.
 */

import { describe, it, expect } from 'vitest'
import { parseThemeAxes } from './ebay-theme-axes.js'
import {
  resolveVariationAxes,
  dedupeSpecsByValueFingerprint,
  buildVariesBySpecifications,
  axisSynonymKey,
  type VariationAxisSpec,
} from './ebay-variation-push.service.js'

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a variant row from aspect name → value pairs. */
const row = (aspects: Record<string, string>): Record<string, unknown> => {
  const r: Record<string, unknown> = { sku: `SKU-${Math.random().toString(36).slice(2, 6)}` }
  for (const [name, val] of Object.entries(aspects)) {
    r[`aspect_${name.replace(/\s+/g, '_')}`] = val
  }
  return r
}

/** Normalise a resolved spec list to a comparable plain shape. */
const shape = (specs: VariationAxisSpec[]) =>
  specs.map((s) => ({ name: s.name, values: [...s.values].sort(), coverage: s.coverage }))

// ── Reference copy of the PRE-EFX inline logic (legacy inference) ────────────
// Verbatim port of ebay-variation-push.service.ts lines ~445-561 (pre-EFX), so
// the legacy branch of resolveVariationAxes can be asserted byte-identical.
function legacyReference(
  variantRows: Array<Record<string, unknown>>,
  opts: { nameLabels?: Record<string, string>; valueLabels?: Record<string, Record<string, string>>; storedAxisOrder?: string[] } = {},
): Array<{ name: string; values: Set<string>; coverage: number }> {
  const nameLabels = opts.nameLabels ?? {}
  const valueLabels = opts.valueLabels ?? {}
  const storedAxisOrder = opts.storedAxisOrder ?? []
  const nmLabel = (a: string) => nameLabels[a] || a
  const vlLabel = (a: string, v: string) => valueLabels[a]?.[v] || v

  const allAspectValueSets = new Map<string, Set<string>>()
  const dimRowCoverage = new Map<string, Set<number>>()
  variantRows.forEach((r, rowIdx) => {
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('aspect_') && typeof v === 'string' && v) {
        const name = k.slice('aspect_'.length).replace(/_/g, ' ')
        if (!name) continue
        if (!allAspectValueSets.has(name)) allAspectValueSets.set(name, new Set())
        allAspectValueSets.get(name)!.add(v)
        const dk = axisSynonymKey(name)
        if (!dimRowCoverage.has(dk)) dimRowCoverage.set(dk, new Set())
        dimRowCoverage.get(dk)!.add(rowIdx)
      }
    }
  })
  const dimCoverage = (name: string) => dimRowCoverage.get(axisSynonymKey(name))?.size ?? 0
  const effectiveVarAxes = [...allAspectValueSets.entries()].filter(([, vals]) => vals.size > 1).map(([n]) => n)
  const seen = new Set<string>()
  const deduped = effectiveVarAxes.filter((a) => {
    const sk = axisSynonymKey(a)
    if (seen.has(sk)) return false
    seen.add(sk)
    return true
  })
  if (storedAxisOrder.length > 0) {
    const rank = new Map(storedAxisOrder.map((a, i) => [axisSynonymKey(a), i]))
    deduped.sort((a, b) => (rank.get(axisSynonymKey(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(axisSynonymKey(b)) ?? Number.MAX_SAFE_INTEGER))
  }
  const specMap = new Map<string, { name: string; values: Set<string>; coverage: number }>()
  for (const rawName of deduped) {
    const label = nmLabel(rawName)
    if (!label) continue
    const mk = label.toLowerCase()
    if (!specMap.has(mk)) specMap.set(mk, { name: label, values: new Set(), coverage: 0 })
    const e = specMap.get(mk)!
    e.coverage = Math.max(e.coverage, dimCoverage(rawName))
    for (const v of allAspectValueSets.get(rawName) ?? []) e.values.add(vlLabel(rawName, v))
    const dk = axisSynonymKey(rawName)
    for (const [cn] of allAspectValueSets) {
      if (cn === rawName) continue
      if (axisSynonymKey(cn) === dk) for (const v of allAspectValueSets.get(cn) ?? []) e.values.add(vlLabel(cn, v))
    }
  }
  return dedupeSpecsByValueFingerprint([...specMap.values()]).filter((e) => e.name && e.values.size > 0)
}

// ─────────────────────────────────────────────────────────────────────────────
describe('parseThemeAxes (D4)', () => {
  it('splits on comma, slash, pipe and semicolon', () => {
    expect(parseThemeAxes('a,b')).toEqual(['a', 'b'])
    expect(parseThemeAxes('a/b')).toEqual(['a', 'b'])
    expect(parseThemeAxes('a|b')).toEqual(['a', 'b'])
    expect(parseThemeAxes('a;b;c')).toEqual(['a', 'b', 'c'])
    expect(parseThemeAxes('Tipo di prodotto / Colore | Taglia')).toEqual(['Tipo di prodotto', 'Colore', 'Taglia'])
  })
  it('trims, drops empties, dedupes case-insensitively (first casing wins), caps at 5', () => {
    expect(parseThemeAxes(' a , , b ')).toEqual(['a', 'b'])
    expect(parseThemeAxes('Colore,colore,COLORE')).toEqual(['Colore'])
    expect(parseThemeAxes('a,b,c,d,e,f,g')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
  it('non-string / empty → []', () => {
    expect(parseThemeAxes(null)).toEqual([])
    expect(parseThemeAxes(undefined)).toEqual([])
    expect(parseThemeAxes('')).toEqual([])
    expect(parseThemeAxes(42 as unknown)).toEqual([])
  })
})

describe('resolveVariationAxes — LEGACY mode is byte-identical to pre-EFX', () => {
  const fixtures: Array<{ name: string; rows: Array<Record<string, unknown>>; opts?: any }> = [
    {
      name: 'plain colour × size',
      rows: [
        row({ Colore: 'Nero', Taglia: 'S' }),
        row({ Colore: 'Blu', Taglia: 'M' }),
        row({ Colore: 'Nero', Taglia: 'L' }),
      ],
    },
    {
      name: 'stray Team Name shadowing Tipo di prodotto (fingerprint dedup)',
      rows: [
        row({ 'Tipo di prodotto': 'Giacca', Colore: 'Nero', 'Team Name': 'Giacca' }),
        row({ 'Tipo di prodotto': 'Pantaloni', Colore: 'Blu', 'Team Name': 'Pantaloni' }),
        row({ 'Tipo di prodotto': 'Giacca', Colore: 'Blu' }), // Team Name missing on some
      ],
    },
    {
      name: 'synonym aliases (Colore + Color, different-language values)',
      rows: [
        row({ Colore: 'Nero', Color: 'Black', Taglia: 'S' }),
        row({ Colore: 'Blu', Color: 'Blue', Taglia: 'M' }),
      ],
    },
    {
      name: 'storedAxisOrder reorders the derived set',
      rows: [
        row({ Colore: 'Nero', Taglia: 'S', Genere: 'Uomo' }),
        row({ Colore: 'Blu', Taglia: 'M', Genere: 'Donna' }),
      ],
      opts: { storedAxisOrder: ['Taglia', 'Genere', 'Colore'] },
    },
  ]

  for (const f of fixtures) {
    it(f.name, () => {
      const got = resolveVariationAxes(f.rows, null, f.opts)
      expect(shape(got.validSpecs)).toEqual(shape(legacyReference(f.rows, f.opts) as VariationAxisSpec[]))
      expect(got.warnings).toEqual([]) // legacy never warns
      expect(got.suppressed).toEqual([])
    })
  }
})

describe('resolveVariationAxes — DECLARED mode (D2/D7/D8)', () => {
  it('theme "Tipo di prodotto,Colore,Taglia" → exactly those 3, in declared order', () => {
    const rows = [
      row({ 'Tipo di prodotto': 'Giacca', Colore: 'Nero', Taglia: 'S' }),
      row({ 'Tipo di prodotto': 'Pantaloni', Colore: 'Blu', Taglia: 'M' }),
    ]
    const declared = parseThemeAxes('Tipo di prodotto,Colore,Taglia')
    const got = resolveVariationAxes(rows, declared)
    expect(got.validSpecs.map((s) => s.name)).toEqual(['Tipo di prodotto', 'Colore', 'Taglia'])
    expect(got.warnings).toEqual([])
  })

  it('";"-separated theme parses to the same 3 axes', () => {
    const rows = [
      row({ 'Tipo di prodotto': 'Giacca', Colore: 'Nero', Taglia: 'S' }),
      row({ 'Tipo di prodotto': 'Pantaloni', Colore: 'Blu', Taglia: 'M' }),
    ]
    const got = resolveVariationAxes(rows, parseThemeAxes('Tipo di prodotto;Colore;Taglia'))
    expect(got.validSpecs.map((s) => s.name)).toEqual(['Tipo di prodotto', 'Colore', 'Taglia'])
  })

  it('AIREON: declared Tipo di prodotto + stray Team Name (same fingerprint) → Team Name suppressed, Tipo survives with its name', () => {
    const rows = [
      row({ 'Tipo di prodotto': 'Giacca', 'Team Name': 'Giacca' }),
      row({ 'Tipo di prodotto': 'Pantaloni', 'Team Name': 'Pantaloni' }),
      row({ 'Tipo di prodotto': 'Giacca' }), // Team Name only on some variants
    ]
    const got = resolveVariationAxes(rows, ['Tipo di prodotto'])
    expect(got.validSpecs.map((s) => s.name)).toEqual(['Tipo di prodotto'])
    expect(got.suppressed).toContain('Team Name')
    expect(got.warnings).toEqual([]) // suppression is silent (proven duplicate)
  })

  it('undeclared axis with a UNIQUE fingerprint → kept + warning', () => {
    const rows = [
      row({ Colore: 'Nero', Taglia: 'S' }),
      row({ Colore: 'Blu', Taglia: 'M' }),
    ]
    const got = resolveVariationAxes(rows, ['Colore'])
    expect(got.validSpecs.map((s) => s.name)).toEqual(['Colore', 'Taglia'])
    expect(got.warnings.some((w) => w.includes('Taglia') && w.includes('not in your Variation Theme'))).toBe(true)
  })

  it('declared axis with a single distinct value → excluded + warning (single value)', () => {
    const rows = [
      row({ Colore: 'Nero', Materiale: 'Cotone' }),
      row({ Colore: 'Blu', Materiale: 'Cotone' }),
    ]
    const got = resolveVariationAxes(rows, ['Colore', 'Materiale'])
    expect(got.validSpecs.map((s) => s.name)).toEqual(['Colore'])
    expect(got.warnings.some((w) => w.includes('Materiale') && w.includes('only one value'))).toBe(true)
  })

  it('declared axis with no observed values → warning (missing)', () => {
    const rows = [row({ Colore: 'Nero' }), row({ Colore: 'Blu' })]
    const got = resolveVariationAxes(rows, ['Colore', 'Genere'])
    expect(got.validSpecs.map((s) => s.name)).toEqual(['Colore'])
    expect(got.warnings.some((w) => w.includes('Genere') && w.includes('no values'))).toBe(true)
  })

  it('synonym match: declared "colour" + observed "Colore" → included, DISPLAYED as observed "Colore"', () => {
    const rows = [row({ Colore: 'Nero' }), row({ Colore: 'Blu' })]
    const got = resolveVariationAxes(rows, ['colour'])
    expect(got.validSpecs.map((s) => s.name)).toEqual(['Colore'])
    expect(got.warnings).toEqual([])
  })

  it('D8: pictureAxisOverride axis survives fingerprint dedup (legacy mode)', () => {
    const rows = [
      row({ Colore: 'Nero', Special: 'Nero' }),
      row({ Colore: 'Blu', Special: 'Blu' }),
      row({ Colore: 'Nero' }), // Colore has higher coverage than Special
    ]
    // Without an override, the lower-coverage look-alike (Special) is dropped.
    const noOverride = resolveVariationAxes(rows, null)
    expect(noOverride.validSpecs.map((s) => s.name)).toEqual(['Colore'])
    // With Special picked as the picture axis, it is exempt and survives.
    const withOverride = resolveVariationAxes(rows, null, { pictureAxisOverride: 'Special' })
    expect(withOverride.validSpecs.map((s) => s.name)).toContain('Special')
  })
})

// ── STEP 1c — buildVariesBySpecifications (shared spec-builder) ───────────────
describe('buildVariesBySpecifications', () => {
  const mkSpec = (name: string, values: string[]): VariationAxisSpec => ({
    name,
    rawName: name,
    values: new Set(values),
    coverage: values.length,
  })

  it('applies the custom value order for an axis (spec ordering)', () => {
    const specs = [mkSpec('Taglia', ['L', 'S', 'M'])]
    const out = buildVariesBySpecifications(specs, { __dim1__: ['S', 'M', 'L'] }, [])
    expect(out).toEqual([{ name: 'Taglia', values: ['S', 'M', 'L'] }])
  })

  it('sorts known clothing sizes via the built-in standard order', () => {
    const specs = [mkSpec('Taglia', ['XL', 'S', 'M'])]
    const out = buildVariesBySpecifications(specs, {}, [])
    expect(out[0].values).toEqual(['S', 'M', 'XL'])
  })

  it('preserves whitespace/case-distinct values (no dedup here)', () => {
    const specs = [mkSpec('Colore', ['Nero', 'nero', 'Blu '])]
    const out = buildVariesBySpecifications(specs, {}, [])
    // Colore is not a size dimension → values pass through unsorted & unmodified.
    expect(out[0].values).toEqual(['Nero', 'nero', 'Blu '])
  })

  it('falls back to a single Custom Bundle spec of SKUs when no valid spec', () => {
    const out = buildVariesBySpecifications([], {}, ['SKU-A', 'SKU-B'])
    expect(out).toEqual([{ name: 'Custom Bundle', values: ['SKU-A', 'SKU-B'] }])
  })
})
