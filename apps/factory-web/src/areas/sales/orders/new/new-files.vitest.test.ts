import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import { scanText } from '../../../../lib/testing/brand-scan'
import { leftKeys, render, textOf } from '../../../../lib/record-thread/parts/testing'
import { attachOutcome, attaching, heldCount, heldKindOf, holdFiles, MAX_HELD, takesSheetTick, toAttach, type HeldFile } from './new-files'
import { CustomerFiles, FilesOutcome, type CustomerFilesModel } from './view/CustomerFiles'
// ---- F-CP-146: the New order of a person without the price grain ----
import { readFileSync } from 'node:fs'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { BLK, canOf, COMPANY, PARTY, STYLE_ID } from '../_demo/fixtures'
import { newKey, type DraftLine } from '../daily-model'
import { COMPOSER_EMPTY } from '../record/record-model'
import { manualBody, type NewOrderModel } from './new-model'
import { confirmHeld, typedSomething } from './new-model' // F-CP-113
import { NewOrderView } from './view/NewOrderView'
// ---- end F-CP-146

/**
 * B-TH-231 — Sales › Orders › New order's fold "Customer files" (O-SAL-ORD-NEW.form-F08; ORD-G05): files held in the page
 * ("Added when you confirm"), each checked as the API will (a picture a photo, a ZIP a document, SVG never with the way out),
 * a PDF or a photo ticked "This is a measurement sheet", uploaded to the new order right after Confirm (office only); when some
 * do not attach the order stays made: "Order SO-… made; 2 files did not attach · Retry". Every case in it and en.
 */

const MB = 1_048_576
const key = (index: number) => `k${index}`
const drop = (files: Array<{ name: string; type?: string; size: number }>, held: HeldFile[] = []) => holdFiles(held, files, key)

describe('held files', () => {
  it('each file is checked as the API will: kind by type, SVG and scripts refused with the way out, sizes', () => {
    const { held } = drop([
      { name: 'front.jpg', type: 'image/jpeg', size: 2 * MB },
      { name: 'Rider sheet.pdf', type: 'application/pdf', size: 300_000 },
      { name: 'Logo.ai', size: 4 * MB },
      { name: 'Artwork pack.zip', type: 'application/zip', size: 9 * MB },
      { name: 'logo.svg', type: 'image/svg+xml', size: 10_000 },
      { name: 'huge.jpg', type: 'image/jpeg', size: 16 * MB },
      { name: 'empty.pdf', type: 'application/pdf', size: 0 },
    ])
    expect(held.map((file) => [file.name, file.kind, file.problem?.key ?? null])).toEqual([
      ['front.jpg', 'PHOTO', null],
      ['Rider sheet.pdf', 'ATTACHMENT', null],
      ['Logo.ai', 'ATTACHMENT', null],
      ['Artwork pack.zip', 'DOCUMENT', null],
      ['logo.svg', 'ATTACHMENT', 'problem.page'],
      ['huge.jpg', 'PHOTO', 'problem.size'],
      ['empty.pdf', 'ATTACHMENT', 'problem.empty'],
    ])
    expect(heldKindOf('image/heic')).toBe('PHOTO')
    expect(heldCount(held)).toBe(4)
    expect(toAttach(held).map((file) => file.name)).toEqual(['front.jpg', 'Rider sheet.pdf', 'Logo.ai', 'Artwork pack.zip'])
  })

  it('the sheet tick: a PDF or a photo of one, never a design file or a refused file', () => {
    const { held } = drop([
      { name: 'Rider sheet.pdf', type: 'application/pdf', size: 10 },
      { name: 'sheet-photo.jpg', type: 'image/jpeg', size: 10 },
      { name: 'Logo.psd', type: 'image/vnd.adobe.photoshop', size: 10 },
      { name: 'logo.svg', type: 'image/svg+xml', size: 10 },
    ])
    expect(held.map(takesSheetTick)).toEqual([true, true, false, false])
  })

  it('the same file once; at most 20, the rest left out and counted', () => {
    const first = drop([{ name: 'a.pdf', type: 'application/pdf', size: 10 }])
    expect(drop([{ name: 'a.pdf', type: 'application/pdf', size: 10 }], first.held).held).toHaveLength(1)
    const many = drop(Array.from({ length: MAX_HELD + 3 }, (_, index) => ({ name: `p${index}.jpg`, type: 'image/jpeg', size: 10 })))
    expect(many.held).toHaveLength(MAX_HELD)
    expect(many.leftOut).toBe(3)
  })

  it('after Confirm: what attached, what did not, Retry sends only those', () => {
    const { held } = drop([
      { name: 'a.pdf', type: 'application/pdf', size: 10 },
      { name: 'b.jpg', type: 'image/jpeg', size: 10 },
      { name: 'c.jpg', type: 'image/jpeg', size: 10 },
    ])
    const after = held.map((file, index): HeldFile => ({ ...file, state: index === 0 ? 'attached' : 'failed' }))
    expect(attachOutcome(after)).toEqual({ attached: 1, failed: 2, refused: 0 })
    expect(toAttach(after).map((file) => file.name)).toEqual(['b.jpg', 'c.jpg'])
    expect(attaching(after)).toBe(false)
    expect(attaching([{ ...after[1]!, state: 'attaching' }])).toBe(true)
  })
})

