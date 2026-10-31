import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { IMPORTS_APPLY, IMPORTS_RUN, IMPORTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  doneProblems,
  FIRST_LOAD_DONE_ACTION,
  FIRST_LOAD_IMPORTERS,
  FIRST_LOAD_STEPS,
  isFirstLoadStep,
  judge,
  stepStateOf,
  type FirstLoadStep,
  type QuantityLine,
  type Reconciliation,
} from '@nexus/factory-domain/imports/first-load'
import { isMarkedJson } from '@nexus/factory-domain/money/marked'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { importedLines } from '../../../modules/inventory/opening/facts'
import { processImporters, type ImportAdapter } from '../registry'
import type { FirstLoadStepView, MarkDoneBody } from './contract'

/**
 * The guided first load (B-W2a-41; PLT-185; design admin.import "First load, in order"), one company at a time:
 *
 *   GET  /imports/first-load?companyId=        the five steps in order, each with its state, the applied import it reads
 *                                              (the company's, or a tenant-wide one), the reconciliation (sheet rows
 *                                              against the records there now; opening stock: quantities per unit and,
 *                                              with the cost grain, the value), the differences in words and the
 *                                              person's "Done"
 *   POST /imports/first-load/:step/done         one command: the step's facts read again, refused (409, the differences)
 *                                              while an earlier step is open, without an applied import or with a
 *                                              difference; else the step's FirstLoadStep row (B-W2b-24; written once) and
 *                                              an audit row `imports.firstLoadStepDone`. `nothing: true` = done with
 *                                              nothing to load, with its reason (open orders have no importer yet).
 *
 * Seeing a step's import needs imports.view and the importer's view permission over the company (as the jobs list);
 * importing needs imports.run and its permission; "Done" needs imports.apply and its permission.
 */

type Client = Prisma.TransactionClient

/** B-W2b-24: the shortest reason for "nothing to load". */
export const NOTHING_REASON_MIN = 3

const actorOfCaller = (caller: CommandCaller): Actor => {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return actorOf(caller.factoryContext)
}

const KEYS = [...new Set(Object.values(FIRST_LOAD_IMPORTERS).filter((key): key is string => key !== null))]
const JOB = { id: true, importerKey: true, companyId: true, status: true, rowCount: true, appliedAt: true, createdAt: true, file: { select: { originalName: true } } } as const satisfies Prisma.ImportJobSelect
type JobRow = Prisma.ImportJobGetPayload<{ select: typeof JOB }>

const CUSTOMER_ROLES = new Set(['CUSTOMER', 'BRAND'])
const SUPPLIER_ROLES = new Set(['SUPPLIER', 'SUBCONTRACTOR'])

const adapterOf = (key: string | null): ImportAdapter | undefined => (key ? processImporters().get(key) : undefined)
const maySee = (actor: Actor, adapter: ImportAdapter | undefined, companyId: string): boolean =>
  adapter !== undefined && can(actor, IMPORTS_VIEW, { companyId }) && can(actor, adapter.viewPermission, { companyId })

const plain = (value: unknown): string | null => {
  const raw = isMarkedJson(value) ? value.value : value
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null
}
const cents = (value: Decimal): number => Number(value.times(100).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toString())

/** The rows of a job that should have a record now: applied creates and updates, and unchanged rows. */
async function loadedRows(client: Client, jobId: string) {
  return client.importRow.findMany({
    where: { jobId, OR: [{ action: 'UNCHANGED' }, { action: { in: ['CREATE', 'UPDATE'] }, outcome: 'APPLIED' }] },
    select: { action: true, key: true, recordId: true, after: true },
    orderBy: { rowNumber: 'asc' },
  })
}

