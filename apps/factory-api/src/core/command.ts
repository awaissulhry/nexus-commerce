import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { FactoryClient, FactoryDatabase, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { isPermission, type Permission } from '@nexus/factory-domain/core/permissions'
import { assertTransition, type Machine } from '@nexus/factory-domain/state/machine'
import { outboxWriter } from '../platform/outbox/writer'
import { SYSTEM_ACTOR_ID, withContextClient, type RequestContext } from './context'
import { ApiError, isBusyDatabaseError } from './errors'
import { serverClock, type Clock } from './time'

/**
 * command(): the one way a write reaches the factory database (plan A1 §3.2 step 4, PLAN §4.6 item 5; features
 * PLT-072, PLT-073, PLT-084, PLT-189, PLT-097, PLT-033, COL-078). ONE transaction on the caller's scoped client
 * (the context's role and settings) does, in order:
 *
 *   1. the idempotency receipt: a repeated Idempotency-Key with the same request returns the stored answer and runs
 *      nothing (`replayed: true`); the same key with another request is refused (409 conflict);
 *   2. the record guard, when the command names a record: it must exist (404), be at the version the caller read
 *      (COL-078: a stale version is a 409 conflict that names the current version), and the move of its state machine
 *      must be allowed (PLT-097: 409 invalid_state, saying what is missing). Then its version is bumped by
 *      compare-and-set, with the new state when there is a move: the row is locked for the rest of the transaction,
 *      and a write that raced this one fails on the version instead of overwriting it;
 *   3. the work, with the transaction client;
 *   4. the audit rows the work recorded (at least one: every write is audited), with the server time, the caller,
 *      the request id and the key;
 *   5. the events the work emitted, checked against the event catalogue and written as OutboxEvent rows
 *      (`EventWriter`, platform/outbox/writer.ts; an undeclared type or a refused payload rolls everything back);
 *   6. the receipt, when there is a key.
 * Commit. Any failure rolls everything back: no change without its audit row, no audit row or receipt without its
 * change. Nothing that matters happens after the commit.
 *
 * Concurrent repeats: two requests with one key that both miss step 1 both run, but only one commits; the other
 * fails (on the record's version, a unique key, or the receipt itself) and then answers from the first one's receipt.
 * The transaction is PostgreSQL's default READ COMMITTED: the version check re-reads the committed row.
 *
 *   const { result } = await command(request, {
 *     name: 'sites.rename',
 *     idempotencyKey: idempotencyKeyFrom(request),
 *     input: request.body,
 *     record: { type: 'Site', id: siteId, expectedVersion: request.body.version },
 *   }, async ({ tx, audit, record }) => {
 *     const before = await tx.site.findUniqueOrThrow({ where: { id: siteId }, select: { name: true, companyId: true } })
 *     await tx.site.update({ where: { id: siteId }, data: { name: request.body.name } })
 *     audit({ recordType: 'Site', recordId: siteId, companyId: before.companyId, before, after: { name: request.body.name } })
 *     return { id: siteId, version: record!.version }
 *   })
 *
 * The work never sets `version` (command() owns it) and returns plain JSON (dates as `toUtcIso` strings, decimals as
 * strings): the first answer and a replayed one are the same value.
 */

/** What command() needs from its caller: the context and the scoped client. A FastifyRequest has both. */
export interface CommandCaller {
  readonly factoryContext: RequestContext | null
  withClient<T>(work: (client: FactoryClient) => Promise<T>): Promise<T>
}

/** A caller outside HTTP (the worker and scheduler, tests): a context and the database. */
export function callerFor(database: FactoryDatabase, context: RequestContext): CommandCaller {
  return { factoryContext: context, withClient: (work) => withContextClient(database, context, work) }
}

/** The client inside the command's transaction. */
export type CommandTx = Prisma.TransactionClient

type ScalarsOf<Model extends Prisma.ModelName> = Prisma.TypeMap['model'][Model]['payload']['scalars']
/** The models command() can guard: those with an `id` and a `version` column (A1 §2.1 "Concurrency"). */
export type VersionedModel = { [Model in Prisma.ModelName]: ScalarsOf<Model> extends { id: string; version: number } ? Model : never }[Prisma.ModelName]

/** A move of the record's state machine (A1 §2.5), checked and written by command(). */
export interface CommandTransition<State extends string, Facts> {
  readonly machine: Machine<State, Facts>
  readonly to: State
  /** The status column. Default `status`. */
  readonly field?: string
  /** Loads what the machine's guard needs, inside the transaction. */
  readonly facts?: (tx: CommandTx) => Promise<Facts>
}

/** The record a command changes. */
export interface CommandRecord<State extends string = string, Facts = undefined> {
  readonly type: VersionedModel
  readonly id: string
  /** The version the caller read (edit-conflict guard). Without it, the version read in the transaction is used. */
  readonly expectedVersion?: number
  readonly transition?: CommandTransition<State, Facts>
}

export interface CommandSpec<State extends string = string, Facts = undefined> {
  /** `<module>.<action>` (`sites.rename`): the default audit action and the scope of the idempotency key. */
  readonly name: Permission
  /** The request's Idempotency-Key (`idempotencyKeyFrom`): required for floor and link writes, optional otherwise. */
  readonly idempotencyKey?: string | null | undefined
  /** The validated input. With the name, the caller and the record it makes the request hash of the receipt. */
  readonly input: unknown
  readonly record?: CommandRecord<State, Facts>
  /** The device's clock for a floor event (A1 §3.8), kept beside the server time. */
  readonly deviceTime?: Date
  /** The event this command handles (a job), the events' causationId. */
  readonly causationId?: string
}

/** One audit row the work records (PLT-072): what changed on which record. */
export interface AuditEntry {
  /** Default: the command's name. */
  readonly action?: string
  readonly recordType: string
  readonly recordId: string
  /** The fields before and after, as the command chooses to record them (JSON; dates become ISO strings). */
  readonly before?: unknown
  readonly after?: unknown
  readonly reason?: string
  /** The record's company, when known. Default: the office context's company. */
  readonly companyId?: string | null
  /** The record's site, when known. A floor row always carries the device's site. */
  readonly siteId?: string | null
}

/** An event the work emits; the outbox writer stores it in the same transaction (A1 §3.4). */
export interface CommandEvent {
  /** Declared in the event catalogue (`@nexus/factory-domain/events/catalogue`); an undeclared type rolls back. */
  readonly type: string
  /** The payload's schema version. Default 1. */
  readonly version?: number
  /** The aggregate it is about, e.g. the record id (the partition key). */
  readonly subject: string
  readonly payload: unknown
  readonly companyId?: string | null
  readonly siteId?: string | null
}

/** An emitted event with its envelope (A1 §3.4), as the EventWriter receives it. */
export interface PendingEvent {
  /** UUIDv7: the event's idempotency key. */
  readonly eventId: string
  readonly type: string
  readonly version: number
  readonly tenantId: string
  readonly companyId: string | null
  readonly siteId: string | null
  /** The party of a partner or link write (the outbox row's scope; not part of the published envelope). */
  readonly partyId: string | null
  readonly subject: string
  /** The request (or job) id: ties the chain together. */
  readonly correlationId: string
  readonly causationId: string | null
  /** The command that emitted it. */
  readonly source: string
  /** The command's server time. */
  readonly occurredAt: Date
  readonly payload: unknown
}

/**
 * Writes the collected events inside the command's transaction, after the audit rows and before the receipt. The
 * default is the outbox writer (platform/outbox/writer.ts): OutboxEvent rows, each checked against the event catalogue.
 */
export type EventWriter = (tx: CommandTx, events: readonly PendingEvent[]) => Promise<void>

/** The guarded record, as the work sees it after the version bump. */
export interface GuardedRecord {
  readonly type: VersionedModel
  readonly id: string
  /** The new version (the one the answer should carry). */
  readonly version: number
  readonly previousVersion: number
  /** The state before and after the move, when the command made one. */
  readonly from?: string
  readonly to?: string
}

export interface CommandTools {
  readonly tx: CommandTx
  readonly context: RequestContext
  /** The command's server time (PLT-084): one instant for all its rows. */
  readonly now: Date
  readonly record: GuardedRecord | undefined
  /** Records an audit row. Every command records at least one. */
  audit(entry: AuditEntry): void
  /** Collects an event (written by the EventWriter in this transaction). */
  emit(event: CommandEvent): void
}

export interface CommandOutcome<Result> {
  readonly result: Result
  /** True when this is a stored answer to a repeated Idempotency-Key: nothing ran this time. */
  readonly replayed: boolean
}

export interface CommandSettings {
  readonly clock: Clock
  readonly writeEvents: EventWriter
  /** How long a receipt answers repeats (then a purge may delete it). */
  readonly receiptTtlMs: number
  /** Prisma's interactive-transaction limits: the wait for a pool connection, and the longest the transaction runs. */
  readonly maxWaitMs: number
  readonly timeoutMs: number
}

/** 30 days: a floor device may resend its queue after days offline (A1 §3.8). */
export const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * B-W2b-F2: room for a command on a loaded machine: 10 s for a connection, 15 s to run (were 5 s and 10 s). Past either
 * limit Prisma rolls the transaction back and the API answers 503 "busy, try again" (core/errors.ts), never 500.
 * Why not more: the browser reaches the API through the web's `/api` rewrite, which Next.js cuts after 30 s with a
 * plain 500 of its own. Both limits together (25 s) leave the route's reads before and after its command inside that,
 * so a busy database still reaches the person as the API's 503. A command that needs longer passes its own timeoutMs.
 */
export const COMMAND_SETTINGS: CommandSettings = Object.freeze({
  clock: serverClock,
  writeEvents: outboxWriter(),
  receiptTtlMs: RECEIPT_TTL_MS,
  maxWaitMs: 10_000,
  timeoutMs: 15_000,
})

/** The edit-conflict guard's refusal (COL-078): the record changed since the caller read it. */
export class StaleVersionError extends ConflictError {
  override name = 'StaleVersionError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly recordType: string,
    readonly recordId: string,
    readonly currentVersion: number,
    readonly sentVersion: number,
  ) {
    super(`This ${recordType} changed since it was read (version ${sentVersion}); it is now at version ${currentVersion}. Reload it and apply the change again.`)
    this.issues = [{ path: 'version', message: `The current version is ${currentVersion}.` }]
  }
}

