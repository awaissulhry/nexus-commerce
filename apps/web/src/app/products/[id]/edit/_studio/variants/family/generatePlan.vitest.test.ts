/**
 * VP.3 — the Generate combinations rules (§3.4).
 *
 * The pattern test is the one that matters. The canvas's default pattern is
 * `{parent}-{Colore.code}-MEN-{Taglia}` with `Nero → BLACK`, and nothing in the data says so
 * directly — it has to be read back out of the family's own SKUs. If `deriveSkuPattern` is wrong
 * the dialog offers a confident, plausible, wrong default, which is exactly the failure a preview
 * line is least likely to catch.
 */
import { describe, expect, it } from 'vitest'

import type { AxisSummary } from './coverage'
import {
  axisHint,
  codeSource,
  axisToken,
  buildPlan,
  codeFor,
  codeLines,
  defaultCode,
  deriveSkuPattern,
  nearestSibling,
  renderSku,
  type AxisChoice,
  type PlanFamily,
} from './generatePlan'

const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']
const CODES: Record<string, string> = { Nero: 'BLACK', Giallo: 'YELLOW' }

const axes: AxisSummary[] = [
  { key: 'color', label: 'Colore', values: [{ code: 'Nero', label: 'Nero', count: 10 }, { code: 'Giallo', label: 'Giallo', count: 10 }] },
  { key: 'size', label: 'Taglia', values: SIZES.map(code => ({ code, label: code, count: 2 })) },
]

const family: PlanFamily = {
  parentSku: 'GALE-JACKET',
  children: ['Nero', 'Giallo'].flatMap(colour =>
    SIZES.map(size => ({ sku: `GALE-JACKET-${CODES[colour]}-MEN-${size}`, axisValues: { color: colour, size } })),
  ),
}

const choices: AxisChoice[] = axes.map(a => ({ key: a.key, label: a.label, values: a.values.map(v => ({ code: v.code, label: v.label, isNew: false })) }))

describe('deriveSkuPattern', () => {
  it('reads the canvas pattern back out of GALE-JACKET’s own SKUs', () => {
    const out = deriveSkuPattern('GALE-JACKET', family.children, axes)
    expect(out.derived).toBe(true)
    expect(out.pattern).toBe('{parent}-{Colore.code}-MEN-{Taglia}')
  })

  it('reads the per-value CODES, which appear nowhere in the data as such', () => {
    const out = deriveSkuPattern('GALE-JACKET', family.children, axes)
    expect(out.codes.color).toEqual({ Nero: 'BLACK', Giallo: 'YELLOW' })
    /* Taglia's segment EQUALS its value, so it gets an IDENTITY map and a plain `{Taglia}` token.
       (I first asserted `undefined` here — that was my expectation, not the rule. The map is what
       makes the token decision, and keeping it costs nothing: `codeFor` returns the same string
       either way, and `codeLines` filters on the TOKEN, not on the presence of a table.) */
    expect(out.codes.size).toEqual(Object.fromEntries(SIZES.map(s => [s, s])))
    expect(out.pattern).toContain('{Taglia}')
    expect(out.pattern).not.toContain('{Taglia.code}')
  })

  it('gives up honestly when the children disagree about their shape', () => {
    const ragged = [
      { sku: 'GALE-JACKET-BLACK-XXS', axisValues: { color: 'Nero', size: 'XXS' } },
      { sku: 'GALE-JACKET-YELLOW-MEN-XS', axisValues: { color: 'Giallo', size: 'XS' } },
    ]
    const out = deriveSkuPattern('GALE-JACKET', ragged, axes)
    expect(out.derived).toBe(false)
    expect(out.pattern).toBe('{parent}-{Colore}-{Taglia}')
  })

  it('gives up when a varying segment matches no axis one-to-one', () => {
    const noisy = [
      { sku: 'GALE-JACKET-BLACK-A-XXS', axisValues: { color: 'Nero', size: 'XXS' } },
      { sku: 'GALE-JACKET-BLACK-B-XS', axisValues: { color: 'Nero', size: 'XS' } },
      { sku: 'GALE-JACKET-YELLOW-A-XXS', axisValues: { color: 'Giallo', size: 'XXS' } },
      { sku: 'GALE-JACKET-YELLOW-B-XS', axisValues: { color: 'Giallo', size: 'XS' } },
    ]
    /* Segment 2 tracks `size` exactly (XXS→A, XS→B), so `size` is consumed there and its own
       segment is then a second one-to-one match — which is fine and still derivable. The refusal
       case is a segment no axis explains at all. */
    const broken = [
      ...noisy,
      { sku: 'GALE-JACKET-BLACK-C-XXS', axisValues: { color: 'Nero', size: 'XXS' } },
    ]
    expect(deriveSkuPattern('GALE-JACKET', broken, axes).derived).toBe(false)
  })

  it('gives up when the children do not carry the parent’s prefix', () => {
    const foreign = [{ sku: 'OTHER-BLACK-MEN-XXS', axisValues: { color: 'Nero', size: 'XXS' } }]
    expect(deriveSkuPattern('GALE-JACKET', foreign, axes).derived).toBe(false)
  })

  it('gives up on a childless family rather than inventing a convention', () => {
    expect(deriveSkuPattern('GALE-JACKET', [], axes).derived).toBe(false)
  })
})