/** One applied import against the records there now (factory-domain imports/first-load). */
export async function reconcile(client: Client, job: JobRow, companyId: string, withValue: boolean): Promise<Reconciliation> {
  const [refused, skipped, rows] = [
    await client.importRow.count({ where: { jobId: job.id, action: 'ERROR' } }),
    await client.importRow.count({ where: { jobId: job.id, outcome: 'SKIPPED' } }),
    await loadedRows(client, job.id),
  ]
  const base = { rows: job.rowCount, refused, skipped }
  const ids = rows.flatMap((row) => (row.recordId ? [row.recordId] : []))
  if (job.importerKey === 'parties.parties') {
    const parties = ids.length === 0 ? [] : await client.party.findMany({ where: { id: { in: ids }, status: { not: 'ARCHIVED' } }, select: { roles: true } })
    return {
      ...base,
      loaded: parties.length,
      roles: {
        customers: parties.filter((party) => party.roles.some((role) => CUSTOMER_ROLES.has(role))).length,
        suppliers: parties.filter((party) => party.roles.some((role) => SUPPLIER_ROLES.has(role))).length,
      },
    }
  }
  if (job.importerKey === 'product.materials') {
    const items = ids.length === 0 ? 0 : await client.item.count({ where: { id: { in: ids }, status: { not: 'ARCHIVED' } } })
    return { ...base, loaded: items }
  }
  // Opening stock: rows find their posted lines by the line reference (the key), never by the record id.
  const owner = job.companyId ?? companyId
  const lineOf = (key: string | null): string | null => {
    if (!key) return null
    try {
      const parsed = JSON.parse(key) as unknown
      return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null
    } catch {
      return null
    }
  }
  const lines = rows.flatMap((row) => {
    const line = lineOf(row.key)
    return line ? [{ line, row }] : []
  })
  const posted = await importedLines(client, owner, lines.map((entry) => entry.line))
  const sheet = new Map<string, Decimal>()
  const loadedQty = new Map<string, Decimal>()
  const add = (map: Map<string, Decimal>, unit: string, quantity: Decimal) => map.set(unit, (map.get(unit) ?? new Dec(0)).plus(quantity))
  const moveIds = [...posted.values()].flatMap((line) => line.moves.map((move) => move.id))
  const valuations = withValue && moveIds.length > 0 ? await client.stockValuation.findMany({ where: { moveId: { in: moveIds } }, select: { moveId: true, valueAmount: true, currency: true } }) : []
  const valueOf = new Map(valuations.map((row) => [row.moveId, row.valueAmount]))
  const value = { sheet: 0, loaded: 0, atStandard: 0, rowsAtStandard: 0, tolerance: 0, currency: valuations[0]?.currency ?? 'EUR' }
  let loaded = 0
  for (const { line, row } of lines) {
    const done = posted.get(line)
    const linesValue = done ? done.moves.reduce((sum, move) => sum + (valueOf.get(move.id) ?? 0), 0) : 0
    if (done) {
      loaded += 1
      for (const move of done.moves) add(loadedQty, done.unit, new Dec(move.quantity))
    }
    const after = row.action === 'CREATE' && row.after && typeof row.after === 'object' && !Array.isArray(row.after) ? (row.after as Record<string, unknown>) : null
    if (!after) {
      // Unchanged: the line was posted before and the sheet says the same.
      if (done) for (const move of done.moves) add(sheet, done.unit, new Dec(move.quantity))
      value.sheet += linesValue
      value.loaded += linesValue
      continue
    }
    const unit = plain(after.unit) ?? done?.unit ?? '?'
    const areas = plain(after.areas)
    const quantity = areas ? areas.split(';').reduce((sum, part) => sum.plus(new Dec(part.trim() || '0')), new Dec(0)) : new Dec(plain(after.quantity) ?? '0')
    add(sheet, unit, quantity)
    const unitCost = plain(after.unitCost)
    if (unitCost === null) {
      value.atStandard += linesValue
      value.rowsAtStandard += 1
    } else {
      value.sheet += cents(quantity.times(new Dec(unitCost)))
      value.loaded += linesValue
      value.tolerance += done ? done.moves.length : 1
    }
  }
  const units = [...new Set([...sheet.keys(), ...loadedQty.keys()])].sort()
  const quantities: QuantityLine[] = units.map((unit) => ({ unit, sheet: (sheet.get(unit) ?? new Dec(0)).toFixed(4), loaded: (loadedQty.get(unit) ?? new Dec(0)).toFixed(4) }))
  return { ...base, loaded, quantities, ...(withValue ? { value } : {}) }
}

