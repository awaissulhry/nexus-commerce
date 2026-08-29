/**
 * The inbound ledger writer.
 *
 * The case that matters most here is the identity of a REJECTED event. `(channel,
 * externalId)` is a unique key, so if an unverified payload were allowed to name
 * itself, a forged notification claiming a genuine notification's id would occupy
 * that slot and the real delivery would be recorded as a duplicate — suppressed by
 * its own audit trail.
 */
import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const created: Array<Record<string, any>> = []
const updated: Array<Record<string, any>> = []
let existingRow: { id: string } | null = null
let failNext = false

const prismaMock = {
  webhookEvent: {
    findUnique: vi.fn(async () => existingRow),
    create: vi.fn(async (args: any) => {
      if (failNext) throw new Error('database unavailable')
      created.push(args.data)
      return { id: `row-${created.length}` }
    }),
    update: vi.fn(async (args: any) => {
      updated.push(args)
      return args
    }),
  },
}
vi.mock('../../../db.js', () => ({ default: prismaMock }))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { recordInbound, completeInbound, digestOf } = await import('./ledger.js')

const BODY = Buffer.from(JSON.stringify({ metadata: { notificationId: 'genuine-123' } }), 'utf8')

beforeEach(() => {
  created.length = 0
  updated.length = 0
  existingRow = null
  failNext = false
})

describe('recordInbound identity', () => {
  it('uses the channel\'s own id when one is supplied', async () => {
    await recordInbound({ channel: 'EBAY', eventType: 't', externalId: 'genuine-123', payload: {}, signatureOk: true, verifiedBy: 'ebay_ecdsa' })
    expect(created[0].externalId).toBe('genuine-123')
  })

  it('keys an unidentified event on the body digest, NOT on anything the body claims', async () => {
    await recordInbound({ channel: 'EBAY', eventType: 'unverified', externalId: null, rawBody: BODY, payload: {}, signatureOk: false, verifiedBy: 'ebay_ecdsa' })
    expect(created[0].externalId).toBe(`sha256:${digestOf(BODY)}`)
    // The whole point: it must not have taken the id the payload named.
    expect(created[0].externalId).not.toContain('genuine-123')
  })

  it('gives two different bodies two different identities', async () => {
    await recordInbound({ channel: 'EBAY', eventType: 'a', externalId: null, rawBody: Buffer.from('{"a":1}'), payload: {}, signatureOk: false, verifiedBy: 'ebay_ecdsa' })
    await recordInbound({ channel: 'EBAY', eventType: 'b', externalId: null, rawBody: Buffer.from('{"a":2}'), payload: {}, signatureOk: false, verifiedBy: 'ebay_ecdsa' })
    expect(created[0].externalId).not.toBe(created[1].externalId)
  })

  it('still produces an identity when there is no body at all', async () => {
    await recordInbound({ channel: 'EBAY', eventType: 'x', externalId: null, rawBody: null, payload: {}, signatureOk: false, verifiedBy: 'ebay_ecdsa' })
    expect(created[0].externalId).toMatch(/^unidentified:/)
  })
})

describe('recordInbound verdicts', () => {
  it('records a failed check as failed, with signatureOk false', async () => {
    await recordInbound({ channel: 'EBAY', eventType: 'x', payload: {}, rawBody: BODY, signatureOk: false, verifiedBy: 'ebay_ecdsa', lastError: 'signature rejected' })
    expect(created[0]).toMatchObject({ status: 'failed', signatureOk: false, verifiedBy: 'ebay_ecdsa', isProcessed: false })
  })

  it('records an unsigned transport as null, never false', async () => {
    await recordInbound({ channel: 'AMAZON', eventType: 'ORDER_CHANGE', externalId: 'm1', payload: {}, signatureOk: null, verifiedBy: 'sqs_iam' })
    expect(created[0].signatureOk).toBeNull()
    expect(created[0].verifiedBy).toBe('sqs_iam')
  })

  it('stores a digest of the body it was given', async () => {
    await recordInbound({ channel: 'EBAY', eventType: 'x', externalId: 'id', payload: {}, rawBody: BODY, signatureOk: true, verifiedBy: 'ebay_ecdsa' })
    expect(created[0].payloadDigest).toBe(crypto.createHash('sha256').update(BODY).digest('hex'))
  })
})

describe('recordInbound redelivery', () => {
  it('counts a repeat without rewriting the original verdict', async () => {
    existingRow = { id: 'row-existing' }
    const r = await recordInbound({ channel: 'EBAY', eventType: 'x', externalId: 'id', payload: {}, signatureOk: true, verifiedBy: 'ebay_ecdsa' })
    expect(r).toEqual({ id: 'row-existing', duplicate: true })
    expect(created).toHaveLength(0)
    expect(updated[0].data).toEqual({ attempts: { increment: 1 } })
  })
})

describe('recordInbound never throws', () => {
  it('returns a null id instead of failing the request — eBay marks a silent endpoint down', async () => {
    failNext = true
    await expect(
      recordInbound({ channel: 'EBAY', eventType: 'x', externalId: 'id', payload: {}, signatureOk: true, verifiedBy: 'ebay_ecdsa' }),
    ).resolves.toEqual({ id: null, duplicate: false })
  })
})

describe('completeInbound', () => {
  it('is a no-op when there is no row to close', async () => {
    await completeInbound(null, true)
    expect(updated).toHaveLength(0)
  })

  it('closes success and failure differently', async () => {
    await completeInbound('r1', true)
    expect(updated[0].data).toMatchObject({ status: 'done', isProcessed: true })
    await completeInbound('r1', false, 'handler blew up')
    expect(updated[1].data).toMatchObject({ status: 'failed', lastError: 'handler blew up' })
  })
})
