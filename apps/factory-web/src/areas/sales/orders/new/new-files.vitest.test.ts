import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import { scanText } from '../../../../lib/testing/brand-scan'
import { leftKeys, render, textOf } from '../../../../lib/record-thread/parts/testing'
import { attachOutcome, attaching, heldCount, heldKindOf, holdFiles, MAX_HELD, takesSheetTick, toAttach, type HeldFile } from './new-files'
import { CustomerFiles, FilesOutcome, type CustomerFilesModel } from './view/CustomerFiles'

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