interface DoneMark {
  readonly at: Date
  readonly byId: string | null
  readonly nothing: boolean
  readonly jobId: string | null
  readonly reason: string | null
}

/**
 * The people's "Done" per step (B-W2b-24): the step's FirstLoadStep row (written once by markFirstLoadDone; B-W2a-41 kept
 * an audit row instead — a step done before B-W2b-24 is read from it until the catch-up (./catch-up.ts) writes its row).
 */
async function doneMarks(client: Client, companyId: string): Promise<Map<FirstLoadStep, DoneMark>> {
  const out = new Map<FirstLoadStep, DoneMark>()
  const rows = await client.firstLoadStep.findMany({ where: { companyId }, select: { step: true, jobId: true, nothingToLoad: true, reason: true, doneAt: true, doneById: true } })
  for (const row of rows) {
    if (!isFirstLoadStep(row.step)) continue
    out.set(row.step, { at: row.doneAt, byId: row.doneById === SYSTEM_ACTOR_ID ? null : row.doneById, nothing: row.nothingToLoad, jobId: row.jobId, reason: row.reason })
  }
  for (const [step, mark] of await auditMarks(client, companyId)) if (!out.has(step)) out.set(step, mark)
  return out
}

/** A step's "Done" as B-W2a-41 kept it: the latest `imports.firstLoadStepDone` audit row of each step. */
export async function auditMarks(client: Pick<Client, 'auditLog'>, companyId: string): Promise<Map<FirstLoadStep, DoneMark>> {
  const rows = await client.auditLog.findMany({ where: { action: FIRST_LOAD_DONE_ACTION, companyId }, select: { at: true, actorId: true, audience: true, after: true, reason: true }, orderBy: { at: 'desc' }, take: 50 })
  const out = new Map<FirstLoadStep, DoneMark>()
  for (const row of rows) {
    const after = row.after && typeof row.after === 'object' && !Array.isArray(row.after) ? (row.after as Record<string, unknown>) : {}
    if (!isFirstLoadStep(after.step) || out.has(after.step)) continue
    const nothing = after.nothing === true
    out.set(after.step, { at: row.at, byId: row.audience === 'OFFICE' ? row.actorId : null, nothing, jobId: typeof after.jobId === 'string' ? after.jobId : null, reason: nothing ? (row.reason ?? null) : null })
  }
  return out
}

interface StepFactsRead {
  readonly step: FirstLoadStep
  readonly adapter: ImportAdapter | undefined
  readonly visible: boolean
  readonly applied: JobRow | null
  readonly running: JobRow | null
  readonly reconciliation: Reconciliation | null
  readonly done: DoneMark | null
}

async function readSteps(client: Client, actor: Actor, companyId: string, chosen?: { step: FirstLoadStep; jobId: string }): Promise<StepFactsRead[]> {
  const jobs = await client.importJob.findMany({
    where: { importerKey: { in: KEYS }, OR: [{ companyId }, { companyId: null }], status: { in: ['UPLOADED', 'PLANNED', 'APPLYING', 'APPLIED'] } },
    select: JOB,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
  })
  const marks = await doneMarks(client, companyId)
  const withValue = heldGrains(actor).has('cost')
  const out: StepFactsRead[] = []
  const reconciled = new Map<string, Reconciliation>()
  for (const step of FIRST_LOAD_STEPS) {
    const key = FIRST_LOAD_IMPORTERS[step]
    const adapter = adapterOf(key)
    const visible = maySee(actor, adapter, companyId)
    const own = jobs.filter((job) => job.importerKey === key)
    const appliedJobs = own.filter((job) => job.status === 'APPLIED').sort((a, b) => (b.appliedAt?.getTime() ?? 0) - (a.appliedAt?.getTime() ?? 0))
    const applied = chosen?.step === step ? (appliedJobs.find((job) => job.id === chosen.jobId) ?? null) : (appliedJobs[0] ?? null)
    const running = own.find((job) => job.status !== 'APPLIED' && (!applied || job.createdAt > applied.createdAt)) ?? null
    let reconciliation: Reconciliation | null = null
    if (applied) {
      reconciliation = reconciled.get(applied.id) ?? (await reconcile(client, applied, companyId, withValue))
      reconciled.set(applied.id, reconciliation)
    }
    out.push({ step, adapter, visible, applied, running, reconciliation, done: marks.get(step) ?? null })
  }
  return out
}

