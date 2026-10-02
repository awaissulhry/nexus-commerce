/**
 * MCP full control 07 O7 — the order desk's own changes, inside Nexus only (no buyer and no channel is told):
 * `update-order` (a note, tags, mark delivered), `update-customer` (a note, tags, the manual risk review) and
 * `triage-reviews` (status, assignee, tags, note of several reviews).
 *
 * Every one waits for a person (or, where a business allows it, runs inside its limits), writes through the services
 * the Nexus pages use (orders/order-update, customers/customer-update, reviews/review-triage), runs in the caller's
 * business only, refuses a run whose approval no longer describes the world (stale-preview.ts), records what it
 * changed, and has an undo: the inverse request through the same gate. Marking an order delivered is the one part that
 * is not taken back from Claude (it may already have started the order's review request).
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { addOrderNote, deleteOrderNote, markOrderDelivered, orderTagNames, setOrderTags } from '../../orders/order-update.service.js'
import { addCustomerNote, deleteCustomerNote, MANUAL_REVIEW_STATES, setCustomerTags, setManualReviewState } from '../../customers/customer-update.service.js'
import { TRIAGE_STATUSES, triageReview } from '../../reviews/review-triage.service.js'
import { staleRefusal } from './stale-preview.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const isoDate = z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), 'a date, e.g. 2026-09-30 or 2026-09-30T12:00:00Z')
const flag = z.preprocess((value) => (value === 'true' ? true : value === 'false' ? false : value), z.boolean())
const tagList = (what: string) => z.array(z.string().trim().min(1).max(60)).min(1).max(10).optional().describe(what)
const excerpt = (text: string | null | undefined, chars = 80) => (!text ? null : text.length > chars ? `${text.slice(0, chars)}…` : text)
const sorted = (names: Iterable<string>) => [...new Set(names)].sort()
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

/** Runs the tool's own dry run again and refuses when what the person approved has moved. */
async function freshOrStale(preview: () => Promise<ToolResult>, ctx: ToolContext, fields: string[], what: string) {
  const fresh = await preview()
  if (!fresh.ok) return { refusal: fresh as ToolResult }
  const stale = staleRefusal(ctx.approvedPreview, fresh.preview, fields, what)
  return stale ? { refusal: { ok: false, error: stale } as ToolResult } : { fresh }
}

// ── update-order ────────────────────────────────────────────────────────────────────────────────────

const ORDER_FINAL = ['CANCELLED', 'REFUNDED', 'RETURNED']

const updateOrderInput = z.object({
  orderId: z.string().trim().min(1).max(64).describe('Nexus order id (from order-search)'),
  note: z.string().trim().min(1).max(2000).optional().describe('a note to add to the order, for the team (the buyer never sees it)'),
  pinNote: flag.optional().describe('pin that note to the top of the order'),
  removeNoteId: z.string().trim().min(1).max(64).optional().describe("the id of one of the order's notes to delete"),
  addTags: tagList("tag names to put on the order; only the business's existing tags"),
  removeTags: tagList('tag names to take off the order'),
  markDelivered: flag.optional().describe('true = mark the order delivered (manual delivery; starts its review-request timing)'),
  deliveredAt: isoDate.optional().describe('when it was delivered (with markDelivered; default: when the change runs); not in the future'),
})
type UpdateOrderArgs = z.infer<typeof updateOrderInput>

/** C2 — update-order's undo: the note removed again (or put back), the tags as they were; a delivered mark is refused. */
const UPDATE_ORDER_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as Record<string, any>
    const orderId = String(after.orderId ?? '')
    const now: Record<string, unknown> = { orderId }
    if ('noteId' in after) now.noteId = after.noteId && (await prisma.orderNote.count({ where: { id: after.noteId, orderId } })) ? after.noteId : null
    if ('removedNoteId' in after) now.removedNoteId = (await prisma.orderNote.count({ where: { id: after.removedNoteId, orderId } })) ? null : after.removedNoteId
    if ('tags' in after) now.tags = await orderTagNames(orderId)
    if ('delivered' in after) {
      const order = await prisma.order.findFirst({ where: { id: orderId }, select: { status: true, deliveredAtSource: true } })
      now.delivered = order?.status === 'DELIVERED' && order.deliveredAtSource === 'MANUAL'
    }
    return now
  },
  request(change) {
    const before = (change.before ?? {}) as Record<string, any>
    const after = (change.after ?? {}) as Record<string, any>
    if (!after.orderId) return { refusal: 'This change does not name its order.' }
    if (after.delivered) {
      return { refusal: 'Marking an order delivered is not taken back from Claude: it may already have started the order\'s review request. Change the order in Nexus.' }
    }
    const args: Record<string, unknown> = { orderId: after.orderId }
    if (after.noteId) args.removeNoteId = after.noteId
    if (before.removedNote?.body) {
      args.note = before.removedNote.body
      if (before.removedNote.pinned) args.pinNote = true
    }
    if (Array.isArray(before.tags) && Array.isArray(after.tags)) {
      const addBack = before.tags.filter((name: string) => !after.tags.includes(name))
      const takeOff = after.tags.filter((name: string) => !before.tags.includes(name))
      if (addBack.length) args.addTags = addBack
      if (takeOff.length) args.removeTags = takeOff
    }
    return Object.keys(args).length > 1 ? { tool: 'update-order', args } : { refusal: 'This change left nothing to put back.' }
  },
}

