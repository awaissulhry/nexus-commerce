import type { FastifyRequest } from 'fastify'
import type { FactoryDatabase } from '@nexus/factory-db'
import { ConflictError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { draftData, draftEnvelope, draftPurgeAfter, draftSizeProblem } from '@nexus/factory-domain/links/drafts'
import { PURPOSE_RULES } from '@nexus/factory-domain/links/purposes'
import { callerFor, command, type CommandTools } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { activeTenants, systemContext } from '../outbox/system'
import { linkSessionOf, linkUnavailable, type LinkSession } from './authenticator'
import { linkCommand } from './use'

/**
 * Drafts kept with us (design links.frame "Finish later"; links-depth.prisma LinkDraft; factory-domain links/drafts). A
 * MEASUREMENTS, CLAIM or SUPPLIER_ONBOARD link session saves its form and resumes it from the same link while the link
 * opens; a save is never a counted use and leaves no evidence. The data is sealed with the API's AES-256-GCM seal (the TOTP
 * secret's) inside an envelope naming the link, so the office (whose grant hides the column) and a copy on another link
 * read nothing.
 *
 *   GET /link/draft    the link's draft, opened (null when there is none, or it cannot be opened).
 *   PUT /link/draft    {data, version?}: ONE command under the link's row lock (the session may lock its own link): the
 *                      draft is updated (version + 1; a stale `version` is refused) or made (purged 7 days after the link
 *                      expires). One audit row, without the data.
 *   dropLinkDraft      for a module's send command (the form is sent): the draft goes in the same transaction.
 *   purge              the scheduler's clustered cron `links.purgeDrafts` (hourly at minute 47), per ACTIVE tenant in its
 *                      system scope: drafts whose purgeAfter passed, at most 1000 per tenant and tick, in ONE command with
 *                      one audit row (how many). The office role may delete drafts; the database lets nothing else.
 */

function draftLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (!PURPOSE_RULES[link.purpose].draft) throw linkUnavailable()
  return link
}

const DRAFT = { id: true, dataEnc: true, version: true, updatedAt: true, purgeAfter: true } as const

/** GET /link/draft. */
export async function readLinkDraft(request: FastifyRequest) {
  const link = draftLinkOf(request)
  const row = await request.withClient((client) => client.linkDraft.findFirst({ where: { linkId: link.id }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: DRAFT }))
  let data: Record<string, unknown> | null = null
  if (row) {
    try {
      data = draftData(link.id, officeAuthOf(request.server).secrets.open(row.dataEnc))
    } catch {
      data = null
    }
  }
  return {
    draft: row && data ? { data, version: row.version, savedAt: toUtcIso(row.updatedAt), purgeAfter: toUtcIso(row.purgeAfter) } : null,
    link: { expiresAt: toUtcIso(link.expiresAt) },
  }
}

/** PUT /link/draft. */
export async function saveLinkDraft(request: FastifyRequest, body: { readonly data: Record<string, unknown>; readonly version?: number | undefined }, idempotencyKey?: string) {
  const link = draftLinkOf(request)
  const envelope = draftEnvelope(link.id, body.data)
  const tooBig = draftSizeProblem(envelope)
  if (tooBig) throw new ValidationError(tooBig, [{ path: 'body/data', message: tooBig }])
  // Sealed outside the command: the sealed text is written, never kept in the command's input or result.
  const sealed = officeAuthOf(request.server).secrets.seal(envelope)
  const purgeAfter = draftPurgeAfter(link.expiresAt)

  const { result } = await linkCommand(request, { name: 'links.saveDraft', idempotencyKey, input: { version: body.version ?? null, bytes: Buffer.byteLength(envelope, 'utf8') } }, async ({ tx, now, audit }) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OneOffLink" WHERE id = ${link.id}::uuid FOR UPDATE`
    if (!locked) throw linkUnavailable()
    const current = await tx.linkDraft.findFirst({ where: { linkId: link.id }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { id: true, version: true } })
    if (current && body.version !== undefined && body.version !== current.version) throw new ConflictError('This draft was saved meanwhile (another tab or device). Reload it first.')
    if (!current && body.version !== undefined) throw new ConflictError('This draft is no longer kept. Reload the form.')
    let saved: { id: string; version: number; updatedAt: Date; purgeAfter: Date }
    if (current) {
      saved = await tx.linkDraft.update({ where: { id: current.id }, data: { dataEnc: sealed, version: current.version + 1, updatedAt: now }, select: { id: true, version: true, updatedAt: true, purgeAfter: true } })
    } else {
      saved = await tx.linkDraft.create({ data: { id: newId(), partyId: link.partyId, linkId: link.id, dataEnc: sealed, purgeAfter, createdAt: now, updatedAt: now }, select: { id: true, version: true, updatedAt: true, purgeAfter: true } })
    }
    audit({ action: 'links.saveDraft', recordType: 'OneOffLink', recordId: link.id, companyId: link.companyId, after: { draftId: saved.id, version: saved.version, purgeAfter: toUtcIso(saved.purgeAfter) } })
    return { draft: { version: saved.version, savedAt: toUtcIso(saved.updatedAt), purgeAfter: toUtcIso(saved.purgeAfter) } }
  })
  return result
}

/** In a module's send command (the form is sent): the link's draft goes with it. Returns how many were deleted. */
export async function dropLinkDraft(tools: Pick<CommandTools, 'tx'>, linkId: string): Promise<number> {
  const { count } = await tools.tx.linkDraft.deleteMany({ where: { linkId } })
  return count
}

// ---- the purge -----------------------------------------------------------------------------------------------------------

export interface DraftPurgeOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

const BATCH = 1000

/** One tick over every active tenant (the cron's; tests call it directly). Returns how many drafts were deleted. */
export async function purgeLinkDrafts(options: DraftPurgeOptions): Promise<number> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `links-purge-${newId()}`
  let purged = 0
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const due = await caller.withClient((client) => client.linkDraft.findMany({ where: { purgeAfter: { lte: now } }, select: { id: true }, orderBy: [{ purgeAfter: 'asc' }, { id: 'asc' }], take: BATCH }))
      if (due.length === 0) continue
      const { result } = await command(caller, { name: 'links.purgeDrafts', input: { before: toUtcIso(now), count: due.length } }, async ({ tx, audit }) => {
        const { count } = await tx.linkDraft.deleteMany({ where: { id: { in: due.map((row) => row.id) }, purgeAfter: { lte: now } } })
        audit({ recordType: 'Tenant', recordId: tenantId, companyId: null, after: { linkDraftsDeleted: count, purgeAfterBefore: toUtcIso(now) } })
        return count
      })
      purged += result
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the expired link drafts of a tenant could not be purged')
    }
  }
  if (purged > 0) options.log.info({ purged }, 'expired link drafts purged')
  return purged
}

/** The scheduler's cron: every hour at minute 47. */
export function linkDraftPurgeCron(options: DraftPurgeOptions): CronJob {
  return defineCron({
    name: 'links.purgeDrafts',
    schedule: '47 * * * *',
    lockTtlMs: 600_000,
    async run() {
      await purgeLinkDrafts(options)
    },
  })
}