/** The reconciliation as the answer carries it (plain arrays). */
function reconciliationOut(r: Reconciliation): NonNullable<FirstLoadStepView['reconciliation']> {
  return {
    rows: r.rows,
    loaded: r.loaded,
    refused: r.refused,
    skipped: r.skipped,
    ...(r.roles ? { roles: { ...r.roles } } : {}),
    ...(r.quantities ? { quantities: r.quantities.map((line) => ({ ...line })) } : {}),
    ...(r.value ? { value: { ...r.value } } : {}),
  }
}

function viewsOf(actor: Actor, companyId: string, steps: readonly StepFactsRead[]): { steps: FirstLoadStepView[]; complete: boolean } {
  let earlierDone = true
  let waitingFor: FirstLoadStep | null = null
  const views: FirstLoadStepView[] = []
  for (const facts of steps) {
    const judgement = facts.reconciliation ? judge(facts.reconciliation) : null
    const state = stepStateOf({ step: facts.step, done: facts.done ? { at: toUtcIso(facts.done.at), nothing: facts.done.nothing } : null, running: facts.running !== null, applied: facts.reconciliation }, earlierDone)
    const shown = facts.visible
    views.push({
      step: facts.step,
      importerKey: FIRST_LOAD_IMPORTERS[facts.step],
      state,
      waitingFor: state === 'waiting' ? waitingFor : null,
      job: shown && facts.applied ? { id: facts.applied.id, fileName: facts.applied.file.originalName, companyId: facts.applied.companyId, appliedAt: facts.applied.appliedAt ? toUtcIso(facts.applied.appliedAt) : null, rowCount: facts.applied.rowCount } : null,
      runningJobId: shown && facts.running ? facts.running.id : null,
      reconciliation: shown && facts.reconciliation ? reconciliationOut(facts.reconciliation) : null,
      matches: shown && judgement ? judgement.matches : null,
      differences: shown && judgement ? [...judgement.differences] : [],
      done: facts.done ? { at: toUtcIso(facts.done.at), byId: facts.done.byId, nothing: facts.done.nothing, reason: facts.done.reason, stillMatches: facts.done.nothing || !shown || !judgement ? null : judgement.matches } : null,
      canImport: facts.adapter !== undefined && can(actor, IMPORTS_RUN, { companyId }) && can(actor, facts.adapter.permission, { companyId }),
      canMarkDone: can(actor, IMPORTS_APPLY, { companyId }) && (facts.adapter === undefined ? FIRST_LOAD_IMPORTERS[facts.step] === null : can(actor, facts.adapter.permission, { companyId })),
    })
    if (!facts.done && earlierDone) waitingFor = facts.step
    earlierDone = earlierDone && facts.done !== null
  }
  return { steps: views, complete: steps.every((facts) => facts.done !== null) }
}

async function companyFor(caller: CommandCaller, client: Client, companyId: string): Promise<void> {
  const company = await client.company.findUnique({ where: { id: companyId }, select: { id: true } })
  if (!company || !can(actorOfCaller(caller), IMPORTS_VIEW, { companyId })) throw new NotFoundError('Company not found.')
}

