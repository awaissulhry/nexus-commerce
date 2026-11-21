import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { SiteOption } from '../../../../_shared/buying/api'
import { MATERIALS } from '../../depth/demo/fixtures'
import { order } from '../../_demo/fixtures'
import { askKeyOf, askOf, customerGoodsOf, type BoughtMaterial } from './materials'
import { quantityOk, receiptBodyOf, receiptDraftOf, receiptHeldOf, receiptRefusalOf, receivePlacesOf } from './receipt'

// F-PT-304 (order PRODUCTION tab, W4): Record what the customer sent… and Ask the buyers… — the dialog's model and the ask rule.

const so = order('IN_PRODUCTION')
const goods = customerGoodsOf(MATERIALS)!
const place = (id: string, kind: string, status = 'ACTIVE') => ({ id, code: id.toUpperCase(), name: id, kind, status })
const SITE: SiteOption = { id: 's1', companyId: so.companyId, code: 'S1', name: 'Plant one', locations: [place('bin-1', 'BIN'), place('dock', 'RECEIVING'), place('ship', 'SHIPPING'), place('old', 'RECEIVING', 'ARCHIVED'), place('fg', 'FINISHED_GOODS')] }

describe('F-PT-304: the receipt draft', () => {
  it('pre-filled with what is still to come; one site picked with its goods-in dock first; outside, finished or archived places never', () => {
    const draft = receiptDraftOf(goods, null, [SITE])
    expect(draft.lines.map((line) => [line.label, line.quantity, line.take])).toEqual([['Zip in metallo del cliente · RED · Rosso', '4', true]])
    expect(draft).toMatchObject({ siteId: 's1', locationId: 'dock', ddtNumber: '', ddtDate: '' })
    expect(receivePlacesOf(SITE).map((entry) => entry.id)).toEqual(['dock', 'bin-1'])
    expect(receiptDraftOf(goods, null, [SITE, { ...SITE, id: 's2' }]).siteId).toBeNull()
  })

  it('from one material’s row: that one; nothing still to come (recorded in full): every material, empty, for an extra delivery', () => {
    expect(receiptDraftOf(goods, goods[0]!.id, null).lines.map((line) => [line.key, line.quantity, line.take])).toEqual([[goods[0]!.id, '', true]])
    const full = goods.map((good) => ({ ...good, toCome: 0 }))
    expect(receiptDraftOf(full, null, null).lines.map((line) => [line.quantity, line.take])).toEqual([['', false], ['', false]])
  })

  it('held in words until it can be sent; leather by the hide is left out BEFORE sending (said in the dialog)', () => {
    const draft = receiptDraftOf(goods, null, [SITE])
    const none = new Map<string, string>()
    expect(receiptHeldOf(draft, none, false)).toBeNull()
    expect(receiptHeldOf({ ...draft, siteId: null }, none, false)).toEqual({ key: 'productionTab.receipt.held.site' })
    expect(receiptHeldOf({ ...draft, locationId: null }, none, false)).toEqual({ key: 'productionTab.receipt.held.place' })
    expect(receiptHeldOf({ ...draft, lines: draft.lines.map((line) => ({ ...line, quantity: '0' })) }, none, false)).toEqual({ key: 'productionTab.receipt.held.quantity' })
    expect(receiptHeldOf(draft, none, true)).toEqual({ key: 'held.busy' })
    const hide = new Map([[draft.lines[0]!.itemId, 'HIDE']])
    expect(receiptHeldOf(draft, hide, false)).toEqual({ key: 'productionTab.receipt.held.nothing' })
    expect(receiptBodyOf(so, draft, hide)?.lines).toEqual([])
    for (const [value, ok] of [['12', true], ['12,5', true], ['0.25', true], ['0', false], ['1.23456', false], ['-3', false], ['', false]] as const) expect(quantityOk(value), value).toBe(ok)
  })

  it('the body is the existing command’s: site, customer, this order, the place, their DDT, each line its lot ref', () => {
    const draft = { ...receiptDraftOf(goods, null, [SITE]), ddtNumber: ' DDT 118 ', ddtDate: '2026-11-20' }
    const body = receiptBodyOf(so, { ...draft, lines: draft.lines.map((line) => ({ ...line, quantity: '4,5', lot: 'L-118' })) }, new Map())
    expect(body).toEqual({ siteId: 's1', partyId: so.partyId, orderId: so.id, locationId: 'dock', supplierDdtNumber: 'DDT 118', supplierDdtDate: '2026-11-20', lines: [{ itemId: goods[1]!.itemId, itemColourId: goods[1]!.itemColourId, quantity: '4.5', supplierLotRef: 'L-118' }] })
    expect(receiptBodyOf(so, { ...draft, siteId: null }, new Map())).toBeNull()
  })

  it('a refusal in this app’s words, the line named (never the API’s English)', () => {
    const sent = [{ label: 'Pelle del cliente' }]
    const refusal = (path: string, message = 'x', kind: 'invalid' | 'forbidden' = 'invalid') => new ApiError(kind, kind === 'invalid' ? 400 : 403, kind, 'x', null, [{ path, message }])
    expect(receiptRefusalOf(refusal('body/lines/0/itemId', 'PEL-01 is tracked hide by hide: …'), sent)).toEqual({ key: 'productionTab.receipt.refused.hide', params: { material: 'Pelle del cliente' } })
    expect(receiptRefusalOf(refusal('body/lines/0/itemId', 'not tracked by lot'), sent)).toEqual({ key: 'productionTab.receipt.refused.lot', params: { material: 'Pelle del cliente' } })
    expect(receiptRefusalOf(refusal('body/lines/0/quantity'), sent)).toEqual({ key: 'productionTab.receipt.refused.quantity', params: { material: 'Pelle del cliente' } })
    expect(receiptRefusalOf(refusal('body/lines/0/toLocationId'), sent)).toEqual({ key: 'productionTab.receipt.refused.place' })
    expect(receiptRefusalOf(refusal('siteId', 'x', 'forbidden'), sent)).toEqual({ key: 'productionTab.receipt.refused.right' })
  })
})

