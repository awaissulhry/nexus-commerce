import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  compareFingerprints,
  DRILL_KEYS,
  DRILL_TIMER_KEY,
  drillProblems,
  drillResultOf,
  drillStatus,
  drillTimerOf,
  fingerprintLine,
  parseFingerprint,
  type DrillKey,
  type DrillResult,
  type Fingerprint,
} from '@nexus/factory-domain/ops/drills'
import type { CommandTools, CommandTx } from '../../../core/command'
import { requireContext, type OfficeContext } from '../../../core/context'
import type { OfficeAuth } from '../../auth/sessions/office-auth'
import { completeUpload, requestUpload } from '../../files/files'
import { processFiles } from '../../files/service'
import { setTimerInCommand } from '../../timers/service'
import type { DrillView, EvidenceBody, RecordDrillBody } from './contract'

/**
 * Restore drills (B-W2a-36; PLT-214; design admin.security "Backups and restore drills", popup drill). The rules are
 * factory-domain ops/drills; here they meet the rows:
 *
 *   GET  /admin/security/fingerprint?asOf=            THIS database's fingerprint as of a time (the restored copy shows
 *                                                     its own on its Security page; a person copies the line)
 *   GET  /admin/security/drills                       the drills, newest first
 *   POST /admin/security/drills/evidence              the drill's id is made first; its evidence file (a StoredFile of
 *                                                     recordType RestoreDrill with that id) is announced for it
 *   POST /admin/security/drills/evidence/:fileId/complete   the upload confirmed
 *   POST /admin/security/drills                       ONE command: the copy's line read, this database's fingerprint at
 *                                                     the backup's time worked out in the same transaction (never the
 *                                                     client's), compared, the drill written (append-only; the database
 *                                                     refuses a PASSED drill with a mismatch too), a drill that passed
 *                                                     moves the reminder (a DueTimer RESTORE_DRILL_DUE:-14d on the
 *                                                     Tenant), the audit row and security.drill_recorded.
 * Nothing here restores anything or reaches a backup: a drill is the record of one a person did.
 */

type Client = FactoryClient | CommandTx

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

type Rows = { n: number; v: string }[]

/** Each key's rows as of a time: their count and a digest of the columns that never change once written. */
function keyRows(client: Client, key: DrillKey, asOf: Date): Promise<Rows> {
  switch (key) {
    case 'orders':
      return client.$queryRaw<Rows>`SELECT count(*)::int AS n, coalesce(string_agg(id::text, ',' ORDER BY id), '') AS v FROM "SalesOrder" WHERE "createdAt" <= ${asOf}`
    case 'invoices':
      return client.$queryRaw<Rows>`SELECT count(*)::int AS n, coalesce(string_agg(id::text, ',' ORDER BY id), '') AS v FROM "Invoice" WHERE "createdAt" <= ${asOf}`
    case 'stockMoves':
      return client.$queryRaw<Rows>`SELECT count(*)::int AS n, coalesce(string_agg(id::text || ':' || quantity::text, ',' ORDER BY id), '') AS v FROM "StockMove" WHERE "createdAt" <= ${asOf}`
    case 'parties':
      return client.$queryRaw<Rows>`SELECT count(*)::int AS n, coalesce(string_agg(id::text, ',' ORDER BY id), '') AS v FROM "Party" WHERE "createdAt" <= ${asOf}`
    case 'files':
      return client.$queryRaw<Rows>`SELECT count(*)::int AS n, coalesce(string_agg(id::text || ':' || sha256, ',' ORDER BY id), '') AS v FROM "StoredFile" WHERE "createdAt" <= ${asOf}`
  }
}

const checksum = (key: DrillKey, count: number, values: string): string => createHash('sha256').update(`${key}|${count}|${values}`).digest('hex').slice(0, 16)

/** The tenant's fingerprint as of a time (read in the caller's scope: the tenant's rows only). */
export async function fingerprintOf(client: Client, asOf: Date): Promise<Fingerprint> {
  const out: Partial<Record<DrillKey, string>> = {}
  // One after the other: a transaction client takes one query at a time.
  for (const key of DRILL_KEYS) {
    const [row] = await keyRows(client, key, asOf)
    out[key] = checksum(key, row?.n ?? 0, row?.v ?? '')
  }
  return out as Fingerprint
}