const updateOrder: AgentTool = {
  name: 'update-order',
  title: 'Update an order',
  input: updateOrderInput,
  requires: [F.ordersEdit],
  category: 'orders',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  undo: UPDATE_ORDER_UNDO,
  description:
    'Change an order inside Nexus: add a note (or delete one), put on or take off existing tags, or mark it delivered. '
    + 'The buyer and the channel are not told. Waits for a person to approve it in Nexus. Undo puts the note and the tags '
    + 'back; a delivered mark is not taken back from here.',
  handler: (args) => previewUpdateOrder(args as UpdateOrderArgs),
  async execute(args, ctx) {
    const a = args as UpdateOrderArgs
    const checked = await freshOrStale(() => previewUpdateOrder(a), ctx, ['changes'], 'the order')
    if ('refusal' in checked) return checked.refusal
    return runUpdateOrder(a, (checked.fresh.preview as { changes: Record<string, any> }).changes, ctx)
  },
}

/** update-order's dry run: what it would change, each part with its starting value. */
async function previewUpdateOrder(a: UpdateOrderArgs): Promise<ToolResult> {
  const order = await prisma.order.findFirst({
    where: { id: a.orderId, deletedAt: null },
    select: { id: true, channel: true, channelOrderId: true, status: true, deliveredAt: true },
  })
  if (!order) return { ok: false, error: 'Order not found' }
  if (!a.note && !a.removeNoteId && !a.addTags && !a.removeTags && !a.markDelivered) {
    return { ok: false, error: 'Name at least one change: note, removeNoteId, addTags, removeTags or markDelivered. Nothing was queued.' }
  }
  const changes: Record<string, unknown> = {}
  if (a.note) changes.note = { add: a.note, pinned: a.pinNote ?? false }
  if (a.removeNoteId) {
    const note = await prisma.orderNote.findFirst({ where: { id: a.removeNoteId, orderId: order.id }, select: { id: true, body: true } })
    if (!note) return { ok: false, error: 'Note not found on this order. Nothing was queued.' }
    changes.removeNote = { id: note.id, text: excerpt(note.body) }
  }
  if (a.addTags || a.removeTags) {
    const known = a.addTags?.length ? await prisma.tag.findMany({ where: { name: { in: a.addTags } }, select: { name: true } }) : []
    const unknown = (a.addTags ?? []).filter((name) => !known.some((tag) => tag.name === name))
    if (unknown.length) return { ok: false, error: `No such tag in this business: ${unknown.join(', ')}. Create it in Nexus first. Nothing was queued.` }
    const from = await orderTagNames(order.id)
    const to = sorted([...from, ...(a.addTags ?? [])].filter((name) => !(a.removeTags ?? []).includes(name)))
    if (to.join('\u0000') !== from.join('\u0000')) changes.tags = { from, to }
  }
  if (a.markDelivered) {
    if (ORDER_FINAL.includes(order.status)) return { ok: false, error: `This order is ${order.status}: it is not marked delivered. Nothing was queued.` }
    if (order.status === 'DELIVERED') return { ok: false, error: 'This order is already delivered. Nothing was queued.' }
    if (a.deliveredAt && Date.parse(a.deliveredAt) > Date.now() + 60_000) return { ok: false, error: 'deliveredAt cannot be in the future. Nothing was queued.' }
    changes.delivered = {
      from: { status: order.status, deliveredAt: iso(order.deliveredAt) },
      to: { status: 'DELIVERED', deliveredAt: a.deliveredAt ? new Date(a.deliveredAt).toISOString() : 'when the change runs' },
    }
  }
  if (!Object.keys(changes).length) return { ok: false, error: 'The order already is as asked. Nothing was queued.' }
  return {
    ok: true,
    preview: {
      action: 'update-order',
      order: { id: order.id, channel: order.channel, channelOrderId: order.channelOrderId, status: order.status },
      changes,
      note: 'Changes this order in Nexus only: the buyer and the channel are not told.'
        + (changes.delivered ? ' Marking it delivered starts its review-request timing and is not taken back from Claude.' : ''),
    },
  }
}

