/**
 * Step 4 Send to FBA — the job that runs a plan's Amazon steps (Part B, plan §2). One run claims the plan, then works
 * step after step until a person is needed, an Amazon operation is still running, the plan is held or failed, or it is
 * done:
 *
 *   QUEUED → CREATING (createInboundPlan) → PACKING (generate / list / pick / confirm packing option) → BOXES
 *   (planBoxes per packing group → setPackingInformation) → PLACING (generatePlacementOptions, getShipment per shipment)
 *   → QUOTING (generateTransportationOptions per option, generateDeliveryWindowOptions per shipment) →
 *   WAITING_FOR_CHOICE ── a person's click (confirmChoice, Part C) ──► CONFIRMING (confirmPlacementOption — FINAL at
 *   Amazon —, FBAShipment rows, confirmDeliveryWindowOptions, confirmTransportationOptions) → LABELS (listShipmentBoxes)
 *   → READY_TO_SHIP ── a person marks each shipment Shipped (Part C) ──► TRACKING (updateShipmentTrackingDetails).
 *   CANCELLING (cancelPlan, Part C) → cancelInboundPlan → CANCELLED.
 *
 * Rules it keeps:
 *  - It NEVER confirms on its own: CONFIRMING runs only with `confirmedBy` + `choice` written by a person's click; a plan
 *    found CONFIRMING without them goes back to WAITING_FOR_CHOICE and nothing is sent.
 *  - Claim: `updateMany where status ∈ FBA_CLAIMABLE_STATUSES and (nextCheckAt null or ≤ now)` → `nextCheckAt = now +
 *    FBA_LEASE_MS`; the lease is bumped before every Amazon call, which also notices a cancel (CANCELLING) in time.
 *  - Operation ids are written to `plan.steps` BEFORE polling; a resumed run polls them and never sends again. A create
 *    is recorded as an intent entry before it is sent: a run that finds the intent without an operation id (the answer
 *    was lost) looks for the plan by its unique name at Amazon (listInboundPlans) and adopts it — never a second plan.
 *    A confirm reads Amazon's state first and is sent only when not yet confirmed: never twice.
 *  - Polls getInboundOperationStatus after 2, 3, 5, 8, 13, 20, 30 s (~80 s); still IN_PROGRESS → `nextCheckAt = now +
 *    FBA_RECHECK_MS` and the run ends; the resume job (or the next dispatch) continues it. No HTTP request waits.
 *  - Amazon writes off / account sign-in / rate wait → HELD (resumes by itself); Amazon refuses → FAILED with Amazon's
 *    problems verbatim ("Try again" re-runs the step); no answer / 5xx → the same step again later.
 *  - Writes `fba.plan_changed` in the transaction of every status / step change. Never touches stock (holds and the
 *    Shipped movement are Part C's).
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { publishEvent } from '../../lib/events/publish.js'
import { MARKETPLACE_ID_TO_CODE } from '../../utils/marketplace-code.js'
import * as amazon from '../../clients/amazon-fba-inbound-v2.client.js'
import {
  FBA_AMAZON_OPERATIONS, FBA_CLAIMABLE_STATUSES, FBA_EVENT_MAX_PRODUCTS, FBA_SEND_COPY, FBA_STEP_STATUS, MIXED_BOX_DEFAULT,
  addressMissing, fbaAmazonPlanName, isFbaPlanStatus, isFbaPlanStep, lengthCm, planBoxes, unitWeightKg,
  type FbaAmazonOperation, type FbaAmazonProblem, type FbaBoxPlan, type FbaBoxSku, type FbaChoiceRequest, type FbaDeliveryWindowOption,
  type FbaFee, type FbaMixedBox, type FbaPackingSnapshot, type FbaPlanOptions, type FbaPlanStatus, type FbaPlanStep,
  type FbaPlanStepEntry, type FbaPlacementOption, type FbaShipmentBox, type FbaShipmentTracking, type FbaShipmentTransport,
  type FbaSourceAddress, type FbaTransportOption,
} from '@nexus/shared/fba-send'
import { FBA_LEASE_MS, FBA_POLL_SECONDS, FBA_POST_SPACING_MS, FBA_RECHECK_MS, type FbaRunOutcome } from './contract.js'

/** HELD for writes off / sign-in: look again after this long (the resume job re-dispatches it). */
export const FBA_HELD_RECHECK_MS = 15 * 60_000
const TRACKING_STATUSES = ['READY_TO_SHIP', 'SHIPPED'] as const
const MAX_STEPS_PER_RUN = 30

export interface FbaRunnerDeps {
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /** After CREATE and TRACKING: re-read Amazon's FBA numbers for these SKUs so "+N" shows early. Best effort. */
  syncInventory?: (mskus: string[], marketplaceId: string) => Promise<void>
}

/* ── the plan as the runner reads it ─────────────────────────────────────────────────────────── */

const PLAN_SELECT = {
  id: true, status: true, currentStep: true, planId: true, name: true, channelConnectionId: true, marketplaceId: true,
  sourceLocationId: true, sourceAddress: true, readyToShipOn: true, mixedBox: true, packing: true, options: true, choice: true,
  steps: true, nextCheckAt: true, confirmedBy: true, cancelledAt: true, source: true, createdAt: true, updatedAt: true, lastError: true,
} as const
type PlanRow = Prisma.FbaInboundPlanV2GetPayload<{ select: typeof PLAN_SELECT }>
interface Line { productId: string; msku: string; quantity: number; cases: number; unitsPerCase: number | null; looseUnits: number; prepOwner: string; labelOwner: string }

interface Ctx {
  id: string
  row: PlanRow
  lines: Line[]
  productIds: string[]
  now: () => Date
  sleep: (ms: number) => Promise<void>
  syncInventory: (mskus: string[], marketplaceId: string) => Promise<void>
  /** The statuses the current step runs in (the lease and the cancel check use them). */
  expect: readonly string[]
  step: FbaPlanStep
  lastWriteAt: number
}

type StepResult = 'continue' | 'stop'

/* ── control flow ────────────────────────────────────────────────────────────────────────────── */

/** An operation is still running at Amazon: look again later (`nextCheckAt = now + FBA_RECHECK_MS`). */
class StillRunning extends Error { constructor(readonly why = 'still running at Amazon') { super(why) } }
/** A person asked to cancel while the step ran: the next loop runs CANCEL. */
class CancelRequested extends Error {}
/** The plan moved under the run (another writer): re-read and go on from its new status. */
class PlanMoved extends Error {}
/** Amazon (or the box rule) refused: the plan is FAILED with these problems. `logged` = the step log already has them. */
class StepFailed extends Error {
  constructor(message: string, readonly problems: FbaAmazonProblem[], readonly call: FbaAmazonOperation | null = null,
    readonly logged = false, readonly note: string | null = null, readonly shipmentId: string | null = null) {
    super(message)
  }
}

const isOperation = (name: string): name is FbaAmazonOperation => (FBA_AMAZON_OPERATIONS as readonly string[]).includes(name)
const problem = (code: string, message: string, severity: string | null = 'ERROR', details: string | null = null): FbaAmazonProblem => ({ code, message, severity, details })
const problemsOfOperation = (list: amazon.OperationProblem[]): FbaAmazonProblem[] =>
  list.map(p => problem(p.code ?? 'Unknown', p.message ?? '', p.severity ?? null, p.details ? p.details : null))
const problemsOfError = (error: amazon.AmazonInboundError): FbaAmazonProblem[] =>
  error.errors.length ? error.errors.map(e => problem(e.code, e.message, 'ERROR', e.details)) : [problem(`HTTP_${error.status}`, error.message)]

function isGatewayRefusal(error: unknown): error is Error & { outcome: string; code: string; retryAfterMs: number | null } {
  return error instanceof Error && error.name === 'GatewayRefusal' && typeof (error as { outcome?: unknown }).outcome === 'string'
}
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024'])
function isTransient(error: unknown): boolean {
  if (error instanceof amazon.AmazonInboundError) return error.transient
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return (typeof code === 'string' && TRANSIENT_CODES.has(code)) || error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'GatewayNoAnswer'
}
/** Nothing reached Amazon: the switch is off, or the gateway refused before sending. */
function notSent(error: unknown): boolean {
  return error instanceof amazon.InboundWritesOff || isGatewayRefusal(error) || error instanceof amazon.FakeAmazonRefused
    || (error instanceof Error && (error as { code?: unknown }).code === 'amazon_account_unavailable')
}
/** Amazon answered and said no (a 4xx other than 429): a FAILED step, Amazon's words shown. */
function refusedByAmazon(error: unknown): error is amazon.AmazonInboundError {
  return error instanceof amazon.AmazonInboundError && !error.transient && !error.throttled
}

