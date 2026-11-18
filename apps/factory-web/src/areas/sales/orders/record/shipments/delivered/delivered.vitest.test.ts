import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../../lib/i18n/provider'
import { deliveriesSchema } from './api'
import { designScreen } from './fixtures'
import { arrivalKey, downloadHeldKey } from './model'
import { readFileSync } from 'node:fs' // B-SA-0xxb
import { proofFileOf } from './model' // B-SA-0xxb
import { DeliveriesView } from './view/DeliveriesView' // B-SA-0xxb

const model = (id: string) => designScreen.cases.find((entry) => entry.id === id)!.model
const KEY = /\b(?:dv|rl)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-039-delivered — the order\'s Delivered (from carrier) card (B-W2b-398)', () => {
  it('every fixture is an answer the API may give', () => {
    for (const entry of designScreen.cases) if (entry.model.read) expect(() => deliveriesSchema.parse(entry.model.read), entry.id).not.toThrow()
  })

  it('says how each shipment arrived and holds the proof download with why', () => {
    const [carrier, typed] = model('delivered').read!.shipments
    expect(arrivalKey(carrier!)).toBe('dv.arrival.carrier')
    expect(arrivalKey(typed!)).toBe('dv.arrival.typed')
    expect(arrivalKey(model('travelling').read!.shipments[1]!)).toBe('dv.arrival.travelling')
    expect(downloadHeldKey(model('delivered'), carrier!)).toBeNull()
    expect(downloadHeldKey(model('delivered'), typed!)).toBe('dv.held.noImage')
    expect(downloadHeldKey(model('no-right'), model('no-right').read!.shipments[0]!)).toBe('dv.held.right')
    expect(downloadHeldKey(model('offline'), carrier!)).toBe('dv.held.offline')
  })

  it('every case draws in Italian and English with no raw key', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'ds-words']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html.match(KEY)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
      }
    }
  })
})

// ---- B-SA-0xxb / F-SA-266b (10-order-page §6.4 "Viewer: … POD"): the proof opens in the thread's ONE viewer, not a download
describe('B-SA-0xxb: the proof of delivery opens in the thread\'s ONE viewer when the reader has its file', () => {
  const file = { id: '00000000-0000-4000-8000-0000000000f1', name: 'proof-of-delivery-SH-26-0040.pdf', contentType: 'application/pdf', sizeBytes: 48211 }
  const withFile = () => {
    const base = model('delivered')
    return { ...base, read: { ...base.read!, shipments: base.read!.shipments.map((row, index) => (index === 0 ? { ...row, pod: { ...row.pod!, file } } : row)) } }
  }
  const draw = (m: ReturnType<typeof model>, actions: Record<string, () => void>, locale: 'en' | 'it' = 'en') => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'ds-words', 'shipping-delivery']) }, createElement(DeliveriesView, { model: m, actions })))

  it('the API\'s file (files.read on the shipment) is the viewer\'s; none: the card keeps Download with its held words', () => {
    expect(deliveriesSchema.parse(withFile().read).shipments[0]!.pod!.file).toEqual(file)
    expect(proofFileOf(withFile().read!.shipments[0]!)).toEqual(file)
    expect(proofFileOf(model('delivered').read!.shipments[0]!)).toBeNull()
    expect(proofFileOf(model('delivered').read!.shipments[1]!)).toBeNull()
  })

  it('Open proof where the page has the viewer and the reader the file; Download otherwise', () => {
    const opened = draw(withFile(), { onView: () => undefined, onDownload: () => undefined })
    expect(opened).toContain('Open proof')
    const noViewer = draw(withFile(), { onDownload: () => undefined })
    expect(noViewer).not.toContain('Open proof')
    expect(noViewer).toContain('Download proof')
    expect(draw(model('delivered'), { onView: () => undefined, onDownload: () => undefined })).not.toContain('Open proof')
    expect(draw(withFile(), { onView: () => undefined }, 'it')).toContain('Apri la prova')
  })

  it('the card hands the proof to the frame\'s viewer (openFiles), as the order\'s other files', () => {
    const source = readFileSync(new URL('./Deliveries.tsx', import.meta.url), 'utf8')
    expect(source).toContain('openFiles({ files: [proof], fileId: proof.id, returnTo: document.activeElement as HTMLElement | null })')
  })
})
// ---- end B-SA-0xxb
