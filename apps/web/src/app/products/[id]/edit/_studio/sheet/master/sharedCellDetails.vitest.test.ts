/**
 * Cell details on the Shared scope (2026-10-04, `docs/shared-cell-details/PLAN.md`): what the window says about a Shared
 * cell, and the one function the mark, the hover and the window share.
 *
 * Fixtures are cells shaped as `/studio/sheet` sends them (`source`, `inheritedFrom`, `inherited` are required on the
 * contract); GALE-JACKET is the family the Owner measured on (20 variations, colour and size axes).
 */
import { describe, expect, it } from 'vitest'

import { CellSaveTracker, classifyProvenance, provenanceTooltip, sheetValidationFor } from '@/design-system/grid'
import { buildMasterColumns } from './columns'
import { holdsFamilyValue, markSourceLabel, sharedCellFrom, sharedCellMember, sharedCellNotes, sharedHoverNote, sharedMember, validationApplies, requirementLabel, requiredByOnRow, type AiDraft } from './columnRules'
import { familyFollowCount, sharedCellDetails, sharedCellDetailsSource, sharedCellExplains, sharedCellResetOffer, SHARED_CELL_DETAILS_COPY, type SharedCellDetailsContext } from './sharedCellDetails'
import { controlColumnFacts, masterResetOffer, resetTargets, type ResetTarget } from '../sheetReset'
import type { SheetColumn, StudioCellValue, StudioRow } from './types'

const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({ value: null, source: 'master', inheritedFrom: null, inherited: false, ...over })
const col = (over: Partial<SheetColumn> = {}): SheetColumn => ({ key: 'brand', writeField: 'brand', label: 'Brand', group: 'Main', kind: 'text',
  storage: 'categoryAttributes', scope: 'global', requiredBy: [], editable: true, defaultVisible: true, ...over }) as SheetColumn

const PARENT_ID = 'gale'
const parent = (values: Record<string, StudioCellValue> = {}, over: Partial<StudioRow> = {}): StudioRow =>
  ({ id: PARENT_ID, sku: 'GALE-JACKET', parentId: null, parentSku: null, isParent: true, productType: 'JACKET', familyId: 'fam', childCount: 20, values, ...over }) as StudioRow
const variation = (i: number, values: Record<string, StudioCellValue> = {}, over: Partial<StudioRow> = {}): StudioRow =>
  ({ id: `gale-${i}`, sku: `GALE-JACKET-${i}`, parentId: PARENT_ID, parentSku: 'GALE-JACKET', isParent: false, productType: 'JACKET', familyId: 'fam', childCount: 0, values, ...over }) as StudioRow

/* The cell shapes the wire sends on Shared. */
const inheritedFromParent = (value: unknown = 'Xavia') => cell({ value, source: 'master', inheritedFrom: PARENT_ID, inherited: true, layer: 'master' })
const variationOwn = (id: string, value: unknown = 'Gale') => cell({ value, source: 'variant', inheritedFrom: id, inherited: false, layer: 'variant', pinned: true })
const parentOwn = (value: unknown = 'Xavia') => cell({ value, source: 'master', inheritedFrom: PARENT_ID, inherited: false, layer: 'master' })
const nobodyFilled = (rowId: string) => cell({ value: null, source: 'default', inheritedFrom: rowId, inherited: true, tier: 'computed', language: 'it', requested: 'it',
  provenance: { member: 'inherited', from: null } })

const ctx = (rows: StudioRow[], over: Partial<SharedCellDetailsContext> = {}): SharedCellDetailsContext & { resets: ResetTarget[][] } => {
  const resets: ResetTarget[][] = []
  return { rows, reset: (targets) => { resets.push(targets) }, resets, ...over }
}

/** Every user-facing string of a window. */
const words = (c: ReturnType<typeof sharedCellDetails>) => [c?.title, c?.value, c?.notes, c?.action?.label, c?.action?.description].join('\n')

