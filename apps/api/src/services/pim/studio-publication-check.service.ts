/**
 * Sheet publish parity, step 4 — what a person can do with a publication from its history.
 *
 * D3 (Owner, 2026-10-01): "Mark as checked". A publication still waiting for a result (PUBLISHING, SUBMITTED,
 * UNVERIFIED) blocks every later publish to its destination — after 7 days without an Amazon report, for good. A
 * person who checked the listing on the channel marks it checked: the status stays (Nexus never invents a result), the
 * publication closes (`completedAt`), the sweep leaves it, and the destination accepts a new publish. Who, when and
 * why are kept in its summary and in the audit log.
 *
 * "Publish failed products again…": the products that failed and the fields they carried, so the browser opens the
 * normal Publish dialog with them pre-ticked. A NEW review compares the current saved values again: nothing is sent
 * from here, and a stored request is never replayed (it could overwrite newer edits).
 */
import { Prisma } from '@prisma/client'
import type { StudioPublicationCheck, StudioPublishResult, StudioPublishScope, StudioRetrySelection } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { auditLogService } from '../audit-log.service.js'
import { object } from './studio-publication-plan.js'
import { WorkspaceScopeError } from './workspace-destination.js'
import { IN_FLIGHT, OPEN_PUBLICATION, PUBLICATION_KIND, RECEIPT_DEADLINE_MS, announcePublication, checkedMark, json } from './studio-publication-settle.js'

export const CHECK_NOTE_MAX = 500
/** The change-review rows that create a whole listing: one change carries every field of it. */
const CREATE_FIELDS = new Set(['$create', '__create__'])

const PUBLICATION_SELECT = { id: true, kind: true, status: true, userId: true, productId: true, channel: true, marketplace: true, channelConnectionId: true,
  aliasKey: true, batchId: true, submittedAt: true, completedAt: true, summary: true, changes: true, createdAt: true } as const
type PublicationRow = Prisma.BulkOperationGetPayload<{ select: typeof PUBLICATION_SELECT }>

/** A studio publication of THIS product's family, in the current business (the tenant policy hides any other). */
async function loadPublication(productId: string, id: string): Promise<{ row: PublicationRow; data: Record<string, any> }> {
  const row = await prisma.bulkOperation.findFirst({ where: { id }, select: PUBLICATION_SELECT })
  const data = object(row?.changes)
  if (!row || (row.kind !== PUBLICATION_KIND && data.kind !== PUBLICATION_KIND)) throw new WorkspaceScopeError('Publication not found.', 404)
  if (data.productId === productId || row.productId === productId) return { row, data }
  // The history may open it from any product of the family: a variation of the publication's family is the same family.
  const product = row.productId ? await prisma.product.findFirst({ where: { id: productId }, select: { parentId: true } }) : null
  if (!product || product.parentId !== row.productId) throw new WorkspaceScopeError('Publication not found.', 404)
  return { row, data }
}

async function userName(userId: string | null): Promise<string | null> {
  if (!userId) return null
  const user = await prisma.userProfile.findFirst({ where: { id: userId }, select: { displayName: true } })
  return user?.displayName?.trim() || null
}

/** Whether no OTHER unsettled publication holds this destination. */
async function destinationOpen(id: string, data: Record<string, any>): Promise<boolean> {
  if (typeof data.publicationKey !== 'string') return true
  const other = await prisma.bulkOperation.findFirst({ where: { id: { not: id }, ...OPEN_PUBLICATION, changes: { path: ['publicationKey'], equals: data.publicationKey } },
    select: { id: true } })
  return !other
}

async function checkView(row: { id: string; status: string }, data: Record<string, any>, summary: unknown): Promise<StudioPublicationCheck> {
  const mark = checkedMark(summary)!
  return { publicationId: row.id, status: row.status as StudioPublishResult['status'], checkedAt: mark.checkedAt,
    checkedBy: mark.checkedBy ? { id: mark.checkedBy, name: await userName(mark.checkedBy) } : null, note: mark.checkedNote,
    destinationOpen: await destinationOpen(row.id, data) }
}

