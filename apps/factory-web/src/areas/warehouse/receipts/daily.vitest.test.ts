import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DISCREPANCY_KINDS, DISCREPANCY_STATUSES } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { receipt } from './demo/fixtures'
import { CHECK, CONTACTS, DISCREPANCIES, dailyCanOf, discrepancy, hideListSummary, REASONS } from './demo/daily/fixtures'
import {
  blankDiscrepancy,
  changeHeld,
  claimBody,
  claimDraft,
  claimDraftHeld,
  claimHeld,
  claimProblem,
  dailyCan,
  deliveryOf,
  discrepancyBody,
  discrepancyHeld,
  discrepancyProblem,
  draftKind,
  draftOf,
  hideListHeld,
  hideListLineWords,
  kindAsked,
  NAMESPACE,
  parseCc,
  photoHeld,
  removeHeld,
  reportableWhy,
  reportBody,
  reportDraft,
  reportHeld,
  reportIds,
  reportProblem,
  reportSendHeld,
  requestDraft,
  requestHeld,
  requestLanguage,
  requestText,
  settleHeld,
  settleMoves,
  takesDiscrepancies,
  typedQuantity,
  wantedDocuments,
  withCheck,
} from './daily-model'
import { LOTS } from './demo/fixtures'
import { receiptQuery, receiptViewOf, RECEIPT_TABS, RECEIPT_TILES, receiptTabOf } from './model'
import { designScreen as receiptsScreen } from './list/fixtures'
import { designScreen as lotsScreen } from './record/fixtures'

// The DS Modal opens only after hydration: drawn in place here so every dialog's words are checked too.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), subtitle as never, children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * The receipt every day (B-W2a-63): the pure rules of the Discrepancies and Documents check tabs, their dialogs and the
 * hide list, and every SCR-063 / SCR-062 design case in both languages with no message key left on screen.
 */

const warehouse = dailyCanOf('warehouse')
const buyer = dailyCanOf('buyer')
const readOnly = dailyCanOf('readOnly')
const conflict = new ApiError('conflict', 409, 'conflict', 'moved')
const invalidAt = (path: string) => new ApiError('invalid', 400, 'invalid', 'refused', null, [{ path, message: 'API English never drawn' }])

describe('who may do what', () => {
  it('reads the W2a permissions of the real templates', () => {
    expect(warehouse).toMatchObject({ manage: true, report: true, receive: true, claims: true, email: false, importRun: true })
    expect(buyer).toMatchObject({ manage: true, report: true, receive: false, claims: true, email: true, parties: true, importRun: false })
    expect(readOnly).toMatchObject({ manage: false, report: false, claims: false, email: false })
    expect(dailyCan([])).toMatchObject({ manage: false, upload: false, importApply: false })
  })

  it('the hide list needs receiving and imports', () => {
    expect(hideListHeld(warehouse)).toBeNull()
    expect(hideListHeld(buyer)?.key).toBe('held.noReceive')
    expect(hideListHeld({ ...warehouse, importRun: false })?.key).toBe('held.noImport')
  })
})

describe('the list: tile, view, address', () => {
  it('"Discrepancies open" is a saved view = the API’s ?discrepancies=open', () => {
    expect(receiptViewOf(new URLSearchParams('discrepancies=open'), true)).toBe('discrepancies')
    expect(receiptViewOf(new URLSearchParams('view=discrepancies'), true)).toBe('discrepancies')
    expect(receiptQuery('discrepancies', '', '2026-10-29T00:00:00Z')).toMatchObject({ discrepancies: true, status: null, waiting: false })
    const tile = RECEIPT_TILES.find((entry) => entry.id === 'discrepancies')!
    expect(tile.count({ posted: 1, reversed: 0, waiting: 0, postedSince: 0, discrepanciesOpen: 3 }, null)).toBe(3)
    expect(tile.count({ posted: 1, reversed: 0, waiting: 0, postedSince: 0 }, null)).toBeNull()
    expect(tile.count(null, null)).toBeNull()
  })

  it('the record’s tabs in the design’s order', () => {
    expect(RECEIPT_TABS).toEqual(['lines', 'lots', 'documents', 'discrepancies', 'activity'])
    expect(receiptTabOf('discrepancies')).toBe('discrepancies')
    expect(receiptTabOf('nope')).toBe('lines')
  })
})

