import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MCP full control O3 — every buyer-facing output carries the business's own identity.
 *
 *   1. Xavia (the legacy business): every e-mail is byte-identical to what it was before O3. The snapshots in
 *      __snapshots__/business-identity.vitest.test.ts.snap were written by the code BEFORE O3 (a characterization):
 *      a buyer e-mail from send-customer-message, the return e-mails, the review e-mails (request and sentiment
 *      check) and the shipment e-mails.
 *   1b. Documents (invoice, packing slip, withdrawal form) print the business's ONE company identity (lead review,
 *      2026-10-01): Settings › Company first, then — for Xavia only — NEXUS_ISSUER_*; never a code placeholder, and
 *      an identity that lacks what a document prints is refused.
 *   2. A second business with its identity set (Settings → Company: name, contact e-mail, address; P.IVA for an
 *      invoice): each output names that business and its contact address, sends from it, and never says Xavia.
 *   3. A second business with no identity: refused — nothing is sent, no invoice number is taken, nothing goes out as
 *      Xavia.
 *
 * The e-mail transport, the database and pdfkit are mocked: the test reads what would be sent or printed.
 */
const h = vi.hoisted(() => ({
  sent: [] as Array<Record<string, unknown>>,
  brand: null as Record<string, unknown> | null,
  order: null as Record<string, unknown> | null,
  pdf: [] as unknown[],
  assigned: 0,
  invoice: null as Record<string, unknown> | null,
}))

vi.mock('../db.js', () => {
  // 07 O11 — send-customer-message writes one BuyerMessage row per send and its event (the outbox).
  const buyerMessage = { create: vi.fn(async () => ({ id: 'test-message-1' })), update: vi.fn(async () => ({})) }
  const eventOutbox = { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) }
  return {
    default: {
      brandSettings: { findFirst: vi.fn(async () => h.brand) },
      order: {
        findUnique: vi.fn(async () => h.order),
        findFirst: vi.fn(async () => h.order),
      },
      buyerMessage,
      eventOutbox,
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ buyerMessage, eventOutbox })),
    },
  }
})
vi.mock('../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('./email/transport.js', () => ({
  sendEmail: vi.fn(async (message: Record<string, unknown>) => {
    h.sent.push(message)
    return { ok: true, provider: 'mock', dryRun: true, messageId: 'mock-1' }
  }),
  __test: { isReal: () => false },
  defaultFrom: () => 'Xavia <ship@xavia.it>',
}))
vi.mock('./reviews/email-suppression.service.js', () => ({
  isEmailSuppressed: vi.fn(async () => ({ suppressed: false })),
  unsubscribeTokenFor: vi.fn(() => 'TEST-UNSUBSCRIBE-TOKEN'),
}))
vi.mock('./fiscal-invoice.service.js', () => ({
  getInvoiceForOrder: vi.fn(async () => h.invoice),
  assignInvoiceNumber: vi.fn(async () => {
    h.assigned++
    throw new Error('not expected in this test')
  }),
}))
vi.mock('pdfkit', () => ({
  default: class FakePdf {
    private handlers: Record<string, (chunk?: unknown) => void> = {}
    constructor(options: { info?: unknown }) {
      h.pdf.push({ info: options.info })
      // Every drawing call returns the document, as pdfkit's chain does; text() is recorded.
      return new Proxy(this, {
        get: (target, key, receiver) => {
          if (key === 'on') return (event: string, fn: (chunk?: unknown) => void) => { target.handlers[event] = fn; return receiver }
          if (key === 'text') return (value: unknown) => { h.pdf.push(value); return receiver }
          if (key === 'end') return () => { target.handlers.data?.(Buffer.from('pdf')); target.handlers.end?.() }
          if (key === 'y' || key === 'x') return 100
          if (key === 'page') return { width: 595, height: 842, margins: { left: 56, right: 56, top: 56, bottom: 56 } }
          return () => receiver
        },
      })
    }
  },
}))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { getTool } from './agents/tool-registry.js'
import { sendReturnEmail, type ReturnEmailKind } from './return-comms/return-emails.service.js'
import { sendReviewRequestEmail } from './reviews/review-request-email.service.js'
import { renderSentimentCheckPreview, sendSentimentCheckEmail } from './reviews/sentiment-check-email.service.js'
import { sendShipmentEmail } from './email/index.js'
import { invoiceHtml, packingSlipHtml } from './fiscal-pdf.service.js'
import { buildModuloRecessoPdf } from './return-comms/modulo-recesso.service.js'
import { generateCreditNoteXml, generateFatturaPaXml } from './fattura-pa.service.js'

