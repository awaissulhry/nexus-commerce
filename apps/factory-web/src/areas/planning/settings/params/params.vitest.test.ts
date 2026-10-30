import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { COWHIDE_ROW, COWHIDE_RED, ENTRIES, LANES, SETTINGS, DEFAULT_SETTINGS } from './demo'
import { designScreen } from './fixtures'
import {
  bulkCounts,
  bulkLines,
  bulkPatch,
  clearedWords,
  draftPreview,
  horizonBody,
  horizonChanged,
  horizonDraftOf,
  horizonProblems,
  horizonRefusal,
  itemRowsOf,
  latestActual,
  methodPatch,
  parseCell,
  peopleEdit,
  percentEdit,
  planPatch,
  qtyText,
  refusalWords,
  reorderCellOpen,
  rowKeyOf,
  ruleTarget,
  sourcePatch,
  sparkOf,
  withoutRow,
  withRow,
  WC_KINDS,
  SOURCINGS,
  UNITS,
} from './model'

const refusal = (status: number, kind: ApiError['kind'], issues: Array<{ path: string }> = []) => new ApiError(kind, status, 'x', 'x', null, issues)

describe('Planning settings › item parameters, reorder rules, horizon, line efficiency (SCR-127)', () => {
  it('reads a typed cell: a comma is a decimal point, empty clears, days are whole', () => {
    expect(parseCell('safetyStock', ' 12,5 ')).toEqual({ value: '12.5' })
    expect(parseCell('safetyStock', '')).toEqual({ value: null })
    expect(parseCell('buyLeadTimeDays', '14')).toEqual({ value: 14 })
    expect(parseCell('buyLeadTimeDays', '2.5')).toEqual({ problem: { key: 'pp.problem.days', params: { field: 'pp.field.buyLeadTimeDays' } } })
    expect(parseCell('minOrderQty', 'ten')).toMatchObject({ problem: { key: 'pp.problem.quantity' } })
  })

  it("refuses a bad value BEFORE sending, with factory-domain's rules said in our words", () => {
    // An order maximum below the minimum (50) of the cowhide's row.
    expect(planPatch(COWHIDE_ROW, { maxOrderQty: '30' })).toEqual({ kind: 'refused', field: 'maxOrderQty', words: { key: 'pp.problem.maxOrder', params: { min: '50' } } })
    expect(planPatch(COWHIDE_RED, { maxStock: '60' })).toMatchObject({ kind: 'refused', words: { key: 'pp.problem.maxStock' } })
    expect(planPatch(COWHIDE_ROW, { lotSize: '0' })).toMatchObject({ kind: 'refused', words: { key: 'pp.problem.aboveZero' } })
    expect(planPatch(null, { reorderPoint: '10' })).toMatchObject({ kind: 'refused', words: { key: 'pp.problem.ropOnly' } })
    expect(planPatch(null, { method: 'REORDER_POINT', reorderPoint: '10', lotSize: null })).toMatchObject({ kind: 'refused', words: { key: 'pp.problem.ropNeeds' } })
    expect(planPatch(null, { supplierId: 'x' })).toMatchObject({ kind: 'refused', words: { key: 'pp.problem.supplierBuy' } })
    expect(planPatch(null, { safetyStock: '1.123456' })).toMatchObject({ kind: 'refused', words: { key: 'pp.problem.decimals' } })
  })

  it('sends only a real change, and names what a method or source switch clears', () => {
    expect(planPatch(COWHIDE_ROW, { safetyStock: '40' })).toEqual({ kind: 'none' })
    expect(planPatch(null, { method: 'ORDERS' })).toEqual({ kind: 'none' })
    const toMinMax = planPatch(COWHIDE_ROW, { method: 'MIN_MAX', minStock: '50', maxStock: '300' })
    expect(toMinMax.kind).toBe('write')
    expect(toMinMax.kind === 'write' && [...toMinMax.cleared].sort()).toEqual(['lotSize', 'reorderPoint'])
    const own = planPatch(COWHIDE_ROW, sourcePatch(null, null, null))
    // The item's own sourcing names the supplier and make site it takes away (sent as null, not cleared behind the back).
    expect(own.kind === 'write' && own.patch).toEqual({ source: null, supplierId: null, makeSiteId: null })
    expect(clearedWords(['lotSize', 'reorderPoint'])).toEqual({ key: 'pp.cleared_other', params: { count: 2, fields: 'pp.field.lotSize|pp.field.reorderPoint' } })
    expect(clearedWords([])).toBeNull()
    expect(methodPatch('MIN_MAX', '20', 'x')).toMatchObject({ field: 'maxStock' })
    expect(methodPatch('ORDERS', '', '')).toEqual({ patch: { method: 'ORDERS' } })
  })

  it("says the API's refusals: at the field (400), a 409 is someone else's change, no answer is 'not known'", () => {
    expect(refusalWords(refusal(400, 'invalid', [{ path: 'body/safetyStock' }]))).toEqual({ words: { key: 'pp.problem.refusedField', params: { field: 'pp.field.safetyStock' } }, conflict: false, unknown: false })
    expect(refusalWords(refusal(409, 'conflict'))).toMatchObject({ conflict: true, words: { key: 'ps.problem.conflict' } })
    expect(refusalWords(refusal(0, 'unavailable'))).toMatchObject({ unknown: true })
    expect(refusalWords(refusal(403, 'forbidden')).words.key).toBe('ps.problem.writeForbidden')
  })

  it('draws one row per site row (every colour first), else one row of defaults; a save puts the row in place', () => {
    const rows = itemRowsOf(ENTRIES)
    expect(rows.map((row) => row.key).slice(0, 3)).toEqual([rowKeyOf(ENTRIES[0]!.item.id, null), rowKeyOf(ENTRIES[0]!.item.id, COWHIDE_RED.colour!.id), rowKeyOf(ENTRIES[1]!.item.id, null)])
    expect(rows[2]!.row).toBeNull()
    const made = { ...COWHIDE_ROW, id: 'new', item: { ...COWHIDE_ROW.item, id: ENTRIES[1]!.item.id }, version: 1 }
    const after = withRow(ENTRIES, made)
    expect(itemRowsOf(after).find((row) => row.key === rowKeyOf(ENTRIES[1]!.item.id, null))?.row?.id).toBe('new')
    expect(withoutRow(after, ENTRIES[1]!.item.id, 'new')[1]!.parameters).toEqual([])
    expect(ruleTarget(ENTRIES[0]!, COWHIDE_RED.colour!.id)?.id).toBe(COWHIDE_RED.id)
    expect(ruleTarget(ENTRIES[1]!, null)).toBeNull()
    expect(reorderCellOpen(COWHIDE_ROW, 'minStock')).toBe(false)
    expect(reorderCellOpen(COWHIDE_RED, 'maxStock')).toBe(true)
    expect(qtyText('100.0000', 'it-IT')).toBe('100')
    expect(qtyText('12.5000', 'it-IT')).toBe('12,5')
  })

  it('reviews a bulk edit row by row: what saves, what is refused with its reason, what is already so', () => {
    const rows = itemRowsOf(ENTRIES).slice(0, 4)
    const typed = bulkPatch({ fields: { maxOrderQty: '30', safetyLeadTimeDays: '5' }, method: null })
    expect('patch' in typed).toBe(true)
    if (!('patch' in typed)) return
    const lines = bulkLines(rows, typed.patch)
    expect(lines[0]!.plan).toMatchObject({ kind: 'refused', words: { key: 'pp.problem.maxOrder' } })
    expect(lines[0]!.changes.find((change) => change.field === 'safetyLeadTimeDays')).toEqual({ field: 'safetyLeadTimeDays', before: '3', after: '5' })
    expect(bulkCounts(lines)).toEqual({ write: 3, refused: 1, same: 0 })
    expect(bulkPatch({ fields: { buyLeadTimeDays: 'x' }, method: null })).toMatchObject({ field: 'buyLeadTimeDays' })
  })

  it("checks the horizon with factory-domain's rules, previews the buckets and sends only the changed fields", () => {
    const draft = horizonDraftOf(SETTINGS.settings)
    expect(draft).toEqual({ horizonWeeks: 26, dayBucketWeeks: 2, weekBucketWeeks: 13, defaultEfficiencyPct: '85', scheduledRunTime: '02:00' })
    expect(horizonChanged(SETTINGS.settings, draft)).toEqual([])
    expect(horizonProblems({ ...draft, dayBucketWeeks: 14 })).toEqual({ dayBucketWeeks: { key: 'pp.horizon.problem.dayAfterWeek', params: { days: 14, weeks: 13 } } })
    expect(horizonProblems({ ...draft, horizonWeeks: '' })).toMatchObject({ horizonWeeks: { key: 'pp.horizon.problem.required' } })
    expect(horizonProblems({ ...draft, defaultEfficiencyPct: '250' })).toEqual({ defaultEfficiencyPct: { key: 'pp.problem.percent' } })
    expect(horizonProblems({ ...draft, scheduledRunTime: '25:00' })).toEqual({ scheduledRunTime: { key: 'pp.horizon.problem.runTime' } })
    expect(horizonBody(SETTINGS.settings, { ...draft, horizonWeeks: 30, defaultEfficiencyPct: '92,5', scheduledRunTime: '' })).toEqual({ version: 4, horizonWeeks: 30, defaultEfficiencyPct: '92.50', scheduledRunTime: null })
    expect(horizonBody(DEFAULT_SETTINGS.settings, { ...horizonDraftOf(DEFAULT_SETTINGS.settings), weekBucketWeeks: 10 })).toEqual({ weekBucketWeeks: 10 })
    const preview = draftPreview(draft, '2026-10-29')
    expect(preview).toMatchObject({ days: { count: 11, to: '2026-11-08' }, weeks: { count: 11, to: '2027-01-24' }, to: '2027-04-25' })
    expect(draftPreview({ ...draft, dayBucketWeeks: 14 }, '2026-10-29')).toBeNull()
    expect(horizonRefusal(refusal(400, 'invalid', [{ path: 'body/weekBucketWeeks' }]))).toEqual({ field: 'weekBucketWeeks', words: { key: 'pp.horizon.problem.refused' }, conflict: false })
  })

  it('keeps line efficiency per line: a percent above 0 and at most 200, people 1 to 500 or empty (one per station)', () => {
    const line = LANES.lines[0]!
    expect(percentEdit(line, '92,5')).toEqual({ kind: 'write', value: '92.50' })
    expect(percentEdit(line, '90')).toEqual({ kind: 'none' })
    expect(percentEdit(line, '250')).toEqual({ kind: 'refused', words: { key: 'pp.problem.percent' } })
    expect(percentEdit(LANES.lines[1]!, '85')).toEqual({ kind: 'write', value: '85.00' })
    expect(peopleEdit(line, '')).toEqual({ kind: 'write', value: null })
    expect(peopleEdit(LANES.lines[1]!, '')).toEqual({ kind: 'none' })
    expect(peopleEdit(line, '0')).toEqual({ kind: 'refused', words: { key: 'pp.problem.people' } })
    expect(peopleEdit(line, '12')).toEqual({ kind: 'write', value: 12 })
    expect(sparkOf(LANES.lines[1]!)).toEqual([71, null, 78.3, 80.05])
    expect(latestActual(LANES.lines[0]!)).toEqual({ week: '2026-W43', pct: '91.20' })
    // Nothing in a lane names a person.
    expect(JSON.stringify(LANES)).not.toMatch(/worker|operatorName|person/i)
  })

  it('has every word it names in both languages, with the same placeholders', () => {
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/'(pp\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!).filter((key) => !key.endsWith('.'))
    const dynamic = [
      ...['item', 'colour', 'method', 'source', 'supplier', 'makeSite', 'buyLeadTimeDays', 'makeLeadTimeDays', 'safetyLeadTimeDays', 'safetyStock', 'minOrderQty', 'orderMultiple', 'maxOrderQty', 'reorderPoint', 'lotSize', 'minStock', 'maxStock'].map((col) => `pp.col.${col}`),
      ...['method', 'source', 'supplierId', 'makeSiteId', 'buyLeadTimeDays', 'makeLeadTimeDays', 'safetyLeadTimeDays', 'safetyStock', 'reorderPoint', 'lotSize', 'minStock', 'maxStock', 'minOrderQty', 'orderMultiple', 'maxOrderQty', 'note', 'horizonWeeks', 'dayBucketWeeks', 'weekBucketWeeks', 'defaultEfficiencyPct', 'scheduledRunTime'].map((field) => `pp.field.${field}`),
      ...['ORDERS', 'MANUAL', 'REORDER_POINT', 'MIN_MAX'].flatMap((method) => [`pp.method.${method}`, `pp.methodHint.${method}`]),
      'pp.source.BUY',
      'pp.source.MAKE',
      ...SOURCINGS.map((sourcing) => `pp.sourcing.${sourcing}`),
      ...UNITS.map((unit) => `pp.uom.${unit}`),
      ...WC_KINDS.map((kind) => `pp.wcKind.${kind}`),
      ...['LANE', 'SITE', 'DEFAULT'].map((source) => `pp.effSource.${source}`),
    ]
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['planning-params'] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      const missing = [...new Set([...literal, ...dynamic])].filter((key) => !has(key))
      expect(missing, locale).toEqual([])
    }
    const it = CATALOGUE.it['planning-params'] ?? {}
    const en = CATALOGUE.en['planning-params'] ?? {}
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
  })

  it('shows every state of the design as a case, for the roles it names', () => {
    expect(designScreen.screen).toBe('SCR-127')
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['items', 'items-saving-marks', 'items-selected', 'items-review', 'items-method-dialog', 'items-supplier-dialog', 'items-buyer', 'items-read-only', 'items-loading', 'items-error', 'items-empty', 'reorder', 'reorder-new-rule', 'reorder-empty', 'horizon', 'horizon-edited', 'horizon-refused', 'horizon-held', 'efficiency', 'efficiency-no-lines', 'efficiency-read-only', 'changed-elsewhere']),
    )
  })

  for (const locale of ['it', 'en'] as const) {
    it(`${locale}: draws the horizon and the page frame with no key on screen`, () => {
      for (const id of ['horizon', 'horizon-edited', 'horizon-refused', 'horizon-held', 'horizon-default', 'horizon-loading']) {
        const entry = designScreen.cases.find((item) => item.id === id)!
        const html = render(h(I18nProvider, { locale, messages: {} }, h(designScreen.view, { model: entry.model })))
        expect(html, id).not.toMatch(/\b(pp|ps)\.[a-z]+\.[a-zA-Z]/)
        if (id === 'horizon') expect(html).toContain(locale === 'it' ? 'Orizzonte e periodi' : 'Horizon and buckets')
        if (id === 'horizon-refused') expect(html).toContain(locale === 'it' ? 'finiscono prima di quelli settimanali' : 'end before the week buckets do')
        if (id === 'horizon-held') expect(html).toContain('planning.settings.manage')
      }
    })
  }
})