/* ── one function for the mark, the hover and the window ─────────────────────────────────────────────────────────── */

/** The code `columns.tsx` ran before (git 6f28ee119): `provOf`, `markFrom` and the hover's `own()`, verbatim. */
function legacy(row: StudioRow, column: SheetColumn, rows: StudioRow[], draft: AiDraft | null, expr: boolean, refusedReason: string | null) {
  const c = row.values[column.key]
  const member = sharedMember(classifyProvenance({ ...c, aiDrafted: !!draft, aiStale: !!draft?.stale, formula: expr, refusedReason }, 'master'), row, c)
  const from = member === 'refused' ? refusedReason : draft ? null : markSourceLabel(member, row, column.key, rows)
  const own = (): string => {
    const v = sheetValidationFor<StudioRow>(column, (d) => validationApplies(column, d)).validate(c?.value ?? null, row, column.key)
    if (v.message) return v.message
    if (holdsFamilyValue(column, row)) return 'The family value: each variation without its own value inherits it'
    if (!validationApplies(column, row)) return row.isParent ? column.axis ? 'A variation axis: each variation has its own value' : 'Belongs to each variation, not to the parent' : `Not part of ${row.productType ?? 'this product type'}`
    if (draft) {
      const base = draft.baseValue ?? c?.value
      return [provenanceTooltip(member, member === 'refused' ? refusedReason : null), base == null || base === '' ? 'The cell is empty now' : `Now: ${String(base)}`,
        draft.violations?.length ? `⚠ ${draft.violations.join(' · ')}` : null, draft.unverified ? 'Not verified against the channel' : null].filter(Boolean).join('\n')
    }
    return provenanceTooltip(member, member === 'refused' ? refusedReason : markSourceLabel(member, row, column.key, rows))
  }
  return { member, from, sentence: provenanceTooltip(member, from), hover: own() }
}

describe('the mark, the hover and the window read ONE function (`columnRules.ts`)', () => {
  const brand = col()
  const fabric = col({ key: 'fabric', label: 'Fabric', scope: 'per_variant', axis: false })
  const size = col({ key: 'size', label: 'Size', kind: 'select', scope: 'per_variant', axis: true })
  const required = col({ key: 'material', label: 'Material', requiredBy: ['Amazon · DE'] })
  const p = parent({ brand: parentOwn(), fabric: parentOwn('Mesh'), material: cell({ value: null }) })
  const v1 = variation(1, { brand: inheritedFromParent(), fabric: variationOwn('gale-1', 'Leather') })
  const v2 = variation(2, { brand: variationOwn('gale-2'), fabric: inheritedFromParent('Mesh') })
  const rows = [p, v1, v2]
  const STATES: Array<[string, StudioRow, SheetColumn, AiDraft | null, boolean, string | null]> = [
    ['a parent’s own value', p, brand, null, false, null],
    ['a variation inheriting', v1, brand, null, false, null],
    ['a variation’s own value', v2, brand, null, false, null],
    ['a variation overriding a family-held value', v1, fabric, null, false, null],
    ['a family-held value on the family row', p, fabric, null, false, null],
    ['a variation axis on the family row', p, size, null, false, null],
    ['a formula', p, brand, null, true, null],
    ['a refused formula', p, brand, null, true, 'Brand must be one of: Xavia, Gale.'],
    ['an AI draft', p, brand, { draftValue: 'Xavia Racing' }, false, null],
    ['a stale AI draft that breaks a cap', v2, brand, { draftValue: 'X'.repeat(300), stale: true, violations: ['over 200 characters'], unverified: true }, false, null],
    ['a required empty value', p, required, null, false, null],
    ['a field nobody filled, on the family row', parent({ brand: nobodyFilled(PARENT_ID) }), brand, null, false, null],
    ['a field nobody filled, on a variation', variation(3, { brand: nobodyFilled('gale-3') }), brand, null, false, null],
  ]
  it.each(STATES)('%s: member, source, sentence and hover are what they were', (_, row, column, draft, expr, refused) => {
    const facts = { draft, formula: expr, refusedReason: refused }
    const before = legacy(row, column, rows, draft, expr, refused)
    const member = sharedCellMember(row, column, facts)
    expect(member).toBe(before.member)
    expect(sharedCellFrom(member, row, column.key, rows, facts)).toBe(before.from)
    const notes = sharedCellNotes(row, column, rows, facts)
    expect(notes.source).toBe(before.member === 'own' ? '' : before.sentence)
    const validation = sheetValidationFor<StudioRow>(column, (d) => validationApplies(column, d)).validate(row.values[column.key]?.value ?? null, row, column.key).message
    expect(sharedHoverNote(validation, notes)).toBe(before.hover)
  })
})

