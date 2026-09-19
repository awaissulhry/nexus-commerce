/**
 * AE.3b — confirming a first copy, and finishing it.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §16.2. Everything here runs in the FOLLOWER's
 * business; the only read of the owner's data is copy-source.service.ts.
 *
 *   confirmCopy   Review 1 is re-computed and must still match what the owner saw (fingerprint).
 *                 Then: record the run → create the missing definitions → map the rows to this
 *                 business (category ids by path, dropped conflicting attributes, only included
 *                 SKUs) → stage a catalog-transfer job. Review 2 is that job's own review.
 *   advanceCopyRun When the transfer job has finished, link every product the job saved, set the
 *                 owner-managed fields the share offers, copy the images (copy-media.service.ts), and
 *                 record the result. Idempotent: an existing link is kept, a missing one is created, a
 *                 managed field that already holds the value is not written again, and an image the
 *                 product already holds is reused — so a PARTIAL run can be finished again and only
 *                 what is missing is done.
 *
 * A run never deletes or overwrites anything outside the transfer engine's reviewed apply. Created
 * definitions stay when a run fails: they are additive and the next run reuses them.
 */
import { Prisma } from '@prisma/client'
import { transferTargetKey, type TransferRow } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { WorkspaceError, requireWorkspace, withWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { categoryTreeService } from '../category-tree.service.js'
import { masterPriceService } from '../master-price.service.js'
import { masterStatusService } from '../master-status.service.js'
import { readTransferJob, stageTransferJob, transferJobStatus } from '../pim/catalog-transfer-jobs.js'
import { createWorkspaceService } from '../workspace.service.js'
import { copyImages, type PlannedImage } from './copy-media.service.js'
import type { ManagedFields, OfferedCatalog } from './copy-source.service.js'
import { previewCopy, type CopyPreview } from './copy-preview.service.js'

const workspaces = createWorkspaceService(prisma)

export type RunState = 'preparing' | 'reviewing' | 'finishing' | 'done' | 'partial' | 'failed' | 'abandoned'

interface PlannedProduct {
  sku: string
  sourceProductId: string
  sourceVersion: number
  kind: 'new' | 'match'
  parentSku: string | null
  managed: ManagedFields
  /** The images confirmed in Review 1 (only when media was offered). */
  images: PlannedImage[]
  /** Videos, 3D models and documents: not copied in this phase. */
  mediaNotCopied: number
}
interface RunPlan { products: PlannedProduct[]; skipped: Array<{ sku: string; reason: string }>; droppedAttributes: string[] }
interface RunCounts {
  linked: number; alreadyLinked: number; notSaved: number; linkRefused: number; managedApplied: number; managedFailed: number
  imagesCopied: number; imagesReused: number; imagesAddressed: number; imagesFailed: number; mediaNotCopied: number
}

export interface CopyRunView {
  id: string
  shareId: string
  market: string
  state: RunState
  transferJobId: string | null
  transferJob: ReturnType<typeof transferJobStatus> | null
  plan: RunPlan
  definitionsCreated: unknown
  counts: RunCounts | null
  error: string | null
  createdAt: Date
  finishedAt: Date | null
}

const JSON_NULL = Prisma.JsonNull
const asJson = (value: unknown) => (value === null || value === undefined ? JSON_NULL : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue))

function actingOwner() {
  const context = requireWorkspace()
  if (!context.actorUserId) throw new WorkspaceError('session_required', 'Sign in as an owner of this business profile to copy shared products.', 403)
  return { workspaceId: context.workspaceId, actorUserId: context.actorUserId }
}

// ── Confirm ────────────────────────────────────────────────────────────────────

