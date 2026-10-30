import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CLAIM_FOUND_AT, CLAIM_KINDS, CLAIM_REMEDIES, CLAIM_STATUSES, claimActions } from '@nexus/factory-domain/purchasing/claims/rules'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, listAddress, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { listClaims, returnToSupplier, updateClaim } from './api'
import { canFor, claim, FOUND_LOTS, LEATHER_STOCK, LOT_HIDES, PAD_STOCK, REASON_LIST, SEND_CHECK } from './demo/fixtures'
import { designScreen } from './list/fixtures'
import {
  actHeld,
  answerBody,
  CLAIM_VIEWS,
  claimQuery,
  claimsAddress,
  claimsCan,
  ddtHeld,
  defaultView,
  filtersOf,
  formHeld,
  formOf,
  formPatch,
  goodsBody,
  minorOf,
  NO_DDT,
  NO_RETURN,
  otherActs,
  primaryAct,
  ready,
  returnBody,
  returnHeld,
  returnRefusal,
  say,
  sendBody,
  sendDraftOf,
  sendHeld,
  TILES,
  viewFromAddress,
  withCheck,
  withHides,
  withStock,
  type ClaimAct,
  type ReturnDraft,
} from './model'

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so every dialog's words
// are checked too.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), subtitle as never, children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * Purchasing › Returns & claims (SCR-131; B-W2a-63 on B-W2a-44's API): the saved views as the API's own filters, the
 * address terms the receipts and lots open it with, why an act is held in our words (the same answers as factory-domain
 * claimActions), the Claim tab's form and its PATCH, every dialog's body, Return to supplier's checks and body, the
 * refusals in our words, the calls as the API takes them, the record links, and every design case drawn in Italian and
 * English with no message key or placeholder left on screen.
 */

const t = (locale: 'it' | 'en') => createTranslator(locale, messagesFor(locale, ['purchasing-claims'])['purchasing-claims'] ?? {})
const sayIn = (locale: 'it' | 'en', value: ReturnType<typeof actHeld>) => (value ? say(t(locale), value) : null)

describe('returns & claims: the views, the address, the tiles', () => {
  it('maps each view to the API’s own filter (a tile and its list agree)', () => {
    const none = filtersOf(new URLSearchParams(''))
    expect(claimQuery('open', none)).toEqual({})
    expect(claimQuery('all', none)).toEqual({ open: false })
    expect(claimQuery('sent', { ...none, q: ' clm ' })).toEqual({ status: 'SENT', q: 'clm' })
    expect(claimQuery('closed', { ...none, kind: 'RETURN' }, 'c1')).toEqual({ status: 'CLOSED', kind: 'RETURN', cursor: 'c1' })
    expect(claimQuery('all', { ...none, receipt: 'r1', lot: 'l1' })).toEqual({ open: false, goodsReceiptId: 'r1', lotId: 'l1' })
    expect(TILES.map((tile) => tile.view)).toEqual(['open', 'sent', 'accepted', 'closed'])
    expect(TILES.map((tile) => tile.count({ open: 5, waitingForSupplier: 1, creditExpected: 2, closedThisMonth: 3 }))).toEqual([5, 1, 2, 3])
  })

  it('reads the address the receipts and lots open it with (every state for one receipt or lot)', () => {
    expect(viewFromAddress(new URLSearchParams(''))).toBe('open')
    expect(viewFromAddress(new URLSearchParams('status=ACCEPTED'))).toBe('accepted')
    expect(viewFromAddress(new URLSearchParams('view=draft&status=SENT'))).toBe('draft')
    expect(viewFromAddress(new URLSearchParams('receipt=r1'))).toBe('all')
    expect(viewFromAddress(new URLSearchParams('lot=l1&return=1'))).toBe('all')
    expect(viewFromAddress(new URLSearchParams('lot=l1&view=open'))).toBe('open')
    expect(filtersOf(new URLSearchParams('kind=RETURN&q=x&receipt=r1&lot=l1'))).toEqual({ q: 'x', kind: 'RETURN', receipt: 'r1', lot: 'l1' })
    expect(filtersOf(new URLSearchParams('kind=NONSENSE')).kind).toBeNull()
    const filters = { q: '', kind: null, receipt: 'r1', lot: null }
    expect(defaultView(filters)).toBe('all')
    expect(claimsAddress('/w/DEMO/purchasing/claims', 'all', filters)).toBe('/w/DEMO/purchasing/claims?receipt=r1')
    expect(claimsAddress('/w/DEMO/purchasing/claims', 'open', filters, { returnOpen: true })).toBe('/w/DEMO/purchasing/claims?view=open&receipt=r1&return=1')
    expect(claimsAddress('/w/DEMO/purchasing/claims', 'open', { q: ' a ', kind: 'CLAIM', receipt: null, lot: null })).toBe('/w/DEMO/purchasing/claims?kind=CLAIM&q=a')
  })

  it('reads the roles: buyer manages with costs, warehouse returns goods without money, read-only reads, sales nothing', () => {
    expect(canFor('buyer')).toMatchObject({ view: true, manage: true, ret: false, ddtIssue: false, cost: true })
    expect(canFor('warehouse')).toMatchObject({ view: true, manage: true, ret: true, ddtIssue: true, cost: false, stock: true })
    expect(canFor('readOnly')).toMatchObject({ view: true, manage: false, ret: false })
    expect(canFor('sales').view).toBe(false)
    expect(claimsCan([])).toMatchObject({ view: false, manage: false, cost: false })
  })
})