/* ── Owner decision 2: a variation's own axis value wears no mark and no pinned tint ─────────────────────────────── */

describe('a variation’s own axis value (colour, size): no mark, no tint', () => {
  const colour = col({ key: 'color', writeField: 'attr_color', label: 'Colour', kind: 'select', scope: 'per_variant', axis: true, options: ['nero'], optionLabels: { nero: 'Nero' } })
  const fabric = col({ key: 'fabric', label: 'Fabric', scope: 'per_variant', axis: false })
  const v = variation(1, { color: variationOwn('gale-1', 'nero'), fabric: variationOwn('gale-1', 'Leather') })
  const rows = [parent(), v]
  const classes = (column: SheetColumn) => {
    const [def] = buildMasterColumns({ columns: [column], tracker: new CellSaveTracker(), locale: 'it' }, { current: rows }) as Array<{ cellClassRules: Record<string, (p: unknown) => boolean> }>
    return Object.entries(def.cellClassRules).filter(([, rule]) => rule({ data: v, colDef: { colId: column.key }, value: v.values[column.key].value })).map(([name]) => name)
  }
  it('the server’s `axis` verdict decides — the DS classifier still says pinned (the Variants tab’s callers keep it)', () => {
    expect(classifyProvenance(v.values.color, 'master')).toBe('pinned')
    expect(sharedCellMember(v, colour)).toBe('own')
    // `axis` absent (a read that did not say) is not an axis.
    expect(sharedCellMember(v, { key: 'color' })).toBe('pinned')
  })
  it('no pinned tint on the axis cell; a variation overriding a family-held value keeps ✎ and its tint', () => {
    expect(classes(colour)).not.toContain('nds-cell-is-pinned')
    expect(classes(fabric)).toContain('nds-cell-is-pinned')
    expect(sharedCellMember(v, fabric)).toBe('pinned')
  })
  it('Cell details: "This variation’s own Colour", the option label, and no action (nothing to reset to)', () => {
    const details = sharedCellDetails(v, colour, ctx(rows))!
    expect(details.title).toBe('Colour: GALE-JACKET-1')
    expect(details.value).toBe('Nero')
    expect(details.notes.split('\n\n')[0]).toBe('This variation’s own Colour')
    expect(details.action).toBeUndefined()
    expect(details.notes).not.toMatch(/Pinned|follows GALE/)
  })
  it('the label is kept as written — never lower-cased ("size (eu)", "own colore")', () => {
    const sized = variation(5, { size: variationOwn('gale-5', '42') })
    const first = (label: string) => sharedCellDetails(sized, col({ key: 'size', label, scope: 'per_variant', axis: true }), ctx([parent(), sized]))!.notes.split('\n\n')[0]
    expect(first('Size (EU)')).toBe('This variation’s own Size (EU)')
    expect(first('Colore')).toBe('This variation’s own Colore')
  })
  it('🔴 a language fallback on an axis stored as text keeps 🔗 "Inherited from the Italian text"', () => {
    // German asked, nothing in German: the wire sends the variation's own Italian "Nero" and names the variation itself.
    const colourDe = col({ key: 'color@de', writeField: 'color', label: 'Colour', scope: 'per_variant', axis: true, storage: 'localizedContent', locale: 'de' })
    const fallback = variation(6, { 'color@de': cell({ value: 'Nero', source: 'masterColumn', inheritedFrom: 'gale-6', inherited: true, tier: 'source', language: 'it',
      requested: 'de', provenance: { member: 'inherited', from: 'Italian · source' } }) })
    expect(sharedCellMember(fallback, colourDe)).toBe('inherited')
    const sentence = 'Inherited from the Italian text — edit to give this row its own value'
    expect(sharedCellNotes(fallback, colourDe, [parent(), fallback]).source).toBe(sentence)
    const details = sharedCellDetails(fallback, colourDe, ctx([parent(), fallback]))!
    expect(details.notes.split('\n\n')[0]).toBe(sentence)
    expect(details.notes).toContain('There is no German text yet.')
    expect(details.notes).not.toMatch(/This variation’s own/)
  })
  it('an empty axis value names nobody as its source either', () => {
    const empty = variation(4, { color: cell({ value: null, source: 'default', inheritedFrom: 'gale-4', inherited: true }) })
    expect(sharedCellMember(empty, colour)).toBe('own')
    expect(sharedCellDetails(empty, colour, ctx([parent(), empty]))!.notes.split('\n\n')[0]).toBe('No value yet')
  })
})

