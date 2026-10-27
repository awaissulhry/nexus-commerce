/**
 * Durable Idempotency-Key handling for commands a double-click must not run twice.
 *
 * Replaces the NN.2 in-memory cache (`services/idempotency.service.ts`, removed), which lived
 * in one process: a second API replica or a restart ran the command again, and two
 * simultaneous requests both missed it. Receipts live in the database, so every
 * replica sees the same claim before the handler runs.
 *
 * Semantics follow the IETF Idempotency-Key draft:
 *   - The first request with a key claims a pending receipt, then runs the handler.
 *   - The same key and request while that runs → 409. After a 2xx → the stored
 *     response is replayed and the handler does not run.
 *   - The same key with a different request (params, query, body or actor) → 422.
 *   - A non-2xx response releases the key: a failed command may be retried as is,
 *     exactly as with the old cache, which only kept successes.
 *   - A receipt lasts RECEIPT_WINDOW_MS, the old cache's window. The web builds some
 *     keys from content (`pim-attach:<parent>:<ids>`), so a long window would turn a
 *     deliberate repeat (attach, detach, attach again) into a silent replay. After
 *     the window an abandoned pending receipt (its server died mid-request) is
 *     replaced, so the command can run again.
 *
 * The response is captured before serialization and stored as JSON, so a replay is
 * compressed (or not) for the client asking, not for the one that asked first.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { withWorkspace, workspaceContext, type WorkspaceContext } from './workspace-context.js'

export const RECEIPT_WINDOW_MS = 10 * 60_000

/** POST routes whose Idempotency-Key is honoured, keyed by Fastify route URL. */
const COMMAND_SCOPES: Record<string, string> = {
  '/api/pim/attach-to-parent': 'pim-attach',
  '/api/pim/promote-to-parent': 'pim-promote',
  '/api/listing-wizard/:id/submit': 'wizard-submit',
  // Attribute parity P3 — one "Download rules" click, one sequential run of provider fetches.
  '/api/categories/schema/download': 'schema-download',
  // "Fill other eBay sites" — one Assign press, one run of rules downloads and category reviews.
  '/api/pim/category-workspace/EBAY/site-assignments': 'ebay-site-assign',
  // One sheet operation (fill, paste, undo): a resend after a lost connection replays its stored answer, never re-applies.
  '/api/products/bulk-save': 'products-bulk-save',
  // MCP full control C5 — Claude's brakes: one Pause or Resume per press (Resume spends a one-time 2FA code).
  '/api/claude/pause': 'claude-pause',
  '/api/claude/resume': 'claude-resume',
  // C8 — one Undo per click on the activity page.
  '/api/claude/changes/:id/undo': 'claude-undo',
  // C6 — one smaller plan per press of "Update plan".
  '/api/agent/fleet/approvals/:id/plan-amend': 'plan-amend',
  // R16 — one press of an engine's switch in the Control Room, one move (a double press never flips it twice).
  '/api/advertising/automation/engine-switch/:key': 'engine-switch',
  // Ads wave 4a — one "Read this market's data" / "Stop reading" press, one switch of that account.
  '/api/advertising/connection/set-active': 'ads-read-switch',
  // Item ID control (step I1) — one Link or Clear press on the sheet's eBay Item ID cell, one write.
  '/api/listings/:id/channel-id/link': 'channel-id-link',
  '/api/listings/:id/channel-id/unlink': 'channel-id-unlink',
  // S10 — one "Delete the old SKU again" press, one try of the old SKU's delete.
  '/api/products/:id/studio-publication/:reviewId/delete-old-sku': 'delete-old-sku',
  // Add rows (R2, R3) — one SKU typed into an empty sheet row, one new variation or one new listing alias, even when the
  // answer is lost and the row sends again (the row keeps its key while the outcome is unknown).
  '/api/catalog/products/:parentId/children': 'variation-create',
  '/api/products/:id/aliases': 'alias-create',
  // CC-24 / CM-33 — one launch click, one set of Amazon campaigns. A launch runs every Amazon call inside its request;
  // when the edge proxy drops the answer, the builder's retry (same key) waits for the run or replays its result
  // instead of building the campaigns a second time.
  '/api/advertising/campaign-builder/sp-super-wizard/launch': 'ads-spw-launch',
  '/api/advertising/campaign-builder/single/launch': 'ads-single-launch',
  '/api/advertising/blueprints/replicate': 'ads-replicate',
  '/api/advertising/ai-goals': 'ads-goal-create',
  '/api/advertising/ai-goals/:id/materialize': 'ads-goal-materialize',
  // CM-33 — one add (campaign, ad group, keyword, product ad, target, negative, creative) per press, even when the
  // answer is lost and the screen sends it again.
  '/api/advertising/campaigns/create': 'ads-campaign-create',
  '/api/advertising/adgroups/create': 'ads-adgroup-create',
  '/api/advertising/keywords/create': 'ads-keyword-create',
  '/api/advertising/product-ads/create': 'ads-product-ad-create',
  '/api/advertising/targets/create': 'ads-target-create',
  '/api/advertising/negative-targets/create': 'ads-negative-target-create',
  '/api/advertising/negative-keywords': 'ads-negative-keyword-create',
  '/api/advertising/sb-creatives/create': 'ads-sb-creative-create',
  // Step 4 Send to FBA — one "Add to draft" press, one change of the draft; one "Send to Amazon" press, one plan and one
  // set of holds; one pick confirmed at Amazon; one cancel, one "Try again", one "Mark shipped" (one stock movement) per
  // press, even when the answer is lost.
  '/api/fba/inbound/drafts': 'fba-draft-add',
  '/api/fba/inbound/plans/:id/send': 'fba-plan-send',
  '/api/fba/inbound/plans/:id/choice': 'fba-plan-choice',
  '/api/fba/inbound/plans/:id/cancel': 'fba-plan-cancel',
  '/api/fba/inbound/plans/:id/retry': 'fba-plan-retry',
  '/api/fba/inbound/shipments/:id/shipped': 'fba-shipment-shipped',
  // Ads brain page A5 — one request (or one decision) per press on the brain page, even when the answer is lost and the
  // page sends it again: a double click never asks twice, kills twice or approves twice.
  '/api/advertising/automation/brain/control': 'brain-control',
  '/api/advertising/automation/brain/kill': 'brain-kill',
  '/api/advertising/automation/brain/bid-brain/enrollment': 'brain-bid-enrollment',
  // Bid page R4 — one Undo of approved asks per click: a resend replays its answer, never puts back twice.
  '/api/advertising/bid-rules/:id/asks/undo': 'bid-ask-undo',
  // Keyword Harvest page (lane HCORE) — a harvest change set and its undo: one apply-harvest request each.
  '/api/advertising/harvest/apply': 'harvest-apply',
  '/api/advertising/harvest/undo': 'harvest-undo',
  '/api/advertising/automation/brain/requests/:approvalId/decide': 'brain-request-decide',
  // Negative Targeting page (lane NWRITE) — one request (or one decision, one skip) per press, even when the answer is
  // lost and the page sends it again: a double click never asks twice, approves twice or skips twice.
  '/api/advertising/waste/apply': 'waste-apply',
  '/api/advertising/waste/skip': 'waste-skip',
  '/api/advertising/waste/unskip': 'waste-unskip',
  '/api/advertising/waste/waiting/decide': 'waste-waiting-decide',
  // Reviews Inbox (PR B) — one reply per Send press (a channel reply cannot be taken back), one import per "Import N
  // reviews" press, one bulk change (assign, tag, status, Draft with AI) per Apply press, even when the answer is lost
  // and the page sends it again.
  '/api/reviews/:id/reply/send': 'review-reply-send',
  '/api/reviews/import/apply': 'review-import-apply',
  '/api/reviews/inbox/bulk': 'review-inbox-bulk',
  // Reviews › Requests (PR C) — one "Run now" per press, one snooze / skip / send now of the picked requests, one test
  // e-mail, one on / off / delete of the picked rules, even when the answer is lost and the page sends it again.
  '/api/review-queue/run': 'review-queue-run',
  '/api/review-queue/bulk': 'review-queue-bulk',
  '/api/review-emails/test': 'review-email-test',
  '/api/review-rules/bulk': 'review-rules-bulk',
  // Reviews › Insights (PR E) — one change plan per "Send for approval" press (one fix, or the ticked fixes), one
  // brief per Generate (10 a day, an AI call), one acknowledge / resolve / "Suggest fixes" of the ticked alerts, even
  // when the answer is lost and the page sends it again.
  '/api/reviews/action-items/:id/propose': 'review-fix-propose',
  '/api/reviews/action-items/bulk': 'review-fix-bulk',
  '/api/reviews/spotlight/generate': 'review-brief-generate',
  '/api/reviews/spikes/bulk': 'review-alert-bulk',
  // Reviews › Amazon seller feedback (Phase 3) — one "Fetch now" per press.
  '/api/reviews/amazon/seller-feedback/fetch': 'review-seller-feedback-fetch',
  // Reviews › Requests (audit A11, 2026-10-27) — the pages already send a key for these: one new rule, one copy ("Duplicate
  // as A/B"), one "Queue these N", one rules import, one "Seed defaults", one timing / send-hour reset, one pause or
  // resume, one "Allow again", even when the answer is lost and the page sends it again.
  '/api/review-rules': 'review-rule-create',
  '/api/review-rules/:id/duplicate': 'review-rule-duplicate',
  '/api/review-rules/:id/run': 'review-rule-queue',
  '/api/review-rules/import': 'review-rules-import',
  '/api/review-rules/seed-default': 'review-rules-seed',
  '/api/review-timing-defaults/seed': 'review-timing-seed',
  '/api/review-send-windows/seed': 'review-send-windows-seed',
  '/api/review-queue/pause': 'review-queue-pause',
  '/api/review-queue/resume': 'review-queue-resume',
  '/api/review-requests/:id/unsuppress': 'review-request-allow-again',
  // Reviews › eBay (PR G) — one approval request (one sale, or ONE change plan for the ticked sales) per "Send for
  // approval" press of "Leave feedback for buyers", even when the answer is lost and the page sends it again.
  '/api/reviews/area/ebay/buyer-feedback/send': 'review-ebay-buyer-feedback-send',
}