function refuseUnlessOpen(row: { status: string; submittedAt: Date | null; createdAt: Date }, data: Record<string, any>, now: Date) {
  if (row.status === 'PREVIEW') throw new WorkspaceScopeError('This review was never sent, so there is nothing to check.', 409)
  if (!IN_FLIGHT.includes(row.status)) throw new WorkspaceScopeError('This publication already has its result. Nothing needs checking.', 409)
  // A send still within its 30-minute receipt deadline may be running right now: marking it would let a second send start.
  const sentAt = row.submittedAt ?? (data.startedAt ? new Date(data.startedAt) : row.createdAt)
  if (row.status === 'PUBLISHING' && now.getTime() - sentAt.getTime() < RECEIPT_DEADLINE_MS)
    throw new WorkspaceScopeError('This publication is still being sent. Wait for its result before you mark it checked.', 409)
}

/**
 * D3 — mark a publication that is still waiting for a result as checked by a person. Repeating it returns the first
 * check unchanged (no second event, no second audit row).
 */
export async function markPublicationChecked(productId: string, id: string, body: unknown, userId: string | null, now = new Date()): Promise<StudioPublicationCheck> {
  const raw = object(body).note
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new WorkspaceScopeError('The note must be text.', 400)
  const note = typeof raw === 'string' ? raw.trim() : ''
  if (note.length > CHECK_NOTE_MAX) throw new WorkspaceScopeError(`Keep the note to ${CHECK_NOTE_MAX} characters or fewer.`, 400)

  const { row, data } = await loadPublication(productId, id)
  if (checkedMark(row.summary)) return checkView(row, data, row.summary)
  refuseUnlessOpen(row, data, now)

  const mark = { checkedAt: now.toISOString(), checkedBy: userId, checkedNote: note || null }
  const summary = json({ ...object(row.summary), ...mark })
  const stored = await prisma.$transaction(async tx => {
    // The submit claim's own lock: a check and a new send to this destination never interleave.
    if (typeof data.publicationKey === 'string')
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `studio-publication:${data.publicationKey}`)
    // Compare-and-set on what was read: a result stored meanwhile (or another check) wins, and this one is re-decided.
    return tx.bulkOperation.updateMany({ where: { id, status: row.status, completedAt: null, summary: { equals: row.summary ?? Prisma.DbNull } },
      data: { completedAt: now, nextCheckAt: null, summary } })
  })
  if (stored.count !== 1) {
    const latest = await prisma.bulkOperation.findFirst({ where: { id }, select: PUBLICATION_SELECT })
    if (latest && checkedMark(latest.summary)) return checkView(latest, data, latest.summary)
    if (latest && !IN_FLIGHT.includes(latest.status)) throw new WorkspaceScopeError('This publication received its result while you were checking it. Open it to see the result.', 409)
    throw new WorkspaceScopeError('The publication changed while you were checking it. Try again.', 409)
  }

  announcePublication(id, row, data, row.status, { terminal: true })
  await auditLogService.write({ userId, entityType: 'BulkOperation', entityId: id, action: 'publication.mark_checked',
    before: { status: row.status, needsCheck: object(row.summary).needsCheck === true, completedAt: null },
    after: { status: row.status, completedAt: now.toISOString(), note: note || null },
    metadata: { productId: row.productId, channel: row.channel, marketplace: row.marketplace, accountId: row.channelConnectionId, aliasKey: row.aliasKey } })
  return checkView({ id, status: row.status }, data, summary)
}

type ResultRow = StudioPublishResult['results'][number]

/** The change id's product: ids are `["<productId>","<field>"]`. */
function changeParts(id: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(id)
    return Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' ? [parsed[0], parsed[1]] : null
  } catch { return null }
}

/** Every SKU the publication's own records tie to a product: the sent selection first, then the plan, then the review. */
function productBySku(data: Record<string, any>): Map<string, string> {
  const map = new Map<string, string>()
  const add = (rows: unknown) => {
    for (const entry of Array.isArray(rows) ? rows : rows ? [rows] : []) {
      const row = object(entry)
      if (typeof row.sku === 'string' && typeof row.productId === 'string' && !map.has(row.sku)) map.set(row.sku, row.productId)
    }
  }
  add(data.selection?.products); add(data.changePlan?.products); add(data.changePlan?.owner); add(data.changePlan?.publication?.products)
  add(data.review?.rows)
  return map
}