export async function readFingerprint(auth: OfficeAuth, request: FastifyRequest, asOfText: string | undefined) {
  const now = auth.clock.now()
  const asOf = asOfText ? new Date(asOfText) : now
  if (asOf.getTime() > now.getTime()) throw new ValidationError('A fingerprint is of a time that has passed.', [{ path: 'querystring/asOf', message: 'Choose a time in the past.' }])
  const fingerprint = await request.withClient((client) => fingerprintOf(client, asOf))
  return { asOf: toUtcIso(asOf), fingerprint, line: fingerprintLine(fingerprint) }
}

const DRILL_SELECT = {
  id: true,
  drilledOn: true,
  environment: true,
  backupAt: true,
  checks: true,
  result: true,
  durationMinutes: true,
  notes: true,
  evidenceFileId: true,
  performedById: true,
  createdAt: true,
} as const

type DrillRow = Prisma.RestoreDrillGetPayload<{ select: typeof DRILL_SELECT }>

const dayOf = (date: Date): string => date.toISOString().slice(0, 10)

function checksOf(value: Prisma.JsonValue): DrillView['checks'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
    const check = entry as Record<string, Prisma.JsonValue>
    if (typeof check.key !== 'string' || typeof check.match !== 'boolean') return []
    return [{ key: check.key, source: typeof check.source === 'string' ? check.source : null, restored: typeof check.restored === 'string' ? check.restored : null, match: check.match }]
  })
}

async function viewsOf(client: Client, rows: readonly DrillRow[]): Promise<DrillView[]> {
  const ids = [...new Set(rows.map((row) => row.performedById))]
  const people = new Map((await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  return rows.map((row) => ({
    id: row.id,
    drilledOn: dayOf(row.drilledOn),
    environment: row.environment,
    backupAt: row.backupAt ? toUtcIso(row.backupAt) : null,
    result: row.result,
    durationMinutes: row.durationMinutes,
    notes: row.notes,
    checks: checksOf(row.checks),
    evidenceFileId: row.evidenceFileId,
    performedBy: people.has(row.performedById) ? { id: row.performedById, name: people.get(row.performedById)! } : null,
    createdAt: toUtcIso(row.createdAt),
  }))
}

/** The last drills, newest first, and the state the status line and the reminder read. */
export async function drillsOf(client: Client, now: Date, take = 50) {
  const rows = await client.restoreDrill.findMany({ orderBy: [{ drilledOn: 'desc' }, { createdAt: 'desc' }], take, select: DRILL_SELECT })
  const status = drillStatus(
    rows.map((row) => ({ drilledOn: dayOf(row.drilledOn), result: row.result as DrillResult, createdAt: row.createdAt })),
    now,
  )
  return { drills: await viewsOf(client, rows), status }
}

export async function listDrills(auth: OfficeAuth, request: FastifyRequest) {
  const { drills } = await request.withClient((client) => drillsOf(client, auth.clock.now()))
  return { drills }
}

const EVIDENCE = 'RestoreDrill'

export async function announceEvidence(request: FastifyRequest, body: EvidenceBody, idempotencyKey: string | undefined) {
  const drillId = body.drillId ?? newId()
  if (body.drillId && (await request.withClient((client) => client.restoreDrill.findUnique({ where: { id: body.drillId }, select: { id: true } })))) {
    throw new ConflictError('This drill is recorded already: a drill never changes; record a new one.')
  }
  const answer = await requestUpload(processFiles(), request, {
    companyId: null,
    recordType: EVIDENCE,
    recordId: drillId,
    kind: 'ATTACHMENT',
    originalName: body.originalName,
    contentType: body.contentType,
    sizeBytes: body.sizeBytes,
    sha256: body.sha256,
  }, idempotencyKey)
  return { drillId, file: { id: answer.file.id, originalName: answer.file.originalName, status: answer.file.status }, upload: answer.upload }
}

export async function completeEvidence(request: FastifyRequest, fileId: string, idempotencyKey: string | undefined) {
  const file = await request.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: { recordType: true } }))
  if (!file || file.recordType !== EVIDENCE) throw new NotFoundError('File not found.')
  const done = await completeUpload(processFiles(), request, fileId, idempotencyKey)
  return { file: { id: done.id, originalName: done.originalName, status: done.status } }
}