describe('a claim: the band’s acts, held in our words like factory-domain claimActions', () => {
  const facts = (value: ReturnType<typeof claim>) => ({ number: value.number, kind: value.kind, status: value.status, remedy: value.remedy, lines: value.lines.map((line) => ({ id: line.id, seq: line.seq, moved: line.move !== null })) })
  const owner = canFor('owner')
  const domainAct: Record<ClaimAct, keyof ReturnType<typeof claimActions> | null> = { send: 'send', answer: 'answer', close: 'close', cancel: 'cancel', returnGoods: 'returnGoods', removeLines: 'edit' }

  it('allows exactly what the domain allows, state by state', () => {
    for (const kind of CLAIM_KINDS) {
      for (const status of CLAIM_STATUSES) {
        for (const returned of [false, true]) {
          const value = claim(kind, status, returned ? { returned: 3 } : {})
          const domain = claimActions(facts(value))
          for (const act of Object.keys(domainAct) as ClaimAct[]) {
            const key = domainAct[act]!
            expect(actHeld(value, act, owner) === null, `${kind} ${status} ${returned} ${act}`).toBe(domain[key] === null)
          }
        }
      }
    }
  })

  it('names the missing permission first, then the facts', () => {
    const sent = claim('RETURN', 'SENT')
    expect(actHeld(sent, 'returnGoods', canFor('buyer'))).toEqual({ key: 'held.permission', params: { permission: 'purchasing.claims.return' } })
    expect(actHeld(sent, 'answer', canFor('readOnly'))).toEqual({ key: 'held.permission', params: { permission: 'purchasing.claims.manage' } })
    expect(sayIn('en', actHeld(claim('CLAIM', 'CLOSED'), 'cancel', owner))).toBe('Only a draft is cancelled; this one is closed.')
    expect(sayIn('it', actHeld(claim('CLAIM', 'SENT'), 'send', owner))).toBe('Si invia solo una bozza, o un reclamo respinto dal fornitore; questo è inviato, in attesa del fornitore.')
    expect(sayIn('en', actHeld(claim('RETURN', 'SENT', { returned: 3 }), 'returnGoods', owner))).toBe('Every line of this return went back already.')
  })

  it('puts the main act by state, the others in ⋯ only when they may be done', () => {
    expect(primaryAct(claim('CLAIM', 'DRAFT'))).toBe('send')
    expect(primaryAct(claim('CLAIM', 'REJECTED'))).toBe('send')
    expect(primaryAct(claim('CLAIM', 'SENT'))).toBe('answer')
    expect(primaryAct(claim('RETURN', 'SENT'))).toBe('returnGoods')
    expect(primaryAct(claim('RETURN', 'SENT', { returned: 3 }))).toBe('answer')
    expect(primaryAct(claim('CLAIM', 'ACCEPTED'))).toBe('close')
    expect(primaryAct(claim('RETURN', 'ACCEPTED'))).toBe('returnGoods')
    expect(primaryAct(claim('RETURN', 'CLOSED'))).toBeNull()
    expect(otherActs(claim('RETURN', 'SENT'), canFor('owner'))).toEqual(['answer', 'close'])
    expect(otherActs(claim('CLAIM', 'DRAFT'), canFor('buyer'))).toEqual(['cancel'])
    expect(otherActs(claim('CLAIM', 'SENT'), canFor('readOnly'))).toEqual([])
  })
})

