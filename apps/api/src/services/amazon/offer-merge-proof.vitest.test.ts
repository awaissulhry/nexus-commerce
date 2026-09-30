/**
 * The offer-merge proof (`src/scripts/amazon-offer-merge-proof.ts`, run compiled as
 * `node apps/api/dist/scripts/amazon-offer-merge-proof.js`) cannot send a real patch and cannot write (2026-09-30).
 *
 *   - `previewOnlyClient` lets through only the listing read and `validateListing` (always `mode=VALIDATION_PREVIEW`,
 *     pinned by `clients/amazon-sp-api.validate.vitest.test.ts`); every write method throws before a request exists;
 *   - the entry is scanned — its source, and its compiled form when `npm run build` has made one: no value import of
 *     the app at load, the gateway client handed ONLY to `previewOnlyClient`, the database read ONLY in
 *     `inReadOnlyTransaction`, no client write and no Prisma write;
 *   - the entry loads nothing on `--help`, on bad arguments, or outside a Railway replica; with a fake runtime it runs
 *     the read, the preview and a read-only transaction, and nothing else;
 *   - `inReadOnlyTransaction` is read-only by PostgreSQL's own rule (real PostgreSQL in-process, PGlite), with a positive
 *     control that the same write succeeds outside it;
 *   - the flow: the live price replayed, one preview of the merge, nothing else.
 * Nothing reaches Amazon: the client is a fake. SKUs and ASINs are fake; marketplace ids are public.
 */
import { existsSync, readFileSync } from 'node:fs'
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
import { offerMergeProofMain, parseProofArguments, PROOF_USAGE, type ProofRuntime } from '../../scripts/amazon-offer-merge-proof.js'
import { amazonListingPriceOffer } from './purchasable-offer.js'
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
  it('the entry (source) loads nothing at import, hands the gateway client only to previewOnlyClient, reads only read-only, and names no write', () => {
    scanProofEntry(readFileSync(fileURLToPath(new URL('../../scripts/amazon-offer-merge-proof.ts', import.meta.url)), 'utf8'))
  })
  const compiled = fileURLToPath(new URL('../../../dist/scripts/amazon-offer-merge-proof.js', import.meta.url))
  it.skipIf(!existsSync(compiled))('the COMPILED entry (dist/, after npm run build) holds the same rules', () => {
    scanProofEntry(readFileSync(compiled, 'utf8'))
  })
  const compiledCore = fileURLToPath(new URL('../../../dist/services/amazon/offer-merge-proof.js', import.meta.url))
  it.skipIf(!existsSync(compiledCore))('the COMPILED wrapper refuses every write the same way', async () => {
    const built = await import(/* @vite-ignore */ compiledCore) as typeof import('./offer-merge-proof.js')
    expect([...built.PROOF_CALLS].sort()).toEqual(['getListingsItem', 'validateListing'])
    const wrapped = built.previewOnlyClient(client) as unknown as Record<string, (...a: unknown[]) => unknown>
    for (const name of WRITES) expect(() => wrapped[name]({})).toThrow(/refused: .* never sends a patch/)
    for (const name of WRITES) expect(client[name]).not.toHaveBeenCalled()
  })
})

