/**
 * MCP full control I11 — broken families and duplicate products, fixed only after a person approves (section 04 §3:
 * fix-parent, merge-duplicate-products). Nexus only: nothing is sent to a channel.
 *
 * fix-parent runs the family writers people use in Nexus (pim/product-relationship.service.ts: attachProduct,
 * reparentProduct, unlinkProducts, promoteProduct), with their own fences and guards (no nesting, no own parent, no
 * product with extra listings moved). Its preview runs the same writer in a transaction that is then rolled back, so
 * the preview is exactly the writer's verdict and nothing is kept. The one case the writers cannot express — a product
 * that names itself as its parent — is detached directly.
 *
 * merge-duplicate-products adopts an old eBay listing shell as an extra listing, or merges a duplicate that holds
 * nothing (services/identity/identity-merge.service.ts); anything else is refused, naming what blocks it.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import type { Prisma } from '@prisma/client'
import {
  ProductRelationshipError,
  attachProduct,
  promoteProduct,
  relationshipParent,
  relationshipTransaction,
  reparentProduct,
  unlinkProducts,
} from '../../pim/product-relationship.service.js'
import { IdentityMergeRefusal, previewMerge, runMerge, type MergePlan } from '../../identity/identity-merge.service.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'

const NEXUS_ONLY = 'Nexus only: nothing is sent to a channel.'
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)

// ── fix-parent ────────────────────────────────────────────────────────────────────────────────────────

const PARENT_ACTIONS = ['attach', 'move', 'detach', 'promote', 'lift-extra-listings'] as const
type ParentAction = (typeof PARENT_ACTIONS)[number]

interface ParentState { productId: string; sku: string; parentId: string | null; parentSku: string | null; isParent: boolean }

class DryRunRollback extends Error {
  constructor() {
    super('dry run')
  }
}

async function stateOf(productId: string): Promise<ParentState | null> {
  const p = await prisma.product.findFirst({ where: liveProduct(productId), select: { id: true, sku: true, parentId: true, isParent: true } })
  if (!p) return null
  // A deleted parent is not named (MCP.12): the preview says "(a deleted product)".
  const parent = p.parentId ? await prisma.product.findFirst({ where: liveProduct(p.parentId), select: { sku: true } }) : null
  return { productId: p.id, sku: p.sku, parentId: p.parentId, parentSku: parent?.sku ?? null, isParent: p.isParent }
}

/**
 * #9d — an extra listing always belongs to the family's parent: move every extra listing of a variation there. Its
 * listing rows stay the variation's (a variation's row points at its family's extra listing), so nothing on the channel
 * moves. A position the parent already uses on that coordinate is not reused.
 */
async function liftExtraListings(tx: Prisma.TransactionClient, state: ParentState): Promise<string[]> {
  if (!state.parentId || state.parentId === state.productId) throw new ProductRelationshipError(`${state.sku} is not a variation: its extra listings already sit on a family parent.`)
  await relationshipParent(tx, state.parentId)
  const aliases = await tx.productListingAlias.findMany({
    where: { productId: state.productId },
    select: { id: true, label: true, channel: true, marketplace: true, channelConnectionId: true, position: true },
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { position: 'asc' }],
  })
  if (!aliases.length) throw new ProductRelationshipError(`${state.sku} has no extra listings.`)
  for (const alias of aliases) {
    const taken = await tx.productListingAlias.findMany({
      where: { productId: state.parentId, channel: alias.channel, marketplace: alias.marketplace, channelConnectionId: alias.channelConnectionId },
      select: { position: true },
    })
    const used = new Set(taken.map((t) => t.position))
    const position = used.has(alias.position) ? Math.max(...used) + 1 : alias.position
    await tx.productListingAlias.update({ where: { id: alias.id }, data: { productId: state.parentId, position } })
  }
  return aliases.map((a) => a.label)
}

/**
 * The family writer for one action. `expectedParentId` is the parent read when the change was planned: a move or a
 * detach is refused by the writer when the product moved since.
 */