const SECOND = 'test_identity_second_business'
const inBusiness = <T>(workspaceId: string, work: () => Promise<T>) =>
  withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const xavia = <T>(work: () => Promise<T>) => inBusiness(LEGACY_WORKSPACE_ID, work)
const second = <T>(work: () => Promise<T>) => inBusiness(SECOND, work)

const SECOND_BRAND = {
  companyName: 'Test Moto S.r.l.',
  contactEmail: 'help@testmoto.example',
  addressLines: ['Via Prova 2', '00100 Roma RM', 'Italia'],
  piva: 'IT12345678901',
  codiceFiscale: null,
  pecEmail: null,
  taxId: null,
}

const ORDER = {
  id: 'test-order-1',
  channel: 'SHOPIFY',
  channelOrderId: 'TEST-ORDER-1001',
  marketplace: 'IT',
  fiscalKind: 'B2C',
  customerName: 'Mario Rossi',
  customerEmail: 'buyer@example.test',
  codiceFiscale: null,
  partitaIva: null,
  codiceDestinatario: null,
  pecEmail: null,
  shippingAddress: { line1: 'Via Test 1', city: 'Testville', postalCode: '00000', countryCode: 'IT' },
  items: [{ sku: 'TEST-SKU-1', quantity: 2, price: '24.40', itVatRatePct: null }],
}

const RETURN_KINDS: ReturnEmailKind[] = ['authorized', 'label_ready', 'received', 'refunded', 'rejected']
const returnContext = (locale: 'it' | 'en') => ({
  to: 'buyer@example.test', customerName: 'Mario Rossi', rmaNumber: 'TEST-RMA-1', channelOrderId: 'TEST-ORDER-1001',
  channel: 'SHOPIFY', refundCents: 4880, currencyCode: 'EUR', reason: 'Item used', refundDeadlineDays: 14, locale,
})
const reviewContext = (locale: 'it' | 'en') => ({
  to: 'buyer@example.test', customerName: 'Mario Rossi', channelOrderId: 'TEST-ORDER-1001', channel: 'SHOPIFY',
  marketplace: 'IT', productName: 'Test Jacket', productType: 'giacca', reviewUrl: 'https://shop.example.test/review', locale,
})
const SENTIMENT_LOCALES = ['it', 'de', 'fr', 'es', 'en'] as const
const sentimentContext = (locale: (typeof SENTIMENT_LOCALES)[number]) => ({
  to: 'buyer@example.test', customerName: 'Mario Rossi', productName: 'Test Jacket',
  baseUrl: 'https://web.example.test/r/TEST', channelOrderId: 'TEST-ORDER-1001', locale,
})
const shipmentContext = (locale: 'it' | 'en') => ({
  to: 'buyer@example.test', customerName: 'Mario Rossi', orderId: 'test-order-1', orderChannelId: 'TEST-ORDER-1001',
  trackingNumber: 'TEST-TRACK-1', trackingUrl: null, carrier: 'BRT', estimatedDelivery: '2026-05-10T00:00:00Z',
  destinationCity: 'Testville', brandedTrackingUrl: 'https://web.example.test/track/TEST-TRACK-1', locale,
})
const moduloInput = {
  rmaNumber: 'TEST-RMA-1', channelOrderId: 'TEST-ORDER-1001', customerName: 'Mario Rossi', customerEmail: 'buyer@example.test',
  shippingAddress: { line1: 'Via Test 1', city: 'Testville' }, items: [{ sku: 'TEST-SKU-1', quantity: 1, productName: null }],
  orderDate: new Date('2026-04-01T10:00:00Z'), deliveredAt: new Date('2026-04-05T10:00:00Z'),
}