describe('the Claim tab’s form and the dialogs’ bodies', () => {
  const buyer = canFor('buyer')

  it('sends only what changed, with the version; holds Save with why', () => {
    const draft = claim('CLAIM', 'DRAFT')
    const base = formOf(draft)
    expect(formHeld(base, draft, buyer, REASON_LIST)).toEqual({ key: 'form.held.nothing' })
    expect(formHeld({ ...base, reasonCode: 'OTHER', reasonNote: '' }, draft, buyer, REASON_LIST)).toEqual({ key: 'form.held.note' })
    expect(formPatch({ ...base, reasonCode: 'OTHER', reasonNote: ' Macchie ', remedy: '' }, draft, buyer)).toEqual({ version: draft.version, reasonCode: 'OTHER', reasonNote: 'Macchie', remedy: null })
    const sent = claim('CLAIM', 'SENT')
    // A sent claim: the kind is not editable (left out even when typed), the credit agreed in minor units.
    expect(formPatch({ ...formOf(sent), kind: 'RETURN', agreed: '18,90', internalNote: '' }, sent, buyer)).toEqual({ version: sent.version, expectedCreditAmount: 1890, internalNote: null })
    expect(formHeld({ ...formOf(sent), agreed: '18,9x' }, sent, buyer, REASON_LIST)).toEqual({ key: 'form.held.agreed' })
    expect(formHeld({ ...formOf(sent), remedy: '' }, sent, buyer, REASON_LIST)).toEqual({ key: 'form.held.remedy' })
    // Without the cost grain the credit is no field of the form.
    expect(formPatch({ ...formOf(sent), agreed: '1' }, sent, { ...buyer, cost: false })).toEqual({ version: sent.version })
    expect(minorOf('18')).toBe(1800)
    expect(minorOf('0,5')).toBe(50)
    expect(minorOf('1.234')).toBeNull()
  })

  it('sends a claim with the contacts ticked, the supplier’s language and only the words that differ', () => {
    const draft = claim('CLAIM', 'DRAFT')
    const send = withCheck(sendDraftOf(draft), ready(SEND_CHECK))
    expect(send.contactIds).toEqual([SEND_CHECK.recipients[0]!.contactId])
    expect(sendHeld(send, draft, buyer)).toBeNull()
    expect(sendBody(send, draft)).toEqual({ version: draft.version, mail: { contactIds: send.contactIds, language: 'it' } })
    expect(sendBody({ ...send, cc: 'a@example.com, nope', subject: 'Altro oggetto' }, draft).mail).toEqual({ contactIds: send.contactIds, cc: ['a@example.com'], subject: 'Altro oggetto', language: 'it' })
    expect(sendHeld({ ...send, cc: 'nope' }, draft, buyer)).toEqual({ key: 'send.held.cc', params: { list: 'nope' } })
    expect(sendHeld({ ...send, contactIds: [] }, draft, buyer)).toEqual({ key: 'send.held.noContact' })
    expect(sendBody({ ...send, withMail: false }, draft)).toEqual({ version: draft.version, mail: null })
    const open = { ...draft, remedy: null }
    expect(sendHeld({ ...send, remedy: '' }, open, buyer)).toEqual({ key: 'send.held.remedy' })
    expect(sendBody({ ...send, remedy: 'REPLACEMENT', withMail: false }, open)).toEqual({ version: draft.version, remedy: 'REPLACEMENT', mail: null })
  })

  it('records the answer and sends the goods back with the return DDT', () => {
    const sent = claim('CLAIM', 'SENT')
    expect(answerBody({ outcome: 'ACCEPTED', answer: ' ok ', remedy: 'CREDIT', agreed: '15' }, sent, buyer)).toEqual({ version: sent.version, outcome: 'ACCEPTED', answer: 'ok', expectedCreditAmount: 1500 })
    expect(answerBody({ outcome: 'REJECTED', answer: 'no', remedy: 'CREDIT', agreed: '15' }, sent, buyer)).toEqual({ version: sent.version, outcome: 'REJECTED', answer: 'no' })
    const ret = claim('RETURN', 'SENT')
    expect(goodsBody({ lineIds: [ret.lines[0]!.id], ddt: { ...NO_DDT, grossWeightKg: '7,5' } }, ret)).toEqual({ version: ret.version, lines: [{ lineId: ret.lines[0]!.id }], ddt: { reason: 'RETURN', transportBy: 'SENDER', packages: 1, grossWeightKg: '7.5' } })
    expect(ddtHeld(NO_DDT)).toEqual({ key: 'ddt.held.weight' })
    expect(ddtHeld({ ...NO_DDT, transportBy: 'CARRIER', grossWeightKg: '3' })).toEqual({ key: 'ddt.held.carrier' })
    expect(ddtHeld({ ...NO_DDT, packages: '0', grossWeightKg: '3' })).toEqual({ key: 'ddt.held.packages' })
  })
})