interface Held { message: string; retryAt: Date }
function heldOf(ctx: Ctx, error: unknown): Held | null {
  const at = (ms: number) => new Date(ctx.now().getTime() + ms)
  if (error instanceof amazon.InboundWritesOff) return { message: FBA_SEND_COPY.held.writesOff, retryAt: at(FBA_HELD_RECHECK_MS) }
  if (isGatewayRefusal(error)) {
    if (error.code === 'RATE_LIMITED_LOCAL') return { message: FBA_SEND_COPY.held.rate, retryAt: at(Math.max(1_000, error.retryAfterMs ?? FBA_RECHECK_MS)) }
    if (error.outcome === 'held') return { message: FBA_SEND_COPY.held.signIn, retryAt: at(FBA_HELD_RECHECK_MS) }
    return null
  }
  if (error instanceof Error && (error as { code?: unknown }).code === 'amazon_account_unavailable') return { message: FBA_SEND_COPY.held.signIn, retryAt: at(FBA_HELD_RECHECK_MS) }
  if (error instanceof amazon.AmazonInboundError && error.throttled) return { message: FBA_SEND_COPY.held.rate, retryAt: at(FBA_RECHECK_MS) }
  return null
}

/* ── reading and writing the plan ────────────────────────────────────────────────────────────── */

async function load(id: string): Promise<PlanRow | null> {
  return prisma.fbaInboundPlanV2.findFirst({ where: { id }, select: PLAN_SELECT })
}
const stepsOf = (row: Pick<PlanRow, 'steps'>): FbaPlanStepEntry[] => (Array.isArray(row.steps) ? (row.steps as unknown as FbaPlanStepEntry[]) : [])
const json = (value: unknown) => value as Prisma.InputJsonValue
const statusOf = (row: PlanRow): FbaPlanStatus | null => (isFbaPlanStatus(row.status) ? row.status : null)

/**
 * Apply a change computed from the freshest row, with compare-and-set on `updatedAt` (another writer — a person's
 * cancel, a Shipped click, a second run — never loses its write, nor the run its step log). `expect` = the statuses the
 * change is for (else nothing is written and null comes back). A status or step change publishes `fba.plan_changed` in
 * the same transaction.
 */
async function mutate(ctx: Ctx, change: (row: PlanRow) => Prisma.FbaInboundPlanV2UpdateManyMutationInput | null, expect?: readonly string[]): Promise<PlanRow | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await load(ctx.id)
    if (!row) throw new PlanMoved('the plan is gone')
    ctx.row = row
    if (expect && !expect.includes(row.status)) return null
    const data = change(row)
    if (!data) return row
    const status = typeof data.status === 'string' ? data.status : row.status
    const step = typeof data.currentStep === 'string' ? data.currentStep : row.currentStep
    const announce = status !== row.status || step !== row.currentStep
    // Strictly later than the row's own stamp, so the compare-and-set of a concurrent writer always sees a change.
    const updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1))
    const written = await prisma.$transaction(async tx => {
      const moved = await tx.fbaInboundPlanV2.updateMany({ where: { id: ctx.id, updatedAt: row.updatedAt }, data: { ...data, updatedAt } })
      if (moved.count !== 1) return false
      if (announce) {
        await publishEvent(tx as never, 'fba.plan_changed', { planId: ctx.id, status, step, productIds: ctx.productIds.slice(0, FBA_EVENT_MAX_PRODUCTS) })
      }
      return true
    })
    if (written) {
      const fresh = await load(ctx.id)
      if (!fresh) throw new PlanMoved('the plan is gone')
      ctx.row = fresh
      return fresh
    }
  }
  throw new Error(`fba-inbound runner: plan ${ctx.id} kept changing under the run`)
}

/** Move to another status / step (only from `from`). */
async function move(ctx: Ctx, status: FbaPlanStatus, step: FbaPlanStep, from: readonly string[], extra: Prisma.FbaInboundPlanV2UpdateManyMutationInput = {}): Promise<boolean> {
  return !!(await mutate(ctx, () => ({ ...extra, status, currentStep: step }), from))
}

/**
 * The lease and the cancel check, before every Amazon call: `nextCheckAt = now + FBA_LEASE_MS` while the plan is still
 * in a status of this step. A cancel asked meanwhile → CancelRequested; any other move → PlanMoved.
 */
async function guard(ctx: Ctx): Promise<void> {
  const moved = await prisma.fbaInboundPlanV2.updateMany({
    where: { id: ctx.id, status: { in: [...ctx.expect] } },
    data: { nextCheckAt: new Date(ctx.now().getTime() + FBA_LEASE_MS) },
  })
  if (moved.count) return
  const row = await load(ctx.id)
  if (row?.status === 'CANCELLING' && ctx.step !== 'CANCEL') throw new CancelRequested()
  throw new PlanMoved(`the plan is ${row?.status ?? 'gone'} now`)
}

/** Amazon allows 2 writes a second (burst 2): the job keeps FBA_POST_SPACING_MS between its own POST / PUTs. */
async function spaceWrites(ctx: Ctx): Promise<void> {
  const wait = ctx.lastWriteAt + FBA_POST_SPACING_MS - ctx.now().getTime()
  if (wait > 0) await ctx.sleep(wait)
  ctx.lastWriteAt = ctx.now().getTime()
}

const iso = (ctx: Ctx) => ctx.now().toISOString()

/* ── the step log ────────────────────────────────────────────────────────────────────────────── */

interface OpKey { step: FbaPlanStep; call: FbaAmazonOperation; shipmentId?: string | null; target?: string | null }

/**
 * The entries of the step's current round: the trailing entries of this step, cut after a FAILED one. A step re-run
 * after "Try again" (a FAILED entry) or after a later step ("Get new options") starts a fresh round.
 */
function roundOf(steps: FbaPlanStepEntry[], step: FbaPlanStep): FbaPlanStepEntry[] {
  const out: FbaPlanStepEntry[] = []
  for (let i = steps.length - 1; i >= 0; i--) {
    const entry = steps[i]
    if (entry.step !== step || entry.result === 'FAILED') break
    out.unshift(entry)
  }
  return out
}
const matches = (entry: FbaPlanStepEntry, key: OpKey) =>
  entry.call === key.call && (entry.shipmentId ?? null) === (key.shipmentId ?? null) && (!key.target || (entry.note ?? '').startsWith(key.target))

function entryOf(ctx: Ctx, key: OpKey, fields: Partial<FbaPlanStepEntry>): FbaPlanStepEntry {
  return {
    step: key.step, call: key.call, operationId: null, shipmentId: key.shipmentId ?? null, startedAt: iso(ctx), finishedAt: null,
    result: null, problems: [], note: key.target ?? null, ...fields,
  }
}
async function appendEntry(ctx: Ctx, entry: FbaPlanStepEntry, extra: Prisma.FbaInboundPlanV2UpdateManyMutationInput = {}): Promise<void> {
  await mutate(ctx, row => ({ ...extra, steps: json([...stepsOf(row), entry]) }))
}
/** Update the LAST entry that `pick` selects. */
async function updateEntry(ctx: Ctx, pick: (entry: FbaPlanStepEntry) => boolean, fields: Partial<FbaPlanStepEntry>, extra: Prisma.FbaInboundPlanV2UpdateManyMutationInput = {}): Promise<void> {
  await mutate(ctx, row => {
    const steps = stepsOf(row).slice()
    for (let i = steps.length - 1; i >= 0; i--) {
      if (pick(steps[i])) {
        steps[i] = { ...steps[i], ...fields }
        return { ...extra, steps: json(steps) }
      }
    }
    return Object.keys(extra).length ? extra : null
  })
}