const sendCustomerMessage = () => getTool('send-customer-message')!
const toolContext = { can: () => true, via: 'app' as const, userId: 'test-user' }

/** Everything one business would send or print, in one list. */
async function everyEmail(): Promise<Array<Record<string, unknown>>> {
  h.sent.length = 0
  await sendCustomerMessage().execute!({ orderId: ORDER.id, message: 'Your parcel ships today.' }, toolContext)
  for (const locale of ['it', 'en'] as const) {
    for (const kind of RETURN_KINDS) await sendReturnEmail(kind, returnContext(locale))
    await sendReviewRequestEmail(reviewContext(locale))
    for (const kind of ['shipped', 'delivered', 'exception'] as const) await sendShipmentEmail(kind, shipmentContext(locale))
  }
  for (const locale of SENTIMENT_LOCALES) await sendSentimentCheckEmail(sentimentContext(locale))
  return [...h.sent]
}

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-05-05T10:00:00Z'), toFake: ['Date'] })
})
afterAll(() => {
  vi.useRealTimers()
})
beforeEach(() => {
  h.sent.length = 0
  h.pdf.length = 0
  h.assigned = 0
  h.brand = null
  h.order = { ...ORDER }
  h.invoice = {
    invoiceNumber: '00007/2026', sequenceNumber: 7, fiscalYear: 2026, issuer: 'XAVIA',
    issuedAt: new Date('2026-03-04T10:00:00Z'), newlyAssigned: false,
  }
})

describe('O3 — Xavia: every buyer-facing output is byte-identical to before', () => {
  it('send-customer-message', async () => {
    const result = await xavia(() => sendCustomerMessage().execute!({ orderId: ORDER.id, message: 'Your parcel ships today.' }, toolContext))
    expect(result.ok).toBe(true)
    expect(h.sent).toMatchSnapshot()
  })

  it('return e-mails, every kind, Italian and English', async () => {
    for (const locale of ['it', 'en'] as const) for (const kind of RETURN_KINDS) await xavia(() => sendReturnEmail(kind, returnContext(locale)))
    expect(h.sent).toHaveLength(10)
    expect(h.sent).toMatchSnapshot()
  })

  it('review request e-mails, Italian and English', async () => {
    for (const locale of ['it', 'en'] as const) await xavia(() => sendReviewRequestEmail(reviewContext(locale)))
    expect(h.sent).toHaveLength(2)
    expect(h.sent).toMatchSnapshot()
  })

  it('sentiment check e-mails, every language, and the in-app preview', async () => {
    for (const locale of SENTIMENT_LOCALES) await xavia(() => sendSentimentCheckEmail(sentimentContext(locale)))
    expect(h.sent).toHaveLength(5)
    expect(h.sent).toMatchSnapshot()
    expect(await xavia(async () => renderSentimentCheckPreview({ locale: 'it' }))).toMatchSnapshot()
  })

  it('shipment e-mails, every kind, Italian and English', async () => {
    for (const locale of ['it', 'en'] as const) for (const kind of ['shipped', 'delivered', 'exception'] as const) await xavia(() => sendShipmentEmail(kind, shipmentContext(locale)))
    expect(h.sent).toHaveLength(6)
    expect(h.sent).toMatchSnapshot()
  })

})

