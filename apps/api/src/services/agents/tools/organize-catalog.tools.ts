/**
 * MCP full control P7 — organizing the catalog: a product's tags, its workflow stage, and the person's saved views
 * (plan section 09 §4). Nexus only: nothing here reaches a marketplace or a buyer.
 *
 * Each is a change a person approves in Nexus (the gate), or one a business may let Claude run itself inside limits
 * (C5): a few tag changes on existing tags, one workflow stage forward, saving a view — never a new tag, a jump or a
 * deletion unless the business says so (`withinLimits`). The dry run (`handler`) writes nothing; `execute` plans the
 * change again in its business and writes it through the same code the pages use (services/products/tags.service.ts,
 * WorkflowService.moveStage, services/saved-views/persistence.service.ts). Every change records what it replaced
 * (`change.before`) and is undone through the same tool (`undo`), refused once the value moved since.
 *
 * Saved views belong to a person. The person is the one who ASKED (the approval's run), not the one who approved it:
 * a view Claude saves for Olga is Olga's, whoever clicks Approve.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { addProductTags, createTag, removeProductTag } from '../../products/tags.service.js'
import { workflowService } from '../../workflow.service.js'
import { deleteSavedView, SavedViewError, writeSavedView } from '../../saved-views/persistence.service.js'
import { buildProductWhereFromSavedView } from '../../saved-views/build-where.service.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

const ID = z.string().trim().min(1).max(64)
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || a.localeCompare(b)
const canonical = (value: unknown) => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v)

/**
 * The person a change is for: the one who asked for it (the approval's run) when an approval is being re-checked or
 * carried out, otherwise the caller. Never an argument: Claude cannot name a person.
 */
async function requesterOf(ctx: ToolContext): Promise<string | null> {
  if (ctx.approvalId) {
    const approval = await prisma.agentApproval.findUnique({
      where: { id: ctx.approvalId },
      select: { agentRun: { select: { userId: true } } },
    })
    if (approval?.agentRun?.userId) return approval.agentRun.userId
  }
  return ctx.userId ?? null
}

// ── set-product-tags ─────────────────────────────────────────────────────────────────────────────────

/** C1 — what Claude may change in a product's tags without a person, when a business lets it (C5). */
export const SET_PRODUCT_TAGS_LIMITS = z.object({
  maxTagChanges: z.number().int().min(1).max(50).default(5)
    .describe('the most tags one change may add and take off together'),
  allowNewTags: z.boolean().default(false)
    .describe('whether a change may create a tag the business does not have yet'),
})

interface TagsPreview {
  added?: string[]
  removed?: string[]
  newTags?: string[]
}

export function setProductTagsWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as TagsPreview | null
  if (!p || !Array.isArray(p.added) || !Array.isArray(p.removed)) return 'there is no tag change to judge'
  const changes = p.added.length + p.removed.length
  const max = Number(limits.maxTagChanges)
  if (!(changes <= max)) return `it makes ${changes} tag changes, more than the ${max} allowed without a person`
  if ((p.newTags?.length ?? 0) > 0 && limits.allowNewTags !== true) {
    return `it creates a new tag (${p.newTags!.join(', ')}), which needs a person`
  }
  return null
}

interface TagPlan {
  productId: string
  sku: string
  name: string
  from: string[]
  to: string[]
  added: string[]
  removed: string[]
  newTags: string[]
  /** Tag ids by name, for the tags that exist now. */
  tagIds: Map<string, string>
}