describe('Return to supplier', () => {
  const warehouse = canFor('warehouse')
  const base = (over: Partial<ReturnDraft> = {}): ReturnDraft => ({ ...NO_RETURN, reasons: ready(REASON_LIST), ...over })
  const leather = (over: Partial<ReturnDraft> = {}) => withHides(withStock(base({ lot: FOUND_LOTS[0]!, ...over }), ready(LEATHER_STOCK)), ready(LOT_HIDES))
  const ddt = { ...NO_DDT, grossWeightKg: '14,5' }

  it('is held with the first missing thing, the rights first', () => {
    expect(returnHeld(base(), canFor('buyer'))).toEqual({ key: 'held.permission', params: { permission: 'purchasing.claims.return' } })
    expect(returnHeld(base(), warehouse)).toEqual({ key: 'ret.held.lot' })
    expect(returnHeld(leather(), warehouse)).toEqual({ key: 'ret.held.reason' })
    expect(returnHeld({ ...leather({ reasonCode: 'QUALITY' }), hideIds: [] }, warehouse)).toEqual({ key: 'ret.held.noHide' })
    expect(returnHeld(leather({ reasonCode: 'OTHER' }), warehouse)).toEqual({ key: 'ret.held.note' })
    expect(returnHeld(leather({ reasonCode: 'QUALITY' }), warehouse)).toEqual({ key: 'ddt.held.weight' })
    expect(returnHeld({ ...leather({ reasonCode: 'QUALITY', mail: true, contacts: ready([]) }), ddt }, warehouse)).toEqual({ key: 'ret.held.contact' })
    expect(returnHeld({ ...leather({ reasonCode: 'QUALITY' }), ddt }, warehouse)).toBeNull()
  })

  it('names a leather lot’s hides, takes a whole lot by quantity as the lot, a part as lines per place', () => {
    const hides = { ...leather({ reasonCode: 'QUALITY', reasonNote: ' fori ' }), ddt }
    expect(returnBody(hides)).toEqual({ reasonCode: 'QUALITY', reasonNote: 'fori', remedy: 'CREDIT', mail: null, ddt: { reason: 'RETURN', transportBy: 'SENDER', packages: 1, grossWeightKg: '14.5' }, from: { lotId: FOUND_LOTS[0]!.id, hideIds: LOT_HIDES.map((hide) => hide.id) } })
    const pads = withStock(base({ lot: FOUND_LOTS[1]!, reasonCode: 'WRONG_ITEM', ddt }), ready(PAD_STOCK))
    expect(pads.quantities).toEqual({ [PAD_STOCK[0]!.location.id]: '24', [PAD_STOCK[1]!.location.id]: '12' })
    expect(returnBody(pads).from).toEqual({ lotId: FOUND_LOTS[1]!.id })
    const part = { ...pads, quantities: { [PAD_STOCK[0]!.location.id]: '10,5', [PAD_STOCK[1]!.location.id]: '' } }
    expect(returnBody(part).lines).toEqual([{ lotId: FOUND_LOTS[1]!.id, quantity: '10.5', uom: 'PCS', fromLocationId: PAD_STOCK[0]!.location.id }])
    expect(returnHeld({ ...pads, quantities: { [PAD_STOCK[0]!.location.id]: '30' } }, warehouse)).toEqual({ key: 'ret.held.tooMuch', params: { place: 'N-PPE-01', onHand: '24' } })
    expect(returnHeld({ ...pads, quantities: {} }, warehouse)).toEqual({ key: 'ret.held.nothing' })
  })

  it('says a refusal in our words, never the API’s', () => {
    const conflict = (message: string, issues: { path: string; message: string }[] = []) => new ApiError('conflict', 409, 'conflict', message, 'req', issues)
    const invalid = (path: string, message = 'x') => new ApiError('invalid', 400, 'invalid_input', 'Bad', 'req', [{ path, message }])
    expect(returnRefusal(conflict('Hide HD-1 is reserved for WO-1: release that reservation first.', [{ path: 'body/lines/0', message: 'reserved' }]))).toEqual({ key: 'ret.refused.reserved' })
    expect(returnRefusal(invalid('body/transportBy'))).toEqual({ key: 'ddt.refused.transport' })
    expect(returnRefusal(invalid('body/ddt/grossWeightKg'))).toEqual({ key: 'ddt.refused.weight' })
    expect(returnRefusal(invalid('body/from/lotId', 'Lot LT-1 has no hide in stock at its site.'))).toEqual({ key: 'ret.refused.nothingLeft' })
    // Found in the live check: the return DDT's numbering refusal has no path; never "changed by someone else".
    expect(returnRefusal(conflict('The last DDT number of series MAIN is dated 2026-11-27; a document dated 2026-10-30 cannot take the next number.', []))).toEqual({ key: 'ret.refused.numbering' })
    expect(returnRefusal(conflict('The company needs its VAT number (partita IVA).', []))).toEqual({ key: 'ret.refused.company' })
    expect(returnRefusal(invalid('body/from/hideIds/0'))).toEqual({ key: 'ret.refused.hideGone' })
    expect(returnRefusal(new ApiError('forbidden', 403, 'forbidden', 'This needs shipping.ddt.issue', 'req'))).toEqual({ key: 'ret.refused.forbidden' })
  })
})