/** Code placeholders documents printed before (lead review, 2026-10-01): never again on a document. */
const PLACEHOLDERS = ['Via Esempio', 'IT00000000000', '00000000000', 'info@xavia.example', 'Riccione', 'Milano', '20100']
/** Xavia's company settings, invented (the real ones live only in the database). */
const XAVIA_SETTINGS = {
  companyName: 'Test Xavia S.r.l.', contactEmail: 'legal@testxavia.example', contactPhone: '+39 0541 000000',
  addressLines: ['Via Prova 9', '47999 Testborgo (RN)', 'Italia'], piva: 'IT11111111111', codiceFiscale: '11111111111',
  pecEmail: 'pec@testxavia.example', taxId: null,
}
const XAVIA_ENV = {
  NEXUS_ISSUER_NAME: 'Env Xavia S.r.l.', NEXUS_ISSUER_ADDRESS: 'Via Ambiente 3', NEXUS_ISSUER_POSTAL: '47998',
  NEXUS_ISSUER_CITY: 'Envtown', NEXUS_ISSUER_COUNTRY: 'IT', NEXUS_ISSUER_VAT: 'IT22222222222', NEXUS_ISSUER_CF: '22222222222',
  NEXUS_ISSUER_EMAIL: 'env@testxavia.example',
}
const stubEnv = (values: Record<string, string>) => { for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value) }

describe('documents print the one company identity: Settings › Company first, NEXUS_ISSUER_* for Xavia, never a placeholder', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('Xavia with its company settings: the invoice, the packing slip and the withdrawal form print them', async () => {
    h.brand = { ...XAVIA_SETTINGS }
    const invoice = await xavia(() => invoiceHtml(ORDER.id))
    expect(invoice).toContain('<strong>Test Xavia S.r.l.</strong>')
    expect(invoice).toContain('Via Prova 9, 47999 Testborgo (RN), Italia')
    expect(invoice).toContain('P. IVA: IT11111111111 · C.F.: 11111111111')
    expect(invoice).toContain('PEC: pec@testxavia.example')
    expect(invoice).toContain('legal@testxavia.example')
    const slip = await xavia(() => packingSlipHtml(ORDER.id))
    expect(slip).toContain('<strong>Test Xavia S.r.l.</strong>')
    expect(slip).toContain('Via Prova 9, 47999 Testborgo (RN), Italia')
    await xavia(() => buildModuloRecessoPdf(moduloInput))
    expect(h.pdf).toEqual(expect.arrayContaining(['Test Xavia S.r.l.', 'Via Prova 9', '47999 Testborgo (RN)', 'Italia', 'Email: legal@testxavia.example']))
    for (const placeholder of PLACEHOLDERS) {
      expect(invoice).not.toContain(placeholder)
      expect(slip).not.toContain(placeholder)
      expect(JSON.stringify(h.pdf)).not.toContain(placeholder)
    }
  })

  it('Xavia without settings: NEXUS_ISSUER_* is the fallback', async () => {
    stubEnv(XAVIA_ENV)
    const invoice = await xavia(() => invoiceHtml(ORDER.id))
    expect(invoice).toContain('<strong>Env Xavia S.r.l.</strong>')
    expect(invoice).toContain('Via Ambiente 3, 47998 Envtown, IT')
    expect(invoice).toContain('P. IVA: IT22222222222 · C.F.: 22222222222')
    await xavia(() => buildModuloRecessoPdf(moduloInput))
    expect(h.pdf).toEqual(expect.arrayContaining(['Env Xavia S.r.l.', 'Via Ambiente 3', '47998 Envtown', 'IT', 'Email: env@testxavia.example']))
  })

  it('a setting wins over NEXUS_ISSUER_*, field by field', async () => {
    stubEnv(XAVIA_ENV)
    h.brand = { companyName: 'Test Xavia S.r.l.', addressLines: [], piva: null }
    const invoice = await xavia(() => invoiceHtml(ORDER.id))
    expect(invoice).toContain('<strong>Test Xavia S.r.l.</strong>')
    expect(invoice).toContain('Via Ambiente 3, 47998 Envtown, IT')
    expect(invoice).toContain('P. IVA: IT22222222222')
  })

  it('Xavia with neither: every document is refused, and no invoice number is taken', async () => {
    h.invoice = null
    await expect(xavia(() => invoiceHtml(ORDER.id))).rejects.toThrow(/Settings › Company/)
    expect(h.assigned).toBe(0)
    await expect(xavia(() => packingSlipHtml(ORDER.id))).rejects.toThrow(/Settings › Company/)
    await expect(xavia(() => buildModuloRecessoPdf(moduloInput))).rejects.toThrow(/Settings › Company/)
  })

  it('an address without a postal code, or a missing P.IVA, is refused for the documents that print it', async () => {
    h.brand = { ...XAVIA_SETTINGS, addressLines: ['Via Prova 9'] }
    await expect(xavia(() => packingSlipHtml(ORDER.id))).rejects.toThrow(/address.*Settings › Company/)
    h.brand = { ...XAVIA_SETTINGS, piva: null }
    await expect(xavia(() => invoiceHtml(ORDER.id))).rejects.toThrow(/P\.IVA.*Settings › Company/)
    // The packing slip prints no P.IVA: it is made.
    expect(await xavia(() => packingSlipHtml(ORDER.id))).toContain('Test Xavia S.r.l.')
  })

  it("NEXUS_ISSUER_* is Xavia's: never another business's fallback", async () => {
    stubEnv(XAVIA_ENV)
    await expect(second(() => invoiceHtml(ORDER.id))).rejects.toThrow(/Settings › Company/)
    await expect(second(() => buildModuloRecessoPdf(moduloInput))).rejects.toThrow(/Settings › Company/)
  })
})