describe('F-PT-304: Ask the buyers…', () => {
  const material: Pick<BoughtMaterial, 'itemId' | 'itemColourId' | 'label' | 'uom' | 'shortages'> = { itemId: 'i1', itemColourId: null, label: 'Zip 60 cm · Navy', uom: 'pcs', shortages: [{ workOrderId: 'w1', number: 'WO-00412', word: 'DELAYED', short: '80', neededOn: '2026-11-24' }] }
  const sites = [{ id: 'w1', siteId: 's1' }]

  it('the first work order short of it, on its site, as the Material plan’s from-shortage dialog asks; once asked, the day', () => {
    expect(askOf(material, sites, new Map(), '2026-11-21')).toEqual({ kind: 'ask', line: { siteId: 's1', workOrder: { id: 'w1', number: 'WO-00412' }, material: { itemId: 'i1', itemColourId: null, label: 'Zip 60 cm · Navy', uom: 'pcs' }, word: 'DELAYED', short: '80', neededBy: '2026-11-24' } })
    expect(askOf(material, sites, new Map([[askKeyOf('w1', 'i1', null), '2026-11-20T10:00:00Z']]), '2026-11-21')).toEqual({ kind: 'asked', at: '2026-11-20T10:00:00Z' })
    expect(askOf({ ...material, shortages: [] }, sites, new Map(), '2026-11-21')).toBeNull()
    expect(askKeyOf('w1', 'i1', null)).toBe('w1|i1|-')
  })

  it('the wiring: the Material plan’s own hook (never a copy); hidden without its rights; the receipt only with inventory.receive', () => {
    const hook = readFileSync(new URL('./use-ask-buyers.ts', import.meta.url), 'utf8')
    expect(hook).toContain("import { useAskToBuy } from '../../../../purchasing/requests/ask/AskToBuy'")
    expect(hook).toContain("ask.can.ask && permissions.includes('planning.view')")
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("const mayReceive = session.permissions.includes('inventory.receive')")
    expect(container).toContain('receipt: mayReceive ? { dialog: receipt.model } : null')
    const view = readFileSync(new URL('../view/production/MaterialsSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain('actions?.receipt?.onOpen(only)')
    expect(view).toContain('actions?.onAskBuyers?.(ask.line)')
    expect(view).not.toMatch(/from '[^']*use-customer-receipt'|from '[^']*use-ask-buyers'/)
  })

  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['open', 'openRow', 'go', 'sites', 'site', 'sitePick', 'place', 'placePick', 'noPlace', 'ddt', 'ddtDate', 'col.quantity', 'col.lot', 'hide', 'hint', 'held.site', 'held.place', 'held.nothing', 'held.quantity', 'refused.place', 'refused.right']) expect(t(`productionTab.receipt.${key}`), `${locale} ${key}`).not.toBe(`productionTab.receipt.${key}`)
      expect(t('productionTab.receipt.title', { number: 'SO-1' }), locale).toContain('SO-1')
      expect(t('productionTab.receipt.done', { number: 'GR-9' }), locale).toContain('GR-9')
      expect(t('productionTab.materials.asked', { date: '20/11/2026' }), locale).toContain('20/11/2026')
      expect(t('productionTab.materials.askBuyers'), locale).not.toBe('productionTab.materials.askBuyers')
    }
  })
})