/**
 * Poll one operation with the in-job backoff (2, 3, 5, 8, 13, 20, 30 s; a resumed one is asked once at once first).
 * SUCCESS → the entry is SUCCESS; FAILED → the entry is FAILED and the step fails with Amazon's problems; still running
 * after the last poll → StillRunning (the run ends, the resume job continues).
 */
async function settleOperation(ctx: Ctx, key: OpKey, operationId: string, resumed: boolean): Promise<void> {
  const accountId = accountOf(ctx)
  const delays = resumed ? [0, ...FBA_POLL_SECONDS] : [...FBA_POLL_SECONDS]
  for (const seconds of delays) {
    if (seconds) await ctx.sleep(seconds * 1000)
    await guard(ctx)
    const status = await amazon.getInboundOperationStatus(accountId, operationId)
    if (status.operationStatus === 'SUCCESS') {
      await updateEntry(ctx, e => e.operationId === operationId, { result: 'SUCCESS', finishedAt: iso(ctx), problems: problemsOfOperation(status.operationProblems) })
      return
    }
    if (status.operationStatus === 'FAILED') {
      const problems = problemsOfOperation(status.operationProblems)
      await updateEntry(ctx, e => e.operationId === operationId, { result: 'FAILED', finishedAt: iso(ctx), problems })
      const first = problems.find(p => (p.severity ?? 'ERROR') !== 'WARNING') ?? problems[0]
      throw new StepFailed(first?.message || `Amazon could not ${key.call}`, problems, key.call, true, null, key.shipmentId ?? null)
    }
  }
  throw new StillRunning(`${key.call} is still running at Amazon`)
}

/**
 * One Amazon operation of a step, exactly once per round: done → nothing; sent and not settled → poll it (never sent
 * again); else `alreadyDone` (Amazon's own state, for confirms) → recorded as done; else send it, write the operation id,
 * then poll. Amazon's refusal → a FAILED entry and StepFailed (unless `acceptRefusal` says the refusal means done).
 */
async function ensureOperation(ctx: Ctx, key: OpKey, send: () => Promise<amazon.OperationResult>, options: {
  alreadyDone?: () => Promise<boolean>
  acceptRefusal?: (error: amazon.AmazonInboundError) => boolean
} = {}): Promise<void> {
  const mine = roundOf(stepsOf(ctx.row), key.step).filter(e => matches(e, key))
  const last = mine[mine.length - 1]
  if (last?.result === 'SUCCESS') return
  if (last?.operationId && (last.result === null || last.result === 'IN_PROGRESS')) {
    await settleOperation(ctx, key, last.operationId, true)
    return
  }
  if (options.alreadyDone && await options.alreadyDone()) {
    await appendEntry(ctx, entryOf(ctx, key, { result: 'SUCCESS', finishedAt: iso(ctx), note: `${key.target ? `${key.target} · ` : ''}already done at Amazon` }))
    return
  }
  amazon.assertInboundWrites(key.call)
  await guard(ctx)
  await spaceWrites(ctx)
  let sent: amazon.OperationResult
  try {
    sent = await send()
  } catch (error) {
    if (refusedByAmazon(error)) {
      if (options.acceptRefusal?.(error)) {
        await appendEntry(ctx, entryOf(ctx, key, { result: 'SUCCESS', finishedAt: iso(ctx), problems: problemsOfError(error), note: `${key.target ? `${key.target} · ` : ''}Amazon: ${error.errors[0]?.message ?? error.message}` }))
        return
      }
      const problems = problemsOfError(error)
      await appendEntry(ctx, entryOf(ctx, key, { result: 'FAILED', finishedAt: iso(ctx), problems }))
      throw new StepFailed(problems[0]?.message || error.message, problems, key.call, true, null, key.shipmentId ?? null)
    }
    throw error
  }
  await appendEntry(ctx, entryOf(ctx, key, { operationId: sent.operationId, result: 'IN_PROGRESS' }))
  await settleOperation(ctx, key, sent.operationId, false)
}

/** A read of Amazon, guarded (lease + cancel check). */
async function read<T>(ctx: Ctx, ask: () => Promise<T>): Promise<T> {
  await guard(ctx)
  return ask()
}

/* ── the plan's facts ────────────────────────────────────────────────────────────────────────── */

function accountOf(ctx: Ctx): string {
  const accountId = ctx.row.channelConnectionId
  if (!accountId) throw new StepFailed('The plan names no Amazon account', [problem('NO_ACCOUNT', 'The plan names no Amazon account')])
  return accountId
}
function amazonPlanIdOf(ctx: Ctx): string {
  if (!ctx.row.planId) throw new StepFailed('Amazon has no plan for this yet', [problem('NO_AMAZON_PLAN', 'Amazon has no plan for this yet')])
  return ctx.row.planId
}
const romeDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
/** The plan's name at Amazon — unique (the row id's last 6) and deterministic, so a lost create is found again by it. */
function amazonNameOf(row: PlanRow): string {
  const own = new RegExp(`^Nexus [A-Z]{2,3} \\d{4}-\\d{2}-\\d{2} #${row.id.slice(-6).replace(/[^A-Za-z0-9]/g, '')}$`)
  if (row.name && own.test(row.name)) return row.name
  const market = (row.marketplaceId && MARKETPLACE_ID_TO_CODE[row.marketplaceId]) || row.marketplaceId || 'XX'
  return fbaAmazonPlanName(market, romeDay(row.createdAt), row.id)
}
function addressOf(ctx: Ctx): amazon.AddressInput {
  const a = (ctx.row.sourceAddress ?? null) as Partial<FbaSourceAddress> | null
  const missing = addressMissing(a)
  if (!a || missing.length) {
    const message = FBA_SEND_COPY.problem.noAddress(missing, null)
    throw new StepFailed(message, [problem('NO_ADDRESS', message)], 'createInboundPlan')
  }
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  return {
    name: a.name!.trim(), companyName: text(a.companyName), addressLine1: a.addressLine1!.trim(), addressLine2: text(a.addressLine2),
    city: a.city!.trim(), stateOrProvinceCode: text(a.stateOrProvinceCode), postalCode: a.postalCode!.trim(),
    countryCode: a.countryCode!.trim().toUpperCase(), phoneNumber: a.phoneNumber!.trim(), email: text(a.email),
  }
}
function contactOf(ctx: Ctx): amazon.ContactInformation | undefined {
  const a = (ctx.row.sourceAddress ?? null) as Partial<FbaSourceAddress> | null
  if (!a?.name || !a?.phoneNumber) return undefined
  return { name: a.name, phoneNumber: a.phoneNumber, ...(a.email ? { email: a.email } : {}) }
}
const owner = (value: string): amazon.PrepOwner => (value === 'AMAZON' || value === 'SELLER' || value === 'NONE' ? value : 'SELLER')
const mixedBoxOf = (row: PlanRow): FbaMixedBox => {
  const box = row.mixedBox as Partial<FbaMixedBox> | null
  return box && [box.lengthCm, box.widthCm, box.heightCm, box.emptyKg, box.maxKg].every(v => typeof v === 'number') ? (box as FbaMixedBox) : { ...MIXED_BOX_DEFAULT }
}
/** Amazon's ready day: the plan's day at 00:00Z, or the next full hour when that is already past ('YYYY-MM-DDTHH:mmZ'). */
function readyStartOf(ctx: Ctx): string {
  const now = ctx.now()
  const day = ctx.row.readyToShipOn ?? now
  let start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
  if (start.getTime() < now.getTime()) start = new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000)
  return `${start.toISOString().slice(0, 16)}Z`
}
const feeOf = (i: amazon.AmazonIncentive): FbaFee => ({
  type: i.type ?? null, target: i.target ?? null, description: i.description ?? null,
  value: i.value && typeof i.value.amount === 'number' ? { amount: i.value.amount, currency: i.value.code } : null,
})
const transportOf = (o: amazon.TransportationOption): FbaTransportOption => ({
  transportationOptionId: o.transportationOptionId, shipmentId: o.shipmentId, carrierName: o.carrier?.name ?? null, carrierCode: o.carrier?.alphaCode ?? null,
  shippingMode: o.shippingMode, shippingSolution: o.shippingSolution,
  quote: o.quote?.cost ? { cost: { amount: o.quote.cost.amount, currency: o.quote.cost.code }, expiresAt: o.quote.expiration ?? null, voidableUntil: o.quote.voidableUntil ?? null } : null,
  preconditions: Array.isArray(o.preconditions) ? o.preconditions : [],
})
const windowOf = (w: amazon.DeliveryWindowOption): FbaDeliveryWindowOption => ({
  deliveryWindowOptionId: w.deliveryWindowOptionId, start: w.startDate, end: w.endDate, availabilityType: w.availabilityType ?? null, validUntil: w.validUntil ?? null,
})
const net = (o: { fees?: amazon.AmazonIncentive[]; discounts?: amazon.AmazonIncentive[] }) =>
  (o.fees ?? []).reduce((s, f) => s + (f.value?.amount ?? 0), 0) - (o.discounts ?? []).reduce((s, f) => s + (f.value?.amount ?? 0), 0)