export async function confirmCopy(input: { shareId: string; market?: unknown; fingerprint?: unknown; skuChoices?: unknown }): Promise<CopyRunView> {
  const { workspaceId, actorUserId } = actingOwner()
  await workspaces.requireOwner(actorUserId, workspaceId)
  const { preview, catalog } = await previewCopy({ shareId: input.shareId, market: String(input.market ?? '') })
  if (typeof input.fingerprint !== 'string' || input.fingerprint !== preview.fingerprint) {
    throw Object.assign(new WorkspaceError('copy_review_changed', 'What this copy brings in has changed since you reviewed it. Review it again.', 409), { preview })
  }
  const choices = normaliseChoices(input.skuChoices, preview)
  const plan = planProducts(preview, catalog, choices)
  if (plan.products.length === 0) throw new WorkspaceError('nothing_to_copy', 'Nothing to copy: every product is already linked, skipped or blocked.', 409)

  const run = await prisma.assortmentCopyRun.create({
    data: {
      shareId: preview.shareId, market: preview.market, state: 'preparing', reviewFingerprint: preview.fingerprint,
      skuChoices: asJson(choices), plan: asJson(plan), createdByUserId: actorUserId,
    },
    select: { id: true },
  })
  try {
    const definitionsCreated = await createDefinitions(catalog, preview)
    await prisma.assortmentCopyRun.update({ where: { id: run.id }, data: { definitionsCreated: asJson(definitionsCreated), version: { increment: 1 } } })
    const rows = await mapRows(catalog, plan)
    const owner = await prisma.workspace.findUnique({ where: { id: catalog.source.ownerWorkspaceId }, select: { name: true } })
    const staged = await stageTransferJob({
      rows, issues: [], mode: 'upsert', market: preview.market, userId: actorUserId,
      filename: `Shared by ${owner?.name ?? 'another business'} (${plan.products.length} products)`,
    })
    await prisma.assortmentCopyRun.update({ where: { id: run.id }, data: { transferJobId: staged.jobId, state: 'reviewing', version: { increment: 1 } } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.assortmentCopyRun.update({ where: { id: run.id }, data: { state: 'failed', error: message.slice(0, 1000), finishedAt: new Date(), version: { increment: 1 } } })
    throw error
  }
  return getCopyRun(run.id)
}

/** Every SKU that already exists needs a choice; a missing choice means skip. Unknown SKUs are refused. */
function normaliseChoices(value: unknown, preview: CopyPreview): Record<string, 'link' | 'skip'> {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new WorkspaceError('invalid_choices', 'Choose link or skip for each product whose SKU already exists.', 400)
  }
  const given = (value ?? {}) as Record<string, unknown>
  const matches = new Set(preview.products.filter((p) => p.kind === 'match').map((p) => p.sku))
  for (const [sku, choice] of Object.entries(given)) {
    if (!matches.has(sku)) throw new WorkspaceError('invalid_choices', `${sku} is not a product whose SKU already exists in this business.`, 400)
    if (choice !== 'link' && choice !== 'skip') throw new WorkspaceError('invalid_choices', `Choose link or skip for ${sku}.`, 400)
  }
  return Object.fromEntries([...matches].map((sku) => [sku, given[sku] === 'link' ? 'link' : 'skip']))
}

/** Which products this run copies. A variation follows its parent: skipped or blocked parent → skipped. */
function planProducts(preview: CopyPreview, catalog: OfferedCatalog, choices: Record<string, 'link' | 'skip'>): RunPlan {
  const bySku = new Map(catalog.products.map((p) => [p.sku, p]))
  const outcome = new Map(preview.products.map((p) => [p.sku, p]))
  const included = new Set<string>()
  const skipped: RunPlan['skipped'] = []
  // Parents come first in the preview, so a variation always sees its parent's verdict.
  for (const p of preview.products) {
    if (p.parentSku && !included.has(p.parentSku) && outcome.get(p.parentSku)?.kind !== 'linked') {
      skipped.push({ sku: p.sku, reason: `its parent ${p.parentSku} is not copied` })
      continue
    }
    if (p.kind === 'linked') continue
    if (p.kind === 'blocked') { skipped.push({ sku: p.sku, reason: p.reason }); continue }
    if (p.kind === 'match' && choices[p.sku] !== 'link') { skipped.push({ sku: p.sku, reason: 'skipped: its SKU already exists in this business' }); continue }
    included.add(p.sku)
  }
  const products: PlannedProduct[] = [...included].map((sku) => {
    const source = bySku.get(sku)!
    const media = catalog.images.filter((image) => image.productId === source.id)
    const images = media.filter((image) => image.mediaType === 'IMAGE').map((image): PlannedImage => ({
      id: image.id, url: image.url, alt: image.alt, type: image.type, isPrimary: image.isPrimary, sortOrder: image.sortOrder,
      width: image.width, height: image.height, mimeType: image.mimeType, fileSize: image.fileSize,
    }))
    return {
      sku, sourceProductId: source.id, sourceVersion: source.version, kind: outcome.get(sku)!.kind as 'new' | 'match', parentSku: source.parentSku,
      managed: source.managed, images, mediaNotCopied: media.length - images.length,
    }
  })
  return { products, skipped, droppedAttributes: preview.conflicts.filter((c) => c.kind === 'attribute_type').map((c) => c.code) }
}

// ── Definitions ────────────────────────────────────────────────────────────────

async function createDefinitions(catalog: OfferedCatalog, preview: CopyPreview) {
  const created = { attributeGroups: [] as string[], attributes: [] as string[], options: [] as string[], families: [] as string[], familyAttributes: [] as string[], categories: [] as string[] }
  const conflicting = new Set(preview.conflicts.map((c) => c.code))
  await prisma.$transaction(async (tx) => {
    for (const group of catalog.attributeGroups) {
      const row = await tx.attributeGroup.createMany({ data: [{ code: group.code, label: group.label, description: group.description, sortOrder: group.sortOrder }], skipDuplicates: true })
      if (row.count) created.attributeGroups.push(group.code)
    }
    const groupIds = new Map((await tx.attributeGroup.findMany({ where: { code: { in: catalog.attributeGroups.map((g) => g.code) } }, select: { id: true, code: true } })).map((g) => [g.code, g.id]))
    for (const attribute of catalog.attributes) {
      if (conflicting.has(attribute.code)) continue
      const groupId = groupIds.get(attribute.groupCode)
      if (!groupId) throw new WorkspaceError('definition_missing', `The attribute group ${attribute.groupCode} is missing.`, 409)
      const row = await tx.customAttribute.createMany({
        data: [{
          code: attribute.code, label: attribute.label, description: attribute.description, groupId, type: attribute.type,
          validation: asJson(attribute.validation), defaultValue: asJson(attribute.defaultValue), localizable: attribute.localizable, scope: attribute.scope, sortOrder: attribute.sortOrder,
        }],
        skipDuplicates: true,
      })
      if (row.count) created.attributes.push(attribute.code)
    }
    const attributeIds = new Map((await tx.customAttribute.findMany({ where: { code: { in: catalog.attributes.map((a) => a.code) } }, select: { id: true, code: true } })).map((a) => [a.code, a.id]))
    for (const attribute of catalog.attributes) {
      if (conflicting.has(attribute.code) || attribute.options.length === 0) continue
      const rows = await tx.attributeOption.createMany({
        data: attribute.options.map((o) => ({ attributeId: attributeIds.get(attribute.code)!, code: o.code, label: o.label, metadata: asJson(o.metadata), sortOrder: o.sortOrder })),
        skipDuplicates: true,
      })
      if (rows.count) created.options.push(`${attribute.code}: ${rows.count}`)
    }
    for (const family of catalog.families) {
      const row = await tx.productFamily.createMany({ data: [{ code: family.code, label: family.label, description: family.description }], skipDuplicates: true })
      if (row.count) created.families.push(family.code)
    }
    const familyIds = new Map((await tx.productFamily.findMany({ where: { code: { in: catalog.families.map((f) => f.code) } }, select: { id: true, code: true, parentFamilyId: true } })).map((f) => [f.code, f]))
    for (const family of catalog.families) {
      const own = familyIds.get(family.code)!
      // Only a family this run created takes the source's parent; an existing family keeps its own.
      if (family.parentCode && created.families.includes(family.code) && !own.parentFamilyId) {
        await tx.productFamily.update({ where: { id: own.id }, data: { parentFamilyId: familyIds.get(family.parentCode)?.id ?? null } })
      }
      for (const link of family.attributes) {
        const attributeId = attributeIds.get(link.code)
        if (!attributeId || conflicting.has(link.code)) continue
        const row = await tx.familyAttribute.createMany({ data: [{ familyId: own.id, attributeId, required: link.required, channels: link.channels, sortOrder: link.sortOrder }], skipDuplicates: true })
        if (row.count) created.familyAttributes.push(`${family.code}.${link.code}`)
      }
    }
  }, { timeout: 30_000, maxWait: 10_000 })

  // Categories through the category service: it keeps the ancestor table and takes the tree lock.
  const byPath = new Map(catalog.categories.map((c) => [c.path.join('/'), c]))
  for (const missing of preview.create.categories) {
    let parentId: string | null = null
    for (let depth = 1; depth <= missing.path.length; depth++) {
      const slug = missing.path[depth - 1]
      const existing: { id: string } | null = await prisma.category.findFirst({ where: { parentId, slug }, select: { id: true } })
      if (existing) { parentId = existing.id; continue }
      const definition = byPath.get(missing.path.slice(0, depth).join('/'))
      const node = await categoryTreeService.create({
        parentId, slug, code: definition?.code ?? null, name: (definition?.name ?? undefined) as never,
        description: (definition?.description ?? undefined) as never, attributes: (definition?.attributes ?? undefined) as never,
        sortOrder: definition?.sortOrder ?? 0, isActive: definition?.isActive ?? true,
      })
      created.categories.push(missing.path.slice(0, depth).join('/'))
      parentId = node.id
    }
  }
  return created
}

/** The source rows, made valid in this business. */
async function mapRows(catalog: OfferedCatalog, plan: RunPlan): Promise<TransferRow[]> {
  const included = new Set(plan.products.map((p) => p.sku))
  const dropped = new Set(plan.droppedAttributes)
  const categories = await prisma.category.findMany({ select: { id: true, parentId: true, slug: true } })
  const idByPath = new Map<string, string>()
  const byId = new Map(categories.map((c) => [c.id, c]))
  for (const c of categories) {
    const path: string[] = []
    for (let at: typeof c | undefined = c; at; at = at.parentId ? byId.get(at.parentId) : undefined) path.unshift(at.slug)
    idByPath.set(path.join('/'), c.id)
  }
  const products = new Map(catalog.products.map((p) => [p.sku, p]))
  // A variation keeps INHERITING its language text in the follower, as it does in the owner. The export
  // attaches the parent's text to that row (R-LX-8), and the engine then stores the text on the variation
  // whenever the parent is not part of this job — which it is not once the parent was linked by an
  // earlier copy. In a linked copy the parent is always in the follower, so the row goes without the
  // text: the variation inherits, and one that had its own translation has it cleared.
  const rows: TransferRow[] = []
  for (const row of catalog.rows) {
    if (!included.has(row.sku) || row.entity !== 'Products' || dropped.has(row.field)) continue
    if (row.locale && row.action === 'INHERIT') {
      rows.push({ ...row, value: undefined })
      continue
    }
    if (row.field === 'categoryIds' && row.action === 'SET') {
      const ids = (products.get(row.sku)?.categoryPaths ?? []).map((path) => idByPath.get(path.join('/'))).filter((id): id is string => !!id).sort()
      rows.push({ ...row, value: ids })
      continue
    }
    if (row.field === 'primaryCategoryId' && row.action === 'SET') {
      const path = products.get(row.sku)?.primaryCategoryPath
      const id = path ? idByPath.get(path.join('/')) : undefined
      rows.push(id ? { ...row, value: id } : { ...row, action: 'INHERIT', value: undefined })
      continue
    }
    rows.push(row)
  }
  return rows
}

// ── Finish ─────────────────────────────────────────────────────────────────────

export async function getCopyRun(runId: string): Promise<CopyRunView> {
  const { workspaceId } = requireWorkspace()
  const run = await prisma.assortmentCopyRun.findFirst({ where: { id: runId, workspaceId } })
  if (!run) throw new WorkspaceError('copy_run_not_found', 'This copy is unavailable in this business profile.', 404)
  const job = run.transferJobId ? await readTransferJob(run.transferJobId, run.createdByUserId) : null
  return {
    id: run.id, shareId: run.shareId, market: run.market, state: run.state as RunState, transferJobId: run.transferJobId,
    transferJob: job ? transferJobStatus(job) : null, plan: run.plan as unknown as RunPlan, definitionsCreated: run.definitionsCreated,
    counts: run.counts as unknown as RunCounts | null, error: run.error, createdAt: run.createdAt, finishedAt: run.finishedAt,
  }
}

/**
 * Moves a run forward if its transfer job has finished. Safe to call any number of times, from the
 * status poll or the sweeper. Runs as the person who confirmed the copy, so the database re-checks that
 * they are still an owner and the share is still active before any link is written.
 */
export async function advanceCopyRun(runId: string): Promise<CopyRunView> {
  const { workspaceId } = requireWorkspace()
  const run = await prisma.assortmentCopyRun.findFirst({ where: { id: runId, workspaceId } })
  if (!run) throw new WorkspaceError('copy_run_not_found', 'This copy is unavailable in this business profile.', 404)
  // A partial run may be finished again: every step below skips what is already done.
  if (!['reviewing', 'finishing', 'partial'].includes(run.state) || !run.transferJobId) return getCopyRun(runId)
  const job = await readTransferJob(run.transferJobId, run.createdByUserId)
  const jobState = job?.job.status
  if (!job || ['FAILED', 'INVALID'].includes(jobState ?? '')) {
    await prisma.assortmentCopyRun.updateMany({ where: { id: run.id, version: run.version }, data: { state: 'abandoned', error: job ? `The product review ${jobState?.toLowerCase()}.` : 'The product review no longer exists.', finishedAt: new Date(), version: { increment: 1 } } })
    return getCopyRun(runId)
  }
  if (!['COMPLETED', 'PARTIAL'].includes(jobState ?? '')) return getCopyRun(runId)

  // Claim the finish step so two callers cannot both run it.
  const claimed = await prisma.assortmentCopyRun.updateMany({ where: { id: run.id, version: run.version, state: run.state }, data: { state: 'finishing', version: { increment: 1 } } })
  if (!claimed.count) return getCopyRun(runId)

  const plan = run.plan as unknown as RunPlan
  const counts: RunCounts = {
    linked: 0, alreadyLinked: 0, notSaved: 0, linkRefused: 0, managedApplied: 0, managedFailed: 0,
    imagesCopied: 0, imagesReused: 0, imagesAddressed: 0, imagesFailed: 0, mediaNotCopied: 0,
  }
  const problems: string[] = []
  await withWorkspace({ workspaceId, actorUserId: run.createdByUserId, membershipId: null, roleKeys: [] }, async () => {
    const outcomes = await prisma.importJobRow.findMany({
      where: { jobId: run.transferJobId!, targetId: { in: plan.products.map((p) => transferTargetKey({ entity: 'Products', sku: p.sku, channel: '', accountId: '', marketplace: '', aliasKey: '' })) } },
      select: { targetId: true, status: true },
    })
    const saved = new Set(outcomes.filter((o) => o.status === 'SUCCESS').map((o) => (JSON.parse(o.targetId ?? '[]') as string[])[1]))
    const share = await prisma.assortmentShare.findUnique({ where: { id: run.shareId }, select: { ownerWorkspaceId: true } })
    for (const planned of plan.products) {
      if (!saved.has(planned.sku)) { counts.notSaved++; continue }
      const product = await prisma.product.findFirst({ where: { workspaceId, sku: planned.sku, deletedAt: null }, select: { id: true } })
      if (!product) { counts.notSaved++; continue }
      const existing = await prisma.catalogLink.findFirst({ where: { targetWorkspaceId: workspaceId, targetProductId: product.id, status: 'active' }, select: { shareId: true, sourceProductId: true } })
      if (existing) {
        if (existing.shareId === run.shareId && existing.sourceProductId === planned.sourceProductId) counts.alreadyLinked++
        else { counts.linkRefused++; problems.push(`${planned.sku}: already follows another shared product`) }
      } else {
        try {
          await prisma.catalogLink.create({
            data: {
              shareId: run.shareId, sourceWorkspaceId: share!.ownerWorkspaceId, sourceProductId: planned.sourceProductId,
              targetWorkspaceId: workspaceId, targetProductId: product.id, linkedBy: planned.kind === 'new' ? 'created' : 'matched',
              sourceVersion: planned.sourceVersion, createdByUserId: run.createdByUserId,
            },
          })
          counts.linked++
        } catch (error) {
          counts.linkRefused++
          problems.push(`${planned.sku}: ${error instanceof Error ? error.message.split('\n').pop() : String(error)}`)
          continue
        }
      }
      const applied = await applyManaged(product.id, planned.managed, run.id)
      counts.managedApplied += applied.applied
      counts.managedFailed += applied.failed.length
      problems.push(...applied.failed.map((f) => `${planned.sku}: ${f}`))

      const media = await copyImages(product.id, planned.images ?? [])
      counts.imagesCopied += media.copied
      counts.imagesReused += media.reused
      counts.imagesAddressed += media.addressed
      counts.imagesFailed += media.failed.length
      counts.mediaNotCopied += planned.mediaNotCopied ?? 0
      problems.push(...media.failed.map((f) => `${planned.sku}: ${f}`))
      // Image copies take time. Keep the claim fresh so the sweeper does not hand this run to another worker.
      await prisma.assortmentCopyRun.updateMany({ where: { id: run.id, state: 'finishing' }, data: { updatedAt: new Date() } })
    }
  })
  const state: RunState = counts.notSaved + counts.linkRefused + counts.managedFailed + counts.imagesFailed === 0 ? 'done' : 'partial'
  await prisma.assortmentCopyRun.update({
    where: { id: run.id },
    data: { state, counts: asJson(counts), error: problems.length ? problems.slice(0, 50).join('\n') : null, finishedAt: new Date(), version: { increment: 1 } },
  })
  return getCopyRun(runId)
}

/**
 * Owner-managed fields, through their owning services, only for groups the share offered. A field that
 * already holds the shared value is not written: a finish run again adds no price history or status event.
 */
async function applyManaged(productId: string, managed: ManagedFields, runId: string): Promise<{ applied: number; failed: string[] }> {
  let applied = 0
  const failed: string[] = []
  const attempt = async (label: string, work: () => Promise<unknown>) => {
    try { await work(); applied++ } catch (error) { failed.push(`${label}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const reason = `assortment-copy:${runId}`
  const current = await prisma.product.findUnique({
    where: { id: productId },
    select: { productType: true, basePrice: true, minPrice: true, maxPrice: true, b2bPrice: true, b2bMinQty: true, status: true },
  })
  if (!current) return { applied, failed: ['the product is no longer available'] }
  const amount = (value: unknown) => (value === null || value === undefined ? null : Number(value))
  if (managed.productType !== undefined && current.productType !== managed.productType) {
    await attempt('product type', () => prisma.product.update({ where: { id: productId }, data: { productType: managed.productType, version: { increment: 1 } } }))
  }
  if (managed.basePrice !== undefined) {
    if (amount(current.basePrice) !== amount(managed.basePrice)) {
      await attempt('price', () => masterPriceService.update(productId, Number(managed.basePrice), { reason }))
    }
    const extra = { minPrice: managed.minPrice, maxPrice: managed.maxPrice, b2bPrice: managed.b2bPrice, b2bMinQty: managed.b2bMinQty }
    const limitsDiffer = (['minPrice', 'maxPrice', 'b2bPrice', 'b2bMinQty'] as const).some((key) => amount(current[key]) !== amount(extra[key]))
    if (limitsDiffer) await attempt('price limits', () => prisma.product.update({ where: { id: productId }, data: { ...extra, version: { increment: 1 } } }))
  }
  if (managed.status !== undefined && current.status !== managed.status) {
    await attempt('status', () => masterStatusService.update(productId, managed.status as never, { reason } as never))
  }
  return { applied, failed }
}

export interface CopyRunSummary {
  id: string
  state: RunState
  market: string
  products: number
  skipped: number
  counts: RunCounts | null
  error: string | null
  createdAt: Date
  finishedAt: Date | null
}

/** This business's copy runs for one share, newest first: the list under an incoming share. */
export async function listCopyRuns(shareId: string): Promise<CopyRunSummary[]> {
  const { workspaceId } = requireWorkspace()
  const runs = await prisma.assortmentCopyRun.findMany({
    where: { workspaceId, shareId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, state: true, market: true, plan: true, counts: true, error: true, createdAt: true, finishedAt: true },
  })
  return runs.map((run) => {
    const plan = run.plan as unknown as RunPlan
    return {
      id: run.id, state: run.state as RunState, market: run.market, products: plan.products.length, skipped: plan.skipped.length,
      counts: run.counts as unknown as RunCounts | null, error: run.error, createdAt: run.createdAt, finishedAt: run.finishedAt,
    }
  })
}

/** One indexed read: is anything waiting to be finished in this business? */
export async function hasOpenCopyRuns(): Promise<boolean> {
  const { workspaceId } = requireWorkspace()
  return (await prisma.assortmentCopyRun.count({ where: { workspaceId, state: { in: ['reviewing', 'finishing'] } } })) > 0
}

/** For the sweeper: runs in this business whose transfer job may have finished. */
export async function advanceOpenCopyRuns(): Promise<{ checked: number; finished: number }> {
  const { workspaceId } = requireWorkspace()
  const open = await prisma.assortmentCopyRun.findMany({ where: { workspaceId, state: { in: ['reviewing', 'finishing'] } }, select: { id: true, state: true, updatedAt: true }, take: 25, orderBy: { updatedAt: 'asc' } })
  let finished = 0
  for (const run of open) {
    // A "finishing" run older than ten minutes lost its worker; hand it back to "reviewing" once.
    if (run.state === 'finishing' && Date.now() - run.updatedAt.getTime() > 10 * 60_000) {
      await prisma.assortmentCopyRun.updateMany({ where: { id: run.id, state: 'finishing', updatedAt: run.updatedAt }, data: { state: 'reviewing' } })
    }
    try {
      const after = await advanceCopyRun(run.id)
      if (['done', 'partial', 'abandoned'].includes(after.state)) finished++
    } catch (error) {
      logger.warn('assortment-copy: advancing a run failed', { runId: run.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { checked: open.length, finished }
}
