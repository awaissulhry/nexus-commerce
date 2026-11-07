import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { designScreen as requiredScreen } from '../../areas/admin/documents/required/fixtures'
import { draftAfter, draftHeld, EMPTY_DRAFT, hiddenOff, newHeld, requiredQuery, rowHeld, rowsOf, switchReach, type RequiredModel } from '../../areas/admin/documents/required/model'
import type { Rule, RulesAnswer } from '../../areas/admin/documents/required/api'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import type { PanelFile } from '../model'
import { designScreen as filesScreen } from './fixtures'
import { compareHeld, expiryTag, markupHeld, markupSaveHeld, moveState, openMoves, pick, restoreHeld, seriesGroups, tagBody, tagHeld, tagProblem, type DocumentsState } from './model'
import { documentsStateOf, versionRowsOf } from './use-file-depth'

/**
 * B-W2b-177: the files panel in depth (SCR-006-files) and Admin › Required documents (SCR-014-required) — their pure rules,
 * and every design case drawn in it and en with no message key left on screen.
 */

const file = (id: string, extra: Partial<PanelFile> = {}): PanelFile => ({
  id,
  name: 'pattern.pdf',
  kind: 'DOCUMENT',
  contentType: 'application/pdf',
  sizeBytes: 1000,
  status: 'AVAILABLE',
  visibility: ['OFFICE'],
  partyId: null,
  retainUntil: null,
  legalHold: false,
  quarantineReason: null,
  availableAt: '2026-10-20T10:00:00Z',
  createdAt: '2026-10-20T10:00:00Z',
  ...extra,
})