/** What the box rule needs per line: the case pack frozen on the line, the case and unit sizes as they are now. */
async function boxSkusOf(ctx: Ctx): Promise<FbaBoxSku[]> {
  const ids = ctx.lines.map(l => l.productId)
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, weightValue: true, weightUnit: true, dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true } })
  const packages = await prisma.productPackage.findMany({ where: { productId: { in: ids } }, select: { productId: true, caseLengthCm: true, caseWidthCm: true, caseHeightCm: true, caseWeightKg: true } })
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return ctx.lines.map(line => {
    const p = products.find(x => x.id === line.productId)
    const pkg = packages.find(x => x.productId === line.productId)
    const caseSides = pkg ? [num(pkg.caseLengthCm), num(pkg.caseWidthCm), num(pkg.caseHeightCm), num(pkg.caseWeightKg)] : []
    const unit = p ? [lengthCm(num(p.dimLength), p.dimUnit), lengthCm(num(p.dimWidth), p.dimUnit), lengthCm(num(p.dimHeight), p.dimUnit)] : []
    return {
      productId: line.productId, sku: p?.sku ?? line.msku, msku: line.msku, unitsPerCase: line.unitsPerCase,
      case: caseSides.length === 4 && caseSides.every(v => typeof v === 'number' && v > 0) ? { lengthCm: caseSides[0]!, widthCm: caseSides[1]!, heightCm: caseSides[2]!, weightKg: caseSides[3]! } : null,
      unitWeightKg: p ? unitWeightKg(num(p.weightValue), p.weightUnit) : null,
      unit: unit.length === 3 && unit.every(v => typeof v === 'number') ? { lengthCm: unit[0]!, widthCm: unit[1]!, heightCm: unit[2]! } : null,
    }
  })
}

async function syncAfter(ctx: Ctx): Promise<void> {
  if (!ctx.row.marketplaceId) return
  try {
    await ctx.syncInventory(ctx.lines.map(l => l.msku), ctx.row.marketplaceId)
  } catch (error) {
    logger.warn('[fba-inbound] FBA inventory read after a plan step failed; the 15-min read catches up', { planRowId: ctx.id, error: error instanceof Error ? error.message : String(error) })
  }
}
async function defaultSyncInventory(mskus: string[], marketplaceId: string): Promise<void> {
  // The fake answers no FBA inventory read: never ask the real Amazon on behalf of a fake plan.
  if (!mskus.length || await amazon.inboundFakeActive()) return
  const { amazonInventoryService } = await import('../amazon-inventory.service.js')
  await amazonInventoryService.syncFBAInventoryForSkus(mskus.slice(0, 50), { marketplaceId })
}

/* ── the steps ───────────────────────────────────────────────────────────────────────────────── */

const isCreateIntent = (e: FbaPlanStepEntry) => e.step === 'CREATE' && e.call === 'createInboundPlan' && !e.operationId && e.result === null

/** The plan Amazon holds under our name, if any (newest ACTIVE plans first, up to 90). */
async function findPlanByName(ctx: Ctx, name: string): Promise<amazon.InboundPlanSummary | null> {
  const accountId = accountOf(ctx)
  let token: string | null = null
  for (let page = 0; page < 3; page++) {
    const result = await read(ctx, () => amazon.listInboundPlans(accountId, { status: 'ACTIVE', sortBy: 'CREATION_TIME', sortOrder: 'DESC', paginationToken: token }))
    const found = result.inboundPlans.find(p => p.name === name)
    if (found) return found
    if (!result.nextToken) return null
    token = result.nextToken
  }
  return null
}

async function createStep(ctx: Ctx): Promise<StepResult> {
  ctx.expect = ['CREATING']
  ctx.step = 'CREATE'
  const accountId = accountOf(ctx)
  const marketplaceId = ctx.row.marketplaceId
  if (!marketplaceId) throw new StepFailed('The plan names no Amazon market', [problem('NO_MARKET', 'The plan names no Amazon market')], 'createInboundPlan')
  if (!ctx.lines.length) throw new StepFailed(FBA_SEND_COPY.problem.noUnits, [problem('NO_UNITS', FBA_SEND_COPY.problem.noUnits)], 'createInboundPlan')
  const sourceAddress = addressOf(ctx)
  const key: OpKey = { step: 'CREATE', call: 'createInboundPlan' }
  const round = roundOf(stepsOf(ctx.row), 'CREATE').filter(e => e.call === 'createInboundPlan')
  const last = round[round.length - 1]

  if (last?.result === 'SUCCESS') {
    if (ctx.row.planId) return afterCreate(ctx)
    const message = 'Amazon created the plan but Nexus did not keep its id. Cancel this plan in Seller Central and create it again.'
    throw new StepFailed(message, [problem('NO_AMAZON_PLAN', message)], 'createInboundPlan')
  }
  if (last?.operationId && (last.result === null || last.result === 'IN_PROGRESS')) {
    await settleOperation(ctx, key, last.operationId, true)
    return afterCreate(ctx)
  }
  const name = amazonNameOf(ctx.row)
  if (last && isCreateIntent(last)) {
    // A create may have reached Amazon before its answer was lost: adopt the plan Amazon holds under our name.
    const found = await findPlanByName(ctx, name)
    if (found) {
      await updateEntry(ctx, isCreateIntent, { result: 'SUCCESS', finishedAt: iso(ctx), note: `adopted plan ${found.inboundPlanId} found by name` }, { planId: found.inboundPlanId })
      return afterCreate(ctx)
    }
    amazon.assertInboundWrites('createInboundPlan')
  } else {
    amazon.assertInboundWrites('createInboundPlan')
    // The intent goes in the log BEFORE the call: a run that finds it without an operation id looks for the plan by name.
    await appendEntry(ctx, entryOf(ctx, key, { note: null }), { planId: null })
  }

  await guard(ctx)
  await spaceWrites(ctx)
  let created: { inboundPlanId: string; operationId: string }
  try {
    created = await amazon.createInboundPlan(accountId, {
      destinationMarketplaces: [marketplaceId],
      sourceAddress,
      name,
      items: ctx.lines.map(l => ({ msku: l.msku, quantity: l.quantity, prepOwner: owner(l.prepOwner), labelOwner: owner(l.labelOwner) })),
    })
  } catch (error) {
    if (notSent(error)) {
      // Nothing reached Amazon: no intent to look for later.
      await mutate(ctx, row => ({ steps: json(stepsOf(row).filter((e, i, all) => !(isCreateIntent(e) && i === all.length - 1))) }))
    } else if (refusedByAmazon(error)) {
      const problems = problemsOfError(error)
      await updateEntry(ctx, isCreateIntent, { result: 'FAILED', finishedAt: iso(ctx), problems })
      throw new StepFailed(problems[0]?.message || error.message, problems, 'createInboundPlan', true)
    }
    throw error
  }
  // The plan id and the operation id land in the SAME write, before any poll.
  await updateEntry(ctx, isCreateIntent, { operationId: created.operationId, result: 'IN_PROGRESS' }, { planId: created.inboundPlanId })
  await settleOperation(ctx, key, created.operationId, false)
  return afterCreate(ctx)
}

async function afterCreate(ctx: Ctx): Promise<StepResult> {
  await syncAfter(ctx)
  await move(ctx, 'PACKING', 'PACK', ['CREATING'])
  return 'continue'
}