async function applyParent(action: ParentAction, state: ParentState, parentId: string | undefined, dryRun: boolean): Promise<void> {
  try {
    await relationshipTransaction(async (tx) => {
      if (action === 'attach') await attachProduct(tx, parentId!, state.productId, {})
      else if (action === 'move') await reparentProduct(tx, state.productId, parentId!, state.parentId ?? undefined)
      else if (action === 'promote') await promoteProduct(tx, state.productId)
      else if (action === 'lift-extra-listings') await liftExtraListings(tx, state)
      else if (state.parentId === state.productId) {
        // A product that names itself as its parent: the writers treat it as a parent of itself and refuse to detach.
        const moved = await tx.product.updateMany({ where: { id: state.productId, parentId: state.productId, deletedAt: null }, data: { parentId: null, version: { increment: 1 } } })
        if (moved.count !== 1) throw new ProductRelationshipError('This product changed after you reviewed it. Reload the family and confirm again.')
      } else await unlinkProducts(tx, [state.productId], state.parentId ?? undefined)
      if (dryRun) throw new DryRunRollback()
    })
  } catch (error) {
    if (error instanceof DryRunRollback) return
    throw error
  }
}

interface ParentPlan { action: ParentAction; before: ParentState; parent: { id: string; sku: string } | null; extraListings: string[] }

async function planParent(args: Record<string, unknown>, nothing: string): Promise<ParentPlan | { error: string }> {
  const action = args.action as ParentAction
  const before = await stateOf(String(args.productId ?? ''))
  if (!before) return { error: PRODUCT_NOT_FOUND }
  const parentId = typeof args.parentId === 'string' && args.parentId ? args.parentId : undefined
  if ((action === 'attach' || action === 'move') && !parentId) return { error: `${before.sku}: name the parent (parentId) to ${action} it to. ${nothing}` }
  let parent: { id: string; sku: string } | null = null
  if (parentId) {
    const p = await prisma.product.findFirst({ where: liveProduct(parentId), select: { id: true, sku: true } })
    if (!p) return { error: `${before.sku}: the parent product was not found. ${nothing}` }
    parent = p
  }
  if (action === 'attach' && before.parentId === parentId) return { error: `${before.sku} is already a variation of ${parent!.sku}. ${nothing}` }
  if (action === 'detach' && !before.parentId) return { error: `${before.sku} has no parent. ${nothing}` }
  if (action === 'promote' && before.isParent) return { error: `${before.sku} is already marked as a parent. ${nothing}` }
  try {
    await applyParent(action, before, parentId, true)
  } catch (error) {
    if (error instanceof ProductRelationshipError) return { error: `${before.sku}: ${error.message} ${nothing}` }
    throw error
  }
  let extraListings: string[] = []
  if (action === 'lift-extra-listings') {
    extraListings = (await prisma.productListingAlias.findMany({ where: { productId: before.productId }, select: { label: true }, orderBy: { label: 'asc' } })).map((a) => a.label)
    parent = before.parentId ? await prisma.product.findFirst({ where: liveProduct(before.parentId), select: { id: true, sku: true } }) : null
  }
  return { action, before, parent, extraListings }
}

function parentPreview(plan: ParentPlan) {
  const from = plan.before.parentSku ?? (plan.before.parentId ? '(a deleted product)' : null)
  const effect = {
    attach: `Makes ${plan.before.sku} a variation of ${plan.parent?.sku}.`,
    move: `Moves ${plan.before.sku} from ${from ?? 'no parent'} to ${plan.parent?.sku}.`,
    detach: `Makes ${plan.before.sku} a product of its own (no parent).`,
    promote: `Marks ${plan.before.sku} as a parent product.`,
    'lift-extra-listings': `Moves the extra listing${plan.extraListings.length === 1 ? '' : 's'} ${plan.extraListings.map((l) => `"${l}"`).join(', ')} of ${plan.before.sku} to its family parent ${plan.parent?.sku}; the listing rows stay where they are.`,
  }[plan.action]
  return {
    action: 'fix-parent',
    fix: plan.action,
    sku: plan.before.sku,
    changes: plan.action === 'promote'
      ? { 'is parent': { from: plan.before.isParent, to: true } }
      : plan.action === 'lift-extra-listings'
        ? { 'extra listings': { from: plan.before.sku, to: plan.parent?.sku ?? null } }
        : { parent: { from, to: plan.action === 'detach' ? null : plan.parent?.sku ?? null } },
    effect,
    note: `${NEXUS_ONLY} Its listings keep their channel ids: check them with product-identity afterwards. Nothing changes until a person approves this in Nexus.`,
  }
}