describe('defaultCode', () => {
  it('folds accents, upper-cases and collapses separators', () => {
    expect(defaultCode('Rosso')).toBe('ROSSO')
    expect(defaultCode('Bleu clair')).toBe('BLEU-CLAIR')
    expect(defaultCode('Réséda')).toBe('RESEDA')
    expect(defaultCode('  40 / 42  ')).toBe('40-42')
  })
})

describe('renderSku', () => {
  const pattern = deriveSkuPattern('GALE-JACKET', family.children, axes)

  it('substitutes the parent, the coded axis and the plain axis', () => {
    expect(renderSku('{parent}-{Colore.code}-MEN-{Taglia}', { parentSku: 'GALE-JACKET', axes: choices, values: { color: 'Nero', size: 'XXS' }, codes: pattern }))
      .toBe('GALE-JACKET-BLACK-MEN-XXS')
  })

  it('falls back to the upper-cased value for a code nobody has minted', () => {
    expect(codeFor(pattern, 'color', 'Rosso')).toBe('ROSSO')
  })

  it('LEAVES an unknown token in rather than blanking it — a silent gap reads as a valid SKU', () => {
    expect(renderSku('{parent}-{Nope}', { parentSku: 'X', axes: choices, values: {}, codes: pattern })).toBe('X-{Nope}')
  })

  it('resolves a token by the axis KEY when the label does not match', () => {
    expect(renderSku('{parent}-{size}', { parentSku: 'X', axes: choices, values: { size: 'M' }, codes: pattern })).toBe('X-M')
  })
})

describe('buildPlan', () => {
  const pattern = deriveSkuPattern('GALE-JACKET', family.children, axes)

  it('creates nothing on a complete family — 2 × 10 = 20, 20 exist', () => {
    const plan = buildPlan(choices, family, pattern, pattern.pattern)
    expect(plan.combinations).toBe(20)
    expect(plan.existing).toBe(20)
    expect(plan.plan).toEqual([])
  })

  it('is the canvas’s summary when a third colour is added: 3 × 10 = 30, 20 exist, 10 created', () => {
    const withRed: AxisChoice[] = [
      { ...choices[0], values: [...choices[0].values, { code: 'Rosso', label: 'Rosso', isNew: true }] },
      choices[1],
    ]
    const codes = { ...pattern, codes: { ...pattern.codes, color: { ...pattern.codes.color, Rosso: 'RED' } } }
    const plan = buildPlan(withRed, family, codes, pattern.pattern)
    expect(plan.combinations).toBe(30)
    expect(plan.existing).toBe(20)
    expect(plan.plan.length).toBe(10)
    expect(plan.plan[0].sku).toBe('GALE-JACKET-RED-MEN-XXS')
    expect(plan.plan[0].axisValues).toEqual({ color: 'Rosso', size: 'XXS' })
  })

  it('copies from the nearest sibling — the same SIZE when the colour is new', () => {
    const withRed: AxisChoice[] = [
      { ...choices[0], values: [...choices[0].values, { code: 'Rosso', label: 'Rosso', isNew: true }] },
      choices[1],
    ]
    const plan = buildPlan(withRed, family, pattern, pattern.pattern)
    expect(plan.plan[0].copiesFrom).toBe('GALE-JACKET-BLACK-MEN-XXS')
  })

  it('REFUSES a SKU collision by name and never renames it', () => {
    const withRed: AxisChoice[] = [
      { ...choices[0], values: [...choices[0].values, { code: 'Rosso', label: 'Rosso', isNew: true }] },
      choices[1],
    ]
    /* `Rosso` with no code of its own renders `ROSSO`; pre-take that SKU and the plan must skip it. */
    const taken: PlanFamily = { ...family, knownSkus: ['GALE-JACKET-ROSSO-MEN-XXS'] }
    const plan = buildPlan(withRed, taken, pattern, pattern.pattern)
    expect(plan.plan.some(p => p.sku === 'GALE-JACKET-ROSSO-MEN-XXS')).toBe(false)
    expect(plan.skipped[0].sku).toBe('GALE-JACKET-ROSSO-MEN-XXS')
    expect(plan.skipped[0].reason).toContain('already exists')
    expect(plan.plan.length).toBe(9)
  })

  it('refuses a pattern that collides two new SKUs with each other', () => {
    const flat: AxisChoice[] = [
      { ...choices[0], values: [{ code: 'Rosso', label: 'Rosso', isNew: true }, { code: 'Verde', label: 'Verde', isNew: true }] },
      { key: 'size', label: 'Taglia', values: [{ code: 'XXS', label: 'XXS', isNew: false }] },
    ]
    /* A pattern naming no colour makes both new variants the same SKU. The second is refused. */
    const plan = buildPlan(flat, family, pattern, '{parent}-NEW-{Taglia}')
    expect(plan.plan.length).toBe(1)
    expect(plan.skipped.length).toBe(1)
  })

  it('answers nothing for an axis with no values, rather than one empty tuple', () => {
    const empty: AxisChoice[] = [{ key: 'color', label: 'Colore', values: [] }]
    expect(buildPlan(empty, family, pattern, pattern.pattern)).toEqual({ combinations: 0, existing: 0, plan: [], skipped: [] })
  })
})