/** The same Idempotency-Key was used for another request (PLT-189). */
export class IdempotencyKeyReusedError extends ConflictError {
  override name = 'IdempotencyKeyReusedError'
  constructor() {
    super('This Idempotency-Key was already used for a different request. Send a new key for a new request.')
  }
}

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const KEY_RULE = '8 to 128 letters, digits, dots, colons, underscores or hyphens'

/** The request's Idempotency-Key header, or undefined. A malformed one is a 400. */
export function idempotencyKeyFrom(request: Pick<FastifyRequest, 'headers'>): string | undefined {
  const value = request.headers[IDEMPOTENCY_KEY_HEADER]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !KEY.test(value)) {
    throw new ValidationError('The Idempotency-Key header is not valid.', [{ path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: `Expected ${KEY_RULE}.` }])
  }
  return value
}

type AuditAudience = Prisma.AuditLogCreateManyInput['audience']

/** Who writes: the audit columns that come from the context. */
interface Writer {
  readonly audience: AuditAudience
  readonly tenantId: string
  readonly actorId: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
  readonly deviceId: string | null
  readonly requestId: string
}

function writerOf(context: RequestContext): Writer {
  const base = { companyId: null, siteId: null, partyId: null, deviceId: null, requestId: context.requestId }
  switch (context.audience) {
    case 'office':
      return { ...base, audience: 'OFFICE', tenantId: context.tenantId, actorId: context.actorId, companyId: context.companyId ?? null, siteId: context.siteId ?? null }
    case 'floor':
      return { ...base, audience: 'FLOOR', tenantId: context.tenantId, actorId: context.actorId, siteId: context.siteId, deviceId: context.deviceId }
    case 'partner':
      return { ...base, audience: 'PARTNER', tenantId: context.tenantId, actorId: context.actorId, partyId: context.partyId }
    case 'link':
      return { ...base, audience: 'LINK', tenantId: context.tenantId, actorId: context.linkId, partyId: context.partyId }
    case 'system':
      return { ...base, audience: 'SYSTEM', tenantId: context.tenantId, actorId: SYSTEM_ACTOR_ID }
    default:
      // A platform context has no tenant, so no tenant audit trail: the tenant set-up step decides how it is audited.
      throw new ApiError('internal_error', `command() needs a tenant; the ${context.audience} audience cannot write through it.`)
  }
}