describe('files in depth (SCR-006-files)', () => {
  it('groups a series by its first version, the newest number on top; files without versions by name, as before', () => {
    const groups = seriesGroups([
      file('a', { versionNo: 1, seriesId: null, supersededAt: '2026-10-21T09:00:00Z' }),
      file('b', { versionNo: 2, seriesId: 'a', name: 'pattern (marked).pdf', createdAt: '2026-10-21T09:00:00Z' }),
      file('c', { name: 'old.pdf' }),
      file('d', { name: 'old.pdf', createdAt: '2026-10-19T10:00:00Z' }),
      file('e', { status: 'DELETED', versionNo: 1 }),
    ])
    expect(groups.map((group) => [group.latest.id, group.earlier.map((item) => item.id)])).toEqual([
      ['b', ['a']],
      ['c', ['d']],
    ])
  })

  it('says each expiry and what each move still needs', () => {
    const doc = { fileId: 'f', name: 'x', category: 'DECLARATION', ofParty: false }
    expect(expiryTag({ ...doc, expiresOn: null, expiryState: 'NONE', daysLeft: null })).toBeNull()
    expect(expiryTag({ ...doc, expiresOn: '2026-10-01', expiryState: 'EXPIRED', daysLeft: -3 })).toMatchObject({ key: 'expiry.expired', tone: 'danger' })
    expect(expiryTag({ ...doc, expiresOn: '2026-11-01', expiryState: 'EXPIRING', daysLeft: 0 })?.key).toBe('expiry.today')
    expect(expiryTag({ ...doc, expiresOn: '2026-11-08', expiryState: 'EXPIRING', daysLeft: 7 })).toMatchObject({ key: 'expiry.soon', tone: 'warning', params: { count: 7 } })
    const met = { toStatus: 'SENT', requirements: [{ ruleId: '1', category: 'PROOF', level: 'BLOCK' as const, reason: 'MET' as const, fileId: 'f', expiresOn: null }] }
    const warn = { toStatus: 'RECEIVED', requirements: [{ ruleId: '2', category: 'TEST_REPORT', level: 'WARN' as const, reason: 'MISSING' as const, fileId: null, expiresOn: null }] }
    const block = { toStatus: 'CONFIRMED', requirements: [{ ruleId: '3', category: 'SUPPLIER_CERTIFICATE', level: 'BLOCK' as const, reason: 'EXPIRED' as const, fileId: 'g', expiresOn: '2026-10-28' }] }
    expect(moveState(block)).toEqual({ blocks: 1, warnings: 0 })
    expect(openMoves([met, warn, block]).map((move) => move.toStatus)).toEqual(['CONFIRMED', 'RECEIVED'])
  })

  it('holds what a file may not do here, with the reason', () => {
    const ready = { status: 'ready' as const, value: { mayTag: true } as DocumentsState }
    const current = file('a', { versionNo: 1, version: 3 })
    expect(markupHeld(current, true)).toBeNull()
    expect(markupHeld(current, false)).toBe('depth.held.noUpload')
    expect(markupHeld(file('c', { contentType: 'text/csv' }), true)).toBe('depth.held.notMarkable')
    expect(markupHeld(file('h', { contentType: 'image/heic' }), true)).toBe('depth.held.notMarkable')
    expect(markupHeld(file('s', { supersededAt: '2026-10-21T09:00:00Z' }), true)).toBe('depth.held.notCurrent')
    expect(tagHeld(current, ready)).toBeNull()
    expect(tagHeld(current, { status: 'loading' })).toBe('depth.held.reading')
    expect(tagHeld(current, { status: 'ready', value: { mayTag: false } as DocumentsState })).toBe('depth.held.noUpload')
    expect(restoreHeld({ current: true, status: 'AVAILABLE' }, true, false)).toBe('versions.held.current')
    expect(restoreHeld({ current: false, status: 'AVAILABLE' }, true, true)).toBe('versions.held.uploading')
    expect(restoreHeld({ current: false, status: 'AVAILABLE' }, true, false)).toBeNull()
    expect(markupSaveHeld([])).toBe('markup.held.noMarks')
  })

  it('picks two versions for side by side, pictures only', () => {
    expect(pick(['a', 'b'], 'c', true)).toEqual(['b', 'c'])
    expect(pick(['a', 'b'], 'a', false)).toEqual(['b'])
    const row = (id: string, picture: boolean) => ({ id, picture }) as never
    expect(compareHeld([row('a', true), row('b', true)], ['a'])).toBe('versions.held.pickTwo')
    expect(compareHeld([row('a', true), row('b', false)], ['a', 'b'])).toBe('versions.held.pictures')
    expect(compareHeld([row('a', true), row('b', true)], ['a', 'b'])).toBeNull()
  })

  it("sends only what changed of a document's kind and date; a date the API would refuse is held", () => {
    const before = { fileId: 'f', name: 'x', category: 'DECLARATION', expiresOn: '2026-11-12', expiryState: 'EXPIRING' as const, daysLeft: 14, ofParty: false }
    expect(tagBody({ category: 'DECLARATION', expiresOn: '2026-11-12' }, before)).toEqual({})
    expect(tagBody({ category: 'DECLARATION', expiresOn: '' }, before)).toEqual({ expiresOn: null })
    expect(tagBody({ category: 'TEST_REPORT', expiresOn: '2027-01-31' }, undefined)).toEqual({ category: 'TEST_REPORT', expiresOn: '2027-01-31' })
    expect(tagProblem({ category: null, expiresOn: '2026-02-30' }, '2026-10-29')).toBe('tag.problem.date')
    expect(tagProblem({ category: 'NOPE', expiresOn: '' }, '2026-10-29')).toBe('tag.problem.category')
  })

  it("maps the API's documents and history", () => {
    const state = documentsStateOf({
      status: 'SENT',
      today: '2026-10-29',
      documents: [
        { fileId: 'own', category: 'DECLARATION', expiresOn: null, expiryState: 'NONE', daysLeft: null, ofParty: false, originalName: 'a.pdf' },
        { fileId: 'party', category: 'SUPPLIER_CERTIFICATE', expiresOn: '2026-11-01', expiryState: 'EXPIRING', daysLeft: 3, ofParty: true, originalName: 'b.pdf' },
      ],
      moves: [],
      mayTag: true,
    })
    expect(Object.keys(state.byFile)).toEqual(['own'])
    expect(state.partyDocuments.map((doc) => doc.fileId)).toEqual(['party'])
    const history = { companyId: null, recordType: 'Quote', recordId: 'r', kind: 'PHOTO', contentType: 'image/png', sizeBytes: 9, status: 'AVAILABLE', visibility: ['OFFICE'], retainUntil: null, quarantineReason: null, createdAt: '2026-10-20T10:00:00Z', version: 1, markups: 0, madeByMarkup: null } as const
    const rows = versionRowsOf(
      [
        { ...history, id: 'v1', originalName: 'a.png', versionNo: 1, availableAt: '2026-10-20T10:00:00Z', current: false, addedBy: { id: null, name: null, fromPartner: false }, usedBy: [{ fileId: 'c', recordType: 'Shipment', recordId: 's1', label: 'SP-1' }] },
        { ...history, id: 'v2', originalName: 'a (marked).png', versionNo: 2, availableAt: '2026-10-21T10:00:00Z', current: true, addedBy: { id: 'u', name: 'Bea', fromPartner: false }, usedBy: [], madeByMarkup: { id: 'm', note: null, marks: 2 } },
      ] as never,
      true,
      '/w/DEMO',
    )
    expect(rows.map((row) => [row.versionNo, row.current, row.restoreHeld, row.picture])).toEqual([
      [2, true, 'versions.held.current', true],
      [1, false, null, true],
    ])
    expect(rows[1]!.usedBy[0]).toMatchObject({ label: 'SP-1', typeKey: 'Shipment' })
    expect(rows[1]!.usedBy[0]!.href.startsWith('/w/DEMO/')).toBe(true)
  })
})

