import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LINE_STATES, TRANSFER_DDT_REASONS, TRANSFER_REFUSALS, TRANSFER_RESOLUTIONS, TRANSFER_STATUSES, TRANSFER_TILES, TRANSFER_TRANSPORT } from '@nexus/factory-domain/inventory/transfers/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { DRAFT, DRAFT_READY, RECEIVED, ROLE_PERMISSIONS, SHIPPED, SITES, STOCK, TODAY } from './demo/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import {
  addressOf,
  addressText,
  emptyNewDraft,
  emptyShipDraft,
  fieldOfPath,
  HOME_ADDRESS,
  KNOWN_REFUSALS,
  lifecycleOf,
  lineOfTag,
  newBodyOf,
  newDraftHeld,
  receiveBodyOf,
  receiveDraftOf,
  receiveHeld,
  settleHeld,
  shipBodyOf,
  shipHeld,
  transfersCan,
  writeProblem,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { pickedBodies, pickerHeld, stockKeyOf } from './record/view/PickerDialog'

const owner = transfersCan(ROLE_PERMISSIONS.owner)

describe('who may do what, by the role templates', () => {
  it('the warehouse reads and changes transfers; a buyer reads; sales has no page', () => {
    expect(transfersCan(ROLE_PERMISSIONS.warehouse)).toEqual({ view: true, manage: true })
    expect(transfersCan(ROLE_PERMISSIONS.buyer)).toEqual({ view: true, manage: false })
    expect(transfersCan(ROLE_PERMISSIONS.sales).view).toBe(false)
  })
})

describe('the address', () => {
  it('reads and writes every term; nonsense is dropped', () => {
    const id = SITES[0]!.id
    const address = addressOf(new URLSearchParams(`tile=IN_TRANSIT&status=SHIPPED&from=${id}&to=${SITES[2]!.id}&q=lining&new=1`))
    expect(address).toEqual({ tile: 'IN_TRANSIT', status: 'SHIPPED', from: id, to: SITES[2]!.id, q: 'lining', isNew: true })
    expect(addressOf(new URLSearchParams(addressText(address)))).toEqual(address)
    expect(addressOf(new URLSearchParams('tile=NOPE&status=x&from=not-an-id'))).toEqual(HOME_ADDRESS)
    expect(addressText(HOME_ADDRESS)).toBe('')
  })
})

describe('the steps held with their reason, and the bodies the API takes', () => {
  it('New transfer: a site to send from, another to go to, the route’s transit place when several', () => {
    expect(newDraftHeld(emptyNewDraft(), SITES, owner, false)).toEqual({ key: 'held.pickFrom' })
    expect(newDraftHeld(emptyNewDraft(SITES[0]!.id), SITES, owner, false)).toEqual({ key: 'held.pickTo' })
    const draft = { ...emptyNewDraft(SITES[0]!.id), toSiteId: SITES[2]!.id }
    expect(newDraftHeld(draft, SITES, owner, false)).toEqual({ key: 'held.pickTransit' })
    expect(newDraftHeld({ ...emptyNewDraft(SITES[1]!.id), toSiteId: SITES[2]!.id }, SITES, owner, false)).toEqual({ key: 'refusal.NO_TRANSIT_PLACE' })
    expect(newDraftHeld({ ...draft, transitLocationId: SITES[0]!.transitPlaces[0]!.id }, SITES, transfersCan(ROLE_PERMISSIONS.buyer), false)).toEqual({ key: 'held.noManage' })
    const ready = { ...draft, transitLocationId: SITES[0]!.transitPlaces[0]!.id, shipOn: '2026-11-13', note: ' For B1 ' }
    expect(newDraftHeld(ready, SITES, owner, false)).toBeNull()
    expect(newBodyOf(ready)).toEqual({ fromSiteId: SITES[0]!.id, toSiteId: SITES[2]!.id, transitLocationId: SITES[0]!.transitPlaces[0]!.id, shipOn: '2026-11-13', note: 'For B1' })
  })

  it('Ship: held as the API holds it, a carrier named, the weight typed in either language', () => {
    expect(shipHeld(emptyShipDraft(DRAFT), DRAFT, TODAY, false)).toEqual({ key: 'refusal.NOT_ENOUGH_STOCK' })
    const draft = { ...emptyShipDraft(DRAFT_READY), grossWeightKg: '48,5' }
    expect(shipHeld(draft, DRAFT_READY, TODAY, false)).toBeNull()
    expect(shipHeld({ ...draft, transportBy: 'CARRIER' }, DRAFT_READY, TODAY, false)).toEqual({ key: 'held.carrierName' })
    expect(shipHeld({ ...draft, grossWeightKg: '' }, DRAFT_READY, TODAY, false)).toEqual({ key: 'held.weight' })
    expect(shipHeld(draft, DRAFT_READY, TODAY, true)).toEqual({ key: 'held.offline' })
    expect(shipBodyOf({ ...draft, transportBy: 'CARRIER', carrierName: ' Demo Corriere ' }, 5)).toMatchObject({ version: 5, transportBy: 'CARRIER', carrierName: 'Demo Corriere', packages: 1, grossWeightKg: '48.5', reason: 'TRANSFER', language: 'it' })
  })

  it('Receive: all of it by default, a hide whole and ticked by its scan, a short line with or without its reason', () => {
    const draft = receiveDraftOf(SHIPPED)
    expect(Object.keys(draft)).toHaveLength(3)
    const hideLine = SHIPPED.lines[1]!
    expect(draft[hideLine.id]!.quantity).toBe('0')
    expect(lineOfTag(SHIPPED, 'hd-demo-0101')?.id).toBe(hideLine.id)
    expect(lineOfTag(SHIPPED, 'NOPE')).toBeNull()
    expect(receiveHeld(draft, SHIPPED, false)).toBeNull()
    const lining = SHIPPED.lines[0]!
    const short = { ...draft, [lining.id]: { ...draft[lining.id]!, quantity: '28', reason: 'SHORT', note: 'Two metres missing' } }
    expect(receiveBodyOf(short, SHIPPED).lines).toEqual([
      { lineId: lining.id, quantity: '28', differenceReasonCode: 'SHORT', differenceNote: 'Two metres missing' },
      { lineId: SHIPPED.lines[2]!.id, quantity: '18' },
    ])
    expect(receiveHeld({ ...draft, [lining.id]: { ...draft[lining.id]!, quantity: '31' } }, SHIPPED, false)).toEqual({ key: 'held.moreThanInTransit', params: { seq: 10 } })
    expect(receiveHeld({ ...draft, [hideLine.id]: { ...draft[hideLine.id]!, quantity: '20' } }, SHIPPED, false)).toEqual({ key: 'refusal.HIDE_WHOLE' })
  })

  it('Settle: a short line, how it is settled, sent back only when nothing of it arrived', () => {
    const line = RECEIVED.lines[0]!
    expect(settleHeld({ lineId: line.id, resolution: null, note: '' }, line, RECEIVED, false)).toEqual({ key: 'held.resolution' })
    expect(settleHeld({ lineId: line.id, resolution: 'SENT_BACK', note: '' }, line, RECEIVED, false)).toEqual({ key: 'refusal.SENT_BACK_PART' })
    expect(settleHeld({ lineId: line.id, resolution: 'ADJUSTMENT', note: '' }, line, RECEIVED, false)).toBeNull()
  })

  it('the stock picker: picked rows become line bodies (a hide whole); more than available is held', () => {
    const lining = stockKeyOf(STOCK.rows[0]!)
    const hide = stockKeyOf(STOCK.rows[2]!)
    const picker = { q: '', locationId: null, stock: STOCK, problem: null, picked: { [lining]: '10,5', [hide]: '49.8' }, busy: false, notice: null }
    expect(pickerHeld(picker)).toBeNull()
    expect(pickedBodies(picker)).toEqual([
      { itemId: STOCK.rows[0]!.item.id, itemColourId: STOCK.rows[0]!.colour!.id, lotId: STOCK.rows[0]!.lot!.id, hideId: null, fromLocationId: STOCK.rows[0]!.location.id, quantity: '10.5' },
      { itemId: STOCK.rows[2]!.item.id, itemColourId: STOCK.rows[2]!.colour!.id, lotId: STOCK.rows[2]!.lot!.id, hideId: STOCK.rows[2]!.hide!.id, fromLocationId: STOCK.rows[2]!.location.id },
    ])
    expect(pickerHeld({ ...picker, picked: { [lining]: '13' } })).toEqual({ key: 'refusal.NOT_ENOUGH_STOCK' })
    expect(pickerHeld({ ...picker, picked: {} })).toEqual({ key: 'picker.pickFirst' })
  })

  it('the lifecycle words: in transit, received with a difference, closed once settled', () => {
    expect(lifecycleOf('SHIPPED', 0)).toBe('IN_TRANSIT')
    expect(lifecycleOf('RECEIVED', 1)).toBe('RECEIVED')
    expect(lifecycleOf('RECEIVED', 0)).toBe('CLOSED')
  })

  it('a refusal is said by its code; a stale version reads again; a 400 names its field', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/NO_DDT_SERIES', message: 'x' }])
    expect(writeProblem(refused)).toMatchObject({ key: 'refusal.NO_DDT_SERIES', stale: false })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, []))).toMatchObject({ key: 'problem.stale', stale: true })
    expect(writeProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/lines/0/quantity', message: 'x' }]))).toMatchObject({ key: 'problem.invalid', paths: ['lines/0/quantity'] })
    expect(fieldOfPath('lines/0/quantity')).toBe('field.quantity')
    expect(fieldOfPath('carrierName')).toBe('field.carrierName')
  })
})