describe('New discrepancy', () => {
  const posted = receipt()
  it('a standard reason gives the kind; a company’s own reason asks it', () => {
    expect(draftKind({ reasonCode: 'DAMAGED', kind: '' })).toBe('DAMAGED')
    expect(kindAsked({ reasonCode: 'DAMAGED' })).toBe(false)
    expect(kindAsked({ reasonCode: 'STAINS' })).toBe(true)
    expect(draftKind({ reasonCode: 'STAINS', kind: '' })).toBeNull()
    expect(draftKind({ reasonCode: '', kind: 'WRONG_COLOUR' })).toBe('WRONG_COLOUR')
  })

  it('Save is held with the first reason, in the form’s order', () => {
    const blank = blankDiscrepancy()
    expect(discrepancyHeld(blank, posted, warehouse, REASONS, false)?.key).toBe('held.kind')
    expect(discrepancyHeld({ ...blank, reasonCode: 'STAINS' }, posted, warehouse, REASONS, false)?.key).toBe('held.ownReasonKind')
    expect(discrepancyHeld({ ...blank, reasonCode: 'STAINS', kind: 'OTHER' }, posted, warehouse, REASONS, false)?.key).toBe('held.noteNeeded')
    expect(discrepancyHeld({ ...blank, reasonCode: 'SHORT', quantity: '0' , uom: 'FT2' }, posted, warehouse, REASONS, false)?.key).toBe('held.quantity')
    expect(discrepancyHeld({ ...blank, reasonCode: 'SHORT', quantity: '2' }, posted, warehouse, REASONS, false)?.key).toBe('held.quantityUnit')
    expect(discrepancyHeld({ ...blank, reasonCode: 'SHORT', quantity: '2,5', uom: 'FT2' }, posted, warehouse, REASONS, false)).toBeNull()
    expect(discrepancyHeld({ ...blank, reasonCode: 'SHORT' }, receipt({ status: 'REVERSED' }), warehouse, REASONS, false)?.key).toBe('held.receiptClosed')
    expect(discrepancyHeld(blank, posted, readOnly, REASONS, false)?.key).toBe('held.noManage')
    expect(discrepancyHeld({ ...blank, reasonCode: 'SHORT', photos: [{ key: 'p', blob: new Blob([]), name: 'p.jpg' }] }, posted, { ...warehouse, upload: false }, REASONS, false)?.key).toBe('held.noUpload')
  })

  it('the body: the kind, the reason, both or neither of quantity and unit (a comma typed is a point)', () => {
    const body = discrepancyBody({ ...blankDiscrepancy('line-1'), reasonCode: 'DAMAGED', quantity: '1,5', uom: 'HIDE', note: '  hole  ' })
    expect(body).toEqual({ kind: 'DAMAGED', reasonCode: 'DAMAGED', receiptLineId: 'line-1', quantity: '1.5', uom: 'HIDE', note: 'hole' })
    expect(discrepancyBody({ ...blankDiscrepancy(), kind: 'OTHER' })).toEqual({ kind: 'OTHER', reasonCode: null, receiptLineId: null, quantity: null, uom: null, note: null })
    expect(typedQuantity('12.34567')).toBeNull()
    expect(typedQuantity('0')).toBeNull()
  })

  it('an open one becomes a draft to change; a reported or closed one does not change', () => {
    const draft = draftOf(DISCREPANCIES[0]!)
    expect(draft).toMatchObject({ id: DISCREPANCIES[0]!.id, version: 1, reasonCode: 'SHORT', quantity: '18.4', uom: 'FT2' })
    expect(changeHeld(DISCREPANCIES[0]!, warehouse)).toBeNull()
    expect(changeHeld(DISCREPANCIES[2]!, warehouse)?.key).toBe('held.sentNoChange')
    expect(changeHeld(DISCREPANCIES[3]!, warehouse)?.key).toBe('held.closedNoChange')
  })
})