const FIX_PARENT_UNDO: ToolUndo = {
  async current(change) {
    const productId = String((change.after as { productId?: unknown } | null)?.productId ?? '')
    const p = await prisma.product.findFirst({ where: liveProduct(productId), select: { parentId: true, isParent: true } })
    return { productId, parentId: p?.parentId ?? null, isParent: p?.isParent ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: string; parentId?: string | null; isParent?: boolean; action?: ParentAction }
    const after = (change.after ?? {}) as { parentId?: string | null }
    if (!before.productId) return { refusal: 'This change does not name its product.' }
    if (before.action === 'promote') return { refusal: 'Marking a product as a parent is undone in Nexus (the family page: demote it), after checking its variations.' }
    if (before.action === 'lift-extra-listings') return { refusal: 'An extra listing belongs on the family parent; it is not moved back onto a variation.' }
    if (before.parentId === before.productId) return { refusal: 'It named itself as its parent before; that is not put back.' }
    if (!before.parentId) return { tool: 'fix-parent', args: { action: 'detach', productId: before.productId } }
    if (!after.parentId) return { tool: 'fix-parent', args: { action: 'attach', productId: before.productId, parentId: before.parentId } }
    return { tool: 'fix-parent', args: { action: 'move', productId: before.productId, parentId: before.parentId } }
  },
}

const fixParent: AgentTool = {
  name: 'fix-parent',
  title: 'Fix a product family',
  input: z.object({
    action: z.preprocess(lower, z.enum(PARENT_ACTIONS))
      .describe('attach (a product of its own becomes a variation of parentId), move (a variation goes to parentId), detach (a variation becomes a product of its own), promote (mark it as a parent), lift-extra-listings (a variation\'s extra listings move to its family parent)'),
    productId: z.string().trim().min(1).max(64).describe('Nexus product id of the product to fix'),
    parentId: z.string().trim().min(1).max(64).optional().describe('Nexus product id of the parent, for attach and move: a top-level parent product'),
  }),
  requires: [F.productsEdit, F.pimManage],
  category: 'products',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: FIX_PARENT_UNDO,
  description:
    `Fix a broken product family: attach a product to a parent, move a variation to another parent, detach it, mark a `
    + `product as a parent, or move a variation's extra listings to its family parent. ${NEXUS_ONLY} Always waits for a person to approve it in Nexus. The family writers' own rules `
    + 'hold: one level of families, no own parent, and a product with extra listings is not moved. Listings keep their '
    + 'channel ids. Undo puts the parent back (a promote is undone in Nexus).',
  async handler(args): Promise<ToolResult> {
    const plan = await planParent(args, 'Nothing was queued.')
    if ('error' in plan) return { ok: false, error: plan.error }
    return { ok: true, preview: parentPreview(plan) }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planParent(args, 'Nothing changed.')
    if ('error' in plan) return { ok: false, error: plan.error }
    try {
      await applyParent(plan.action, plan.before, plan.parent?.id, false)
    } catch (error) {
      if (error instanceof ProductRelationshipError) return { ok: false, error: `${plan.before.sku}: ${error.message} Nothing changed.` }
      throw error
    }
    const after = await stateOf(plan.before.productId)
    return {
      ok: true,
      data: { ...parentPreview(plan), note: NEXUS_ONLY },
      change: {
        before: { productId: plan.before.productId, sku: plan.before.sku, action: plan.action, parentId: plan.before.parentId, isParent: plan.before.isParent },
        after: { productId: plan.before.productId, parentId: after?.parentId ?? null, isParent: after?.isParent ?? null },
      },
    }
  },
}

// ── merge-duplicate-products ──────────────────────────────────────────────────────────────────────────