/** The product's tags now, and what the requested set changes. Reads only. */
async function planTags(args: Record<string, unknown>): Promise<TagPlan | { error: string }> {
  const productId = String(args.productId ?? '')
  const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { sku: true, name: true } })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const current = await prisma.productTag.findMany({ where: { productId }, select: { tag: { select: { id: true, name: true } } } })
  // One name per tag, the first spelling asked: "summer" and "SUMMER" are one request.
  const requested: string[] = []
  for (const raw of (args.tags as string[] | undefined) ?? []) {
    const name = raw.trim()
    if (name && !requested.some((seen) => seen.toLowerCase() === name.toLowerCase())) requested.push(name)
  }
  const existing = requested.length
    ? await prisma.tag.findMany({ where: { OR: requested.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })) }, select: { id: true, name: true } })
    : []
  const tagIds = new Map<string, string>()
  for (const row of [...current.map((c) => c.tag), ...existing]) tagIds.set(row.name, row.id)
  // A requested name takes the spelling of the tag the business already has.
  const to = requested.map((name) => existing.find((tag) => tag.name.toLowerCase() === name.toLowerCase())?.name ?? name).sort(byName)
  const from = current.map((c) => c.tag.name).sort(byName)
  const lower = (names: string[]) => new Set(names.map((name) => name.toLowerCase()))
  const fromSet = lower(from)
  const toSet = lower(to)
  return {
    productId,
    sku: product.sku,
    name: product.name,
    from,
    to,
    added: to.filter((name) => !fromSet.has(name.toLowerCase())),
    removed: from.filter((name) => !toSet.has(name.toLowerCase())),
    newTags: to.filter((name) => !existing.some((tag) => tag.name.toLowerCase() === name.toLowerCase()) && !fromSet.has(name.toLowerCase())),
    tagIds,
  }
}

const tagsUnchanged = (plan: TagPlan) =>
  `Nothing to change: ${plan.sku} already carries exactly these tags (${plan.from.join(', ') || 'none'}).`

/** C2 — undo of set-product-tags: give the product the tags it had, through set-product-tags itself. */
export const SET_PRODUCT_TAGS_UNDO: ToolUndo = {
  async current(change) {
    const productId = String((change.after as { productId?: unknown } | null)?.productId ?? '')
    const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { id: true } })
    if (!product) return { productId, tags: null }
    const rows = await prisma.productTag.findMany({ where: { productId }, select: { tag: { select: { name: true } } } })
    return { productId, tags: rows.map((row) => row.tag.name).sort(byName) }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: string; tags?: unknown }
    if (!before.productId || !Array.isArray(before.tags)) return { refusal: 'This change does not name its product and its tags.' }
    return { tool: 'set-product-tags', args: { productId: before.productId, tags: before.tags } }
  },
}

const setProductTags: AgentTool = {
  name: 'set-product-tags',
  title: 'Set product tags',
  category: 'products',
  description:
    'Give a product exactly this set of tags (Nexus tags, used to filter and group products; they do not reach a '
    + 'marketplace): tags not named are taken off, and a name the business has no tag for yet creates that tag. The '
    + 'preview shows the tags before and after. Waits for a person to approve it in Nexus, unless the business lets '
    + 'Claude make small tag changes itself. Undoable.',
  input: z.object({
    productId: ID.describe('Nexus product id'),
    tags: z.array(z.string().trim().min(1).max(64)).max(50)
      .describe('the tag names the product should carry after the change: the whole set (an empty list takes every tag off)'),
  }),
  requires: [F.productsEdit],
  riskTier: 'low',
  readOnly: false,
  // A person approves it unless the business lets Claude run it inside its limits (C5); no policy loosens that.
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: SET_PRODUCT_TAGS_LIMITS,
  withinLimits: setProductTagsWithinLimits,
  undo: SET_PRODUCT_TAGS_UNDO,
  async handler(args): Promise<ToolResult> {
    const plan = await planTags(args)
    if ('error' in plan) return { ok: false, error: plan.error }
    if (!plan.added.length && !plan.removed.length) return { ok: false, error: tagsUnchanged(plan) }
    return {
      ok: true,
      preview: {
        action: 'set-product-tags',
        productId: plan.productId,
        sku: plan.sku,
        product: plan.name,
        changes: { tags: { from: plan.from, to: plan.to } },
        added: plan.added,
        removed: plan.removed,
        newTags: plan.newTags,
        note: 'Nexus only: tags filter and group products and are not sent to a marketplace. Undoable.',
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planTags(args)
    if ('error' in plan) return { ok: false, error: plan.error }
    if (!plan.added.length && !plan.removed.length) return { ok: false, error: tagsUnchanged(plan) }
    const after = await inDatabaseTransaction(prisma, async () => {
      const ids = new Map(plan.tagIds)
      for (const name of plan.newTags) {
        // Created by someone else since the plan: use theirs (a failed insert would end the transaction).
        const row = await prisma.tag.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } })
        ids.set(name, row?.id ?? (await createTag({ name })).id)
      }
      await addProductTags(plan.productId, plan.added.map((name) => ids.get(name)!).filter(Boolean))
      for (const name of plan.removed) await removeProductTag(plan.productId, ids.get(name)!)
      const rows = await prisma.productTag.findMany({ where: { productId: plan.productId }, select: { tag: { select: { name: true } } } })
      return rows.map((row) => row.tag.name).sort(byName)
    })
    return {
      ok: true,
      data: { sku: plan.sku, tags: after, added: plan.added, removed: plan.removed, created: plan.newTags },
      change: {
        before: { productId: plan.productId, sku: plan.sku, tags: plan.from },
        after: { productId: plan.productId, tags: after },
      },
    }
  },
}