describe('the calls, as the API takes them', () => {
  function fakeApi() {
    const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
    const api: ApiClient = createApiClient({
      baseUrl: 'http://api.test',
      csrfToken: () => 'csrf',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, key: headers.get('idempotency-key') })
        const value = claim('RETURN', 'SENT')
        const body = String(input).includes('/returns')
          ? { claim: value, moveIds: [], ddt: { id: 'd', number: '1/2026', file: null, pdfProblem: null }, claimLinesKeepingOldDdt: [], overReserved: [] }
          : String(input).includes('/purchasing/claims?') || String(input).endsWith('/purchasing/claims')
            ? { items: [], nextCursor: null }
            : { claim: value }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    return { api, calls }
  }

  it('lists with the API’s filters, patches with the version, returns in one call with one key', async () => {
    const { api, calls } = fakeApi()
    await listClaims(api, { status: 'SENT', kind: 'RETURN', goodsReceiptId: 'r1', q: ' x ' })
    await listClaims(api, { open: false, lotId: 'l1' })
    await updateClaim(api, 'c1', { version: 4, internalNote: null }, 'k1')
    await returnToSupplier(api, { reasonCode: 'QUALITY', remedy: 'CREDIT', from: { lotId: 'l1' }, mail: null, ddt: { reason: 'RETURN', transportBy: 'SENDER', packages: 1, grossWeightKg: '7.5' } }, 'k2')
    expect(calls[0]!.url).toBe('http://api.test/purchasing/claims?status=SENT&kind=RETURN&goodsReceiptId=r1&q=x&limit=50')
    expect(calls[1]!.url).toBe('http://api.test/purchasing/claims?open=false&lotId=l1&limit=50')
    expect(calls[2]).toMatchObject({ method: 'PATCH', url: 'http://api.test/purchasing/claims/c1', body: { version: 4, internalNote: null }, key: 'k1' })
    expect(calls[3]).toMatchObject({ method: 'POST', url: 'http://api.test/purchasing/claims/returns', key: 'k2' })
  })

  it('opens a claim on its own page; its list keeps the address terms', () => {
    expect(OFFICE_PAGES.has('/purchasing/claims')).toBe(true)
    expect(OFFICE_PAGES.has('/purchasing/claims/[id]')).toBe(true)
    expect(recordAddress({ type: 'SupplierClaim', id: 'c1' }, OFFICE_PAGES)).toBe('/purchasing/claims/c1')
    expect(LIST_PAGES['/purchasing/claims']).toBe('/purchasing/claims')
    expect(listAddress('/purchasing/claims', { status: 'SENT' }, OFFICE_PAGES)).toBe('/purchasing/claims?status=SENT')
  })
})