describe('words and navigation', () => {
  it('every code, status, tile, state, reason, way of transport and resolution has words in both languages', () => {
    expect(new Set(KNOWN_REFUSALS)).toEqual(new Set(TRANSFER_REFUSALS))
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['warehouse-transfers']!
      for (const code of TRANSFER_REFUSALS) expect(words[`refusal.${code}`], `${locale} refusal.${code}`).toBeTruthy()
      for (const status of TRANSFER_STATUSES) expect(words[`status.${status}`], `${locale} status.${status}`).toBeTruthy()
      for (const tile of TRANSFER_TILES) expect(words[`tile.${tile}`], `${locale} tile.${tile}`).toBeTruthy()
      for (const state of LINE_STATES) expect(words[`state.${state}`], `${locale} state.${state}`).toBeTruthy()
      for (const reason of TRANSFER_DDT_REASONS) expect(words[`reason.${reason}`], `${locale} reason.${reason}`).toBeTruthy()
      for (const by of TRANSFER_TRANSPORT) expect(words[`transport.${by}`], `${locale} transport.${by}`).toBeTruthy()
      for (const resolution of TRANSFER_RESOLUTIONS) expect(words[`resolution.${resolution}`], `${locale} resolution.${resolution}`).toBeTruthy()
    }
  })

  it('the page is built, in the navigation of the roles that read the stock, and a TransferOrder opens its record', () => {
    expect(OFFICE_PAGES.has('/warehouse/transfers')).toBe(true)
    expect(recordAddress({ type: 'TransferOrder', id: 't1' }, OFFICE_PAGES)).toBe('/warehouse/transfers/t1')
    const rows = (permissions: readonly string[]) => officeNavFor(permissionCheck([...permissions])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
    expect(rows(ROLE_PERMISSIONS.warehouse)).toContain('/warehouse/transfers')
    expect(rows(ROLE_PERMISSIONS.buyer)).toContain('/warehouse/transfers')
    expect(rows(ROLE_PERMISSIONS.sales)).not.toContain('/warehouse/transfers')
  })
})

const LEFT_KEY = /\b(?:common|held|list|record|tile|new|tab|live|row|col|keys|lines|picker|transit|ship|receive|received|settle|cancel|refusal|problem|field|status|lifecycle|state|reason|transport|resolution|noAccess)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/\binventory\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