const RULE = (over: Partial<Rule>): Rule => ({ id: 'r1', companyId: 'c1', recordType: 'PurchaseOrder', category: 'SUPPLIER_CERTIFICATE', beforeStatus: 'CONFIRMED', partyRole: 'SUPPLIER', level: 'BLOCK', active: true, version: 1, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z', ...over })
const ANSWER: RulesAnswer = { rules: [RULE({}), RULE({ id: 'r2', active: false, category: 'DECLARATION' }), RULE({ id: 'r3', companyId: 'c2' })], recordTypes: [{ recordType: 'PurchaseOrder', statuses: ['SENT', 'CONFIRMED'] }, { recordType: 'GoodsReceipt', statuses: ['POSTED'] }], categories: ['SUPPLIER_CERTIFICATE', 'DECLARATION'], mayChange: ['c1'] }
const model = (over: Partial<RequiredModel> = {}): RequiredModel => ({ companies: [], companyId: 'c1', read: { status: 'ready', answer: ANSWER }, showOff: false, selected: [], dialog: null, saving: [], notice: null, asOf: null, ...over })

describe('required documents (SCR-014-required)', () => {
  it("lists the company's rules, switched-off ones only when asked", () => {
    expect(rowsOf(model()).map((rule) => rule.id)).toEqual(['r1'])
    expect(rowsOf(model({ showOff: true })).map((rule) => rule.id)).toEqual(['r1', 'r2'])
    expect(rowsOf(model({ companyId: null })).map((rule) => rule.id)).toEqual(['r1', 'r3'])
    expect(hiddenOff(model())).toBe(1)
  })

  it('holds what the person may not change, and a second active rule of the same key', () => {
    expect(rowHeld(model(), RULE({ companyId: 'c2' }))).toBe('req.held.noRight')
    expect(rowHeld(model({ saving: ['r1'] }), RULE({}))).toBe('req.held.saving')
    expect(newHeld(model({ companyId: null }))).toBe('req.held.pickCompany')
    expect(newHeld(model({ companyId: 'c2' }))).toBe('req.held.noRight')
    expect(draftHeld(model(), EMPTY_DRAFT)).toBe('req.held.duplicate')
    expect(draftHeld(model(), { ...EMPTY_DRAFT, category: 'DECLARATION' })).toBeNull()
    expect(draftAfter(ANSWER, EMPTY_DRAFT, { recordType: 'GoodsReceipt' }).beforeStatus).toBe('POSTED')
  })

  it('switches on or off only the ticked rules that change', () => {
    const rows = rowsOf(model({ showOff: true }))
    expect(switchReach(model(), rows, ['r1', 'r2'], false)).toMatchObject({ applies: [expect.objectContaining({ id: 'r1' })], left: 1, held: null })
    expect(switchReach(model(), rows, ['r1'], true).held).toBe('req.held.allOn')
    expect(requiredQuery({ companyId: 'c1', showOff: true, dialog: true })).toBe('view=required&company=c1&off=1&rule=new')
  })
})

const LEFT_KEY = /\b(?:req|docs|depth|versions|tag|markup|required|files|expiry|category|status|recordType|role|problem|common|list)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

describe('every design case in it and en, no key on screen; both catalogues have the same keys', () => {
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const screen of [filesScreen, requiredScreen]) {
        const View = screen.view as ComponentType<{ model: unknown }>
        for (const item of screen.cases) {
          const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
          expect(html.length, item.id).toBeGreaterThan(500)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen} ${item.id} (${locale})`).toBeNull()
        }
      }
    })
  }
  it('same keys', () => {
    for (const namespace of ['record-files', 'admin-required']) {
      const keys = (locale: string) => Object.keys((CATALOGUE as Record<string, Record<string, Record<string, string>>>)[locale]![namespace] ?? {}).sort()
      expect(keys('it').length, namespace).toBeGreaterThan(20)
      expect(keys('it')).toEqual(keys('en'))
    }
  })
})