/** GET /imports/first-load. */
export async function readFirstLoad(caller: CommandCaller, companyId: string): Promise<{ companyId: string; steps: FirstLoadStepView[]; complete: boolean }> {
  const actor = actorOfCaller(caller)
  return caller.withClient(async (client) => {
    await companyFor(caller, client, companyId)
    return { companyId, ...viewsOf(actor, companyId, await readSteps(client, actor, companyId)) }
  })
}

/** imports.firstLoadStepDone: the step read again in the command; refused in words; an audit row. */
export async function markFirstLoadDone(caller: CommandCaller, step: FirstLoadStep, body: MarkDoneBody, idempotencyKey?: string): Promise<{ companyId: string; steps: FirstLoadStepView[]; complete: boolean }> {
  const actor = actorOfCaller(caller)
  const { companyId } = body
  await caller.withClient((client) => companyFor(caller, client, companyId))
  const adapter = adapterOf(FIRST_LOAD_IMPORTERS[step])
  if (!can(actor, IMPORTS_APPLY, { companyId }) || (adapter && !can(actor, adapter.permission, { companyId }))) throw new ForbiddenError()
  // B-W2b-24: "nothing to load" says why (the step's row keeps it; the database refuses it without one).
  const reason = body.reason?.trim() ?? ''
  if (body.nothing === true && reason.length < NOTHING_REASON_MIN) throw new ValidationError('Say why there is nothing to load for this step.', [{ path: 'body/reason', message: `Expected ${NOTHING_REASON_MIN} to 500 characters.` }])
  const { result } = await command(caller, { name: 'imports.firstLoadStepDone', idempotencyKey, input: { step, ...body } }, async ({ tx, audit, now }) => {
    const steps = await readSteps(tx, actor, companyId, body.jobId ? { step, jobId: body.jobId } : undefined)
    const index = FIRST_LOAD_STEPS.indexOf(step)
    const facts = steps[index]!
    if (body.jobId && !facts.applied) throw new NotFoundError('No applied import with this id for this step.')
    const problems = doneProblems({
      step,
      earlier: steps.slice(0, index).map((item) => ({ step: item.step, done: item.done !== null })),
      applied: body.nothing ? (facts.reconciliation ?? null) : facts.reconciliation,
      nothing: body.nothing === true,
      alreadyDone: facts.done !== null,
    })
    if (problems.length > 0) throw new DomainError('conflict', problems[0]!.message, problems)
    const job = body.nothing ? null : facts.applied
    // B-W2b-24: the step's row, written once (the database refuses a second one and every change).
    const doneById = caller.factoryContext?.audience === 'office' ? caller.factoryContext.actorId : SYSTEM_ACTOR_ID
    await tx.firstLoadStep.create({
      data: { id: newId(), companyId, step, jobId: job?.id ?? null, nothingToLoad: job === null, reason: job === null ? reason : null, doneAt: now, doneById, createdAt: now, updatedAt: now, createdById: doneById },
      select: { id: true },
    })
    audit({
      action: FIRST_LOAD_DONE_ACTION,
      recordType: job ? 'ImportJob' : 'Company',
      recordId: job ? job.id : companyId,
      companyId,
      after: {
        step,
        nothing: body.nothing === true,
        jobId: job?.id ?? null,
        rows: facts.reconciliation?.rows ?? 0,
        loaded: facts.reconciliation?.loaded ?? 0,
        ...(facts.reconciliation?.quantities ? { quantities: facts.reconciliation.quantities } : {}),
      },
      ...(body.reason ? { reason: body.reason } : {}),
    })
    const after = steps.map((item, i) => (i === index ? { ...item, done: { at: now, byId: doneById === SYSTEM_ACTOR_ID ? null : doneById, nothing: job === null, jobId: job?.id ?? null, reason: job === null ? reason : null } } : item))
    return { companyId, ...viewsOf(actor, companyId, after) }
  })
  return result
}