describe('the fold and the outcome, in it and en', () => {
  const held = drop([
    { name: `${BRAND_ALPHA.tradeName} rider sheet.pdf`, type: 'application/pdf', size: 300_000 },
    { name: 'front.jpg', type: 'image/jpeg', size: 2 * MB },
    { name: 'logo.svg', type: 'image/svg+xml', size: 10 },
  ]).held
  const model: CustomerFilesModel = { held, canUpload: true, leftOut: 0, made: null, busy: false }
  const KEYS = ['fold', 'file', 'problem', 'outcome']

  it('before Confirm: “Added when you confirm”, each file with its size, the sheet tick, a refused file with its reason', () => {
    const text = textOf(render(createElement(CustomerFiles, { model })))
    expect(text).toContain('Customer files · 2 files')
    expect(text).toContain('Added to the order when you confirm, for the office only')
    expect(text).toContain('This is a measurement sheet')
    expect(text).toContain('an SVG, HTML or script file is never accepted: send a PDF or PNG')
    for (const locale of ['en', 'it'] as const) {
      const html = render(createElement(CustomerFiles, { model }), locale)
      expect(leftKeys(html, KEYS)).toEqual([])
      expect(scanText(html, BRAND_BETA)).toEqual([])
    }
  })

  it('without files.upload the order is made without them, said', () => {
    expect(textOf(render(createElement(CustomerFiles, { model: { ...model, held: [], canUpload: false } })))).toContain('Adding files needs the right to upload files')
  })

  it('the order made, two files did not attach: Retry and Open the order', () => {
    const after = model.held.map((file, index): HeldFile => (file.problem ? file : { ...file, state: index === 0 ? 'failed' : 'failed' }))
    const made: CustomerFilesModel = { ...model, held: after, made: { number: 'SO-2026-0042', href: '/w/demo/sales/orders/o1' } }
    const text = textOf(render(createElement(FilesOutcome, { model: made })))
    expect(text).toContain('Order SO-2026-0042 made; 2 files did not attach')
    expect(text).toContain('Retry')
    expect(text).toContain('Open the order')
    for (const locale of ['en', 'it'] as const) expect(leftKeys(render(createElement(FilesOutcome, { model: made }), locale), KEYS)).toEqual([])
    expect(render(createElement(FilesOutcome, { model }))).toBe('')
  })
})