/** The SKU each product was reviewed under, for the response. */
function skuByProduct(bySku: Map<string, string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [sku, productId] of bySku) if (!map.has(productId)) map.set(productId, sku)
  return map
}

/** A channel attribute names a change field when it is the field, or the field's root (`bullet_point:["…","de_DE"]`). */
const namesField = (attribute: string, field: string) => field === attribute || field.startsWith(`${attribute}:`)

/**
 * "Publish failed products again…" — the failed products of a publication and the fields they carried. Refused while
 * the publication is still waiting for a result: which products failed is not known yet.
 */
export async function publicationRetrySelection(productId: string, id: string): Promise<StudioRetrySelection> {
  const { row, data } = await loadPublication(productId, id)
  if (row.status === 'PREVIEW') throw new WorkspaceScopeError('This review was never sent. Open Publish to review it again.', 409)
  if (IN_FLIGHT.includes(row.status)) throw new WorkspaceScopeError(checkedMark(row.summary)
    ? 'Nexus does not know which products failed in this publication. Open Publish to review the destination again.'
    : 'This publication is still waiting for a result. Check it before you publish again.', 409)

  const result = (data.result && typeof data.result === 'object' ? data.result : null) as StudioPublishResult | null
  const results: ResultRow[] = Array.isArray(result?.results) ? result!.results : []
  const scope = object(data.scope) as StudioPublishScope
  const aliasKey = String(data.delivery?.aliasKey ?? row.aliasKey ?? '')
  const destination = { channel: scope.channel, marketplace: scope.marketplace, accountId: scope.accountId,
    ...(scope.listingId ? { listingId: scope.listingId } : {}), aliasKey }

  const bySku = productBySku(data)
  const skuOf = skuByProduct(bySku)
  const selectedIds: string[] = Array.isArray(data.selection?.selectedIds) ? data.selection.selectedIds.filter((value: unknown): value is string => typeof value === 'string') : []
  // Nothing reached the channel: a refusal before sending stores FAILED with no per-product rows. Every delivered product failed.
  const notSent = row.status === 'FAILED' && !results.length
  const delivered: string[] = Array.isArray(data.delivery?.productIds) ? data.delivery.productIds
    : Array.isArray(data.selection?.products) ? data.selection.products.map((p: any) => p.productId) : []

  const failed = notSent
    ? delivered.map(productId => ({ productId, sku: skuOf.get(productId) ?? '', message: result?.message ?? null, attributeNames: [] as string[] }))
    : results.filter(entry => entry.status === 'FAILED' || (entry.status as string) === 'NOT_SENT').map(entry => ({
      productId: bySku.get(entry.sku) ?? null, sku: entry.sku, message: entry.message ?? null,
      attributeNames: [...new Set((entry.issues ?? []).flatMap(issue => issue.attributeNames ?? []))] }))
  const unmatchedSkus = failed.filter(entry => !entry.productId).map(entry => entry.sku)

  const products = new Map<string, StudioRetrySelection['products'][number]>()
  for (const entry of failed) {
    if (!entry.productId) continue
    const existing = products.get(entry.productId)
    const fieldIds = selectedIds.filter(changeId => changeParts(changeId)?.[0] === entry.productId)
    const attributeNames = [...new Set([...(existing?.attributeNames ?? []), ...entry.attributeNames])]
    const flaggedFieldIds = attributeNames.length ? fieldIds.filter(changeId => {
      const field = changeParts(changeId)![1]
      return CREATE_FIELDS.has(field) || attributeNames.some(attribute => namesField(attribute, field))
    }) : []
    products.set(entry.productId, { productId: entry.productId, sku: existing?.sku || entry.sku, message: existing?.message ?? entry.message,
      attributeNames, fieldIds, flaggedFieldIds })
  }
  const list = [...products.values()]
  return {
    publicationId: row.id, status: row.status as StudioPublishResult['status'], destination,
    productIds: list.map(product => product.productId),
    fieldIds: [...new Set(list.flatMap(product => product.fieldIds))],
    products: list, unmatchedSkus, notSent,
  }
}