/* ── the window ──────────────────────────────────────────────────────────────────────────────────────────────────── */

describe('where it comes from — a cell with no mark says what it is', () => {
  it('🔴 a family row’s field nobody filled never says "Inherited"', () => {
    const p = parent({ brand: nobodyFilled(PARENT_ID) })
    const details = sharedCellDetails(p, col(), ctx([p]))!
    expect(details.value).toBe('Empty')
    expect(details.notes.split('\n\n')[0]).toBe('No value yet')
    expect(details.notes).not.toMatch(/Inherited/)
  })
  it('the family row’s own value', () => {
    const p = parent({ brand: parentOwn() })
    expect(sharedCellDetails(p, col(), ctx([p]))!.notes.split('\n\n')[0]).toBe('This row’s own value')
  })
  it('what an edit changes: saved on the Shared product (as its German text); following listings change with it', () => {
    const p = parent({ brand: parentOwn() })
    expect(sharedCellDetails(p, col(), ctx([p]))!.notes).toContain('Saved on the Shared product. Listings that follow the Shared product for this field change with it; a listing with its own value keeps it.')
    const de = parent({ 'name@de': cell({ value: 'Jacke', tier: 'language', language: 'de', requested: 'de', contentAddress: { tier: 'language', language: 'de' } }) })
    const notes = sharedCellDetails(de, col({ key: 'name@de', writeField: 'name', label: 'Name', storage: 'localizedContent', locale: 'de' }), ctx([de]))!.notes
    expect(notes).toContain('Saved on the Shared product, as its German text. ')
    expect(notes).not.toMatch(/Publish sends/)
  })
  it('the language state: written by machine, not reviewed — and what editing does', () => {
    const de = parent({ 'name@de': cell({ value: 'Jacke', tier: 'language', language: 'de', requested: 'de', contentAddress: { tier: 'language', language: 'de' },
      translation: { source: 'ai', reviewedAt: null, outdated: false } }) })
    const details = sharedCellDetails(de, col({ key: 'name@de', writeField: 'name', label: 'Name', storage: 'localizedContent', locale: 'de' }), ctx([de]))!
    expect(details.notes.split('\n\n')[0]).toBe('Translated by machine and not reviewed yet')
    expect(details.notes).toContain('German text, written by machine, not reviewed. Editing the cell saves your text as reviewed.')
    const old = parent({ 'name@de': cell({ value: 'Jacke', tier: 'language', language: 'de', requested: 'de', translation: { source: 'manual', reviewedAt: '2026-09-01T00:00:00Z', outdated: true } }) })
    expect(sharedCellDetails(old, col({ key: 'name@de', label: 'Name', storage: 'localizedContent' }), ctx([old]))!.notes).toContain('German text, out of date.')
  })
  it('a formula: its expression and the server’s reason, verbatim', () => {
    const p = parent({ brand: parentOwn(null) })
    const details = sharedCellDetails(p, col(), ctx([p], { exprFor: () => 'UPPER(manufacturer)', errorFor: () => 'Brand must be one of: Xavia, Gale.' }))!
    expect(details.notes.split('\n\n')[0]).toBe('Brand must be one of: Xavia, Gale.')
    expect(details.notes).toContain('Formula: =UPPER(manufacturer)')
  })
  it('an AI draft: the window shows what the cell shows, and the hover’s draft lines', () => {
    const p = parent({ brand: parentOwn() })
    const details = sharedCellDetails(p, col(), ctx([p], { draftFor: () => ({ draftValue: 'Xavia Racing', violations: ['over 20 characters'], unverified: true }) }))!
    expect(details.value).toBe('Xavia Racing')
    expect(details.notes.split('\n\n').slice(0, 4)).toEqual(['Drafted by AI and not yet approved — review before it counts as confirmed', 'Now: Xavia', '⚠ over 20 characters', 'Not verified against the channel'])
  })
  it('the value as the cell formats it: option labels, Yes/No, lists, measures — never JSON for these', () => {
    const p = parent({ origin: parentOwn('PK'), waterproof: parentOwn(true), tags: parentOwn(['a', 'b']), weight: parentOwn({ value: 1.2, unit: 'kilograms' }) })
    const value = (column: SheetColumn) => sharedCellDetails(p, column, ctx([p]))!.value
    expect(value(col({ key: 'origin', kind: 'select', options: ['PK'], optionLabels: { PK: 'Pakistan' } }))).toBe('Pakistan')
    expect(value(col({ key: 'waterproof', kind: 'boolean' }))).toBe('Yes')
    expect(value(col({ key: 'tags', shape: 'list', optionLabels: { a: 'Alpha' } }))).toBe('Alpha · b')
    expect(value(col({ key: 'weight', shape: 'measure' }))).toBe('1.2 kg')
  })
})