const LEFT_KEY = /\b(?:status|statusIn|kind|kindPlural|act|held|problem|common|live|page|tiles|tile|view|list|col|bulk|csv|chip|ret|ddt|field|form|save|claimTab|fact|lines|goods|goodsBack|credit|send|answer|close|cancel|notice|record|remedy|foundAt|uom|lotQuality|moveReason|discrepancyKind|discrepancyStatus|contactRole|language|tab)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs purchasing.claims.manage"); example domains are not keys. */
const SAID = /\b(?:purchasing\.[a-z.]+|shipping\.ddt\.[a-z]+|inventory\.stock\.view|parties\.view|files\.read|money\.cost|[a-z-]+\.example\.com|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'purchasing-claims']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('draws the dialogs too (the DS Modal in place): Return to supplier, Send, the goods back', () => {
    const html = (id: string, locale: 'it' | 'en') => render(screen, screen.cases.find((item) => item.id === id)!.model, locale)
    expect(html('return-ready', 'en')).toContain('Create return')
    expect(html('return-ready', 'it')).toContain('Crea il reso')
    expect(html('return-hides', 'en')).toContain('HD-DEMO-0042-2')
    expect(html('dialog-send', 'it')).toContain('Invia al fornitore')
    expect(html('dialog-goods-back', 'en')).toContain('Send 3 lines back')
    expect(html('return-refused', 'en')).toContain('release that reservation first')
  })

  it('has words for every state, kind, view, tile, remedy and found-at in both languages', () => {
    for (const locale of LOCALES) {
      const words = t(locale)
      const has = (key: string, count?: number) => expect(words(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const status of CLAIM_STATUSES) {
        has(`status.${status}`)
        has(`statusIn.${status}`)
      }
      for (const kind of CLAIM_KINDS) {
        has(`kind.${kind}`)
        has(`kindPlural.${kind}`)
      }
      for (const remedy of CLAIM_REMEDIES) has(`remedy.${remedy}`)
      for (const at of CLAIM_FOUND_AT) has(`foundAt.${at}`)
      for (const view of CLAIM_VIEWS) has(`view.${view}`)
      for (const tile of TILES) has(`tile.${tile.id}`)
      for (const act of ['send', 'sendAgain', 'answer', 'returnGoods', 'close', 'cancel']) has(`act.${act}`)
    }
  })
})
