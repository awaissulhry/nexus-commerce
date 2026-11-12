import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { LOCATIONS, ROLE_PERMISSIONS } from '../../../_shared/stock/fixtures'
import { DEFAULTS, PICK_FACE, PLACES, PRINTERS, RACK_LABEL, TRANSIT } from '../../stock/depth/demo/fixtures'
import { designScreen as listScreen } from '../list/fixtures'
import { LocationsView } from '../list/view/LocationsView'
import { designScreen as recordScreen } from '../record/fixtures'
import { LocationRecordView } from '../record/view/LocationRecordView'
import {
  binLabelLayout,
  blockChecks,
  blockDraftOf,
  blockHeldOf,
  blockProblemOf,
  countHref,
  defaultsOf,
  depthCan,
  kindFacts,
  labelCodeOf,
  labelCodeProblem,
  labelCodeWriteProblem,
  labelRefusalOf,
  partyHeldOf,
  placementHeldOf,
  placeStatus,
  printHeldOf,
  printSplit,
  printStartHeldKey,
  retypeKinds,
  unblockHeldOf,
  type PrintDialogModel,
} from './model'

const NAMESPACES = ['shell', 'stock', 'lists']
const draw = (view: unknown, model: unknown, locale: 'it' | 'en' = 'en') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(view as never, { model } as never)))
const LEFT_KEY = /\bwd\.[a-zA-Z]+(?:\.[a-zA-Z_]+)+\b/
const place = (code: string) => PLACES.find((entry) => entry.code === code)!
const manage = { manage: true }

describe('B-W2b-327 Locations in depth: status, blocks and what a count blocks', () => {
  it('says Active, Blocked (a block that holds) or Archived', () => {
    expect(placeStatus(place('N-MAG-A-01'))).toBe('BLOCKED')
    expect(placeStatus(place('N-MAG-A-02'))).toBe('ACTIVE')
    expect(placeStatus({ status: 'ACTIVE', block: { ...place('N-QUA').block!, holds: false } })).toBe('ACTIVE')
    expect(placeStatus(LOCATIONS.old)).toBe('ARCHIVED')
    expect(countHref('/w/DEMO', 'CNT-D-0007')).toBe('/w/DEMO/warehouse/counts?q=CNT-D-0007')
  })

  it('holds Block and Unblock with the reason: no right, archived, outside or in transit, a running count’s own block', () => {
    expect(blockHeldOf(place('N-MAG-A-02'), manage)).toBeNull()
    expect(blockHeldOf(place('N-MAG-A-02'), { manage: false })).toEqual({ key: 'wd.loc.held.noManage' })
    expect(blockHeldOf(TRANSIT, manage)).toEqual({ key: 'wd.loc.held.notBlockable' })
    expect(blockHeldOf({ ...LOCATIONS.old, block: null }, manage)).toEqual({ key: 'wd.loc.held.archived' })
    expect(blockHeldOf(place('N-MAG-A-01'), manage)).toEqual({ key: 'wd.loc.held.countBlock', params: { number: 'CNT-D-0007' } })
    expect(unblockHeldOf(place('N-MAG-A-01'), manage)).toEqual({ key: 'wd.loc.held.countBlock', params: { number: 'CNT-D-0007' } })
    expect(unblockHeldOf(place('N-QUA'), manage)).toBeNull()
    expect(unblockHeldOf(place('N-MAG-A-02'), manage)).toEqual({ key: 'wd.loc.held.notBlocked' })
  })

  it('checks a block: a reason, words for Other, an until-day not past; a change starts from the block there', () => {
    expect(blockChecks({ reason: '', note: '', until: '' }, '2026-10-30')).toEqual(['wd.loc.block.held.reason'])
    expect(blockChecks({ reason: 'OTHER', note: ' ', until: '' }, '2026-10-30')).toEqual(['wd.loc.block.held.note'])
    expect(blockChecks({ reason: 'DAMAGE', note: '', until: '2026-10-29' }, '2026-10-30')).toEqual(['wd.loc.block.held.past'])
    expect(blockChecks({ reason: 'CLEAN_UP', note: '', until: '2026-10-30' }, '2026-10-30')).toEqual([])
    expect(blockDraftOf(place('N-QUA'))).toEqual({ reason: 'DAMAGE', note: 'Perdita dal tetto: ripiano da asciugare', until: '2026-11-02' })
    // A count's block is not a person's to change: the dialog starts empty.
    expect(blockDraftOf(place('N-MAG-A-01'))).toEqual({ reason: '', note: '', until: '' })
    expect(blockProblemOf(new ApiError('conflict', 409, 'conflict', 'Version 2 expected.'))).toEqual({ key: 'wd.loc.problem.changed' })
    expect(blockProblemOf(new ApiError('invalid', 400, 'validation', 'Archived.', null, [{ path: 'body/location' }]))).toEqual({ key: 'wd.loc.problem.notNow' })
  })
})