/** Moves the drill's reminder: the Tenant's PENDING RESTORE_DRILL_DUE timer is cancelled (its date moved) and a new one set. */
async function moveDrillTimer(tools: CommandTools, tenantId: string, drilledOn: string): Promise<void> {
  // B-W2b-24: THE timer service (platform/timers): one PENDING RESTORE_DRILL_DUE timer on the tenant; another date cancels
  // the old one (MOVED) and sets the new one, audited as timers.set / timers.cancel; platform/timers/restore-drill.ts tells
  // the holders of security.view when it fires.
  const timer = drillTimerOf(drilledOn)
  await setTimerInCommand(tools, { record: { type: 'Tenant', id: tenantId }, timerKey: DRILL_TIMER_KEY, dueAt: timer.dueAt, fireAt: timer.fireAt, payload: { dueOn: timer.dueOn } })
}

export async function recordDrill(auth: OfficeAuth, request: FastifyRequest, body: RecordDrillBody, idempotencyKey: string | undefined) {
  const context = officeContextOf(request)
  const parsed = parseFingerprint(body.restored)
  const backupAt = new Date(body.backupAt)
  const problems = [
    ...parsed.issues.map((issue) => ({ ...issue, path: `body/${issue.path}` })),
    ...drillProblems({ drilledOn: body.drilledOn, environment: body.environment, backupAt, durationMinutes: body.durationMinutes ?? null, notes: body.notes ?? null }, auth.clock.now()).map((issue) => ({
      ...issue,
      path: `body/${issue.path}`,
    })),
  ]
  if (body.evidenceFileId && !body.id) problems.push({ path: 'body/id', message: 'The evidence belongs to the drill it was announced for: send that drill id.' })
  if (problems.length > 0 || !parsed.fingerprint) throw new ValidationError('The drill is not valid.', problems)
  const restored = parsed.fingerprint
  const id = body.id ?? newId()

  const { result } = await auth.command(context, { name: 'security.recordDrill', idempotencyKey, input: body }, async (tools) => {
    const { tx, now, audit, emit } = tools
    if (await tx.restoreDrill.findUnique({ where: { id }, select: { id: true } })) throw new ConflictError('This drill is recorded already: a drill never changes; record a new one.')
    if (body.evidenceFileId) {
      const file = await tx.storedFile.findUnique({ where: { id: body.evidenceFileId }, select: { recordType: true, recordId: true, status: true } })
      if (!file || file.recordType !== EVIDENCE || file.recordId !== id) throw new ValidationError('The evidence is not a file of this drill.', [{ path: 'body/evidenceFileId', message: 'Upload the evidence for this drill.' }])
      if (file.status !== 'AVAILABLE') throw new ConflictError('The evidence file has not arrived yet: finish its upload, then save the drill.')
    }
    const source = await fingerprintOf(tx, backupAt)
    const checks = compareFingerprints(source, restored)
    const outcome = drillResultOf(checks)
    await tx.restoreDrill.create({
      data: {
        id,
        drilledOn: new Date(`${body.drilledOn}T00:00:00.000Z`),
        environment: body.environment.trim(),
        backupAt,
        checks: checks.map((check) => ({ ...check })) as Prisma.InputJsonValue,
        result: outcome,
        durationMinutes: body.durationMinutes ?? null,
        notes: body.notes?.trim() || null,
        evidenceFileId: body.evidenceFileId ?? null,
        performedById: context.actorId,
        requestId: context.requestId,
        createdAt: now,
      },
    })
    audit({
      recordType: 'RestoreDrill',
      recordId: id,
      after: { drilledOn: body.drilledOn, environment: body.environment.trim(), backupAt: toUtcIso(backupAt), result: outcome, matched: checks.filter((check) => check.match).length, of: checks.length, evidenceFileId: body.evidenceFileId ?? null },
    })
    if (outcome === 'PASSED') await moveDrillTimer(tools, context.tenantId, body.drilledOn)
    emit({ type: 'security.drill_recorded', subject: id, payload: { drillId: id, result: outcome, drilledOn: body.drilledOn } })
    const [drill] = await viewsOf(tx, [await tx.restoreDrill.findUniqueOrThrow({ where: { id }, select: DRILL_SELECT })])
    return { drill: drill!, drillStatus: (await drillsOf(tx, now, 20)).status }
  })
  return result
}