/** update-order's run: each part the approved preview names, through the Orders page's own writes. */
async function runUpdateOrder(a: UpdateOrderArgs, changes: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
  const before: Record<string, unknown> = { orderId: a.orderId }
  const after: Record<string, unknown> = { orderId: a.orderId }
  if (changes.removeNote) {
    const note = await prisma.orderNote.findFirst({ where: { id: a.removeNoteId!, orderId: a.orderId }, select: { body: true, pinned: true } })
    if (!note || !(await deleteOrderNote(a.orderId, a.removeNoteId!))) return { ok: false, error: 'Note not found on this order. Nothing changed.' }
    before.removedNote = { body: note.body, pinned: note.pinned }
    after.removedNoteId = a.removeNoteId
  }
  if (changes.note) {
    const added = await addOrderNote(a.orderId, { body: a.note, pinned: a.pinNote ?? false, authorUserId: ctx.userId ?? null })
    if (added.status !== 'created') return { ok: false, error: 'Order not found' }
    after.noteId = added.note.id
  }
  if (changes.tags) {
    before.tags = changes.tags.from
    const result = await setOrderTags(a.orderId, a.addTags ?? [], a.removeTags ?? [])
    if (result.unknown.length) return { ok: false, error: `No such tag in this business: ${result.unknown.join(', ')}.` }
    after.tags = result.tags
  }
  if (changes.delivered) {
    before.delivered = changes.delivered.from
    const order = await markOrderDelivered(a.orderId, a.deliveredAt ? new Date(a.deliveredAt) : new Date())
    if (!order) return { ok: false, error: 'Order not found' }
    after.delivered = true
  }
  return { ok: true, data: { orderId: a.orderId, done: Object.keys(changes) }, change: { before, after } }
}

// ── update-customer ─────────────────────────────────────────────────────────────────────────────────

const REVIEW_CHOICES = [...MANUAL_REVIEW_STATES, 'NONE'] as const

const updateCustomerInput = z.object({
  customerId: z.string().trim().min(1).max(200).describe('Nexus customer id (from customer-lookup)'),
  note: z.string().trim().min(1).max(2000).optional().describe('a note to add to the customer, for the team'),
  pinNote: flag.optional().describe('pin that note to the top'),
  removeCustomerNoteId: z.string().trim().min(1).max(64).optional().describe("the id of one of the customer's notes to delete"),
  addTags: tagList('tags to add to the customer'),
  removeTags: tagList('tags to take off the customer'),
  manualReview: z.enum(REVIEW_CHOICES).optional()
    .describe('the manual risk review: PENDING, APPROVED, REJECTED, or NONE to clear it'),
})
type UpdateCustomerArgs = z.infer<typeof updateCustomerInput>

/** C5 — what Claude may change on a customer without a person, when a business allows it. */
export const UPDATE_CUSTOMER_LIMITS = z.object({
  maxTagChanges: z.number().int().min(0).max(20).default(5).describe('the most tags added and removed in one change'),
  allowManualReview: z.boolean().default(false).describe('whether the manual risk review may change without a person'),
  allowNoteRemoval: z.boolean().default(false).describe('whether a note may be deleted without a person'),
})

export function updateCustomerWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  if (!(preview as { changes?: unknown } | null)?.changes) return 'there is no preview of the change to judge'
  const changes = ((preview as { changes?: Record<string, any> } | null)?.changes ?? {}) as Record<string, any>
  if (changes.manualReview && limits.allowManualReview !== true) return 'it changes the manual risk review, which you keep for a person'
  if (changes.removeNote && limits.allowNoteRemoval !== true) return 'it deletes a note, which you keep for a person'
  if (changes.tags) {
    const moved = changes.tags.to.filter((t: string) => !changes.tags.from.includes(t)).length + changes.tags.from.filter((t: string) => !changes.tags.to.includes(t)).length
    if (moved > Number(limits.maxTagChanges)) return `it changes ${moved} tags, more than the ${limits.maxTagChanges} allowed without a person`
  }
  return null
}