async function packStep(ctx: Ctx): Promise<StepResult> {
  ctx.expect = ['PACKING']
  ctx.step = 'PACK'
  const accountId = accountOf(ctx)
  const planId = amazonPlanIdOf(ctx)
  await ensureOperation(ctx, { step: 'PACK', call: 'generatePackingOptions' }, () => amazon.generatePackingOptions(accountId, planId))
  const options = await amazon.allPages(async token => {
    const page = await read(ctx, () => amazon.listPackingOptions(accountId, planId, token))
    return { items: page.packingOptions, nextToken: page.nextToken }
  })
  const kept = (ctx.row.packing as unknown as FbaPackingSnapshot | null)?.packingOptionId
  const offered = options.filter(o => o.status === 'OFFERED')
  const chosen = options.find(o => o.packingOptionId === kept && o.status !== 'EXPIRED')
    ?? options.find(o => o.status === 'ACCEPTED')
    // Fewest packing groups (fewest box sets to pack), then the lowest fees.
    ?? offered.slice().sort((a, b) => (a.packingGroups?.length ?? 0) - (b.packingGroups?.length ?? 0) || net(a) - net(b))[0]
  if (!chosen) throw new StepFailed('Amazon offered no packing option for this plan', [problem('NO_PACKING_OPTION', 'Amazon offered no packing option for this plan')], 'generatePackingOptions')

  const groups: FbaPackingSnapshot['groups'] = []
  for (const packingGroupId of chosen.packingGroups ?? []) {
    const items = await amazon.allPages(async token => {
      const page = await read(ctx, () => amazon.listPackingGroupItems(accountId, planId, packingGroupId, token))
      return { items: page.items, nextToken: page.nextToken }
    })
    groups.push({ packingGroupId, items: items.map(i => ({ msku: i.msku, quantity: i.quantity })), boxes: [] })
  }
  const snapshot: FbaPackingSnapshot = { packingOptionId: chosen.packingOptionId, fees: [...(chosen.fees ?? []), ...(chosen.discounts ?? [])].map(feeOf), groups, sentAt: null }
  await mutate(ctx, () => ({ packing: json(snapshot) }))
  await ensureOperation(ctx, { step: 'PACK', call: 'confirmPackingOption', target: `packing ${chosen.packingOptionId}` },
    () => amazon.confirmPackingOption(accountId, planId, chosen.packingOptionId),
    { alreadyDone: async () => chosen.status === 'ACCEPTED' })
  await move(ctx, 'BOXES', 'BOXES', ['PACKING'])
  return 'continue'
}

async function boxesStep(ctx: Ctx): Promise<StepResult> {
  ctx.expect = ['BOXES']
  ctx.step = 'BOXES'
  const accountId = accountOf(ctx)
  const planId = amazonPlanIdOf(ctx)
  const packing = ctx.row.packing as unknown as FbaPackingSnapshot | null
  if (!packing?.groups?.length) {
    // No packing groups stored (an older run stopped before them): pack again.
    await move(ctx, 'PACKING', 'PACK', ['BOXES'])
    return 'continue'
  }
  const seen = new Map<string, string>()
  for (const group of packing.groups) {
    for (const item of group.items) {
      if (seen.has(item.msku) && seen.get(item.msku) !== group.packingGroupId) {
        const message = `${item.msku}: Amazon put it in two packing groups; Nexus cannot pack it. Cancel the plan and create it again.`
        throw new StepFailed(message, [problem('SPLIT_ACROSS_GROUPS', message)], 'setPackingInformation')
      }
      seen.set(item.msku, group.packingGroupId)
    }
  }
  const skus = await boxSkusOf(ctx)
  const result = planBoxes(
    ctx.lines.map(l => ({ productId: l.productId, cases: l.cases, looseUnits: l.looseUnits })),
    skus,
    mixedBoxOf(ctx.row),
    packing.groups.map(g => ({ packingGroupId: g.packingGroupId, mskus: g.items.map(i => i.msku) })),
  )
  const blocking = result.problems.filter(p => p.blocking)
  if (blocking.length) {
    throw new StepFailed(blocking[0].message, blocking.map(p => problem(p.code, p.message)), 'setPackingInformation')
  }
  // Amazon's group quantities must be what the boxes hold, SKU by SKU.
  const boxed = new Map<string, number>()
  for (const box of result.boxes) for (const item of box.items) boxed.set(item.msku, (boxed.get(item.msku) ?? 0) + item.quantity * box.quantity)
  for (const group of packing.groups) {
    for (const item of group.items) {
      if ((boxed.get(item.msku) ?? 0) !== item.quantity) {
        const message = `${item.msku}: Amazon's packing group holds ${item.quantity} units; the boxes hold ${boxed.get(item.msku) ?? 0}`
        throw new StepFailed(message, [problem('BOX_CONTENT_MISMATCH', message)], 'setPackingInformation')
      }
    }
  }
  const owners = new Map(ctx.lines.map(l => [l.msku, { prepOwner: owner(l.prepOwner), labelOwner: owner(l.labelOwner) }]))
  const groups = packing.groups.map(g => ({ ...g, boxes: result.boxes.filter(b => b.packingGroupId === g.packingGroupId) }))
  await mutate(ctx, row => ({ packing: json({ ...(row.packing as unknown as FbaPackingSnapshot), groups, sentAt: null }) }))
  const body = {
    packageGroupings: groups.map(g => ({
      packingGroupId: g.packingGroupId,
      boxes: g.boxes.map((b: FbaBoxPlan): amazon.BoxInput => ({
        contentInformationSource: 'BOX_CONTENT_PROVIDED',
        dimensions: { unitOfMeasurement: 'CM', length: b.lengthCm, width: b.widthCm, height: b.heightCm },
        weight: { unit: 'KG', value: b.weightKg },
        quantity: b.quantity,
        items: b.items.map(i => ({ msku: i.msku, quantity: i.quantity, ...(owners.get(i.msku) ?? { prepOwner: 'SELLER' as const, labelOwner: 'SELLER' as const }) })),
      })),
    })),
  }
  await ensureOperation(ctx, { step: 'BOXES', call: 'setPackingInformation' }, () => amazon.setPackingInformation(accountId, planId, body))
  await mutate(ctx, row => ({ packing: json({ ...(row.packing as unknown as FbaPackingSnapshot), sentAt: (row.packing as unknown as FbaPackingSnapshot)?.sentAt ?? iso(ctx) }) }))
  await move(ctx, 'PLACING', 'PLACE', ['BOXES'])
  return 'continue'
}

async function listPlacements(ctx: Ctx): Promise<amazon.PlacementOption[]> {
  const accountId = accountOf(ctx)
  const planId = amazonPlanIdOf(ctx)
  return amazon.allPages(async token => {
    const page = await read(ctx, () => amazon.listPlacementOptions(accountId, planId, token))
    return { items: page.placementOptions, nextToken: page.nextToken }
  })
}

async function placeStep(ctx: Ctx): Promise<StepResult> {
  ctx.expect = ['PLACING']
  ctx.step = 'PLACE'
  const accountId = accountOf(ctx)
  const planId = amazonPlanIdOf(ctx)
  await ensureOperation(ctx, { step: 'PLACE', call: 'generatePlacementOptions' }, () => amazon.generatePlacementOptions(accountId, planId))
  const list = await listPlacements(ctx)
  const offered = list.filter(o => o.status === 'OFFERED')
  if (!offered.length) {
    const message = list.some(o => o.status === 'ACCEPTED')
      ? 'Amazon shows a placement already confirmed for this plan (outside Nexus)'
      : 'Amazon offered no placement option for this plan'
    throw new StepFailed(message, [problem('NO_PLACEMENT_OPTION', message)], 'generatePlacementOptions')
  }
  const placements: FbaPlacementOption[] = []
  for (const option of offered) {
    const shipments = []
    for (const shipmentId of option.shipmentIds ?? []) {
      const shipment = await read(ctx, () => amazon.getShipment(accountId, planId, shipmentId))
      shipments.push({ shipmentId, destinationFc: shipment.destination?.warehouseId ?? null, destinationTown: shipment.destination?.address?.city ?? null, transport: [], deliveryWindows: [] })
    }
    placements.push({
      placementOptionId: option.placementOptionId, status: option.status, expiresAt: option.expiration ?? null,
      fees: (option.fees ?? []).map(feeOf), discounts: (option.discounts ?? []).map(feeOf), shipments,
    })
  }
  const expiries = placements.map(p => p.expiresAt).filter((v): v is string => !!v).sort()
  const options: FbaPlanOptions = { readAt: iso(ctx), expiresAt: expiries[0] ?? null, placements }
  await move(ctx, 'QUOTING', 'QUOTE', ['PLACING'], { options: json(options) })
  return 'continue'
}