describe('required by — per row, never "Master"', () => {
  const material = col({ key: 'material', requiredBy: ['Master', 'Amazon · DE'], requiredForProductTypes: ['JACKET'],
    familyRules: { fam: { required: true, sortOrder: 1 } } })
  it('names the coordinates that require it on THIS row, and the product family for the family rule', () => {
    const jacket = variation(1, { material: cell() })
    expect(requiredByOnRow(material, jacket)).toEqual(['the product family', 'Amazon · DE'])
    expect(sharedCellDetails(jacket, material, ctx([jacket]))!.notes).toContain('Required by the product family, Amazon · DE')
  })
  it('a row of another type or family is not required by them', () => {
    expect(requiredByOnRow(material, variation(2, {}, { productType: 'GLOVES' }))).toEqual(['the product family'])
    expect(requiredByOnRow(material, variation(3, {}, { familyId: 'other' }))).toEqual([])
  })
  it('the Shared record’s own requirement (no family rules) is the Shared product — the header says so too', () => {
    expect(requirementLabel(col(), 'Master')).toBe('the Shared product')
    const [def] = buildMasterColumns({ columns: [col({ requiredBy: ['Master', 'eBay · IT'] })], tracker: new CellSaveTracker(), locale: 'it' }, { current: [] }) as Array<{ headerTooltip?: string }>
    expect(def.headerTooltip).toBe('Required by the Shared product, eBay · IT')
  })
})

/* ── the family row's count = the column menu's "Reset column to inherited (n)" ──────────────────────────────────── */