describe('nearestSibling', () => {
  it('prefers the EARLIER axis when nothing matches on both', () => {
    const children = [
      { sku: 'A', axisValues: { color: 'Nero', size: '5XL' } },
      { sku: 'B', axisValues: { color: 'Giallo', size: 'XXS' } },
    ]
    expect(nearestSibling({ color: 'Nero', size: 'XXS' }, choices, children)).toBe('A')
  })
  it('is null when the family has no children at all', () => {
    expect(nearestSibling({ color: 'Nero' }, choices, [])).toBeNull()
  })
})

describe('the copy', () => {
  it('names the new values in the axis hint, and says nothing extra when there are none', () => {
    expect(axisHint({ key: 'size', label: 'Taglia', values: SIZES.map(c => ({ code: c, label: c, isNew: false })) })).toBe('10 values')
    expect(axisHint({
      key: 'color', label: 'Colore',
      values: [{ code: 'Nero', label: 'Nero', isNew: false }, { code: 'Giallo', label: 'Giallo', isNew: false }, { code: 'Rosso', label: 'Rosso', isNew: true }],
    })).toBe('3 values · Rosso is new and is added only when you create · type a value and press Enter to add another')
  })

  it('lists codes only for the axes the pattern actually CODES', () => {
    const pattern = deriveSkuPattern('GALE-JACKET', family.children, axes)
    const lines = codeLines(choices, pattern, pattern.pattern)
    expect(lines.map(l => l.axisKey)).toEqual(['color'])
    expect(lines[0].entries).toEqual([
      { label: 'Nero', code: 'BLACK', isNew: false, source: 'sibling' },
      { label: 'Giallo', code: 'YELLOW', isNew: false, source: 'sibling' },
    ])
  })

  it('builds the token an axis contributes from its LABEL', () => {
    expect(axisToken({ key: 'color', label: 'Colore' }, true)).toBe('{Colore.code}')
    expect(axisToken({ key: 'color', label: '' }, false)).toBe('{color}')
  })
})

describe('codeSource — whose answer a code is (VP.2, 2026-09-11)', () => {
  const pattern = deriveSkuPattern('GALE-JACKET', family.children, axes)

  it('marks a code READ from the family’s own SKUs as the client’s evidence', () => {
    expect(codeSource(pattern, 'color', 'Nero')).toBe('sibling')
    expect(codeFor(pattern, 'color', 'Nero')).toBe('BLACK')
  })

  it('marks an invented code as the DEFAULT — which is what the service would produce', () => {
    /*
     * 🔴 The divergence this pins. The generate service has no value-mapping data at all
     * (`FieldValueMap` is empty, `SizeScaleMap` holds EU-to-alpha SIZE conversions), so its
     * `{axis.code}` uppercases: `Nero → NERO`. This client reads `Nero → BLACK` out of the siblings.
     * Both are defensible; only one of them is what Create will do. The dialog must say which.
     */
    expect(codeSource(pattern, 'color', 'Rosso')).toBe('default')
    expect(codeFor(pattern, 'color', 'Rosso')).toBe(defaultCode('Rosso'))
    expect(defaultCode('Nero')).toBe('NERO')
  })

  it('reports the source on every code line, so the dialog cannot render one unlabelled', () => {
    const withRed: AxisChoice[] = [
      { ...choices[0], values: [...choices[0].values, { code: 'Rosso', label: 'Rosso', isNew: true }] },
      choices[1],
    ]
    const line = codeLines(withRed, pattern, pattern.pattern).find(l => l.axisKey === 'color')!
    expect(line.entries.map(e => [e.label, e.source])).toEqual([['Nero', 'sibling'], ['Giallo', 'sibling'], ['Rosso', 'default']])
  })
})