describe('B-W2b-327 Locations in depth: defaults, the W2b kinds, a new place', () => {
  it('names what a place is the default for, purpose by purpose', () => {
    expect(defaultsOf(LOCATIONS.binA1.id, DEFAULTS)).toEqual([{ purpose: 'PUT_AWAY', itemKind: 'LEATHER' }])
    expect(defaultsOf(LOCATIONS.binA2.id, DEFAULTS)).toEqual([])
    expect(defaultsOf(LOCATIONS.binA1.id, null)).toEqual([])
  })

  it('says what each kind holds and where it sits; a customer’s or transit place at the top, nothing inside a pick face', () => {
    expect(kindFacts('PRODUCTION')).toEqual(['wd.loc.holds.MATERIALS', 'wd.loc.group.LINE'])
    expect(kindFacts('TRANSIT')).toEqual(['wd.loc.holds.ANY', 'wd.loc.group.TRANSIT', 'wd.loc.kind.atTop', 'wd.loc.kind.noInside', 'wd.loc.kind.noLabel', 'wd.loc.kind.transferOnly'])
    expect(kindFacts('CUSTOMER')).toContain('wd.loc.kind.namesCustomer')
    expect(placementHeldOf('CUSTOMER', LOCATIONS.rackA)).toEqual({ key: 'wd.loc.new.atTop' })
    expect(placementHeldOf('CUSTOMER', null)).toBeNull()
    expect(placementHeldOf('BIN', PICK_FACE)).toEqual({ key: 'wd.loc.new.noInside', params: { code: PICK_FACE.code } })
    expect(placementHeldOf('BIN', LOCATIONS.rackA)).toBeNull()
  })

  it('asks a workshop’s or a customer’s place for its party, and says when it cannot', () => {
    expect(partyHeldOf('BIN', null, null, { parties: false })).toBeNull()
    expect(partyHeldOf('CUSTOMER', null, null, { parties: false })).toEqual({ key: 'wd.loc.new.partyNoRight' })
    expect(partyHeldOf('CUSTOMER', null, { status: 'ready', value: [] }, { parties: true })).toEqual({ key: 'wd.loc.new.noCustomers' })
    expect(partyHeldOf('SUBCONTRACTOR', null, { status: 'ready', value: [] }, { parties: true })).toEqual({ key: 'wd.loc.new.noWorkshops' })
    expect(partyHeldOf('CUSTOMER', null, { status: 'ready', value: [{ id: 'p', code: 'C', name: 'C' }] }, { parties: true })).toEqual({ key: 'wd.loc.new.partyPick' })
    expect(partyHeldOf('CUSTOMER', 'p', { status: 'ready', value: [{ id: 'p', code: 'C', name: 'C' }] }, { parties: true })).toBeNull()
  })

  it('never retypes an outside or transit place, nor into one; a place with places inside never becomes a pick face', () => {
    const held = (current: Parameters<typeof retypeKinds>[0], children: number, parent: boolean) => retypeKinds(current, children, parent).filter((entry) => entry.held).map((entry) => entry.kind)
    expect(held('BIN', 0, true)).toEqual(['SUBCONTRACTOR', 'CUSTOMER', 'TRANSIT'])
    expect(held('ZONE', 2, true)).toEqual(['SUBCONTRACTOR', 'CUSTOMER', 'TRANSIT', 'PICK_FACE'])
    expect(held('TRANSIT', 0, false).length).toBe(12)
    expect(depthCan(ROLE_PERMISSIONS.warehouse)).toEqual({ manage: true, printLabels: true, printView: true, parties: true })
    expect(depthCan(ROLE_PERMISSIONS.readOnly)).toEqual({ manage: false, printLabels: false, printView: true, parties: true })
  })
})