describe('a family row says how many variations follow its value', () => {
  // GALE-JACKET: 20 variations, 3 with their own brand.
  const variations = Array.from({ length: 20 }, (_, i) => variation(i + 1, { brand: i < 3 ? variationOwn(`gale-${i + 1}`) : inheritedFromParent() }))
  const p = parent({ brand: parentOwn() })
  const rows = [p, ...variations]
  it('"17 of 20 variations follow this value; 3 have their own." — here 3 is also the column menu’s reset count', () => {
    const details = sharedCellDetails(p, col(), ctx(rows))!
    expect(details.notes).toContain('17 of 20 variations follow this value; 3 have their own.')
    // The column menu's rule (`useSheetControl.columnMenuItems`): every shown row, `offer` = column facts + masterResetOffer.
    const menu = resetTargets(rows.map((r) => ({ rowId: r.id, colId: 'brand' })), (rowId) => {
      const r = rows.find((x) => x.id === rowId)!
      return controlColumnFacts(col()) ? masterResetOffer(r, col(), false) : null
    })
    expect(menu).toHaveLength(3)
    expect(familyFollowCount(p, col(), rows)).toEqual({ variations: 20, follow: 17, own: 3 })
  })
  it('no count where the variations never take the family’s value (an axis, a price)', () => {
    expect(familyFollowCount(p, col({ key: 'size', scope: 'per_variant', axis: true }), rows)).toBeNull()
    expect(familyFollowCount(p, col({ key: 'basePrice', writeField: 'basePrice', kind: 'number' }), rows)).toBeNull()
    expect(familyFollowCount(variations[0], col(), rows)).toBeNull()
  })

  /* The two real shapes that printed a false count (review, 2026-10-04). Both as `/studio/sheet` sends them. */
  const countWords = /variations? (follows?|have|has)|of \d+ variations/
  it('🔴 an empty family value: no count — the variations follow nothing (was "0 of 3 variations follow this value; 0 have their own.")', () => {
    // A global attribute nobody filled: every row gets the server's `empty` cell (`studio-sheet.service.ts`).
    const empty = () => cell({ value: null, source: null as never, inheritedFrom: null, inherited: false })
    const fam = parent({ brand: empty() })
    const all = [fam, variation(1, { brand: empty() }), variation(2, { brand: empty() }), variation(3, { brand: empty() })]
    expect(familyFollowCount(fam, col(), all)).toBeNull()
    expect(sharedCellDetails(fam, col(), ctx(all))!.notes).not.toMatch(countWords)
  })
  it('🔴 a language fallback: no count — a variation showing its OWN Italian name does not follow (was "All 3 variations follow this value.")', () => {
    // German asked, no German anywhere: each row shows its own Italian name, and the wire names the row itself.
    const name = col({ key: 'name@de', writeField: 'name', label: 'Name', storage: 'localizedContent', locale: 'de' })
    const italian = (id: string, value: string) => cell({ value, source: 'masterColumn', inheritedFrom: id, inherited: true, tier: 'source', language: 'it',
      requested: 'de', provenance: { member: 'inherited', from: 'Italian · source' } })
    const fam = parent({ 'name@de': italian(PARENT_ID, 'Giacca Gale') })
    const all = [fam, ...[1, 2, 3].map((i) => variation(i, { 'name@de': italian(`gale-${i}`, `Giacca Gale ${i}`) }))]
    expect(familyFollowCount(fam, name, all)).toBeNull()
    expect(sharedCellDetails(fam, name, ctx(all))!.notes).not.toMatch(countWords)
    // Even under a family German text, a variation that falls back to its own Italian text is neither: no count.
    const german = parent({ 'name@de': cell({ value: 'Motorradjacke', source: 'masterLocale', inheritedFrom: PARENT_ID, inherited: false, tier: 'language', language: 'de', requested: 'de' }) })
    expect(familyFollowCount(german, name, [german, ...all.slice(1)])).toBeNull()
  })
  it('a family German text: its inheritors follow it — an unreviewed machine translation it inherits too — and the count adds up', () => {
    const name = col({ key: 'name@de', writeField: 'name', label: 'Name', storage: 'localizedContent', locale: 'de' })
    const german = (over: Partial<StudioCellValue>) => cell({ value: 'Motorradjacke', source: 'masterLocale', tier: 'language', language: 'de', requested: 'de', ...over })
    const fam = parent({ 'name@de': german({ inheritedFrom: PARENT_ID, inherited: false }) })
    const all = [fam,
      variation(1, { 'name@de': german({ source: 'masterLocale', inheritedFrom: PARENT_ID, inherited: true }) }),
      // The content resolver's member for an unreviewed machine translation is `ai`, so the wire says `inherited: false` —
      // but the text is the family row's (`inheritedFrom`): it follows.
      variation(2, { 'name@de': german({ inheritedFrom: PARENT_ID, inherited: false, translation: { source: 'ai', reviewedAt: null, outdated: false } }) }),
      variation(3, { 'name@de': german({ value: 'Motorradjacke S', source: 'variantLocale', inheritedFrom: 'gale-3', inherited: false }) }),
    ]
    expect(familyFollowCount(fam, name, all)).toEqual({ variations: 3, follow: 2, own: 1 })
    expect(sharedCellDetails(fam, name, ctx(all))!.notes).toContain('2 of 3 variations follow this value; 1 has its own.')
  })
  it('a variation’s own formula counts as its own; the two numbers always add up to the variations counted', () => {
    const count = familyFollowCount(p, col(), rows, (id) => (id === 'gale-10' ? 'UPPER(manufacturer)' : null))!
    expect(count).toEqual({ variations: 20, follow: 16, own: 4 })
    expect(count.follow + count.own).toBe(count.variations)
  })
})