/** C2 — update-customer's undo: the note removed again (or put back), the tags and the manual review as they were. */
const UPDATE_CUSTOMER_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as Record<string, any>
    const customerId = String(after.customerId ?? '')
    const customer = await prisma.customer.findFirst({ where: { id: customerId }, select: { tags: true, manualReviewState: true } })
    const now: Record<string, unknown> = { customerId }
    if ('noteId' in after) now.noteId = after.noteId && (await prisma.customerNote.count({ where: { id: after.noteId, customerId } })) ? after.noteId : null
    if ('removedNoteId' in after) now.removedNoteId = (await prisma.customerNote.count({ where: { id: after.removedNoteId, customerId } })) ? null : after.removedNoteId
    if ('tags' in after) now.tags = sorted(customer?.tags ?? [])
    if ('manualReview' in after) now.manualReview = customer?.manualReviewState ?? 'NONE'
    return now
  },
  request(change) {
    const before = (change.before ?? {}) as Record<string, any>
    const after = (change.after ?? {}) as Record<string, any>
    if (!after.customerId) return { refusal: 'This change does not name its customer.' }
    const args: Record<string, unknown> = { customerId: after.customerId }
    if (after.noteId) args.removeCustomerNoteId = after.noteId
    if (before.removedNote?.body) {
      args.note = before.removedNote.body
      if (before.removedNote.pinned) args.pinNote = true
    }
    if (Array.isArray(before.tags) && Array.isArray(after.tags)) {
      const addBack = before.tags.filter((t: string) => !after.tags.includes(t))
      const takeOff = after.tags.filter((t: string) => !before.tags.includes(t))
      if (addBack.length) args.addTags = addBack
      if (takeOff.length) args.removeTags = takeOff
    }
    if ('manualReview' in before) args.manualReview = before.manualReview
    return Object.keys(args).length > 1 ? { tool: 'update-customer', args } : { refusal: 'This change left nothing to put back.' }
  },
}

const updateCustomer: AgentTool = {
  name: 'update-customer',
  title: 'Update a customer',
  input: updateCustomerInput,
  requires: [F.customersEdit],
  category: 'orders',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: UPDATE_CUSTOMER_LIMITS,
  withinLimits: updateCustomerWithinLimits,
  undo: UPDATE_CUSTOMER_UNDO,
  description:
    'Change a customer record inside Nexus: add a note (or delete one), add or remove tags, or set the manual risk '
    + 'review (PENDING, APPROVED, REJECTED, NONE). Nothing reaches the customer. Waits for a person to approve it in '
    + 'Nexus unless the business lets it run inside its limits. Undo puts everything back.',
  handler: (args) => previewUpdateCustomer(args),
  async execute(args, ctx) {
    const a = args as UpdateCustomerArgs
    const checked = await freshOrStale(() => previewUpdateCustomer(args), ctx, ['changes'], 'the customer')
    if ('refusal' in checked) return checked.refusal
    const changes = (checked.fresh.preview as { changes: Record<string, any> }).changes
    const before: Record<string, unknown> = { customerId: a.customerId }
    const after: Record<string, unknown> = { customerId: a.customerId }
    if (changes.removeNote) {
      const note = await prisma.customerNote.findFirst({ where: { id: a.removeCustomerNoteId!, customerId: a.customerId }, select: { body: true, pinned: true } })
      if (!note || !(await deleteCustomerNote(a.customerId, a.removeCustomerNoteId!))) return { ok: false, error: 'Note not found on this customer. Nothing changed.' }
      before.removedNote = { body: note.body, pinned: note.pinned }
      after.removedNoteId = a.removeCustomerNoteId
    }
    if (changes.note) {
      const added = await addCustomerNote(a.customerId, { body: a.note, pinned: a.pinNote ?? false, authorUserId: ctx.userId ?? null })
      if (added.status !== 'created') return { ok: false, error: 'Customer not found' }
      after.noteId = added.note.id
    }
    if (changes.tags) {
      before.tags = changes.tags.from
      after.tags = sorted((await setCustomerTags(a.customerId, changes.tags.to)).tags)
    }
    if (changes.manualReview) {
      before.manualReview = changes.manualReview.from
      const updated = await setManualReviewState(a.customerId, changes.manualReview.to === 'NONE' ? null : changes.manualReview.to)
      after.manualReview = updated.manualReviewState ?? 'NONE'
    }
    return { ok: true, data: { customerId: a.customerId, done: Object.keys(changes) }, change: { before, after } }
  },
}