// ── move-workflow-stage ──────────────────────────────────────────────────────────────────────────────

/** C1 — how far Claude may move a product through its workflow without a person, when a business lets it (C5). */
export const MOVE_WORKFLOW_STAGE_LIMITS = z.object({
  maxSteps: z.number().int().min(1).max(20).default(1).describe('the most stages one move may pass, forward or back'),
  allowBackward: z.boolean().default(false).describe('whether a move may go back to an earlier stage'),
  allowTerminal: z.boolean().default(false).describe('whether a move may reach the workflow\'s last (terminal) stage'),
})

interface StagePreview {
  steps?: unknown
  terminal?: unknown
}

export function moveWorkflowStageWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as StagePreview | null
  if (!p || typeof p.steps !== 'number') return 'there is no stage move to judge'
  const max = Number(limits.maxSteps)
  if (p.steps < 0 && limits.allowBackward !== true) return 'it moves the product back to an earlier stage, which needs a person'
  if (!(Math.abs(p.steps) <= max)) return `it moves the product ${Math.abs(p.steps)} stages, more than the ${max} allowed without a person`
  if (p.terminal === true && limits.allowTerminal !== true) return 'it moves the product to the last stage of its workflow, which needs a person'
  return null
}

interface StageRef { id: string; label: string }
interface StagePlan {
  productId: string
  sku: string
  workflow: string
  from: StageRef
  to: StageRef & { terminal: boolean; publishable: boolean }
  steps: number
}

async function planMove(args: Record<string, unknown>): Promise<StagePlan | { error: string }> {
  const productId = String(args.productId ?? '')
  const product = await prisma.product.findFirst({
    where: liveProduct(productId),
    select: { sku: true, workflowStage: { select: { id: true, label: true, workflowId: true, workflow: { select: { label: true } } } } },
  })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  // The product's own state first: a product on no workflow cannot move, whatever stage is named.
  const current = product.workflowStage
  if (!current) {
    return { error: `${product.sku} is on no workflow yet: put it on a workflow in Nexus first (its first stage), then it can be moved.` }
  }
  const stage = await prisma.workflowStage.findFirst({
    where: { id: String(args.stageId ?? '') },
    select: { id: true, label: true, workflowId: true, isTerminal: true, isPublishable: true, workflow: { select: { label: true } } },
  })
  if (!stage) return { error: 'Workflow stage not found' }
  if (current.workflowId !== stage.workflowId) {
    return { error: `${product.sku} is on the ${current.workflow.label} workflow; ${stage.label} is a stage of ${stage.workflow.label}. A product moves within its own workflow only.` }
  }
  if (current.id === stage.id) return { error: `Nothing to change: ${product.sku} is already at ${stage.label}.` }
  // The workflow's stages in their order: how many a move passes, and which way.
  const order = await prisma.workflowStage.findMany({
    where: { workflowId: stage.workflowId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })
  const index = (id: string) => order.findIndex((row) => row.id === id)
  return {
    productId,
    sku: product.sku,
    workflow: stage.workflow.label,
    from: { id: current.id, label: current.label },
    to: { id: stage.id, label: stage.label, terminal: stage.isTerminal, publishable: stage.isPublishable },
    steps: index(stage.id) - index(current.id),
  }
}

/** C2 — undo of move-workflow-stage: move the product back to the stage it left, through the same tool. */
export const MOVE_WORKFLOW_STAGE_UNDO: ToolUndo = {
  async current(change) {
    const productId = String((change.after as { productId?: unknown } | null)?.productId ?? '')
    const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { workflowStageId: true } })
    return { productId, stageId: product?.workflowStageId ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: string; stageId?: string | null }
    if (!before.productId || !before.stageId) return { refusal: 'The product was on no workflow stage before this change, so there is no stage to move it back to.' }
    return { tool: 'move-workflow-stage', args: { productId: before.productId, stageId: before.stageId, comment: 'Undo of an earlier move' } }
  },
}