describe('O3 — a second business with its identity: its own name, contact and sender, never Xavia', () => {
  beforeEach(() => {
    h.brand = { ...SECOND_BRAND }
  })

  it('every e-mail names the business, sends from its address and never says Xavia', async () => {
    const sent = await second(() => everyEmail())
    expect(sent).toHaveLength(1 + 2 * (RETURN_KINDS.length + 1 + 3) + SENTIMENT_LOCALES.length)
    for (const message of sent) {
      const all = JSON.stringify(message)
      expect(all).not.toMatch(/xavia/i)
      expect(message.from).toBe('"Test Moto S.r.l." <help@testmoto.example>')
      expect(`${message.subject} ${message.html}`).toContain('Test Moto S.r.l.')
      expect(String(message.text)).toContain('Test Moto S.r.l.')
    }
    // The buyer can reach the business: its own address is in the message (the review request's unsubscribe too).
    const withSupport = sent.filter((message) => String(message.html).includes('help@testmoto.example'))
    expect(withSupport.length).toBeGreaterThan(0)
    const review = sent.find((message) => message.tag === 'review-request')!
    expect((review.headers as Record<string, string>)['List-Unsubscribe']).toContain('mailto:help@testmoto.example?subject=unsubscribe')
  })

  it('the sentiment check preview names the business', async () => {
    const html = await second(async () => renderSentimentCheckPreview({ locale: 'it', productName: 'Test Jacket' }))
    expect(html).toContain('TEST MOTO S.R.L.')
    expect(html).not.toMatch(/xavia/i)
  })

  it('send-customer-message: the approver sees who it is sent as', async () => {
    const dryRun = await second(() => sendCustomerMessage().handler({ orderId: ORDER.id, message: 'Your parcel ships today.' }, toolContext))
    expect(dryRun.ok).toBe(true)
    expect((dryRun.preview as Record<string, unknown>).sendsAs).toEqual({ name: 'Test Moto S.r.l.', from: '"Test Moto S.r.l." <help@testmoto.example>' })
  })

  it('invoice and packing slip carry its legal identity, and Xavia is nowhere', async () => {
    const invoice = await second(() => invoiceHtml(ORDER.id))
    expect(invoice).toContain('Test Moto S.r.l.')
    expect(invoice).toContain('P. IVA: IT12345678901')
    expect(invoice).toContain('Via Prova 2, 00100 Roma RM, Italia')
    expect(invoice).toContain('help@testmoto.example')
    expect(invoice).not.toMatch(/xavia/i)
    const slip = await second(() => packingSlipHtml(ORDER.id))
    expect(slip).toContain('Test Moto S.r.l.')
    expect(slip).toContain('Via Prova 2, 00100 Roma RM, Italia')
    expect(slip).not.toMatch(/xavia/i)
  })

  it('the withdrawal form is addressed to the business', async () => {
    await second(() => buildModuloRecessoPdf(moduloInput))
    const printed = JSON.stringify(h.pdf)
    expect(printed).toContain('Test Moto S.r.l.')
    expect(printed).toContain('Via Prova 2')
    expect(printed).toContain('Email: help@testmoto.example')
    expect(printed).not.toMatch(/xavia/i)
  })
})