/** updateCustomer's dry run. */
async function previewUpdateCustomer(args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as UpdateCustomerArgs
  const customer = await prisma.customer.findFirst({
    where: { id: a.customerId },
    select: { id: true, name: true, tags: true, manualReviewState: true },
  })
  if (!customer) return { ok: false, error: 'Customer not found' }
  if (!a.note && !a.removeCustomerNoteId && !a.addTags && !a.removeTags && !a.manualReview) {
    return { ok: false, error: 'Name at least one change: note, removeCustomerNoteId, addTags, removeTags or manualReview. Nothing was queued.' }
  }
  const changes: Record<string, unknown> = {}
  if (a.note) changes.note = { add: a.note, pinned: a.pinNote ?? false }
  if (a.removeCustomerNoteId) {
    const note = await prisma.customerNote.findFirst({ where: { id: a.removeCustomerNoteId, customerId: customer.id }, select: { id: true, body: true } })
    if (!note) return { ok: false, error: 'Note not found on this customer. Nothing was queued.' }
    changes.removeNote = { id: note.id, text: excerpt(note.body) }
  }
  if (a.addTags || a.removeTags) {
    const from = sorted(customer.tags)
    const to = sorted([...from, ...(a.addTags ?? [])].filter((t) => !(a.removeTags ?? []).includes(t)))
    if (to.join('\u0000') !== from.join('\u0000')) changes.tags = { from, to }
  }
  if (a.manualReview) {
    const from = customer.manualReviewState ?? 'NONE'
    if (from !== a.manualReview) changes.manualReview = { from, to: a.manualReview }
  }
  if (!Object.keys(changes).length) return { ok: false, error: 'The customer already is as asked. Nothing was queued.' }
  return {
    ok: true,
    preview: {
      action: 'update-customer',
      customer: { id: customer.id, firstName: (customer.name ?? '').trim().split(/\s+/)[0] || null },
      changes,
      note: 'Changes the customer record in Nexus only; nothing reaches the customer.',
    },
  }
}

// ── triage-reviews ──────────────────────────────────────────────────────────────────────────────────

const TRIAGE_CHOICES = [...TRIAGE_STATUSES, 'NONE'] as const
const MAX_TRIAGE = 50

const triageInput = z.object({
  reviews: z.array(z.object({
    reviewId: z.string().trim().min(1).max(64).describe('Nexus review id (from review-search)'),
    status: z.enum(TRIAGE_CHOICES).describe(`its triage status: ${TRIAGE_STATUSES.join(', ')}, or NONE to clear it`),
    assignee: z.string().trim().min(1).max(80).nullable().optional().describe('who on the team handles it; null to clear'),
    tags: z.array(z.string().trim().min(1).max(60)).max(10).optional().describe('its triage tags, replacing the ones it has'),
    note: z.string().trim().min(1).max(1000).nullable().optional().describe('a triage note for the team; null to clear'),
  })).min(1).max(MAX_TRIAGE).describe(`the reviews to triage, each with its own values (at most ${MAX_TRIAGE})`),
})
type TriageArgs = z.infer<typeof triageInput>
type TriageState = { status: string; assignee: string | null; tags: string[]; note: string | null }

/** C5 — how many reviews Claude may triage in one change without a person. */
export const TRIAGE_REVIEWS_LIMITS = z.object({
  maxReviews: z.number().int().min(1).max(MAX_TRIAGE).default(10).describe('the most reviews triaged in one change'),
})

export function triageWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  if (!Array.isArray((preview as { reviews?: unknown } | null)?.reviews)) return 'there is no preview of the change to judge'
  const count = ((preview as { reviews?: unknown[] } | null)?.reviews ?? []).length
  return count > Number(limits.maxReviews) ? `it triages ${count} reviews, more than the ${limits.maxReviews} allowed without a person` : null
}

const stateOf = (review: { triageStatus: string | null; assignee: string | null; triageTags: string[]; triageNote: string | null }): TriageState =>
  ({ status: review.triageStatus ?? 'NONE', assignee: review.assignee, tags: [...review.triageTags], note: review.triageNote })

