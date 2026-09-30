/**
 * The offer-merge proof (`scripts/amazon-offer-merge-proof.mts`) cannot send a real patch and cannot write (2026-09-30).
 *
 *   - `previewOnlyClient` lets through only the listing read and `validateListing` (always `mode=VALIDATION_PREVIEW`,
 *     pinned by `clients/amazon-sp-api.validate.vitest.test.ts`); every write method throws before a request exists;
 *   - the script itself is scanned: it hands the gateway client ONLY to `previewOnlyClient`, reads the database ONLY in
 *     `inReadOnlyTransaction`, and names no client write and no Prisma write;
 *   - `inReadOnlyTransaction` is read-only by PostgreSQL's own rule (real PostgreSQL in-process, PGlite), with a positive
 *     control that the same write succeeds outside it;
 *   - the flow: the live price replayed, one preview of the merge, nothing else.
 * Nothing reaches Amazon: the client is a fake. SKUs and ASINs are fake; marketplace ids are public.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { inReadOnlyTransaction, previewOnlyClient, PROOF_CALLS, runOfferMergeProof } from './offer-merge-proof.js'
import { IT, liveOffer, liveRead } from '../../test-support/amazon-offer-model.js'

const WRITES = ['submitListingPayload', 'submitListingPayloadBatch', 'patchPurchasableOffer', 'patchListingPrice', 'putListingsItem', 'deleteListingsItem'] as const
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

const fake = () => ({
  getListingsItem: vi.fn(async () => liveRead(liveOffer())),
  validateListing: vi.fn(async () => ({ ok: true, available: true, status: 'VALID', errors: null, warnings: [], issues: [] })),
  ...Object.fromEntries(WRITES.map((name) => [name, vi.fn(async () => ({ success: true }))])),
}) as Record<string, ReturnType<typeof vi.fn>>

const queueOffer = (price: number) => ({ currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: price }] }], marketplace_id: IT })
const engineOffer = (price: number) => ({ marketplace_id: IT, currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: price }] }] })
const input = (client: ReturnType<typeof fake>, lines: string[]) => ({
  sellerId: 'seller', sku: 'TEST-SKU-1', market: 'IT', marketplaceId: IT, productType: 'OUTERWEAR',
  stored: { listing: { price: 120, salePrice: null } },
  senders: [{ name: 'queue', buildOffer: queueOffer }, { name: 'engine', buildOffer: engineOffer }],
  client: previewOnlyClient(client), print: (text: string) => lines.push(text),
})

let client: ReturnType<typeof fake>
beforeEach(() => { client = fake() })
afterAll(async () => { await state.db?.close() })

describe('the proof cannot send a real patch', () => {
  it('only the read and the preview pass', () => {
    expect([...PROOF_CALLS].sort()).toEqual(['getListingsItem', 'validateListing'])
  })
  it.each(WRITES)('%s is refused before any request, and the real method is never called', async (name) => {
    const wrapped = previewOnlyClient(client) as unknown as Record<string, (...a: unknown[]) => unknown>
    expect(() => wrapped[name]({ sellerId: 'seller', sku: 'TEST-SKU-1' })).toThrow(/refused: .* never sends a patch/)
    expect(client[name]).not.toHaveBeenCalled()
  })
  it('the script hands the gateway client only to previewOnlyClient, reads only read-only, and names no write', () => {
    const script = readFileSync(fileURLToPath(new URL('../../../scripts/amazon-offer-merge-proof.mts', import.meta.url)), 'utf8')
    const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).toContain('previewOnlyClient(amazonSpApiClient)')
    expect(code.match(/amazonSpApiClient/g)).toHaveLength(2) // the import and the wrap — nothing else touches it
    expect(code).toContain('inReadOnlyTransaction(prisma,')
    expect(code).not.toMatch(new RegExp(`\\b(${WRITES.join('|')})\\b`))
    expect(code).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/)
    expect(code).not.toMatch(/prisma\.channelListing|prisma\.marketplace/) // every table read is inside the read-only transaction
  })
})

describe('inReadOnlyTransaction — read-only by PostgreSQL\'s own rule', () => {
  const market = { channel: 'AMAZON', code: 'ZZ', name: 'Proof', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] }
  it('a write inside it fails; reads work', () => scoped(async () => {
    await expect(inReadOnlyTransaction(prisma, (tx) => tx.marketplace.create({ data: market }))).rejects.toThrow(/read-only transaction/)
    expect(await inReadOnlyTransaction(prisma, (tx) => tx.marketplace.count({ where: { code: 'ZZ' } }))).toBe(0)
  }))
  it('positive control: the same write outside it succeeds', () => scoped(async () => {
    await prisma.$transaction((tx) => tx.marketplace.create({ data: market }))
    expect(await prisma.marketplace.count({ where: { code: 'ZZ' } })).toBe(1)
  }))
})

describe('the flow', () => {
  it('replays the live price as a merge, previews it ONCE (both senders agree), prints everything, sends nothing', async () => {
    const lines: string[] = []
    const result = await runOfferMergeProof(input(client, lines))
    expect(result).toMatchObject({ read: 'ok', livePrice: 120 })
    const patch = { op: 'merge', path: '/attributes/purchasable_offer', value: [{ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: [{ schedule: [{ value_with_tax: 120 }] }] }] }
    expect(result.plans.map((p) => p.plan)).toEqual([{ kind: 'merge', patch }, { kind: 'merge', patch }])
    expect(client.getListingsItem).toHaveBeenCalledExactlyOnceWith({ sellerId: 'seller', sku: 'TEST-SKU-1', marketplaceId: IT, includedData: ['attributes', 'summaries'] })
    expect(client.validateListing).toHaveBeenCalledExactlyOnceWith({ sellerId: 'seller', sku: 'TEST-SKU-1', marketplaceId: IT, productType: 'OUTERWEAR', patches: [patch] })
    for (const name of WRITES) expect(client[name]).not.toHaveBeenCalled()
    const text = lines.join('\n')
    expect(text).toContain(JSON.stringify(liveOffer(), null, 2)) // the live offer, verbatim
    expect(text).toMatch(/VALIDATION_PREVIEW .* NOT saved/)
    expect(text).toContain('Nothing was saved in Nexus or on Amazon.')
  })
  it('a failed live read stops the proof: no preview', async () => {
    client.getListingsItem.mockResolvedValue({ success: false, error: 'Amazon listing read failed (500)' })
    const lines: string[] = []
    expect((await runOfferMergeProof(input(client, lines))).read).toBe('failed')
    expect(client.validateListing).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('Amazon listing read failed (500)')
  })
  it('no priced offer for all buyers in the market: nothing to replay, no preview', async () => {
    client.getListingsItem.mockResolvedValue(liveRead([liveOffer()[1]]))
    const result = await runOfferMergeProof(input(client, []))
    expect(result.livePrice).toBeNull()
    expect(client.validateListing).not.toHaveBeenCalled()
  })
})