describe('O3 — a second business with no identity: refused, nothing sent as Xavia', () => {
  it('no e-mail is sent, and each sender says why', async () => {
    const results: Array<{ ok: boolean; error?: string }> = []
    await second(async () => {
      results.push(await sendCustomerMessage().execute!({ orderId: ORDER.id, message: 'Your parcel ships today.' }, toolContext))
      for (const kind of RETURN_KINDS) results.push(await sendReturnEmail(kind, returnContext('it')))
      results.push(await sendReviewRequestEmail(reviewContext('it')))
      results.push(await sendSentimentCheckEmail(sentimentContext('it')))
      results.push(await sendShipmentEmail('shipped', shipmentContext('it')))
    })
    expect(h.sent).toEqual([])
    for (const result of results) {
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/no identity for buyers/i)
    }
  })

  it('send-customer-message is refused at the preview: nothing is queued', async () => {
    const dryRun = await second(() => sendCustomerMessage().handler({ orderId: ORDER.id, message: 'Your parcel ships today.' }, toolContext))
    expect(dryRun.ok).toBe(false)
    expect(dryRun.error).toMatch(/no identity for buyers/i)
  })

  it('a contact e-mail alone is not an identity (name and address are needed too)', async () => {
    h.brand = { companyName: null, contactEmail: 'help@testmoto.example', addressLines: [], piva: null }
    const result = await second(() => sendReturnEmail('received', returnContext('it')))
    expect(result.ok).toBe(false)
    expect(h.sent).toEqual([])
  })

  it('the invoice is refused before a number is taken, and the packing slip and withdrawal form too', async () => {
    // No invoice yet: the old code took a number first.
    h.invoice = null
    await expect(second(() => invoiceHtml(ORDER.id))).rejects.toThrow(/Settings › Company/)
    expect(h.assigned).toBe(0)
    await expect(second(() => packingSlipHtml(ORDER.id))).rejects.toThrow(/Settings › Company/)
    await expect(second(() => buildModuloRecessoPdf(moduloInput))).rejects.toThrow(/Settings › Company/)
  })

  it('an invoice needs the P.IVA too: name, contact and address alone are refused', async () => {
    h.brand = { ...SECOND_BRAND, piva: null, taxId: null }
    await expect(second(() => invoiceHtml(ORDER.id))).rejects.toThrow(/P\.IVA/)
  })

  it('FatturaPA XML (invoice and credit note) is refused for any business but Xavia, before anything is read or numbered', async () => {
    h.brand = { ...SECOND_BRAND }
    await expect(second(() => generateFatturaPaXml(ORDER.id))).rejects.toThrow(/only for Xavia/)
    await expect(second(() => generateCreditNoteXml('test-refund-1'))).rejects.toThrow(/only for Xavia/)
    expect(h.assigned).toBe(0)
  })
})
