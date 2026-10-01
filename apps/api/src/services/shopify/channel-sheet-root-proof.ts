/**
 * Proof that ONE sheet action created a Shopify family's missing draft root (lane01; contract:
 * .local-pse/reports/aaa-shopify-root-proof-review.md, accepted 2026-09-30).
 *
 * The problem: a column action over more than 1,000 cells leaves as several cells requests. Before the first one the
 * family has no root listing, so every cell token was minted against that absence. The first request that saves a cell
 * creates the root, which changes every other cell's token — so the action's next request would be refused as a
 * conflict although nobody else edited anything.
 *
 * The fix is narrow: inside the SAME Serializable transaction that truly creates the root, record a private, typed,
 * versioned receipt that binds the trusted business, account, family, market, alias, actor and the action's stable id to
 * the exact physical root (id + createdAt), with a FIXED expiry. A later request of that action may then compare an
 * original absent-root token against the CURRENT cell state with only the root identity shown as absent — for that exact
 * root only. Existing-root tokens never use this exception.
 *
 * It reuses the `CommandReceipt` table (row-level secured per business), never the idempotency middleware's claim/replay
 * or its replacement of expired keys: a key collision throws and rolls the whole transaction back, so a proof is never
 * renewed or retargeted at another root. Its scope is not in the middleware's route map, so no request can name it.
 * This is not replay or idempotency: a cell already changed by the action still needs its real returned token.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'

export const ROOT_CREATION_PROOF_SCOPE = 'shopify-sheet-root-v1'
const VERSION = 1
/** Fixed lifetime of a proof; never extended. Long enough for one large action, short of a working session. */
export const ROOT_CREATION_PROOF_TTL_MS = 30 * 60_000

/** Trusted inputs only: the verified business and destination, the authenticated actor, the action's stable id. */
export interface RootProofScope {
  workspaceId: string
  accountId: string
  familyId: string
  market: string
  /** The normalized alias key: '' for the primary listing, never null. */
  aliasKey: string
  actorUserId: string | null
  operationId: string
}
export interface RootIdentity { id: string; createdAt: Date }

type Tx = Pick<Prisma.TransactionClient, 'commandReceipt'>
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bound = (scope: RootProofScope) => [scope.workspaceId, scope.accountId, scope.familyId, scope.market, scope.aliasKey, scope.actorUserId ?? '', scope.operationId]
const keyHash = (scope: RootProofScope) => sha256(['shopify-sheet-root-key', VERSION, ...bound(scope)])
const requestHash = (scope: RootProofScope, root: RootIdentity) => sha256(['shopify-sheet-root-proof', VERSION, ...bound(scope), root.id, root.createdAt.toISOString()])
const payloadSchema = z.object({ version: z.literal(VERSION), root: z.object({ id: z.string().min(1), createdAt: z.string().datetime() }).strict() }).strict()

/**
 * Record the proof — only for a genuine absent→present transition (`before` null), inside the transaction that created
 * `root`. Returns false when there was a root before (nothing to prove). A second proof for the same key throws (unique
 * key): the caller's transaction, and with it the root this attempt created, rolls back.
 */
export async function recordRootCreationProof(tx: Tx, scope: RootProofScope, before: RootIdentity | null, root: RootIdentity, now = new Date()): Promise<boolean> {
  if (before) return false
  await tx.commandReceipt.create({ data: {
    workspaceId: scope.workspaceId, scope: ROOT_CREATION_PROOF_SCOPE, keyHash: keyHash(scope), requestHash: requestHash(scope, root), actorUserId: scope.actorUserId,
    status: 'completed', httpStatus: null, response: { version: VERSION, root: { id: root.id, createdAt: root.createdAt.toISOString() } },
    expiresAt: new Date(now.getTime() + ROOT_CREATION_PROOF_TTL_MS),
  } })
  return true
}

/** True only if this exact action, actor and destination created exactly `root`, and the proof is intact and unexpired. */
export async function matchesRootCreationProof(tx: Tx, scope: RootProofScope, root: RootIdentity, now = new Date()): Promise<boolean> {
  const found = await tx.commandReceipt.findUnique({ where: { scope_keyHash: { workspaceId: scope.workspaceId, scope: ROOT_CREATION_PROOF_SCOPE, keyHash: keyHash(scope) } } })
  if (!found || found.scope !== ROOT_CREATION_PROOF_SCOPE || found.workspaceId !== scope.workspaceId || found.actorUserId !== scope.actorUserId) return false
  if (found.status !== 'completed' || !(found.expiresAt.getTime() > now.getTime())) return false
  const payload = payloadSchema.safeParse(found.response)
  if (!payload.success || payload.data.root.id !== root.id || payload.data.root.createdAt !== root.createdAt.toISOString()) return false
  return found.requestHash === requestHash(scope, root)
}