/** The rules the proof's entry file must keep, in source and compiled form. */
function scanProofEntry(file: string) {
  const code = file.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  // Nothing of the app is loaded at import: db.js would load .env before the Railway check.
  for (const line of code.split('\n').filter((l) => /^\s*import\s/.test(l))) expect(line).toMatch(/^\s*import type |from ['"]node:/)
  expect(code).toMatch(/RAILWAY_REPLICA_ID/)
  expect(code).toContain('previewOnlyClient(amazonSpApiClient)')
  expect(code.match(/amazonSpApiClient/g)).toHaveLength(2) // the loader's import and the wrap — nothing else touches it
  expect(code).toContain('inReadOnlyTransaction(prisma,')
  expect(code).not.toMatch(new RegExp(`\\b(${WRITES.join('|')})\\b`))
  expect(code).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/)
  expect(code).not.toMatch(/prisma\.channelListing|prisma\.marketplace/) // every table read is inside the read-only transaction
}

describe('the entry: arguments, the Railway check, and a run on a fake runtime', () => {
  const load = vi.fn()
  beforeEach(() => { load.mockReset() })
  it('--help prints the usage and loads nothing', async () => {
    const lines: string[] = []
    expect(await offerMergeProofMain(['--help'], {}, load, (t) => lines.push(t))).toBe(0)
    expect(lines).toEqual([PROOF_USAGE])
    expect(load).not.toHaveBeenCalled()
  })
  it.each([[[]], [['--sku', 'TEST-SKU-1']], [['--market', 'IT']], [['--sku']], [['--sku', 'A', '--sku', 'B', '--market', 'IT']], [['--apply', 'yes']]])('bad arguments %j: refused, nothing loaded', async (args) => {
    await expect(offerMergeProofMain(args, { RAILWAY_REPLICA_ID: 'r' }, load)).rejects.toThrow(/usage:/)
    expect(load).not.toHaveBeenCalled()
  })
  it('outside a Railway replica (no RAILWAY_REPLICA_ID): refused before anything is loaded — no .env, no database, no Amazon', async () => {
    await expect(offerMergeProofMain(['--sku', 'TEST-SKU-1', '--market', 'IT'], { DATABASE_URL: 'postgresql://x@127.0.0.1:1/y_test' }, load)).rejects.toThrow(/Refusing: .* Railway replica .* Nothing was loaded, read or sent/)
    expect(load).not.toHaveBeenCalled()
  })
  it('parses the optional arguments', () => {
    expect(parseProofArguments(['--sku', 'S', '--market', 'de', '--connection', 'c', '--alias', '', '--workspace', 'w'])).toEqual({ help: false, sku: 'S', market: 'DE', connection: 'c', alias: '', workspace: 'w' })
  })
  it('on a replica, with a fake runtime: one read-only transaction, the read, one preview — and no write anywhere', async () => {
    const statements: string[] = []
    const tx = {
      $executeRawUnsafe: vi.fn(async (sql: string) => { statements.push(sql); return 0 }),
      channelListing: { findMany: vi.fn(async () => { statements.push('channelListing.findMany'); return [{ id: 'l', channelConnectionId: 'amz-1', aliasKey: '', platformAttributes: { productType: 'OUTERWEAR' }, product: { sku: 'TEST-SKU-1', productType: 'OUTERWEAR' } }] }) },
      marketplace: { findFirst: vi.fn(async () => ({ code: 'IT', currency: 'EUR', taxInclusive: true, marketplaceId: IT })) },
    }
    const runtime: ProofRuntime = {
      prisma: { $transaction: async (work: (t: unknown) => Promise<unknown>) => work(tx), $disconnect: vi.fn(async () => undefined) },
      withWorkspace: (_ctx, work) => work(),
      readSaleWindows: async () => new Map([['l', { start: null, end: null }]]),
      amazonMarketplaceIdOrNull: () => IT,
      buildAmazonListingPatch: async ({ price }) => ({ patches: [{ value: [{ currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: price }] }], marketplace_id: IT }] }] }),
      getAmazonSellerId: async () => 'seller',
      amazonListingPriceOffer, inReadOnlyTransaction, runOfferMergeProof,
      client: previewOnlyClient(client),
    }
    load.mockResolvedValue(runtime)
    const lines: string[] = []
    expect(await offerMergeProofMain(['--sku', 'TEST-SKU-1', '--market', 'IT'], { RAILWAY_REPLICA_ID: 'replica-1' }, load, (t) => lines.push(t))).toBe(0)
    expect(statements[0]).toBe('SET TRANSACTION READ ONLY') // before the first read
    expect(client.getListingsItem).toHaveBeenCalledOnce()
    expect(client.validateListing).toHaveBeenCalledOnce() // queue and engine agree on the merge → one preview
    for (const name of WRITES) expect(client[name]).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('Nothing was saved in Nexus or on Amazon.')
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