const moveWorkflowStage: AgentTool = {
  name: 'move-workflow-stage',
  title: 'Move workflow stage',
  category: 'products',
  description:
    'Move a product to another stage of its product workflow (for example from Draft to Review), with an optional '
    + 'comment; the move is written to the product\'s workflow history. Nexus only. The preview shows the stage before '
    + 'and after and how many stages it passes. Waits for a person to approve it in Nexus, unless the business lets '
    + 'Claude move products one stage forward itself. Undoable.',
  input: z.object({
    productId: ID.describe('Nexus product id'),
    stageId: ID.describe('the stage to move the product to (catalog-structure kind=workflows lists the stages)'),
    comment: z.string().trim().min(1).max(500).optional().describe('a note kept with the move in the workflow history'),
  }),
  requires: [F.pimManage],
  riskTier: 'low',
  readOnly: false,
  // A person approves it unless the business lets Claude run it inside its limits (C5); no policy loosens that.
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: MOVE_WORKFLOW_STAGE_LIMITS,
  withinLimits: moveWorkflowStageWithinLimits,
  undo: MOVE_WORKFLOW_STAGE_UNDO,
  async handler(args): Promise<ToolResult> {
    const plan = await planMove(args)
    if ('error' in plan) return { ok: false, error: plan.error }
    return {
      ok: true,
      preview: {
        action: 'move-workflow-stage',
        productId: plan.productId,
        sku: plan.sku,
        workflow: plan.workflow,
        changes: { stage: { from: plan.from, to: { id: plan.to.id, label: plan.to.label } } },
        steps: plan.steps,
        terminal: plan.to.terminal,
        publishable: plan.to.publishable,
        comment: (args.comment as string | undefined) ?? null,
        note: 'Nexus only: the workflow stage is not sent to a marketplace. Undoable.',
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planMove(args)
    if ('error' in plan) return { ok: false, error: plan.error }
    const moved = await workflowService.moveStage(plan.productId, plan.to.id, {
      userId: await requesterOf(ctx),
      comment: (args.comment as string | undefined) ?? null,
    })
    return {
      ok: true,
      data: { sku: plan.sku, from: plan.from.label, to: plan.to.label, transitionId: moved.transitionId },
      change: {
        before: { productId: plan.productId, sku: plan.sku, stageId: plan.from.id, stage: plan.from.label },
        after: { productId: plan.productId, stageId: plan.to.id },
      },
    }
  },
}

// ── save-view ────────────────────────────────────────────────────────────────────────────────────────

/** The surface Claude saves views on: the products list, whose filters are plain (build-where.service.ts). */
const VIEW_SURFACE = 'products'
const COMPARISONS = ['GT', 'LT', 'CHANGE_ABS', 'CHANGE_PCT'] as const
const DEFAULT_COOLDOWN = 60
const LIST = z.array(z.string().trim().min(1).max(100)).max(50)

/** The product filters a view applies: the canonical keys of SavedViewFiltersInput. Unknown keys are dropped. */
const FILTERS = z.object({
  search: z.string().trim().max(200).optional().describe('text the product name or SKU contains'),
  status: LIST.optional().describe('product statuses, e.g. ACTIVE, DRAFT, INACTIVE'),
  channel: LIST.optional().describe('channels the product is listed on, e.g. AMAZON, EBAY'),
  marketplace: LIST.optional().describe('market codes, e.g. IT, DE'),
  productTypes: LIST.optional().describe('product types'),
  brands: LIST.optional().describe('brands'),
  tags: LIST.optional().describe('tag names'),
  fulfillment: LIST.optional().describe('fulfillment methods, e.g. FBA, FBM'),
  stockLevel: z.enum(['in', 'low', 'out']).optional().describe('in stock, low (1–5), or out of stock'),
  hasPhotos: z.boolean().optional().describe('only products with photos (true) or without (false)'),
})

const ALERT = z.object({
  comparison: z.enum(COMPARISONS).describe('GT/LT: the number of products in the view goes above/below the threshold; CHANGE_ABS/CHANGE_PCT: it moves by that much'),
  threshold: z.coerce.number().min(0).max(1_000_000).describe('the number (or percent, for CHANGE_PCT) that fires the alert'),
  cooldownMinutes: z.coerce.number().int().min(1).max(10_080).optional().describe(`minutes before it may fire again (default ${DEFAULT_COOLDOWN})`),
})

interface AlertSnapshot { comparison: string; threshold: number; cooldownMinutes: number; active: boolean }
interface ViewSnapshot { name: string; filters: Record<string, unknown>; alert: AlertSnapshot | null }

/** C1 — what Claude may do with a person's saved views without a person, when a business lets it (C5). */
export const SAVE_VIEW_LIMITS = z.object({
  allowRemove: z.boolean().default(false).describe('whether a change may delete a saved view'),
})

export function saveViewWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const mode = (preview as { mode?: unknown } | null)?.mode
  if (mode !== 'create' && mode !== 'update' && mode !== 'remove') return 'there is no saved-view change to judge'
  if (mode === 'remove' && limits.allowRemove !== true) return 'it deletes a saved view, which needs a person'
  return null
}

/** The person's own view on the products list, with their alert on it. */
async function ownView(id: string, owner: string) {
  const view = await prisma.savedView.findFirst({ where: { id, userId: owner, surface: VIEW_SURFACE } })
  if (!view) return null
  const alert = await prisma.savedViewAlert.findFirst({ where: { savedViewId: id, userId: owner }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return { view, alert }
}

const alertSnapshot = (alert: { comparison: string; threshold: unknown; cooldownMinutes: number; isActive: boolean } | null): AlertSnapshot | null =>
  alert ? { comparison: alert.comparison, threshold: Number(alert.threshold), cooldownMinutes: alert.cooldownMinutes, active: alert.isActive } : null

const asFilters = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

interface ViewPlan {
  mode: 'create' | 'update' | 'remove'
  owner: string
  savedViewId: string | null
  from: ViewSnapshot | null
  to: ViewSnapshot | null
  /** The person's alert row on the view now, when there is one. */
  alertId: string | null
}

async function planView(args: Record<string, unknown>, ctx: ToolContext): Promise<ViewPlan | { error: string }> {
  const owner = await requesterOf(ctx)
  if (!owner) return { error: 'A saved view belongs to a person: a signed-in person must ask for it.' }
  const id = args.savedViewId as string | undefined
  const name = args.name as string | undefined
  const filters = args.filters as Record<string, unknown> | undefined
  const alertArg = args.alert as z.infer<typeof ALERT> | null | undefined
  const nextAlert = (current: AlertSnapshot | null): AlertSnapshot | null =>
    alertArg === undefined ? current
      : alertArg === null ? (current ? { ...current, active: false } : null)
        : { comparison: alertArg.comparison, threshold: alertArg.threshold, cooldownMinutes: alertArg.cooldownMinutes ?? current?.cooldownMinutes ?? DEFAULT_COOLDOWN, active: true }
  const nameTaken = async (wanted: string, except: string | null) =>
    !!(await prisma.savedView.findFirst({ where: { userId: owner, surface: VIEW_SURFACE, name: wanted, ...(except ? { id: { not: except } } : {}) }, select: { id: true } }))

  if (!id) {
    if (args.remove === true) return { error: 'Name the view to delete (savedViewId).' }
    if (!name) return { error: 'Name the new view (name).' }
    if (await nameTaken(name, null)) return { error: `You already have a view named "${name}": name its savedViewId to change it.` }
    return { mode: 'create', owner, savedViewId: null, from: null, to: { name, filters: filters ?? {}, alert: nextAlert(null) }, alertId: null }
  }
  const found = await ownView(id, owner)
  if (!found) return { error: 'Saved view not found' }
  const from: ViewSnapshot = { name: found.view.name, filters: asFilters(found.view.filters), alert: alertSnapshot(found.alert) }
  if (args.remove === true) return { mode: 'remove', owner, savedViewId: id, from, to: null, alertId: found.alert?.id ?? null }
  const to: ViewSnapshot = { name: name ?? from.name, filters: filters ?? from.filters, alert: nextAlert(from.alert) }
  if (canonical(to) === canonical(from)) return { error: `Nothing to change: your view "${from.name}" already has these settings.` }
  if (to.name !== from.name && (await nameTaken(to.name, id))) return { error: `You already have a view named "${to.name}".` }
  return { mode: 'update', owner, savedViewId: id, from, to, alertId: found.alert?.id ?? null }
}

/** The person's alert on a view, as the view should have it: created, changed, or switched off. */
async function writeAlert(viewId: string, owner: string, name: string, filters: Record<string, unknown>, alertId: string | null, alert: AlertSnapshot | null) {
  if (!alert) return
  if (alertId) {
    await prisma.savedViewAlert.update({
      where: { id: alertId },
      data: { comparison: alert.comparison, threshold: alert.threshold, cooldownMinutes: alert.cooldownMinutes, isActive: alert.active },
    })
    return
  }
  // As POST /saved-views/:viewId/alerts: the baseline is today's count, so a CHANGE_* alert fires on movement.
  const count = await prisma.product.count({ where: await buildProductWhereFromSavedView(prisma as never, filters as never) })
  await prisma.savedViewAlert.create({
    data: {
      savedViewId: viewId, userId: owner, name, comparison: alert.comparison, threshold: alert.threshold,
      cooldownMinutes: alert.cooldownMinutes, isActive: alert.active, baselineCount: count, lastCount: count, lastCheckedAt: new Date(),
    },
  })
}

/** C2 — undo of save-view: a created view is deleted, a deleted one saved again, a changed one set back. */
export const SAVE_VIEW_UNDO: ToolUndo = {
  async current(change) {
    const savedViewId = String((change.after as { savedViewId?: unknown } | null)?.savedViewId ?? '')
    const view = await prisma.savedView.findFirst({ where: { id: savedViewId, surface: VIEW_SURFACE } })
    if (!view) return { savedViewId, view: null }
    const alert = await prisma.savedViewAlert.findFirst({ where: { savedViewId, userId: view.userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    return { savedViewId, view: { name: view.name, filters: asFilters(view.filters), alert: alertSnapshot(alert) } }
  },
  request(change) {
    const before = (change.before ?? {}) as { savedViewId?: string | null; view?: ViewSnapshot | null }
    const after = (change.after ?? {}) as { savedViewId?: string; view?: ViewSnapshot | null }
    const alertArgs = (alert: AlertSnapshot | null | undefined) =>
      alert ? (alert.active ? { comparison: alert.comparison, threshold: alert.threshold, cooldownMinutes: alert.cooldownMinutes } : null) : undefined
    if (!before.view) {
      if (!after.savedViewId) return { refusal: 'This change does not name the view it saved.' }
      return { tool: 'save-view', args: { savedViewId: after.savedViewId, remove: true } }
    }
    const old = before.view
    const alert = alertArgs(old.alert)
    if (!after.view) return { tool: 'save-view', args: { name: old.name, filters: old.filters, ...(alert ? { alert } : {}) } }
    return {
      tool: 'save-view',
      args: { savedViewId: after.savedViewId, name: old.name, filters: old.filters, ...(alert !== undefined ? { alert } : after.view.alert ? { alert: null } : {}) },
    }
  },
}

const saveView: AgentTool = {
  name: 'save-view',
  title: 'Save a product view',
  category: 'products',
  description:
    'Save a view of the products list for the person asking: a name and the filters it applies (status, channel, '
    + 'market, brand, tags, stock level, …), and optionally an alert when the number of products in it crosses a '
    + 'threshold. Change one of their views by its savedViewId (alert: null switches its alert off), or delete it '
    + '(remove). Only the person\'s own views. The preview shows the view before and after. Waits for a person to '
    + 'approve it in Nexus, unless the business lets Claude save views itself (never a deletion). Undoable.',
  input: z.object({
    savedViewId: ID.optional().describe('one of your saved views to change (saved-views lists them); omit to save a new view'),
    name: z.string().trim().min(1).max(120).optional().describe('the view\'s name (needed for a new view)'),
    filters: FILTERS.optional().describe('the product filters the view applies; replaces the view\'s filters'),
    alert: ALERT.nullable().optional().describe('an alert on the number of products in the view; null switches your alert on it off'),
    remove: z.boolean().optional().describe('true deletes this view (savedViewId)'),
  }),
  requires: [F.productsEdit, F.settingsNotificationsEdit],
  riskTier: 'low',
  readOnly: false,
  // A person approves it unless the business lets Claude run it inside its limits (C5); no policy loosens that.
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: SAVE_VIEW_LIMITS,
  withinLimits: saveViewWithinLimits,
  undo: SAVE_VIEW_UNDO,
  async handler(args, ctx): Promise<ToolResult> {
    const plan = await planView(args, ctx)
    if ('error' in plan) return { ok: false, error: plan.error }
    const filters = plan.to?.filters ?? plan.from?.filters ?? {}
    const products = await prisma.product.count({ where: await buildProductWhereFromSavedView(prisma as never, filters as never) })
    return {
      ok: true,
      preview: {
        action: 'save-view',
        mode: plan.mode,
        savedViewId: plan.savedViewId,
        changes: { view: { from: plan.from, to: plan.to } },
        // How many products the view finds today (not a fact the approval depends on: it moves with the catalog).
        productsInView: products,
        note: plan.mode === 'remove'
          ? 'Deletes the view and its alert. Undo saves it again.'
          : 'Nexus only: a saved view of the products list for the person asking. Undoable.',
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planView(args, ctx)
    if ('error' in plan) return { ok: false, error: plan.error }
    try {
      if (plan.mode === 'remove') {
        await deleteSavedView(plan.owner, plan.savedViewId!)
        return {
          ok: true,
          data: { removed: plan.from!.name },
          change: { before: { savedViewId: plan.savedViewId, view: plan.from }, after: { savedViewId: plan.savedViewId, view: null } },
        }
      }
      const to = plan.to!
      const saved = await writeSavedView(plan.owner, plan.savedViewId, { name: to.name, surface: VIEW_SURFACE, filters: to.filters })
      await writeAlert(saved.id, plan.owner, to.name, to.filters, plan.alertId, to.alert)
      return {
        ok: true,
        data: { savedViewId: saved.id, name: to.name, mode: plan.mode },
        change: { before: { savedViewId: plan.savedViewId, view: plan.from }, after: { savedViewId: saved.id, view: to } },
      }
    } catch (error) {
      if (error instanceof SavedViewError) return { ok: false, error: error.message }
      throw error
    }
  },
}

export const ORGANIZE_CATALOG_TOOLS: AgentTool[] = [setProductTags, moveWorkflowStage, saveView]