/* ── the one action: exactly the cell menu's own ─────────────────────────────────────────────────────────────────── */

describe('the action is the cell menu’s own — and nothing else', () => {
  const v = variation(1, { brand: variationOwn('gale-1') })
  const rows = [parent({ brand: parentOwn() }), v]
  it('a variation’s own value: the menu’s label, and its writer resets exactly this cell', () => {
    const c = ctx(rows)
    const details = sharedCellDetails(v, col(), c)!
    expect(details.action?.label).toBe(masterResetOffer(v, col(), false)!.label)
    expect(details.action?.label).toBe('Reset to inherited')
    details.action!.run()
    expect(c.resets).toEqual([[{ rowId: 'gale-1', colId: 'brand', intent: 'reset', formula: false }]])
  })
  it('its formula version', () => {
    const c = ctx(rows, { exprFor: () => 'UPPER(manufacturer)' })
    const details = sharedCellDetails(v, col(), c)!
    expect(details.action?.label).toBe('Remove formula and reset to inherited')
    expect(details.action?.description).toMatch(/formula \(its last value is kept\)/)
    details.action!.run()
    expect(c.resets[0][0].formula).toBe(true)
  })
  it('only where the menu has one: inherited, a family row, relationship, theme, excluded and read-only cells get none', () => {
    const inherited = variation(2, { brand: inheritedFromParent() })
    const p = parent({ brand: parentOwn(), __parentSku: parentOwn('GALE-JACKET'), basePrice: parentOwn(99), variation_theme: parentOwn(null) })
    const vPrice = variation(3, { basePrice: variationOwn('gale-3', 99), brand: cell({ ...variationOwn('gale-3'), editable: false }) })
    const all = [p, inherited, vPrice]
    const none: Array<[StudioRow, SheetColumn]> = [
      [inherited, col()],
      [p, col()],
      [p, col({ key: '__parentSku', label: 'Parent SKU', editable: false, helpText: 'The family this product belongs to.' })],
      [p, col({ key: 'variation_theme', label: 'Variation theme', kind: 'variationTheme', shape: 'axes' })],
      [vPrice, col({ key: 'basePrice', writeField: 'basePrice', kind: 'number' })],
      [vPrice, col()],
      [v, col({ editable: false })],
    ]
    for (const [row, column] of none) {
      expect([column.key, row.id, sharedCellDetails(row, column, ctx(all))?.action]).toEqual([column.key, row.id, undefined])
      expect(sharedCellResetOffer(row, column, false)).toBeNull()
    }
  })
  it('a read-only or not-applicable cell explains itself with its reason', () => {
    const p = parent({ brand: parentOwn() })
    expect(sharedCellDetails(p, col({ editable: false }), ctx([p]))!.notes).toContain('Brand is read-only on this sheet — it cannot be edited here.')
    const axisOnParent = sharedCellDetails(p, col({ key: 'size', label: 'Size', scope: 'per_variant', axis: true }), ctx([p]))!
    expect(axisOnParent.notes).toContain('Size is a variation axis — each variation has its own value, so the parent has none. Open a variation row to edit it.')
    expect(axisOnParent.notes).not.toMatch(/No value yet|Saved on/)
  })
})