describe('settle, remove, photos', () => {
  it('the moves by hand follow the machine (the report makes OPEN → SENT)', () => {
    expect(settleMoves('OPEN')).toEqual(['CLOSED'])
    expect(settleMoves('SENT')).toEqual(['AGREED', 'CLOSED'])
    expect(settleMoves('AGREED')).toEqual(['CREDITED', 'CLOSED'])
    expect(settleMoves('CREDITED')).toEqual(['CLOSED'])
    expect(settleMoves('CLOSED')).toEqual([])
    expect(settleHeld('CLOSED', '  ', warehouse, false)?.key).toBe('held.closeNote')
    expect(settleHeld('AGREED', '', warehouse, false)).toBeNull()
  })

  it('removed only while open and without a photo; photos until closed, at most ten', () => {
    expect(removeHeld(DISCREPANCIES[0]!, warehouse)).toBeNull()
    expect(removeHeld(DISCREPANCIES[1]!, warehouse)?.key).toBe('held.photosNoRemove')
    expect(removeHeld(DISCREPANCIES[2]!, warehouse)?.key).toBe('held.sentNoRemove')
    expect(photoHeld(DISCREPANCIES[3]!, warehouse)?.key).toBe('held.closedNoPhoto')
    expect(photoHeld(discrepancy(9, { photos: Array.from({ length: 10 }, (_, n) => ({ id: `f${n}`, originalName: 'x', contentType: 'image/jpeg', sizeBytes: 1, status: 'AVAILABLE', createdAt: '' })) }), warehouse)?.key).toBe('held.photosFull')
  })
})

describe('the report and the claim', () => {
  it('the report names the selection (open or reported), else every open one', () => {
    expect(reportIds(DISCREPANCIES, [])).toEqual([DISCREPANCIES[0]!.id, DISCREPANCIES[1]!.id])
    expect(reportIds(DISCREPANCIES, [DISCREPANCIES[1]!.id, DISCREPANCIES[3]!.id])).toEqual([DISCREPANCIES[1]!.id])
    expect(reportableWhy(DISCREPANCIES[2]!)?.key).toBe('disc.notReportable.answered')
    expect(reportableWhy(DISCREPANCIES[3]!)?.key).toBe('disc.notReportable.CLOSED')
    expect(reportHeld(DISCREPANCIES, [], warehouse)).toBeNull()
    expect(reportHeld(DISCREPANCIES.slice(2), [], warehouse)?.key).toBe('held.nothingOpen')
    expect(reportHeld(DISCREPANCIES, [], readOnly)?.key).toBe('held.noReport')
  })

  it('the send: the suggested contacts first, held until one is picked, the copy addresses checked', () => {
    const draft = withCheck(reportDraft([DISCREPANCIES[0]!.id]), CHECK)
    expect(draft.contactIds).toEqual([CHECK.recipients[0]!.contactId])
    expect(reportSendHeld(draft, warehouse, false)).toBeNull()
    expect(reportSendHeld({ ...draft, contactIds: [] }, warehouse, false)?.key).toBe('held.pickRecipient')
    expect(reportSendHeld({ ...draft, cc: 'a@b.example, nope' }, warehouse, false)).toEqual({ key: 'held.cc', params: { list: 'nope' } })
    expect(reportSendHeld(reportDraft([]), warehouse, false)?.key).toBe('held.loading')
    expect(reportSendHeld(withCheck(reportDraft([]), { ...CHECK, recipients: [], problems: [{ path: 'contactIds', message: 'x' }] }), warehouse, false)?.key).toBe('report.problem.noContact')
    expect(reportBody({ ...draft, cc: 'x@y.example', message: '  ' })).toEqual({ discrepancyIds: [DISCREPANCIES[0]!.id], contactIds: [CHECK.recipients[0]!.contactId], cc: ['x@y.example'], subject: CHECK.subject, message: null, language: 'it' })
    expect(parseCc('a@b.example; ; c@d.example').valid).toEqual(['a@b.example', 'c@d.example'])
    expect(deliveryOf({ status: 'DELIVERED' })).toBe('delivered')
    expect(deliveryOf({ status: 'SENDING' })).toBe('queued')
    expect(deliveryOf({ status: 'BOUNCED' })).toBe('bounced')
  })

  it('a claim from discrepancies: open or reported, on a line, not pursued yet', () => {
    expect(claimHeld(DISCREPANCIES, [DISCREPANCIES[0]!.id, DISCREPANCIES[1]!.id], buyer)).toBeNull()
    expect(claimHeld(DISCREPANCIES, [], buyer)?.key).toBe('held.pickForClaim')
    expect(claimHeld(DISCREPANCIES, [DISCREPANCIES[2]!.id], buyer)?.key).toBe('held.claimAnswered')
    expect(claimHeld([discrepancy(5, { receiptLine: null })], [discrepancy(5).id], buyer)?.key).toBe('held.claimNoLine')
    expect(claimHeld([discrepancy(6, { status: 'SENT', claims: [{ id: 'c', number: 'CLM-2026-0009', status: 'SENT' }] })], [discrepancy(6).id], buyer)).toEqual({ key: 'held.claimPursued', params: { seq: 60, number: 'CLM-2026-0009' } })
    expect(claimHeld(DISCREPANCIES, [DISCREPANCIES[0]!.id], readOnly)?.key).toBe('held.noClaims')
    const draft = claimDraft([DISCREPANCIES[0]!.id])
    expect(claimDraftHeld(draft, REASONS, buyer, false)?.key).toBe('held.claimReason')
    expect(claimDraftHeld({ ...draft, reasonCode: 'OTHER' }, REASONS, buyer, false)?.key).toBe('held.noteNeeded')
    expect(claimBody({ ...draft, reasonCode: 'QUALITY', note: '' })).toEqual({ reasonCode: 'QUALITY', reasonNote: null, remedy: 'CREDIT', discrepancyIds: [DISCREPANCIES[0]!.id] })
  })
})