function mergePreview(plan: MergePlan) {
  if (plan.mode === 'adopt-shell') {
    return {
      action: 'merge-duplicate-products',
      mode: 'adopt-shell',
      sku: plan.keeper.sku,
      duplicate: plan.shell.sku,
      changes: { [`${plan.shell.sku} listing`]: { from: plan.shell.sku, to: `${plan.keeper.sku} (extra listing "${plan.shell.sku}")` } },
      plan,
      effect: `Adopts the ${plan.listing.channel} ${plan.listing.marketplace} listing${plan.listing.externalListingId ? ` (item ${plan.listing.externalListingId})` : ''} of the old shell ${plan.shell.sku} as an extra listing of ${plan.keeper.sku}, and moves ${plan.shell.sku} to the trash; its SKU then names ${plan.keeper.sku} (a SKU alias), so no order or stock file reaches the trashed shell.`,
      note: `${NEXUS_ONLY} The live item on the channel is untouched. Nothing changes until a person approves this in Nexus.`,
    }
  }
  return {
    action: 'merge-duplicate-products',
    mode: 'merge',
    sku: plan.keeper.sku,
    duplicate: plan.duplicate.sku,
    changes: { [plan.duplicate.sku]: { from: 'a product', to: `merged into ${plan.keeper.sku}` } },
    plan,
    effect: `Moves ${plan.duplicate.sku} to the trash${plan.newSkuAlias ? ` and keeps its SKU as a SKU alias of ${plan.keeper.sku}` : ''}${plan.skuAliases.length ? `; its ${plan.skuAliases.length} SKU alias(es) move to ${plan.keeper.sku}` : ''}. It holds no stock, orders, listings, shared links or ads. Its SKU, barcodes and old channel ids are released, so no order or stock file reaches the trashed product.`,
    note: `${NEXUS_ONLY} Nothing changes until a person approves this in Nexus.`,
  }
}

const mergeDuplicateProducts: AgentTool = {
  name: 'merge-duplicate-products',
  title: 'Merge a duplicate product',
  input: z.object({
    duplicateId: z.string().trim().min(1).max(64).describe('Nexus product id of the duplicate (or of an old eBay listing shell)'),
    keeperId: z.string().trim().min(1).max(64).describe('Nexus product id of the product to keep (for a shell: the family parent)'),
  }),
  requires: [F.productsEdit, F.productsDelete, F.listingsEdit],
  category: 'products',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  // Put back by a person in Nexus (restore from the trash; move an adopted listing back): no undo tool yet, so it is on
  // the contract's pending-undo list (tool-contract.vitest.test.ts UNDO_PENDING).
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  description:
    `Merge a duplicate product into the one to keep, in SAFE cases only. ${NEXUS_ONLY} Always waits for a person to approve `
    + 'it in Nexus. An old eBay listing shell is adopted: its one listing becomes an extra listing of the product kept. Any '
    + 'other duplicate is merged only when it holds nothing that could be lost — no stock, FBA units, orders, listings, '
    + 'shared-stock or catalogue links, ads, variations or extra listings — and its SKU then names the product kept. '
    + 'Otherwise it is refused, naming what blocks it. The duplicate goes to the trash, never deleted: a person restores it in Nexus.',
  async handler(args): Promise<ToolResult> {
    try {
      return { ok: true, preview: mergePreview(await previewMerge(String(args.duplicateId), String(args.keeperId))) }
    } catch (error) {
      if (error instanceof IdentityMergeRefusal) return { ok: false, error: error.message === PRODUCT_NOT_FOUND ? error.message : `${error.message} Nothing was queued.` }
      throw error
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const out = await runMerge(String(args.duplicateId), String(args.keeperId), { actor: ctx.userId ?? null })
      return {
        ok: true,
        data: { ...out, note: NEXUS_ONLY },
        change: {
          before: { mode: out.mode, duplicateId: out.duplicate.id, duplicateSku: out.duplicate.sku, keeperId: out.keeper.id, keeperSku: out.keeper.sku },
          after: { duplicateId: out.duplicate.id, merged: true },
        },
      }
    } catch (error) {
      if (error instanceof IdentityMergeRefusal) return { ok: false, error: error.message === PRODUCT_NOT_FOUND ? error.message : `${error.message} Nothing changed.` }
      throw error
    }
  },
}

export const IDENTITY_MERGE_TOOLS: AgentTool[] = [fixParent, mergeDuplicateProducts]
