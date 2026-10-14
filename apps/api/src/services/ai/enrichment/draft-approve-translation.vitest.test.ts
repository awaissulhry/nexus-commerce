import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Approving a translation draft (D7) writes the language's content: what `PUT /api/products/:id/translations/:language`
 * did before that route went with the old product drawer (2026-10-14), and what `approveDrafts` now does itself.
 * Real save path on PGlite: `approveDrafts` → `applyProductBulkEdits` → the content writers; what is STORED is the claim.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))

import type { FastifyInstance, FastifyRequest } from 'fastify'
import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { approveDrafts } from './draft.service.js'
import { encodeCellKey } from './cell-key.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
/** A translation group never goes through the app: an inject here would be the deleted route again. */
const app = { inject: vi.fn(async () => { throw new Error('a translation approval must not inject a route') }) } as unknown as FastifyInstance
const request = { authUser: { id: 'u-approver' }, ip: '127.0.0.1', headers: {}, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as FastifyRequest
let productId = ''
let runs = 0

const draft = (locale: string, writeField: string, draftValue: unknown, baseValue: unknown = null, onProduct = productId) => scoped(async () => (await prisma.productAiDraft.create({ data: {
  productId: onProduct, cellKey: encodeCellKey({ channel: null, marketplace: null, aliasId: null, locale, writeField }), channel: null, marketplace: null, locale,
  writeField, columnKey: writeField, draftValue: draftValue as never, baseValue: baseValue as never, status: 'pending', runId: `run-${locale}-${++runs}`, provider: 'anthropic',
  model: 'test-model', promptHash: 'hash',
} as never })).id)

beforeAll(() => scoped(async () => {
  for (const [code, language] of [['IT', 'it'], ['DE', 'de']] as const) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: code, currency: 'EUR', region: 'EU', language, languages: [language], marketplaceId: `MKT-${code}` } as never })
  }
  productId = (await prisma.product.create({ data: { sku: 'TEST-SKU-APPROVE-DE', name: 'Giacca di prova', description: 'Descrizione', basePrice: 10 } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

describe('approving a translation draft', () => {
  it('a German title and bullets are saved as reviewed German content; the drafts are approved with no apply error', async () => {
    const ids = [await draft('de', 'title', 'Testjacke'), await draft('de', 'bulletPoints', ['Wasserdicht', 'Leicht'])]
    const result = await scoped(() => approveDrafts(app, request, ids))
    expect(result.refused).toEqual([])
    expect(result.approved.sort()).toEqual([...ids].sort())
    expect(app.inject).not.toHaveBeenCalled()
    const rows = await scoped(() => prisma.productAiDraft.findMany({ where: { id: { in: ids } } }))
    expect(rows.map((r) => [r.status, r.lastApplyError, r.decidedBy])).toEqual([['approved', null, 'u-approver'], ['approved', null, 'u-approver']])
    const german = await scoped(() => prisma.productTranslation.findFirstOrThrow({ where: { productId, language: 'de' } }))
    expect(german).toMatchObject({ name: 'Testjacke', bulletPoints: ['Wasserdicht', 'Leicht'] })
    expect(german.reviewedAt).not.toBeNull()
    // The model that wrote the words is kept beside the review.
    expect(german.sourceModel).toBe('test-model')
    // The master (Italian) row is not touched.
    expect(await scoped(() => prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { name: true } }))).toEqual({ name: 'Giacca di prova' })
  })

  it('a draft in the primary language is refused, as the route refused it, and nothing is written', async () => {
    // Its base is the Italian title the draft was made against, so the staleness check passes and the refusal is the route's.
    const id = await draft('it', 'title', 'Titolo nuovo', 'Giacca di prova')
    const result = await scoped(() => approveDrafts(app, request, [id]))
    expect(result.approved).toEqual([])
    expect(result.refused).toEqual([{ id, reason: expect.stringContaining("language 'it' is the primary language") }])
    const row = await scoped(() => prisma.productAiDraft.findUniqueOrThrow({ where: { id } }))
    expect(row.status).toBe('pending')
    expect(row.lastApplyError).toContain('primary language')
    expect(await scoped(() => prisma.productTranslation.count({ where: { productId, language: 'it' } }))).toBe(0)
    expect(await scoped(() => prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { name: true } }))).toEqual({ name: 'Giacca di prova' })
  })
})

describe('a German row that already holds an unreviewed machine draft (catalog-translate.ts writes such rows)', () => {
  let machineProduct = ''
  beforeAll(() => scoped(async () => {
    machineProduct = (await prisma.product.create({ data: { sku: 'TEST-SKU-APPROVE-MACHINE', name: 'Giacca macchina', description: 'Descrizione', basePrice: 10 } })).id
    await prisma.productTranslation.create({ data: { productId: machineProduct, language: 'de', description: 'Maschinentext', source: 'ai', reviewedAt: null, version: 1 } as never })
  }))
  const germanRow = () => scoped(() => prisma.productTranslation.findFirstOrThrow({ where: { productId: machineProduct, language: 'de' } }))

  it('approving only the title is refused with the sheet door\'s sentence; nothing is written and the row stays unreviewed', async () => {
    const before = await germanRow()
    const id = await draft('de', 'title', 'Maschinenjacke', null, machineProduct)
    const result = await scoped(() => approveDrafts(app, request, [id]))
    expect(result.approved).toEqual([])
    expect(result.refused).toEqual([{ id, reason: expect.stringContaining('Other text in this language was drafted since you read it') }])
    expect(await germanRow()).toEqual(before)
    expect(before).toMatchObject({ name: null, description: 'Maschinentext', source: 'ai', reviewedAt: null })
    const row = await scoped(() => prisma.productAiDraft.findUniqueOrThrow({ where: { id } }))
    expect([row.status, row.lastApplyError?.includes('drafted since you read it')]).toEqual(['pending', true])
    await scoped(() => prisma.productAiDraft.update({ where: { id }, data: { status: 'rejected' } }))
  })

  it('approving every field that holds text reviews the whole row; the audit records what each field held before', async () => {
    const ids = [await draft('de', 'title', 'Maschinenjacke', null, machineProduct), await draft('de', 'description', 'Geprüfter Text', 'Maschinentext', machineProduct)]
    const result = await scoped(() => approveDrafts(app, request, ids))
    expect(result.refused).toEqual([])
    expect(result.approved.sort()).toEqual([...ids].sort())
    const german = await germanRow()
    expect(german).toMatchObject({ name: 'Maschinenjacke', description: 'Geprüfter Text', source: 'manual', sourceModel: 'test-model' })
    expect(german.reviewedAt).not.toBeNull()
    const audits = await scoped(() => prisma.auditLog.findMany({ where: { entityId: machineProduct, action: 'ai-draft.approve' } }))
    expect(audits.map((a) => [a.before, a.after]).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toEqual([
      [{ 'de.description': 'Maschinentext' }, { 'de.description': 'Geprüfter Text' }],
      [{ 'de.title': null }, { 'de.title': 'Maschinenjacke' }],
    ])
  })
})