describe('Documents check and Request from supplier', () => {
  it('what the delivery waits for: the Cr VI report of a lot in quarantine, a PPE certificate, a missing DDT', () => {
    const lots = [LOTS[0]!, { ...LOTS[1]!, qualityStatus: 'QUARANTINE' as const, holds: ['PPE_CERTIFICATE' as const] }]
    const wanted = wantedDocuments({ supplierDdtNumber: null, ddtPhotos: [] }, lots)
    expect(wanted.map((entry) => entry.ask)).toEqual(['CR_VI_REPORT', 'PPE_CERTIFICATE', 'DELIVERY_NOTE'])
    expect(wantedDocuments({ supplierDdtNumber: 'DDT-1', ddtPhotos: [] }, [{ ...LOTS[0]!, qualityStatus: 'RELEASED' }])).toEqual([])
  })

  it('the text is in the supplier’s language, names the lots by the supplier’s own refs, and has no price', () => {
    const wanted = wantedDocuments({ supplierDdtNumber: 'DDT-DEMO-562', ddtPhotos: [] }, LOTS)
    const it = requestText('it', { number: 'GR-2026-0022', supplierDdtNumber: 'DDT-DEMO-562', ddtDay: '29/10/2026' }, wanted)
    expect(it.subject).toContain('DDT-DEMO-562')
    expect(it.body).toContain('cromo esavalente')
    expect(it.body).toContain(LOTS[0]!.supplierLotRef!)
    expect(it.body).not.toMatch(/€|EUR|prezz/i)
    const en = requestText('en', { number: 'GR-2026-0022', supplierDdtNumber: null, ddtDay: null }, wanted)
    expect(en.body).toContain('hexavalent chromium')
    expect(requestLanguage([{ ...CONTACTS[0]!, language: 'en-GB' }], [CONTACTS[0]!.id])).toBe('en')
    expect(requestLanguage(CONTACTS, [])).toBe('it')
  })

  it('Send request is held without e-mail rights, contacts, a recipient or a document', () => {
    const wanted = wantedDocuments({ supplierDdtNumber: null, ddtPhotos: [] }, LOTS)
    const draft = { ...requestDraft(wanted), contacts: { value: CONTACTS, problem: null }, to: [CONTACTS[0]!.id], subject: 'S', body: 'B' }
    expect(requestHeld(draft, buyer, false)).toBeNull()
    expect(requestHeld(draft, warehouse, false)?.key).toBe('held.noEmail')
    expect(requestHeld({ ...draft, to: [] }, buyer, false)?.key).toBe('held.pickRecipient')
    expect(requestHeld({ ...draft, asked: [] }, buyer, false)?.key).toBe('held.pickDocument')
    expect(requestHeld({ ...draft, contacts: { value: null, problem: null } }, buyer, false)?.key).toBe('held.loading')
  })

  it('a reversed receipt still takes discrepancies? no; an open or posted one does', () => {
    expect(takesDiscrepancies({ status: 'POSTED' })).toBe(true)
    expect(takesDiscrepancies({ status: 'OPEN' })).toBe(true)
    expect(takesDiscrepancies({ status: 'REVERSED' })).toBe(false)
  })
})