/** Fails fast on a malformed command, before the database is touched. Returns the key (or null). */
function checkSpec(spec: CommandSpec<string, unknown>, context: RequestContext): string | null {
  if (!isPermission(spec.name)) throw new ApiError('internal_error', `Command name ${JSON.stringify(spec.name)} is not <module>.<action>.`)
  const key = spec.idempotencyKey ?? null
  if (key !== null && (typeof key !== 'string' || !KEY.test(key))) {
    throw new ValidationError('The Idempotency-Key is not valid.', [{ path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: `Expected ${KEY_RULE}.` }])
  }
  if (key === null && (context.audience === 'floor' || context.audience === 'link')) {
    // A floor device resends its queue and a link may be clicked twice: without a key a resend would write twice.
    throw new ValidationError(`An Idempotency-Key is required for ${context.audience} writes.`, [
      { path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: 'Required.' },
    ])
  }
  const record = spec.record
  if (record) {
    if (!isUuid(record.id)) throw new NotFoundError(`${record.type} not found.`)
    if (record.expectedVersion !== undefined && (!Number.isSafeInteger(record.expectedVersion) || record.expectedVersion < 1)) {
      throw new ValidationError('The version is not valid.', [{ path: 'version', message: 'Expected a whole number from 1.' }])
    }
    // A link opens one record; it cannot be used to change another.
    if (context.audience === 'link' && (record.type !== context.record.type || record.id !== context.record.id)) throw new ForbiddenError()
  }
  if (spec.deviceTime !== undefined && !(spec.deviceTime instanceof Date && Number.isFinite(spec.deviceTime.getTime()))) {
    throw new ValidationError('The device time is not valid.', [{ path: 'deviceTime', message: 'Expected a time.' }])
  }
  return key
}