/* ── which columns open the window ───────────────────────────────────────────────────────────────────────────────── */

describe('which columns open Cell details', () => {
  it('attribute, relationship, theme, bullets and read-only columns open it; photos have their own editor; the rest say "Select…"', () => {
    expect(sharedCellExplains(col())).toBe(true)
    expect(sharedCellExplains(col({ key: '__productRole', editable: false }))).toBe(true)
    expect(sharedCellExplains(col({ key: 'variation_theme', kind: 'variationTheme', shape: 'axes' }))).toBe(true)
    expect(sharedCellExplains(col({ key: 'bulletPoints', shape: 'list', storage: 'localizedContent' }))).toBe(true)
    expect(sharedCellExplains(col({ editable: false }))).toBe(true)
    expect(sharedCellExplains(col({ key: 'productMedia', editable: false }))).toEqual({ refusal: 'Photos have their own editor: press Enter on the cell.' })
    expect(sharedCellExplains(col({ key: 'progress:scope', managedBy: 'progress' }))).toBe(false)
    expect(sharedCellExplains(col({ key: 'publish:status', managedBy: 'progress' }))).toBe(false)
    expect(sharedCellExplains(col({ key: 'publish:action', managedBy: 'progress' }))).toBe(false)
    // The Product band is not a sheet column at all.
    const source = sharedCellDetailsSource((colId) => (colId === 'brand' ? col() : undefined), () => ctx([]))
    expect(source.explains('product')).toBe(false)
    expect(source.describe(parent(), 'product')).toBeNull()
    expect(SHARED_CELL_DETAILS_COPY.photos).toBe('Photos have their own editor: press Enter on the cell.')
  })
})

/* ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────── */

describe('no "master" in any word the window says', () => {
  it('over every state above', () => {
    const material = col({ key: 'material', requiredBy: ['Master', 'Amazon · DE'], familyRules: { fam: { required: true, sortOrder: 1 } } })
    const p = parent({ brand: parentOwn(), material: cell(), __parentSku: parentOwn('X'), variation_theme: parentOwn(null) })
    const vs = [variation(1, { brand: variationOwn('gale-1'), material: cell() }), variation(2, { brand: inheritedFromParent(), material: cell() })]
    const columns = [col(), material, col({ editable: false }), col({ key: '__parentSku', editable: false }), col({ key: 'variation_theme', kind: 'variationTheme', shape: 'axes' }),
      col({ key: 'size', scope: 'per_variant', axis: true })]
    const said: string[] = []
    for (const row of [p, ...vs]) for (const column of columns) said.push(words(sharedCellDetails(row, column, ctx([p, ...vs], { exprFor: (id) => (id === 'gale-1' ? 'UPPER(x)' : null) }))))
    for (const text of said) expect(text).not.toMatch(/master/i)
  })
})