async function quoteStep(ctx: Ctx): Promise<StepResult> {
  ctx.expect = ['QUOTING']
  ctx.step = 'QUOTE'
  const accountId = accountOf(ctx)
  const planId = amazonPlanIdOf(ctx)
  const options = ctx.row.options as unknown as FbaPlanOptions | null
  if (!options?.placements?.length) {
    await move(ctx, 'PLACING', 'PLACE', ['QUOTING'])
    return 'continue'
  }
  const contact = contactOf(ctx)
  const start = readyStartOf(ctx)
  const placements: FbaPlacementOption[] = []
  for (const placement of options.placements) {
    await ensureOperation(ctx, { step: 'QUOTE', call: 'generateTransportationOptions', target: `placement ${placement.placementOptionId}` },
      () => amazon.generateTransportationOptions(accountId, planId, {
        placementOptionId: placement.placementOptionId,
        shipmentTransportationConfigurations: placement.shipments.map(s => ({ shipmentId: s.shipmentId, readyToShipWindow: { start }, ...(contact ? { contactInformation: contact } : {}) })),
      }))
    const transports = await amazon.allPages(async token => {
      const page = await read(ctx, () => amazon.listTransportationOptions(accountId, planId, { placementOptionId: placement.placementOptionId, paginationToken: token }))
      return { items: page.transportationOptions, nextToken: page.nextToken }
    })
    const shipments = []
    for (const shipment of placement.shipments) {
      await ensureOperation(ctx, { step: 'QUOTE', call: 'generateDeliveryWindowOptions', shipmentId: shipment.shipmentId },
        () => amazon.generateDeliveryWindowOptions(accountId, planId, shipment.shipmentId))
      const windows = await amazon.allPages(async token => {
        const page = await read(ctx, () => amazon.listDeliveryWindowOptions(accountId, planId, shipment.shipmentId, token))
        return { items: page.deliveryWindowOptions, nextToken: page.nextToken }
      })
      shipments.push({ ...shipment, transport: transports.filter(t => t.shipmentId === shipment.shipmentId).map(transportOf), deliveryWindows: windows.map(windowOf) })
    }
    placements.push({ ...placement, shipments })
  }
  // The Owner chooses from here; the runner stops and never confirms by itself.
  await move(ctx, 'WAITING_FOR_CHOICE', 'CONFIRM', ['QUOTING'], { options: json({ ...options, readAt: iso(ctx), placements }), nextCheckAt: null })
  return 'stop'
}

async function confirmStep(ctx: Ctx): Promise<StepResult> {
  ctx.expect = ['CONFIRMING']
  ctx.step = 'CONFIRM'
  const choice = ctx.row.choice as unknown as FbaChoiceRequest | null
  if (!ctx.row.confirmedBy || !choice?.placementOptionId || !Array.isArray(choice.shipments)) {
    // Never without a person: confirming the placement is final at Amazon and starts only from a person's click.
    await mutate(ctx, () => ({ status: 'WAITING_FOR_CHOICE', currentStep: 'CONFIRM', nextCheckAt: null, lastError: 'Confirming with Amazon needs a person\'s click', lastErrorAt: ctx.now() }), ['CONFIRMING'])
    return 'stop'
  }
  const accountId = accountOf(ctx)
  const planId = amazonPlanIdOf(ctx)
  const options = ctx.row.options as unknown as FbaPlanOptions | null
  const placement = options?.placements?.find(p => p.placementOptionId === choice.placementOptionId)
  if (!placement) {
    const message = 'The chosen placement option is not among Amazon\'s options any more. Get new options.'
    throw new StepFailed(message, [problem('OPTION_UNKNOWN', message)], 'confirmPlacementOption')
  }
  const contact = contactOf(ctx)
  const shipmentOf = (shipmentId: string) => read(ctx, () => amazon.getShipment(accountId, planId, shipmentId))

  // 1. The placement — FINAL at Amazon. Amazon's own state is read first: never confirmed twice.
  await ensureOperation(ctx, { step: 'CONFIRM', call: 'confirmPlacementOption', target: `placement ${placement.placementOptionId}` },
    () => amazon.confirmPlacementOption(accountId, planId, placement.placementOptionId),
    { alreadyDone: async () => (await listPlacements(ctx)).some(o => o.placementOptionId === placement.placementOptionId && o.status === 'ACCEPTED') })

  // 2. One FBAShipment per Amazon shipment, by its FBA15… id (the status poll reads them).
  for (const chosen of choice.shipments) {
    const shipment = await shipmentOf(chosen.shipmentId)
    if (!shipment.shipmentConfirmationId) throw new StillRunning('Amazon has not given the shipment its FBA id yet')
    await ensureShipmentRow(ctx, placement, chosen, shipment)
  }

  // 3. Own carrier: the delivery window of each shipment.
  for (const chosen of choice.shipments) {
    if (!chosen.deliveryWindowOptionId) continue
    await ensureOperation(ctx, { step: 'CONFIRM', call: 'confirmDeliveryWindowOptions', shipmentId: chosen.shipmentId },
      () => amazon.confirmDeliveryWindowOptions(accountId, planId, chosen.shipmentId, chosen.deliveryWindowOptionId!),
      { alreadyDone: async () => (await shipmentOf(chosen.shipmentId)).selectedDeliveryWindow?.deliveryWindowOptionId === chosen.deliveryWindowOptionId })
  }

  // 4. The carriers of every shipment, in one call.
  await ensureOperation(ctx, { step: 'CONFIRM', call: 'confirmTransportationOptions' },
    () => amazon.confirmTransportationOptions(accountId, planId, choice.shipments.map(s => ({ shipmentId: s.shipmentId, transportationOptionId: s.transportationOptionId, ...(contact ? { contactInformation: contact } : {}) }))),
    {
      alreadyDone: async () => {
        for (const chosen of choice.shipments) {
          if ((await shipmentOf(chosen.shipmentId)).selectedTransportationOptionId !== chosen.transportationOptionId) return false
        }
        return true
      },
    })
  await move(ctx, 'LABELS', 'LABELS', ['CONFIRMING'])
  return 'continue'
}

async function ensureShipmentRow(ctx: Ctx, placement: FbaPlacementOption, chosen: FbaChoiceRequest['shipments'][number], shipment: amazon.AmazonShipment): Promise<void> {
  const confirmationId = shipment.shipmentConfirmationId!
  const existing = await prisma.fBAShipment.findFirst({
    where: { OR: [{ planRowId: ctx.id, amazonShipmentId: chosen.shipmentId }, { shipmentId: confirmationId }] },
    select: { id: true, planRowId: true, _count: { select: { items: true } } },
  })
  if (existing?.planRowId === ctx.id) return
  const accountId = accountOf(ctx)
  const planId = amazonPlanIdOf(ctx)
  const items = await amazon.allPages(async token => {
    const page = await read(ctx, () => amazon.listShipmentItems(accountId, planId, chosen.shipmentId, token))
    return { items: page.items, nextToken: page.nextToken }
  })
  const offered = placement.shipments.find(s => s.shipmentId === chosen.shipmentId)
  const option = offered?.transport.find(t => t.transportationOptionId === chosen.transportationOptionId) ?? null
  const window = chosen.deliveryWindowOptionId ? offered?.deliveryWindows.find(w => w.deliveryWindowOptionId === chosen.deliveryWindowOptionId) ?? null : null
  const transport: FbaShipmentTransport = {
    transportationOptionId: chosen.transportationOptionId, carrierName: option?.carrierName ?? null, carrierCode: option?.carrierCode ?? null,
    shippingMode: option?.shippingMode ?? '', shippingSolution: option?.shippingSolution ?? '',
    deliveryWindow: window ? { deliveryWindowOptionId: window.deliveryWindowOptionId, start: window.start, end: window.end } : null,
    quote: option?.quote?.cost ?? null,
  }
  const units = new Map<string, number>()
  for (const item of items) {
    const line = ctx.lines.find(l => l.msku === item.msku)
    if (!line) {
      logger.warn('[fba-inbound] Amazon lists a SKU the plan does not send; not recorded on the shipment', { planRowId: ctx.id, msku: item.msku })
      continue
    }
    units.set(line.productId, (units.get(line.productId) ?? 0) + item.quantity)
  }
  const data = {
    planRowId: ctx.id, amazonShipmentId: chosen.shipmentId, sourceLocationId: ctx.row.sourceLocationId,
    destinationFC: shipment.destination?.warehouseId ?? offered?.destinationFc ?? 'UNKNOWN', transport: json(transport),
  }
  await prisma.$transaction(async tx => {
    let shipmentRowId = existing?.id
    if (shipmentRowId) {
      // An older row with this FBA15… id (a v0 backfill): it belongs to this plan now.
      await tx.fBAShipment.update({ where: { id: shipmentRowId }, data })
      if (existing!._count.items > 0) return
    } else {
      shipmentRowId = (await tx.fBAShipment.create({ data: { ...data, shipmentId: confirmationId, name: shipment.name ?? amazonNameOf(ctx.row), status: 'WORKING' }, select: { id: true } })).id
    }
    for (const [productId, quantitySent] of units) await tx.fBAShipmentItem.create({ data: { shipmentId: shipmentRowId!, productId, quantitySent } })
  })
}

