import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VersionCompare } from './VersionCompare'
import { VERSION_COMPARE_LABELS } from './VersionCompareLabels'
import { quantityDelta, quantityOf, versionChangeNote, versionHasChanges, versionLineViews, versionSummary, type VersionLine, type VersionTotal } from './versionCompareModel'

/** B-W2b-207 — VersionCompare. A made-up BOM, Rev 3 → Rev 4. */
const FIELDS = [
  { id: 'qty', label: 'Quantity' },
  { id: 'supplier', label: 'Supplier' },
]
const SIZES = ['S', 'M', 'L']
const LINES: VersionLine[] = [
  { id: 'l10', label: '10 · LEA-001 Cowhide 1.2 mm', detail: 'Body', before: { fields: { qty: '1.20 m²', supplier: 'Demo Tannery' }, sizes: { S: '1.1', M: '1.2000', L: 1.3 } }, after: { fields: { qty: '1.30 m²', supplier: 'Demo Tannery' }, sizes: { S: '1.1', M: '1.25', L: 1.3 } } },
  { id: 'l20', label: '20 · ZIP-07 Zip 60 cm', before: { fields: { qty: '1 pcs' } }, after: { fields: { qty: '1 pcs' } } },
  { id: 'l30', label: '30 · PRO-01 Elbow protector', before: null, after: { fields: { qty: '2 pcs', supplier: 'Demo Protect' } } },
  { id: 'l40', label: '40 · LBL-02 Care label', before: { fields: { qty: '1 pcs' } }, after: null },
]
const TOTALS: VersionTotal[] = [
  { id: 'cost', label: 'Total cost', before: '€ 41.20', after: '€ 43.10' },
  { id: 'lines', label: 'Lines', before: '3', after: '3' },
]
const BEFORE = { label: 'Rev 3', note: 'Released' }
const AFTER = { label: 'Rev 4', note: 'Draft' }

describe('the comparison', () => {
  it('kinds by line; only changed fields and sizes; exact quantities', () => {
    const views = versionLineViews(LINES, FIELDS, SIZES)
    expect(views.map((view) => view.kind)).toEqual(['changed', 'unchanged', 'added', 'removed'])
    expect(views[0]!.fields).toEqual([{ id: 'qty', label: 'Quantity', from: '1.20 m²', to: '1.30 m²' }])
    expect(views[0]!.sizes).toEqual([{ size: 'M', from: '1.2', to: '1.25', delta: '0.05' }])
    expect(views[2]!.fields.map((f) => [f.from, f.to])).toEqual([[null, '2 pcs'], [null, 'Demo Protect']])
    expect(views[3]!.fields).toEqual([{ id: 'qty', label: 'Quantity', from: '1 pcs', to: null }])
    expect(versionSummary(views, TOTALS)).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1, totals: 1 })
    expect(versionHasChanges(versionSummary([views[1]!], [TOTALS[1]!]))).toBe(false)
  })

  it('quantities compared and moved exactly', () => {
    expect([quantityOf('1.2000'), quantityOf(1.3), quantityOf('x'), quantityOf(null), quantityOf('0,5')]).toEqual(['1.2', '1.3', null, null, '0.5'])
    expect([quantityDelta('1.1', '1.4'), quantityDelta('2', '1.75'), quantityDelta('3', '3')]).toEqual(['0.3', '-0.25', '0'])
  })

  it('the change note says every change in plain words, unchanged lines left out; empty when nothing moved', () => {
    const views = versionLineViews(LINES, FIELDS, SIZES)
    expect(versionChangeNote(BEFORE, AFTER, views, TOTALS, VERSION_COMPARE_LABELS)).toBe(
      [
        'Rev 3 → Rev 4',
        '- 10 · LEA-001 Cowhide 1.2 mm: Quantity 1.20 m² → 1.30 m²; size M 1.2 → 1.25',
        '- Added 30 · PRO-01 Elbow protector',
        '- Removed 40 · LBL-02 Care label',
        '- Total cost € 41.20 → € 43.10',
      ].join('\n'),
    )
    expect(versionChangeNote(BEFORE, AFTER, [views[1]!], [], VERSION_COMPARE_LABELS)).toBe('')
  })
})

describe('VersionCompare', () => {
  it('both versions, the summary, each line with its word, changed fields in two columns, the size moves', () => {
    const html = render(h(VersionCompare, { before: BEFORE, after: AFTER, lines: LINES, fields: FIELDS, sizes: SIZES, totals: TOTALS, locale: 'it-IT', onUseAsNote: () => undefined }))
    expect(html).toContain('Rev 3 compared with Rev 4')
    expect(html).toContain('1 added · 1 removed · 1 changed')
    expect(html).toContain(' Added</span>')
    expect(html).toContain('Not in Rev 3')
    expect(html).toContain('Not in Rev 4')
    expect(html).toContain('Size M: from 1,2 to 1,25, +0,05')
    expect(html).toContain('Show 1 unchanged line')
    expect(html).not.toContain('20 · ZIP-07')
    expect(html).toContain('Use as change note')
    expect(html).not.toContain('aria-disabled')
    expect(html).toMatch(/<tr data-changed="true"><th scope="row">Total cost<\/th>/)
  })

  it('unchanged lines on request; the same versions say so and hold the note', () => {
    const shown = render(h(VersionCompare, { before: BEFORE, after: AFTER, lines: LINES, fields: FIELDS, defaultShowUnchanged: true }))
    expect(shown).toContain('20 · ZIP-07')
    expect(shown).toContain('Hide the unchanged lines')
    expect(shown).not.toContain('Use as change note')
    const same = render(h(VersionCompare, { before: BEFORE, after: AFTER, lines: [LINES[1]!], fields: FIELDS, onUseAsNote: () => undefined }))
    expect(same).toContain('The two versions are the same.')
    expect(same).toContain('aria-description="Nothing changed between the two versions."')
    const decided = render(h(VersionCompare, { before: BEFORE, after: AFTER, lines: LINES, fields: FIELDS, onUseAsNote: () => undefined, noteHeldReason: 'The change is approved.' }))
    expect(decided).toContain('aria-description="The change is approved."')
  })
})