/** The POST routes whose Idempotency-Key is honoured (for the tests that hold a route to it). */
export const COMMAND_SCOPE_ROUTES: readonly string[] = Object.freeze(Object.keys(COMMAND_SCOPES))

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** Key order must not change the fingerprint of an otherwise identical request. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  }
  return value ?? null
}

/**
 * A keyless wizard submit is keyed on the wizard's saved state. Two submits of the same
 * state coalesce; a submit changes `updatedAt`, so a deliberate retry after a FAILED
 * result is a new command rather than a replay of the failure.
 */
async function wizardFallbackKey(request: FastifyRequest): Promise<string | null> {
  const { id } = request.params as { id: string }
  const wizard = await prisma.listingWizard.findUnique({ where: { id }, select: { updatedAt: true } })
  return wizard ? `wizard:${id}:${wizard.updatedAt.toISOString()}` : null // no row: the route answers 404
}

type Claim =
  | { kind: 'owner'; id: string }
  | { kind: 'replay'; httpStatus: number; response: unknown }
  | { kind: 'running' }
  | { kind: 'mismatch' }

async function claimReceipt(scope: string, keyHash: string, requestHash: string, actorUserId: string | null): Promise<Claim> {
  // Two rounds: an expired receipt is removed in the first and re-claimed in the second.
  for (let round = 0; round < 2; round++) {
    const now = new Date()
    const id = randomUUID()
    const created = await prisma.commandReceipt.createMany({
      data: [{ id, scope, keyHash, requestHash, actorUserId, expiresAt: new Date(now.getTime() + RECEIPT_WINDOW_MS) }],
      skipDuplicates: true,
    })
    if (created.count === 1) return { kind: 'owner', id }

    const existing = await prisma.commandReceipt.findUnique({
      where: { scope_keyHash: workspaceKey({ scope, keyHash }) },
    })
    if (!existing) continue // released between the insert and the read
    if (existing.expiresAt <= now) {
      // Conditional on updatedAt: a request that re-claimed it meanwhile keeps its claim.
      await prisma.commandReceipt.deleteMany({ where: { id: existing.id, updatedAt: existing.updatedAt } })
      continue
    }
    if (existing.requestHash !== requestHash) return { kind: 'mismatch' }
    if (existing.status === 'completed' && existing.httpStatus !== null) {
      return { kind: 'replay', httpStatus: existing.httpStatus, response: existing.response }
    }
    return { kind: 'running' }
  }
  return { kind: 'running' }
}