const CM_PER_UNIT: Record<string, number> = { CM: 1, IN: 2.54 }
const KG_PER_UNIT: Record<string, number> = { KG: 1, LB: 0.45359237 }
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places

function shipmentBoxOf(box: amazon.ShipmentBox, packing: FbaPackingSnapshot | null): FbaShipmentBox {
  const cm = CM_PER_UNIT[(box.dimensions?.unitOfMeasurement ?? 'CM').toUpperCase()] ?? 1
  const kg = KG_PER_UNIT[(box.weight?.unit ?? 'KG').toUpperCase()] ?? 1
  const side = (v: number | undefined) => (typeof v === 'number' ? round(v * cm, 1) : null)
  const items = (box.items ?? []).map(i => ({ msku: i.msku, quantity: i.quantity }))
  const out: FbaShipmentBox = {
    boxId: box.boxId ?? '', kind: null, lengthCm: side(box.dimensions?.length), widthCm: side(box.dimensions?.width), heightCm: side(box.dimensions?.height),
    weightKg: typeof box.weight?.value === 'number' ? round(box.weight.value * kg, 2) : null, items,
  }
  // Case or mixed: the planned box with the same content and size.
  const content = JSON.stringify(items.map(i => [i.msku, i.quantity]).sort())
  const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 0.5
  for (const group of packing?.groups ?? []) {
    const planned = group.boxes.find(b => JSON.stringify(b.items.map(i => [i.msku, i.quantity]).sort()) === content
      && near(out.lengthCm, b.lengthCm) && near(out.widthCm, b.widthCm) && near(out.heightCm, b.heightCm))
    if (planned) {
      out.kind = planned.kind
      break
    }
  }
  return out
}

async function labelsStep(ctx: Ctx): Promise<StepResult> {
  ctx.expect = ['LABELS']
  ctx.step = 'LABELS'
  const accountId = accountOf(ctx)
  const planId = amazonPlanIdOf(ctx)
  const rows = await prisma.fBAShipment.findMany({ where: { planRowId: ctx.id }, select: { id: true, amazonShipmentId: true }, orderBy: { createdAt: 'asc' } })
  if (!rows.length || rows.some(r => !r.amazonShipmentId)) {
    // CONFIRM did not leave its shipments: run it again (every confirm reads Amazon's state first, so nothing is sent twice).
    await move(ctx, 'CONFIRMING', 'CONFIRM', ['LABELS'])
    return 'continue'
  }
  const packing = ctx.row.packing as unknown as FbaPackingSnapshot | null
  const startedAt = iso(ctx)
  let boxCount = 0
  for (const row of rows) {
    const boxes = await amazon.allPages(async token => {
      const page = await read(ctx, () => amazon.listShipmentBoxes(accountId, planId, row.amazonShipmentId!, token))
      return { items: page.boxes, nextToken: page.nextToken }
    })
    if (!boxes.length || boxes.some(b => !b.boxId)) throw new StillRunning('Amazon has not numbered the boxes yet')
    if (boxes.some(b => (b.quantity ?? 1) > 1)) logger.warn('[fba-inbound] Amazon lists a box record for several boxes; one entry is kept per record', { planRowId: ctx.id, shipmentId: row.amazonShipmentId })
    await prisma.fBAShipment.update({ where: { id: row.id }, data: { boxes: json(boxes.map(b => shipmentBoxOf(b, packing))) } })
    boxCount += boxes.length
  }
  // LABELS reads only (no Amazon operation), yet the drawer's "Labels" step needs its time like every other step:
  // one SUCCESS entry without a call, written with the move to READY_TO_SHIP.
  const done: FbaPlanStepEntry = {
    step: 'LABELS', call: null, operationId: null, shipmentId: null, startedAt, finishedAt: iso(ctx), result: 'SUCCESS', problems: [],
    note: `${boxCount} ${boxCount === 1 ? 'box' : 'boxes'} numbered`,
  }
  await mutate(ctx, row => ({ status: 'READY_TO_SHIP', currentStep: 'TRACKING', nextCheckAt: null, steps: json([...stepsOf(row), done]) }), ['LABELS'])
  return 'stop'
}

/** Shipments marked Shipped whose tracking has not reached Amazon yet. */
async function trackingDue(ctx: Ctx) {
  const rows = await prisma.fBAShipment.findMany({ where: { planRowId: ctx.id, shippedAt: { not: null } }, select: { id: true, amazonShipmentId: true, tracking: true }, orderBy: { createdAt: 'asc' } })
  return rows.filter(r => {
    const tracking = r.tracking as unknown as FbaShipmentTracking | null
    return !!r.amazonShipmentId && !!tracking?.boxes?.length && !tracking.sentAt
  })
}

async function trackingStep(ctx: Ctx): Promise<StepResult> {
  ctx.expect = TRACKING_STATUSES
  ctx.step = 'TRACKING'
  let sent = false
  for (let pass = 0; pass < 5; pass++) {
    const due = await trackingDue(ctx)
    if (!due.length) {
      // Nothing to send: drop the lease. A Shipped click landing after this read sets nextCheckAt itself, so it is
      // never lost; one that landed before it is caught by the second read.
      await prisma.fbaInboundPlanV2.updateMany({ where: { id: ctx.id, status: { in: [...TRACKING_STATUSES] } }, data: { nextCheckAt: null } })
      if (!(await trackingDue(ctx)).length) break
      continue
    }
    const accountId = accountOf(ctx)
    const planId = amazonPlanIdOf(ctx)
    for (const row of due) {
      const tracking = row.tracking as unknown as FbaShipmentTracking
      await ensureOperation(ctx, { step: 'TRACKING', call: 'updateShipmentTrackingDetails', shipmentId: row.amazonShipmentId },
        () => amazon.updateShipmentTrackingDetails(accountId, planId, row.amazonShipmentId!, tracking.boxes))
      await prisma.fBAShipment.update({ where: { id: row.id }, data: { tracking: json({ ...tracking, sentAt: iso(ctx) }) } })
      sent = true
    }
  }
  if (sent) await syncAfter(ctx)
  return 'stop'
}

async function cancelStep(ctx: Ctx): Promise<StepResult> {
  ctx.expect = ['CANCELLING']
  ctx.step = 'CANCEL'
  let planId = ctx.row.planId
  if (!planId && ctx.row.channelConnectionId && stepsOf(ctx.row).some(e => e.call === 'createInboundPlan' && e.result !== 'FAILED')) {
    // A create may have reached Amazon: cancel the plan it holds under our name, if any.
    const found = await findPlanByName(ctx, amazonNameOf(ctx.row))
    if (found) {
      await mutate(ctx, () => ({ planId: found.inboundPlanId }))
      planId = found.inboundPlanId
    }
  }
  if (planId) {
    const accountId = accountOf(ctx)
    await ensureOperation(ctx, { step: 'CANCEL', call: 'cancelInboundPlan' }, () => amazon.cancelInboundPlan(accountId, planId!), {
      acceptRefusal: error => error.errors.some(e => /already (been )?(cancel|void)/i.test(e.message)),
    })
  }
  await mutate(ctx, row => ({ status: 'CANCELLED', currentStep: 'CANCEL', nextCheckAt: null, cancelledAt: row.cancelledAt ?? ctx.now() }), ['CANCELLING'])
  return 'stop'
}