/** Plain JSON only, so the first answer and a replayed one are the same value. Throws (a bug: 500) otherwise. */
export function assertJson(value: unknown, path = 'result', depth = 0): void {
  const refuse = (what: string): never => {
    throw new ApiError('internal_error', `A command returned ${what} at ${path}; return plain JSON (dates via toUtcIso, decimals as strings).`)
  }
  if (depth > 64) refuse('data nested too deep')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) assertJson(value[index], `${path}[${index}]`, depth + 1)
    return
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) refuse(`a ${(value as object).constructor?.name ?? 'class'} object`)
    for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`, depth + 1)
    return
  }
  refuse(value === undefined ? 'undefined' : `a ${typeof value}`)
}

/** JSON as JSON.stringify writes it (toJSON applied, undefined dropped), with object keys sorted at every level. */
function canonical(value: unknown): unknown {
  const plain = value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function' ? (value as { toJSON(): unknown }).toJSON() : value
  if (typeof plain === 'bigint') return plain.toString()
  if (Array.isArray(plain)) return plain.map((item) => (item === undefined ? null : canonical(item)))
  if (plain !== null && typeof plain === 'object') {
    return Object.fromEntries(
      Object.keys(plain)
        .filter((key) => (plain as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, canonical((plain as Record<string, unknown>)[key])]),
    )
  }
  return plain
}

/** SHA-256 (hex) of the command, the caller, the record and the input: what makes a repeat "the same request". */
export function requestHash<State extends string, Facts>(spec: CommandSpec<State, Facts>, context: RequestContext): string {
  const writer = writerOf(context)
  const record = spec.record
    ? { type: spec.record.type, id: spec.record.id, expectedVersion: spec.record.expectedVersion, to: spec.record.transition?.to }
    : null
  const material = canonical({ command: spec.name, audience: writer.audience, actorId: writer.actorId, record, input: spec.input })
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

const json = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue)

interface RecordDelegate {
  findUnique(args: { where: { id: string }; select: Record<string, true> }): Promise<Record<string, unknown> | null>
  updateMany(args: { where: { id: string; version: number }; data: Record<string, unknown> }): Promise<{ count: number }>
}

function delegateOf(tx: CommandTx, type: string): RecordDelegate {
  const delegate = (tx as unknown as Record<string, RecordDelegate | undefined>)[type.charAt(0).toLowerCase() + type.slice(1)]
  if (!delegate || typeof delegate.updateMany !== 'function') throw new ApiError('internal_error', `command(): no model ${type}.`)
  return delegate
}

/** Step 2: exists, expected version, allowed move; then compare-and-set the version (and the state). */
async function guardRecord(tx: CommandTx, record: CommandRecord<string, unknown>): Promise<GuardedRecord> {
  const delegate = delegateOf(tx, record.type)
  const field = record.transition?.field ?? 'status'
  const select: Record<string, true> = record.transition ? { version: true, [field]: true } : { version: true }
  const row = await delegate.findUnique({ where: { id: record.id }, select })
  if (!row) throw new NotFoundError(`${record.type} not found.`)
  const version = row.version as number
  if (record.expectedVersion !== undefined && record.expectedVersion !== version) {
    throw new StaleVersionError(record.type, record.id, version, record.expectedVersion)
  }
  let from: string | undefined
  if (record.transition) {
    from = String(row[field])
    const facts = record.transition.facts ? await record.transition.facts(tx) : undefined
    assertTransition(record.transition.machine as Machine<string, unknown>, from, record.transition.to, facts)
  }
  const data: Record<string, unknown> = { version: version + 1 }
  if (record.transition) data[field] = record.transition.to
  const { count } = await delegate.updateMany({ where: { id: record.id, version }, data })
  if (count !== 1) {
    const current = await delegate.findUnique({ where: { id: record.id }, select: { version: true } })
    if (!current) throw new NotFoundError(`${record.type} not found.`)
    throw new StaleVersionError(record.type, record.id, current.version as number, version)
  }
  return {
    type: record.type,
    id: record.id,
    version: version + 1,
    previousVersion: version,
    ...(record.transition ? { from, to: record.transition.to } : {}),
  }
}

type StoredReceipt = { readonly requestHash: string; readonly response: unknown }

const findReceipt = (client: Pick<CommandTx, 'idempotencyReceipt'>, scope: string, key: string): Promise<StoredReceipt | null> =>
  client.idempotencyReceipt.findFirst({ where: { scope, key }, select: { requestHash: true, response: true } })

function answerFrom<Result>(stored: StoredReceipt, hash: string): CommandOutcome<Result> {
  if (stored.requestHash !== hash) throw new IdempotencyKeyReusedError()
  return { result: (stored.response as { result: Result }).result, replayed: true }
}

/** The receipt's key is taken by a transaction that committed meanwhile (or by a row this caller cannot see). */
class ReceiptTaken extends Error {
  override name = 'ReceiptTaken'
}

function auditRow(entry: AuditEntry, spec: CommandSpec<string, unknown>, writer: Writer, key: string | null, now: Date): Prisma.AuditLogCreateManyInput {
  // An entry's own company and site win, null included ("tenant-wide"); left out, the context's apply.
  let siteId = entry.siteId !== undefined ? entry.siteId : writer.siteId
  if (writer.audience === 'FLOOR') {
    if (entry.siteId && entry.siteId !== writer.siteId) {
      throw new ApiError('internal_error', 'A floor command recorded an audit row for another site than its device\'s.')
    }
    siteId = writer.siteId
  }
  const before = json(entry.before)
  const after = json(entry.after)
  return {
    id: newId(),
    companyId: entry.companyId !== undefined ? entry.companyId : writer.companyId,
    siteId,
    partyId: writer.partyId,
    at: now,
    deviceTime: spec.deviceTime ?? null,
    audience: writer.audience,
    actorId: writer.actorId,
    deviceId: writer.deviceId,
    action: entry.action ?? spec.name,
    recordType: entry.recordType,
    recordId: entry.recordId,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    reason: entry.reason ?? null,
    requestId: writer.requestId,
    idempotencyKey: key,
  }
}

function checkEntry(entry: AuditEntry): AuditEntry {
  if (typeof entry?.recordType !== 'string' || !/^[A-Z][A-Za-z0-9]{0,63}$/.test(entry.recordType)) {
    throw new ApiError('internal_error', 'An audit entry needs the record\'s model name (recordType).')
  }
  if (!isUuid(entry.recordId)) throw new ApiError('internal_error', 'An audit entry needs the record\'s id (a UUID).')
  if (entry.action !== undefined && !isPermission(entry.action)) throw new ApiError('internal_error', `Audit action ${JSON.stringify(entry.action)} is not <module>.<action>.`)
  return entry
}

function checkEvent(event: CommandEvent): CommandEvent {
  if (typeof event?.type !== 'string' || event.type === '' || typeof event.subject !== 'string' || event.subject === '') {
    throw new ApiError('internal_error', 'An event needs a type and a subject.')
  }
  if (event.version !== undefined && (!Number.isSafeInteger(event.version) || event.version < 1)) {
    throw new ApiError('internal_error', 'An event version is a whole number from 1.')
  }
  assertJson(event.payload, `event ${event.type} payload`)
  return event
}

/** Runs a write through command() with the default settings (the server clock; the outbox's event writer). */
export function command<Result, State extends string = string, Facts = undefined>(
  caller: CommandCaller,
  spec: CommandSpec<State, Facts>,
  work: (tools: CommandTools) => Promise<Result>,
): Promise<CommandOutcome<Result>> {
  return runCommand(caller, spec, work, COMMAND_SETTINGS)
}

/** command() with explicit settings (tests: a fixed clock, an event writer). */
export async function runCommand<Result, State extends string = string, Facts = undefined>(
  caller: CommandCaller,
  spec: CommandSpec<State, Facts>,
  work: (tools: CommandTools) => Promise<Result>,
  settings: CommandSettings,
): Promise<CommandOutcome<Result>> {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  const loose = spec as unknown as CommandSpec<string, unknown>
  const writer = writerOf(context)
  const key = checkSpec(loose, context)
  const hash = key === null ? '' : requestHash(loose, context)
  const now = settings.clock.now()

  try {
    return await caller.withClient((client) =>
      client.$transaction(
        async (tx): Promise<CommandOutcome<Result>> => {
          if (key !== null) {
            const stored = await findReceipt(tx, spec.name, key)
            if (stored) return answerFrom<Result>(stored, hash)
          }
          const record = loose.record ? await guardRecord(tx, loose.record) : undefined

          const audits: AuditEntry[] = []
          const events: CommandEvent[] = []
          let open = true
          const tools: CommandTools = {
            tx,
            context,
            now,
            record,
            audit(entry) {
              if (!open) throw new ApiError('internal_error', 'audit() was called after the command\'s work ended.')
              audits.push(checkEntry(entry))
            },
            emit(event) {
              if (!open) throw new ApiError('internal_error', 'emit() was called after the command\'s work ended.')
              events.push(checkEvent(event))
            },
          }
          let result: Result
          try {
            result = await work(tools)
          } finally {
            open = false
          }
          assertJson(result)
          if (audits.length === 0) throw new ApiError('internal_error', `Command ${spec.name} recorded no audit row; every write is audited.`)

          await tx.auditLog.createMany({ data: audits.map((entry) => auditRow(entry, loose, writer, key, now)) })
          await settings.writeEvents(
            tx,
            events.map((event) => ({
              eventId: newId(),
              type: event.type,
              version: event.version ?? 1,
              tenantId: writer.tenantId,
              companyId: event.companyId ?? writer.companyId,
              siteId: event.siteId ?? writer.siteId,
              partyId: writer.partyId,
              subject: event.subject,
              correlationId: writer.requestId,
              causationId: spec.causationId ?? null,
              source: spec.name,
              occurredAt: now,
              payload: event.payload,
            })),
          )
          if (key !== null) {
            const response = { result } as unknown as Prisma.InputJsonValue
            const { count } = await tx.idempotencyReceipt.createMany({
              data: [
                {
                  id: newId(),
                  siteId: writer.audience === 'FLOOR' ? writer.siteId : null,
                  partyId: writer.partyId,
                  scope: spec.name,
                  key,
                  requestHash: hash,
                  response,
                  actorId: writer.actorId,
                  requestId: writer.requestId,
                  createdAt: now,
                  expiresAt: new Date(now.getTime() + settings.receiptTtlMs),
                },
              ],
              skipDuplicates: true,
            })
            if (count !== 1) throw new ReceiptTaken()
          }
          return { result, replayed: false }
        },
        { maxWait: settings.maxWaitMs, timeout: settings.timeoutMs },
      ),
    )
  } catch (error) {
    // B-W2b-F2: a busy database answers at once (503 "busy, try again", core/errors.ts) without waiting for one more
    // connection to look for a receipt; this command wrote nothing, and its repeat finds the receipt if one was written.
    if (key === null || error instanceof IdempotencyKeyReusedError || isBusyDatabaseError(error)) throw error
    // A repeat that raced the first request: both missed the receipt, the first committed, this one failed (on the
    // version, a unique key or the receipt). Answer from the first one's receipt.
    let stored: StoredReceipt | null
    try {
      stored = await caller.withClient((client) => findReceipt(client, spec.name, key))
    } catch {
      throw error
    }
    if (stored) return answerFrom<Result>(stored, hash)
    if (error instanceof ReceiptTaken) throw new IdempotencyKeyReusedError()
    throw error
  }
}