describe('B-W2b-327 bin labels: the code, the print, the PDF', () => {
  it('gives a place without a code its suggested one, and checks a typed code', () => {
    expect(labelCodeOf(place('N-MAG-A-02'), 'STAB-N')).toEqual({ code: 'STAB-N-N-MAG-A-02', suggested: true })
    expect(labelCodeOf(place('N-MAG-A-01'), 'STAB-N')).toEqual({ code: 'STAB-N-N-MAG-A-01', suggested: false })
    expect(labelCodeProblem('', PLACES, LOCATIONS.binA2.id)).toBe('wd.loc.label.code.missing')
    expect(labelCodeProblem('bin a2', PLACES, LOCATIONS.binA2.id)).toBe('wd.loc.label.code.shape')
    expect(labelCodeProblem('stab-n-n-mag-a-01', PLACES, LOCATIONS.binA2.id)).toBe('wd.loc.label.code.taken')
    expect(labelCodeProblem('A2/ROSSO', PLACES, LOCATIONS.binA2.id)).toBeNull()
    expect(labelCodeWriteProblem(new ApiError('conflict', 409, 'conflict', 'Location N-MAG-A-01 already carries the label code X.'))).toEqual({ key: 'wd.loc.label.code.taken' })
    expect(labelRefusalOf(TRANSIT)).toBe('wd.loc.label.refused.kind')
    expect(labelRefusalOf({ ...LOCATIONS.old })).toBe('wd.loc.label.refused.archived')
  })

  it('prints what can carry a label, gives codes first, and holds Print with the reason', () => {
    const places = [place('N-MAG-A-01'), place('N-MAG-A-02'), TRANSIT]
    const split = printSplit(places)
    expect(split.printable.map((entry) => entry.code)).toEqual(['N-MAG-A-01', 'N-MAG-A-02'])
    expect(split.needCode.map((entry) => entry.code)).toEqual(['N-MAG-A-02'])
    expect(split.refused.map((entry) => [entry.place.code, entry.key])).toEqual([['N-TRANSIT', 'wd.loc.label.refused.kind']])
    const model = (over: Partial<PrintDialogModel> = {}): PrintDialogModel => ({ places, siteCode: 'STAB-N', draft: { printerId: PRINTERS[0]!.id, copies: 1, language: 'it' }, printers: { status: 'ready', value: PRINTERS }, posting: false, problem: null, ...over })
    expect(printHeldOf(model(), { printLabels: true, manage: true })).toBeNull()
    // A role that prints but does not manage places cannot give bin A2 its code: held (the PDF still goes).
    expect(printHeldOf(model(), { printLabels: true, manage: false })).toEqual({ key: 'wd.loc.print.held.needCode', params: { count: 1 } })
    expect(printHeldOf(model({ draft: { printerId: 'PDF', copies: 1, language: 'it' } }), { printLabels: false, manage: false })).toBeNull()
    expect(printHeldOf(model(), { printLabels: false, manage: true })).toEqual({ key: 'wd.loc.print.held.noRight' })
    expect(printHeldOf(model({ draft: { printerId: '', copies: 1, language: 'it' } }), { printLabels: true, manage: true })).toEqual({ key: 'wd.loc.print.held.printer' })
    expect(printHeldOf(model({ draft: { printerId: PRINTERS[0]!.id, copies: 11, language: 'it' } }), { printLabels: true, manage: true })).toEqual({ key: 'wd.loc.print.held.copies' })
    expect(printHeldOf(model({ places: [TRANSIT] }), { printLabels: true, manage: true })).toEqual({ key: 'wd.loc.print.held.none' })
    expect(printStartHeldKey(0)).toBe('wd.loc.print.held.select')
    expect(printStartHeldKey(2)).toBeNull()
  })

  it('lays the bin label out as it prints: heading, the name, the code as bars, the facts', () => {
    const layout = binLabelLayout(RACK_LABEL.label, 'Bin label')
    expect(layout).toMatchObject({ widthMm: 100, heightMm: 50 })
    expect(layout.blocks.map((block) => block.kind)).toEqual(['text', 'title', 'barcode', 'fields'])
    expect(layout.blocks[2]).toMatchObject({ kind: 'barcode', value: 'STAB-N-N-MAG-A' })
  })
})

describe('B-W2b-327 draws every Locations design case in both languages with no key left', () => {
  for (const locale of LOCALES) {
    it(`the list’s and the record’s cases in ${locale}`, () => {
      for (const item of listScreen.cases) {
        const html = draw(LocationsView, item.model.model, locale)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-065/${item.id} (${locale})`).toBeNull()
      }
      for (const item of recordScreen.cases) {
        const html = draw(LocationRecordView, item.model.model, locale)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-065-record/${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('says the block, the count and the labels in words', () => {
    const counted = draw(LocationRecordView, recordScreen.cases.find((item) => item.id === 'w2b-count-blocked')!.model.model)
    expect(counted).toContain('Blocked while count CNT-D-0007 runs')
    expect(counted).toContain('/warehouse/counts?q=CNT-D-0007')
    const damaged = draw(LocationRecordView, recordScreen.cases.find((item) => item.id === 'w2b-damage-blocked')!.model.model)
    expect(damaged).toContain('Blocked: Damage')
    expect(damaged).toContain('Quality')
    const labels = draw(LocationRecordView, recordScreen.cases.find((item) => item.id === 'w2b-labels')!.model.model)
    expect(labels).toContain('Print history')
    expect(labels).toContain('Not printed')
    expect(draw(LocationRecordView, recordScreen.cases.find((item) => item.id === 'w2b-labels-transit')!.model.model)).toContain('carries no label')
    expect(draw(LocationRecordView, recordScreen.cases.find((item) => item.id === 'w2b-labels-read-only')!.model.model)).not.toContain('Save the code')
    expect(draw(LocationsView, listScreen.cases.find((item) => item.id === 'w2b-status')!.model.model)).toContain('Print labels')
  })
})