/** C2 — triage-reviews' undo: every review back to the status, assignee, tags and note it had. */
const TRIAGE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { reviews?: Array<{ reviewId: string }> }
    const ids = (after.reviews ?? []).map((r) => r.reviewId)
    const rows = await prisma.review.findMany({ where: { id: { in: ids } }, select: { id: true, triageStatus: true, assignee: true, triageTags: true, triageNote: true } })
    const byId = new Map(rows.map((row) => [row.id, stateOf(row)]))
    return { reviews: ids.map((reviewId) => ({ reviewId, ...(byId.get(reviewId) ?? { status: 'gone' }) })) }
  },
  request(change) {
    const before = (change.before ?? {}) as { reviews?: Array<{ reviewId: string } & TriageState> }
    const reviews = (before.reviews ?? []).map((r) => ({ reviewId: r.reviewId, status: r.status, assignee: r.assignee, tags: r.tags, note: r.note }))
    return reviews.length ? { tool: 'triage-reviews', args: { reviews } } : { refusal: 'This change names no review.' }
  },
}

const triageReviews: AgentTool = {
  name: 'triage-reviews',
  title: 'Triage reviews',
  input: triageInput,
  requires: [F.reviewsManage],
  category: 'comms',
  riskTier: 'low',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: TRIAGE_REVIEWS_LIMITS,
  withinLimits: triageWithinLimits,
  undo: TRIAGE_UNDO,
  description:
    'Triage reviews on the review desk: set each one\'s status (NEW, IN_PROGRESS, RESPONDED, RESOLVED, IGNORED), '
    + 'assignee, tags and note. Inside Nexus only: no reply is sent. Waits for a person to approve it in Nexus unless the '
    + 'business lets it run inside its limits. Undo puts every review back.',
  handler: (args) => previewTriageReviews(args),
  async execute(args, ctx) {
    const checked = await freshOrStale(() => previewTriageReviews(args), ctx, ['reviews'], 'a review')
    if ('refusal' in checked) return checked.refusal
    const moving = (checked.fresh.preview as { reviews: Array<{ reviewId: string; from: TriageState; to: TriageState }> }).reviews
    for (const review of moving) {
      const result = await triageReview(review.reviewId, {
        status: review.to.status === 'NONE' ? null : review.to.status,
        assignee: review.to.assignee,
        tags: review.to.tags,
        note: review.to.note,
      })
      if ('error' in result) return { ok: false, error: `Review ${review.reviewId}: ${result.error}` }
    }
    return {
      ok: true,
      data: { triaged: moving.length },
      change: {
        before: { reviews: moving.map((r) => ({ reviewId: r.reviewId, ...r.from })) },
        after: { reviews: moving.map((r) => ({ reviewId: r.reviewId, ...r.to })) },
      },
    }
  },
}

/** triageReviews's dry run. */
async function previewTriageReviews(args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as TriageArgs
  const ids = a.reviews.map((r) => r.reviewId)
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'A review is named twice. Nothing was queued.' }
  const rows = await prisma.review.findMany({
    where: { id: { in: ids } },
    select: { id: true, channel: true, rating: true, body: true, triageStatus: true, assignee: true, triageTags: true, triageNote: true },
  })
  const missing = ids.filter((id) => !rows.some((row) => row.id === id))
  if (missing.length) return { ok: false, error: `Review not found: ${missing.join(', ')}. Nothing was queued.` }
  const reviews = a.reviews.map((item) => {
    const row = rows.find((r) => r.id === item.reviewId)!
    const from = stateOf(row)
    const to: TriageState = {
      status: item.status,
      assignee: item.assignee !== undefined ? item.assignee : from.assignee,
      tags: item.tags !== undefined ? [...item.tags] : from.tags,
      note: item.note !== undefined ? item.note : from.note,
    }
    return { reviewId: row.id, channel: row.channel, rating: row.rating, text: excerpt(row.body, 60), from, to }
  })
  const moving = reviews.filter((r) => JSON.stringify(r.from) !== JSON.stringify(r.to))
  if (!moving.length) return { ok: false, error: 'Every review already is as asked. Nothing was queued.' }
  return {
    ok: true,
    preview: { action: 'triage-reviews', reviews: moving, note: 'Changes the review desk in Nexus only: no reply is sent.' },
  }
}

export const ORDER_DESK_TOOLS: AgentTool[] = [updateOrder, updateCustomer, triageReviews]