/** Register after the workspace and RBAC hooks, so a replay is never served to a caller they refuse. */
export function registerCommandIdempotency(app: FastifyInstance): void {
  // The business context is kept with the claim: the receipt is row-level secured,
  // and onResponse runs after the request's context may have ended.
  const owned = new WeakMap<FastifyRequest, { id: string; completed: boolean; context: WorkspaceContext }>()

  app.addHook('preHandler', async (request, reply) => {
    const scope = request.method === 'POST' ? COMMAND_SCOPES[request.routeOptions.url ?? ''] : undefined
    if (!scope) return
    const header = request.headers['idempotency-key']
    if (header !== undefined && (typeof header !== 'string' || !header.trim())) {
      return reply.code(400).send({ error: 'Idempotency-Key must be a non-empty string.' })
    }
    // The workspace hook runs first and always sets a business (the legacy one when
    // profiles are off). A route outside it has no receipt to claim.
    const context = workspaceContext()
    if (!context) return
    const key = typeof header === 'string' ? header : scope === 'wizard-submit' ? await wizardFallbackKey(request) : null
    if (!key) return

    const actorUserId = context.actorUserId ?? null
    const fingerprint = canonical({ params: request.params, query: request.query, body: request.body, actorUserId })
    const claim = await claimReceipt(scope, sha256(key), sha256(JSON.stringify(fingerprint)), actorUserId)
    switch (claim.kind) {
      case 'owner':
        owned.set(request, { id: claim.id, completed: false, context })
        return
      case 'replay':
        return reply.code(claim.httpStatus).send(claim.response)
      case 'mismatch':
        return reply.code(422).send({ error: 'This Idempotency-Key was already used for a different request.' })
      case 'running':
        return reply.code(409).header('retry-after', '1')
          .send({ error: 'The same request is still running. Wait for its result before sending it again.' })
    }
  })

  // Objects only: every command above answers with a JSON object. A string or
  // buffer response is not stored; onResponse releases its key instead.
  app.addHook('preSerialization', async (request, reply, payload) => {
    const receipt = owned.get(request)
    if (!receipt || reply.statusCode < 200 || reply.statusCode >= 300) return payload
    try {
      const stored = await withWorkspace(receipt.context, () => prisma.commandReceipt.updateMany({
        where: { id: receipt.id, status: 'pending' },
        data: { status: 'completed', httpStatus: reply.statusCode, response: JSON.parse(JSON.stringify(payload)) },
      }))
      receipt.completed = stored.count === 1
    } catch (error) {
      // The command already ran; its caller still gets the real response. The
      // pending receipt refuses duplicates until the window closes.
      logger.error('[command-idempotency] could not store a command response', {
        receiptId: receipt.id, error: error instanceof Error ? error.message : String(error),
      })
    }
    return payload
  })

  app.addHook('onResponse', async request => {
    const receipt = owned.get(request)
    if (!receipt || receipt.completed) return
    owned.delete(request)
    await withWorkspace(receipt.context, () => prisma.commandReceipt.deleteMany({ where: { id: receipt.id, status: 'pending' } })).catch(error => {
      logger.error('[command-idempotency] could not release a command key', {
        receiptId: receipt.id, error: error instanceof Error ? error.message : String(error),
      })
    })
  })
}