async function resumeHeld(ctx: Ctx): Promise<StepResult> {
  const step = isFbaPlanStep(ctx.row.currentStep) ? ctx.row.currentStep : 'CREATE'
  let status: FbaPlanStatus
  if (step === 'TRACKING') status = 'READY_TO_SHIP'
  else if (step === 'CONFIRM' && !ctx.row.confirmedBy) status = 'WAITING_FOR_CHOICE'
  else status = FBA_STEP_STATUS[step]
  await mutate(ctx, () => ({ status, currentStep: step, lastError: null, lastErrorAt: null }), ['HELD'])
  return status === 'WAITING_FOR_CHOICE' ? 'stop' : 'continue'
}

async function runStep(ctx: Ctx): Promise<StepResult> {
  switch (ctx.row.status) {
    case 'QUEUED':
      ctx.step = 'CREATE'
      await move(ctx, 'CREATING', 'CREATE', ['QUEUED'])
      return 'continue'
    case 'HELD': return resumeHeld(ctx)
    case 'CREATING': return createStep(ctx)
    case 'PACKING': return packStep(ctx)
    case 'BOXES': return boxesStep(ctx)
    case 'PLACING': return placeStep(ctx)
    case 'QUOTING': return quoteStep(ctx)
    case 'CONFIRMING': return confirmStep(ctx)
    case 'LABELS': return labelsStep(ctx)
    case 'READY_TO_SHIP':
    case 'SHIPPED': return trackingStep(ctx)
    case 'CANCELLING': return cancelStep(ctx)
    default:
      // A person's turn, or done: let go of the lease.
      await prisma.fbaInboundPlanV2.updateMany({ where: { id: ctx.id, status: ctx.row.status }, data: { nextCheckAt: null } })
      return 'stop'
  }
}

/* ── errors → the plan ───────────────────────────────────────────────────────────────────────── */

const inTracking = (ctx: Ctx) => (TRACKING_STATUSES as readonly string[]).includes(ctx.row.status)

async function failPlan(ctx: Ctx, error: StepFailed): Promise<void> {
  const at = ctx.now()
  await mutate(ctx, row => {
    const steps = error.logged ? stepsOf(row) : [...stepsOf(row), {
      step: ctx.step, call: error.call, operationId: null, shipmentId: error.shipmentId, startedAt: at.toISOString(), finishedAt: at.toISOString(),
      result: 'FAILED' as const, problems: error.problems, note: error.note,
    }]
    // TRACKING keeps the plan's status (its units have left): the sentence shows, the tracking stays unsent.
    return inTracking(ctx)
      ? { steps: json(steps), lastError: error.message, lastErrorAt: at, nextCheckAt: null }
      : { steps: json(steps), status: 'FAILED', currentStep: ctx.step, lastError: error.message, lastErrorAt: at, nextCheckAt: null }
  }, ctx.expect)
}

async function holdPlan(ctx: Ctx, held: Held): Promise<void> {
  await mutate(ctx, () => (inTracking(ctx)
    ? { lastError: held.message, lastErrorAt: ctx.now(), nextCheckAt: held.retryAt }
    : { status: 'HELD', currentStep: ctx.step, lastError: held.message, lastErrorAt: ctx.now(), nextCheckAt: held.retryAt }), ctx.expect)
}

async function waitPlan(ctx: Ctx, at: Date): Promise<void> {
  await prisma.fbaInboundPlanV2.updateMany({ where: { id: ctx.id, status: { in: [...ctx.expect] } }, data: { nextCheckAt: at } })
}

async function handleError(ctx: Ctx, error: unknown): Promise<StepResult> {
  if (error instanceof CancelRequested || error instanceof PlanMoved) return 'continue'
  if (error instanceof StillRunning) {
    await waitPlan(ctx, new Date(ctx.now().getTime() + FBA_RECHECK_MS))
    return 'stop'
  }
  if (error instanceof StepFailed) {
    await failPlan(ctx, error)
    return 'stop'
  }
  const held = heldOf(ctx, error)
  if (held) {
    logger.info('[fba-inbound] plan held', { planRowId: ctx.id, step: ctx.step, reason: held.message })
    await holdPlan(ctx, held)
    return 'stop'
  }
  if (isTransient(error)) {
    logger.warn('[fba-inbound] no answer from Amazon; the step runs again later', { planRowId: ctx.id, step: ctx.step, error: error instanceof Error ? error.message : String(error) })
    await waitPlan(ctx, new Date(ctx.now().getTime() + FBA_RECHECK_MS))
    return 'stop'
  }
  if (refusedByAmazon(error)) {
    const problems = problemsOfError(error)
    await failPlan(ctx, new StepFailed(problems[0]?.message || error.message, problems, isOperation(error.operation) ? error.operation : null, false, isOperation(error.operation) ? null : error.operation))
    return 'stop'
  }
  const message = error instanceof Error ? error.message : String(error)
  logger.error('[fba-inbound] plan step failed unexpectedly', { planRowId: ctx.id, step: ctx.step, error: message })
  await failPlan(ctx, new StepFailed(message, [problem('NEXUS_ERROR', message)]))
  return 'stop'
}

/* ── the run ─────────────────────────────────────────────────────────────────────────────────── */

/** One run of the job (the frozen signature in contract.ts). */
export async function runFbaPlan(planRowId: string): Promise<FbaRunOutcome> {
  return runFbaPlanWith(planRowId)
}

/** `runFbaPlan` with its clock, sleep and inventory read injectable (tests). */
export async function runFbaPlanWith(planRowId: string, deps: FbaRunnerDeps = {}): Promise<FbaRunOutcome> {
  const now = deps.now ?? (() => new Date())
  const claimAt = now()
  const claimed = await prisma.fbaInboundPlanV2.updateMany({
    where: {
      id: planRowId,
      // Step 4 plans only: an older wizard plan's status words overlap ours.
      source: { not: null },
      status: { in: [...FBA_CLAIMABLE_STATUSES] },
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: claimAt } }],
    },
    data: { nextCheckAt: new Date(claimAt.getTime() + FBA_LEASE_MS) },
  })
  if (!claimed.count) return { claimed: false, status: null, step: null, nextCheckAt: null }

  const row = await load(planRowId)
  if (!row) return { claimed: false, status: null, step: null, nextCheckAt: null }
  const lines = (await prisma.fbaInboundPlanLine.findMany({
    where: { planRowId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { productId: true, msku: true, quantity: true, cases: true, unitsPerCase: true, looseUnits: true, prepOwner: true, labelOwner: true },
  })).filter(l => l.quantity > 0)
  const ctx: Ctx = {
    id: planRowId, row, lines, productIds: [...new Set(lines.map(l => l.productId))], now,
    sleep: deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    syncInventory: deps.syncInventory ?? defaultSyncInventory,
    expect: [row.status], step: isFbaPlanStep(row.currentStep) ? row.currentStep : 'CREATE', lastWriteAt: 0,
  }

  for (let n = 0; n < MAX_STEPS_PER_RUN; n++) {
    const fresh = await load(planRowId)
    if (!fresh) break
    ctx.row = fresh
    ctx.expect = [fresh.status]
    ctx.step = isFbaPlanStep(fresh.currentStep) ? fresh.currentStep : 'CREATE'
    let result: StepResult
    try {
      result = await runStep(ctx)
    } catch (error) {
      result = await handleError(ctx, error)
    }
    if (result === 'stop') break
  }

  const final = await load(planRowId)
  return {
    claimed: true,
    status: final ? statusOf(final) : null,
    step: final && isFbaPlanStep(final.currentStep) ? final.currentStep : null,
    nextCheckAt: final?.nextCheckAt ?? null,
  }
}