// ---- F-CP-146 (customer page lane, money wall D1-c, review A8): the New order of a person without the price grain -----------------
// As Sales worker (the Sales role after B-CP-011: no money.price) and as Production manager: "Confirm order" and its preview send NO
// price key (a price typed earlier in this tab by someone else is never sent: the API's grain wall refuses it), the page and the New
// order window say "Priced from <customer>'s price list". The Owner's body is unchanged.
describe('F-CP-146: the New order sends no price key without the price grain', () => {
  const SALES_AFTER = { ...canOf('sales'), price: false }
  const header = { companyId: COMPANY, partyId: PARTY.id, contactId: '', customerRef: '' }
  const lines: DraftLine[] = [
    { key: newKey(STYLE_ID, BLK.id), lineId: null, styleId: STYLE_ID, colourwayId: BLK.id, sizes: { '48': 2, '50': 1 }, price: '430', locked: false },
    { key: newKey(STYLE_ID, 'c2'), lineId: null, styleId: STYLE_ID, colourwayId: 'c2', sizes: { '50': 3 }, price: '', locked: false },
  ]
  const draft = { lines, requestedDate: '', promiseDate: '', internalNote: '' }
  const priceKeys = (body: unknown): string[] => JSON.stringify(body).match(/"unitPrice"/g) ?? []

  it('as Sales worker / as Production manager: no line carries a price key; the Owner\'s body keeps the typed price', () => {
    for (const can of [SALES_AFTER, canOf('manager')]) {
      const body = manualBody(header, draft, can)
      expect(priceKeys(body)).toEqual([])
      expect(body.lines.map((line) => line.sizes.length)).toEqual([2, 1])
    }
    expect(manualBody(header, draft, canOf('owner')).lines[0]).toMatchObject({ unitPrice: '430' })
    expect(manualBody(header, draft, canOf('owner'))).toEqual(manualBody(header, draft))
  })

  it('the page sends the person\'s grain with the preview and with Confirm order', () => {
    // F-CP-113: the page's container is the ONE editor now (NewOrderEditor).
    const page = readFileSync(new URL('./NewOrderEditor.tsx', import.meta.url), 'utf8')
    expect(page.match(/manualBody\(header, draft, can\b/g)?.length).toBe(2)
    const window = readFileSync(new URL('../list/view/NewOrderDialog.tsx', import.meta.url), 'utf8')
    expect(window).toContain("model.price === false && <p className=\"fw-so-hint\">{t('priced.fromList'")
    const sheet = readFileSync(new URL('../list/use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet.match(/emptyNew\([^\n]*can\.price/g)?.length).toBe(2)
  })

  it('the page says "Priced from <customer>\'s price list" to a person without prices, never to the Owner', () => {
    const model = (can: NewOrderModel['can']): NewOrderModel => ({
      prefix: '/w/DEMO',
      can,
      today: '2026-10-29',
      header,
      party: { status: 'ready', value: PARTY },
      number: 'SO-2026-0089',
      draft,
      styles: {},
      composer: COMPOSER_EMPTY,
      preview: { phase: 'idle', value: null, problem: null },
      busy: false,
      problem: null,
    })
    for (const locale of ['en', 'it'] as const) {
      const html = render(createElement(NewOrderView, { model: model(SALES_AFTER) }), locale)
      expect(textOf(html)).toContain(locale === 'en' ? `Priced from ${PARTY.legalName}'s price list` : `Prezzi dal listino di ${PARTY.legalName}`)
      expect(leftKeys(html, ['priced', 'pricedPdf'])).toEqual([])
    }
    expect(textOf(render(createElement(NewOrderView, { model: model(canOf('owner')) })))).not.toContain('Priced from')
  })

  it('the confirmation PDF is sent by someone who sees prices (its Send held with the words); the words in both languages', () => {
    const card = readFileSync(new URL('../confirmation/view/ConfirmationCard.tsx', import.meta.url), 'utf8')
    expect(card).toContain("const pricedHeld = model.can.price ? null : o('pricedPdf.held')")
    expect(card).toContain('heldReason={pricedHeld ?? (held ? d(held.key) : busy)}')
    for (const locale of ['en', 'it'] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('pricedPdf.held'), locale).not.toBe('pricedPdf.held')
      expect(t('priced.fromList', { customer: 'Brand Alpha' }), locale).toContain('Brand Alpha')
    }
  })
})
// ---- end F-CP-146

// ---- F-CP-113 (customer page plan C2a; review A2, lead pick "one editor, a large centred window"): ONE lines editor, two doors ------
// The New order page's container moved out of its page shell into NewOrderEditor (never copied): /sales/orders/new mounts it as a
// page (the header from the address), the customer page as a large centred window (the header from the New order window, no
// address of its own). Discard asks first when something is typed; Confirm is held without orders.manage, as on the page.
describe('F-CP-113: one New order editor, mounted by the page and by the customer page\'s window', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('both doors mount the same NewOrderEditor; the order is made in one place only (no copy)', () => {
    const page = read('./NewOrderPage.tsx')
    expect(page).toContain('<NewOrderEditor')
    expect(page).toContain('frame="page"')
    expect(page).not.toContain('createManualOrder')
    const work = read('../../customers/record/view/WorkTab.tsx')
    expect(work).toContain('<NewOrderEditor')
    expect(work).toContain('frame="window"')
    const editor = read('./NewOrderEditor.tsx')
    expect(editor.match(/createManualOrder\(/g)?.length).toBe(1)
    expect(editor).toContain("const View = frame === 'window' ? NewOrderWindow : NewOrderView")
  })

  it('the editor writes no address and moves no page: its door decides (the page: its list or the order; the window: closes)', () => {
    const editor = read('./NewOrderEditor.tsx')
    expect(editor).not.toMatch(/useRouter|useSearchParams|usePathname|router\.|writeSearch/)
    const page = read('./NewOrderPage.tsx')
    expect(page).toContain('onDiscarded={() => router.push(`${prefix}/sales/orders`)}')
    expect(page).toContain('onMade={(order) => router.push(order.href)}')
  })

  it('Discard asks first when something is typed (lines, a date, the note), at once when nothing is', () => {
    const empty = { lines: [], requestedDate: '', promiseDate: '', internalNote: '' }
    expect(typedSomething(empty)).toBe(false)
    expect(typedSomething({ ...empty, internalNote: '  ' })).toBe(false)
    expect(typedSomething({ ...empty, promiseDate: '2026-12-08' })).toBe(true)
    expect(typedSomething({ ...empty, internalNote: 'Etichetta' })).toBe(true)
    expect(typedSomething({ ...empty, lines: [{ key: 'k', lineId: null, styleId: 's', colourwayId: 'c', sizes: {}, price: '', locked: false }] })).toBe(true)
    const editor = read('./NewOrderEditor.tsx')
    expect(editor).toContain('onDiscard: () => (typedSomething(draft) ? setDiscardAsk(true) : discard())')
    const view = read('./view/NewOrderView.tsx')
    expect(view).toContain("title={t('newOrder.discardAsk.title')}")
    expect(view).toContain('onClick={() => actions?.onDiscardConfirm?.()}')
  })

  it('Confirm is held without orders.manage in the window as on the page (the same rule)', () => {
    const ready = { phase: 'ready' as const, value: null, problem: null }
    expect(confirmHeld({ can: { ...canOf('sales'), manage: false }, draft: { lines: [], requestedDate: '', promiseDate: '', internalNote: '' }, preview: ready, today: '2026-10-29', busy: false })?.key).toBe('held.noManage')
  })

  it('the page frame still draws its band and the same body (the window draws the body in a DetailModal)', () => {
    const model: NewOrderModel = { prefix: '/w/DEMO', can: canOf('owner'), today: '2026-10-29', header: { companyId: COMPANY, partyId: PARTY.id, contactId: '', customerRef: 'PO-1' }, party: { status: 'ready', value: PARTY }, number: 'SO-2026-0089', draft: { lines: [], requestedDate: '', promiseDate: '', internalNote: '' }, styles: {}, composer: COMPOSER_EMPTY, preview: { phase: 'idle', value: null, problem: null }, busy: false, problem: null }
    const text = textOf(render(createElement(NewOrderView, { model })))
    expect(text).toContain('Confirm order')
    expect(text).toContain('Discard')
    expect(text).toContain(PARTY.legalName)
    const view = read('./view/NewOrderView.tsx')
    expect(view).toContain('<DetailModal open onClose={() => actions?.onClose?.()} title={title} meta={facts} actions={buttons}>')
  })

  it('the words in both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['newOrder.discardAsk.title', 'newOrder.discardAsk.keep']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('newOrder.discardAsk.body', { lines: 2 }), locale).toContain('2')
      expect(t('newOrder.window.made', { number: 'SO-2026-0089' }), locale).toContain('SO-2026-0089')
    }
  })
})
// ---- end F-CP-113