describe('refusals in our words (never the API’s English)', () => {
  it('by the path the API names', () => {
    expect(discrepancyProblem(invalidAt('body.reasonCode')).key).toBe('refused.reason')
    expect(discrepancyProblem(invalidAt('body.kind')).key).toBe('refused.kind')
    expect(discrepancyProblem(invalidAt('body.quantity')).key).toBe('refused.quantity')
    expect(discrepancyProblem(conflict).key).toBe('refused.moved')
    expect(reportProblem(invalidAt('body.contactIds')).key).toBe('report.problem.noContact')
    expect(reportProblem(conflict).key).toBe('refused.reportMoved')
    expect(claimProblem(invalidAt('body.from.discrepancyIds')).key).toBe('refused.claimDiscrepancies')
    expect(claimProblem(invalidAt('body.reasonCode')).key).toBe('refused.claimReason')
    expect(discrepancyProblem(new Error('x')).key).toBe('problem.write')
  })

  it('a hide list line in words', () => {
    const line = hideListSummary().lines[0]!
    expect(hideListLineWords(line).key).toBe('hideList.judge.within')
    expect(hideListLineWords({ ...line, kind: 'OVER', needsReason: true }).key).toBe('hideList.judge.overReason')
    expect(hideListLineWords({ ...line, kind: 'SHORT' }).key).toBe('hideList.judge.short')
  })
})

describe('the catalogue', () => {
  it('has every kind, state and the words each part names, in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, CATALOGUE[locale][NAMESPACE] ?? {})
      for (const kind of DISCREPANCY_KINDS) expect(t(`kind.${kind}`)).not.toBe(`kind.${kind}`)
      for (const status of DISCREPANCY_STATUSES) {
        expect(t(`discStatus.${status}`)).not.toBe(`discStatus.${status}`)
        expect(t(`discStatusWords.${status}`)).not.toBe(`discStatusWords.${status}`)
      }
    }
  })
})

const LEFT_KEY = /\b(?:common|held|problem|record|uom|kind|disc|discStatus|discStatusWords|docs|report|request|new|settle|remove|claim|hideList|photo|detail|refused|notice|tile|view|col|list|lines|lots|band|tab|contactRole|language|remedy|rc|po|imp)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
/** Permission names are said on purpose ("needs email.send"): not keys. */
const PERMISSIONS = /\b(?:planning\.(?:view|run|decide)|purchasing\.(?:view|manage|send|claims\.manage|claims\.return)|inventory\.(?:stock\.view|receive|reverse|locations\.view|discrepancies\.manage|discrepancies\.report)|quality\.lots\.view|money\.cost|email\.send|parties\.view|files\.upload|imports\.run)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'buying', 'lists', 'records', 'send']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [receiptsScreen, lotsScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(PERMISSIONS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(/\{[a-z][a-zA-Z]*\}/)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }
})
