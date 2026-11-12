import type { Issue } from '../../core/errors'
import { fitsDecimal, QUANTITY, toMinorUnits, UNIT_PRICE, type CurrencyCode, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { Dec, parseDecimal } from '../../tax/decimal'
import { isFinalRepair, stageWords, UNKNOWN_STYLE_WORDS, type RepairKind, type RepairStage } from '../repairs/rules'

/**
 * Repairs and alterations in depth (B-W2b-342; SAL-384 repair request form, SAL-385 damage photos at intake, SAL-387
 * repair quote from parts and labour, SAL-391 repair history per garment, SAL-393 alteration orders; follow-ups RR1:01
 * "The claim link offers Repair with its questions and damage photos", RR1:02 "The portal and the claim link make a
 * repair request"; design sales.returns rec "Repair order" › Intake & photos, Estimate; links.claim sec:details "Repair:
 * the work wanted — no payment data here", sec:photos "at least 2 for damage"). Pure, so the API and the screens share it.
 *
 *   the request    a repair or an alteration of one garment, from the office (B-W2a-57's create), the customer's portal or
 *                  a claim link (channel OFFICE | PORTAL | LINK, never changed): what is wrong (a repair's problem), the
 *                  work wanted ("add 2 cm to the sleeve": an alteration's, needed), the garment from what we delivered or
 *                  by the serial on its label; AWAITING_GOODS until it arrives. Its damage photos are files of the repair
 *                  of category DAMAGE_PHOTO (two at least for a repair, by the page; an alteration's fit photos optional).
 *   the estimate   revisions 1, 2, 3 … of parts and labour (quantity, labour minutes, price per unit to the customer, our
 *                  cost per unit: office only), DRAFT → SENT → ACCEPTED | DECLINED, or WITHDRAWN; ONE live (DRAFT or SENT)
 *                  per repair; a change after sending is a new revision that withdraws the sent one. Sending moves the
 *                  repair from received to estimated; the customer's yes (recorded by the office, or given in the portal)
 *                  moves it to approved. "Approved by the customer before work starts": while the newest estimate waits for
 *                  the answer, or the customer declined it, the repair is neither approved nor put into repair.
 *   the history    every repair, return and complaint of one garment by its serial (ours: GarmentSerial), newest first.
 *   an alteration  goes through the same flow; a protective garment (its style is PPE, an unknown style counts as one)
 *                  keeps its safety check: it goes back only after a passed check that its certificate still covers it.
 * Money only by grain: prices are the price grain, costs the cost grain; never in an event, a stage note or an audit row
 * without its marking. No worker's name: office people by id.
 */

export const ESTIMATE_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN'] as const
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number]
export const ESTIMATE_LINE_KINDS = ['PART', 'LABOUR'] as const
export type EstimateLineKind = (typeof ESTIMATE_LINE_KINDS)[number]
export const ESTIMATE_ANSWERS = ['ACCEPTED', 'DECLINED'] as const
export type EstimateAnswer = (typeof ESTIMATE_ANSWERS)[number]
export const ANSWER_VIAS = ['LINK', 'PORTAL', 'OFFICE'] as const
export type AnswerVia = (typeof ANSWER_VIAS)[number]
export const REQUEST_CHANNELS = ['OFFICE', 'PORTAL', 'LINK'] as const
export type RequestChannel = (typeof REQUEST_CHANNELS)[number]
/** How a customer's request reached us from outside. */
export const OUTSIDE_CHANNELS = ['PORTAL', 'LINK'] as const
export type OutsideChannel = (typeof OUTSIDE_CHANNELS)[number]

/** The live estimate of a repair: at most one (the API's rule; the database's uniques cannot say it). */
export const LIVE_ESTIMATE: readonly EstimateStatus[] = Object.freeze(['DRAFT', 'SENT'])
export const FINAL_ESTIMATE: readonly EstimateStatus[] = Object.freeze(['ACCEPTED', 'DECLINED', 'WITHDRAWN'])

export const DEPTH_LIMITS = Object.freeze({
  /** An estimate line as the customer reads it (one line). */
  description: 500,
  customerNote: 2000,
  internalNote: 2000,
  declineReason: 1000,
  answeredByName: 200,
  /** How the office heard the customer's answer ("by phone with Ms Rossi"). */
  how: 500,
  workWanted: 2000,
  problem: 2000,
  serial: 60,
  size: 20,
  /** Lines on one estimate. */
  lines: 50,
  minutes: 100000,
  /** Photos of one repair from outside, at most (as a return's or a complaint's). */
  photos: 10,
  /** Damage photos a repair asks of the customer (the page checks; an alteration's are optional). */
  damagePhotos: 2,
  /** Entries in a garment's history, at most per kind. */
  history: 50,
  /** Repairs in the customer's list, at most. */
  list: 200,
  /** The search text of a serial. */
  query: 60,
})

const blank = (value: string | null | undefined): boolean => (value ?? '').trim() === ''
const longerThan = (value: string | null | undefined, max: number): boolean => (value ?? '').trim().length > max
const oneLine = (value: string): boolean => !/[\r\n]/.test(value)

// ---- the request ------------------------------------------------------------------------------------------------------

export interface RepairRequestShape {
  readonly kind: RepairKind
  readonly salesOrderLineId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly problem?: string | null | undefined
  readonly workWanted?: string | null | undefined
}

/**
 * What a request from outside needs, field by field (400 at body/<field>): the garment (an item we delivered, or the
 * serial on its label), a repair's problem ("what is wrong"), an alteration's work wanted; their lengths.
 */
export function requestProblems(body: RepairRequestShape): Issue[] {
  const problems: Issue[] = []
  if (blank(body.salesOrderLineId) && blank(body.serial)) problems.push({ path: 'body/salesOrderLineId', message: 'Pick the garment from what we delivered, or type the serial on its label.' })
  if (longerThan(body.serial, DEPTH_LIMITS.serial)) problems.push({ path: 'body/serial', message: `At most ${DEPTH_LIMITS.serial} characters.` })
  else if (!blank(body.serial) && !oneLine(body.serial!)) problems.push({ path: 'body/serial', message: 'The serial is one line.' })
  if (longerThan(body.size, DEPTH_LIMITS.size)) problems.push({ path: 'body/size', message: `At most ${DEPTH_LIMITS.size} characters.` })
  if (body.kind === 'REPAIR' && blank(body.problem)) problems.push({ path: 'body/problem', message: 'Say what is wrong with the garment.' })
  if (longerThan(body.problem, DEPTH_LIMITS.problem)) problems.push({ path: 'body/problem', message: `At most ${DEPTH_LIMITS.problem} characters.` })
  if (body.kind === 'ALTERATION' && blank(body.workWanted)) problems.push({ path: 'body/workWanted', message: "Say the work you want (for example 'add 2 cm to the sleeves')." })
  if (longerThan(body.workWanted, DEPTH_LIMITS.workWanted)) problems.push({ path: 'body/workWanted', message: `At most ${DEPTH_LIMITS.workWanted} characters.` })
  return problems
}

/**
 * The repair's `problem` (the database needs one): a repair's own words, else an alteration's work wanted (an
 * alteration's "what is wrong" is often the fit the work answers).
 */
export const problemOf = (body: Pick<RepairRequestShape, 'problem' | 'workWanted'>): string => (blank(body.problem) ? (body.workWanted ?? '').trim() : body.problem!.trim())

/** Photos may be added while the garment is not worked on yet (waiting, received, estimated). */
export const PHOTO_STAGES: readonly RepairStage[] = Object.freeze(['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED'])

export function photosHeld(number: string, stage: RepairStage): string | null {
  if (PHOTO_STAGES.includes(stage)) return null
  return `Repair ${number} is ${stageWords(stage)}: photos are added before the work starts.`
}

/** Damage photos a request asks for (design sec:photos "at least 2 for damage"; an alteration's fit photos optional). */
export const photosNeeded = (kind: RepairKind): number => (kind === 'REPAIR' ? DEPTH_LIMITS.damagePhotos : 0)

// ---- the estimate: lines and totals ---------------------------------------------------------------------------------

export interface EstimateLineShape {
  readonly kind: EstimateLineKind
  readonly itemId?: string | null | undefined
  readonly description: string
  /** A decimal string, Decimal(18,4), above 0. */
  readonly quantity: string
  /** LABOUR only: the minutes of the work, 1 to 100000. */
  readonly minutes?: number | null | undefined
  /** Price per unit to the customer, a decimal string Decimal(18,6), 0 or more. */
  readonly unitPrice: string
  /** Our cost per unit, a decimal string Decimal(18,6), 0 or more; none: not known. */
  readonly unitCost?: string | null | undefined
}

/** The problems of one line (paths under `path`, e.g. body/…). The database refuses the same, without the words. */
export function lineProblems(line: EstimateLineShape, path = 'body'): Issue[] {
  const problems: Issue[] = []
  const description = line.description.trim()
  if (description === '') problems.push({ path: `${path}/description`, message: 'Say what the part or the job is, as the customer reads it.' })
  else if (description.length > DEPTH_LIMITS.description || !oneLine(description)) problems.push({ path: `${path}/description`, message: `One line of at most ${DEPTH_LIMITS.description} characters.` })
  const quantity = fitsDecimal(line.quantity, QUANTITY.precision, QUANTITY.scale) ? parseDecimal(line.quantity) : null
  if (!quantity || !quantity.greaterThan(0)) problems.push({ path: `${path}/quantity`, message: 'A quantity above 0 (at most 4 decimals).' })
  if (line.kind === 'LABOUR') {
    if (line.minutes === null || line.minutes === undefined || !Number.isInteger(line.minutes) || line.minutes < 1 || line.minutes > DEPTH_LIMITS.minutes) problems.push({ path: `${path}/minutes`, message: `The minutes of the work, 1 to ${DEPTH_LIMITS.minutes}.` })
    if (line.itemId) problems.push({ path: `${path}/itemId`, message: 'Labour names no item: an item is a part.' })
  } else if (line.minutes !== null && line.minutes !== undefined) problems.push({ path: `${path}/minutes`, message: 'A part has no minutes: put the work on its own labour line.' })
  const price = fitsDecimal(line.unitPrice, UNIT_PRICE.precision, UNIT_PRICE.scale) ? parseDecimal(line.unitPrice) : null
  if (!price || price.isNegative()) problems.push({ path: `${path}/unitPrice`, message: 'A price per unit of 0 or more (at most 6 decimals).' })
  if (line.unitCost !== null && line.unitCost !== undefined) {
    const cost = fitsDecimal(line.unitCost, UNIT_PRICE.precision, UNIT_PRICE.scale) ? parseDecimal(line.unitCost) : null
    if (!cost || cost.isNegative()) problems.push({ path: `${path}/unitCost`, message: 'A cost per unit of 0 or more (at most 6 decimals).' })
  }
  return problems
}

/** The line's total to the customer and our cost, in minor units of the estimate's currency (rounded once, half up). */
export function lineAmounts(line: Pick<EstimateLineShape, 'quantity' | 'unitPrice' | 'unitCost'>, currency: CurrencyCode): { amount: MinorUnits; costAmount: MinorUnits | null } {
  const quantity = new Dec(line.quantity)
  return {
    amount: toMinorUnits(quantity.times(new Dec(line.unitPrice)), currency),
    costAmount: line.unitCost === null || line.unitCost === undefined ? null : toMinorUnits(quantity.times(new Dec(line.unitCost)), currency),
  }
}

export interface LineTotals {
  readonly kind: EstimateLineKind
  readonly amount: MinorUnits
  readonly costAmount: MinorUnits | null
  readonly minutes: number | null
  readonly quantity: string
}

/**
 * The estimate's totals: to the customer (price), our cost (cost; null when a line's cost is not known), the parts' and
 * the labour's share, and the labour minutes (a job's minutes times its quantity).
 */
export function estimateTotals(lines: readonly LineTotals[]): { amount: MinorUnits; parts: MinorUnits; labour: MinorUnits; costAmount: MinorUnits | null; labourMinutes: number; lines: number } {
  let amount = 0
  let parts = 0
  let labour = 0
  let cost: number | null = 0
  let minutes = new Dec(0)
  for (const line of lines) {
    amount += line.amount
    if (line.kind === 'PART') parts += line.amount
    else {
      labour += line.amount
      minutes = minutes.plus(new Dec(line.quantity).times(line.minutes ?? 0))
    }
    cost = cost === null || line.costAmount === null ? null : cost + line.costAmount
  }
  return { amount, parts, labour, costAmount: lines.length === 0 ? null : cost, labourMinutes: Number(minutes.toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0)), lines: lines.length }
}

// ---- the estimate: what may be done ---------------------------------------------------------------------------------

/** A new estimate may be drafted while the work has not started (also before the garment arrives: from its photos). */
export const DRAFT_STAGES: readonly RepairStage[] = Object.freeze(['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED'])
/** It is sent once the garment is here (received: it moves to estimated; estimated: a new revision). */
export const SEND_STAGES: readonly RepairStage[] = Object.freeze(['RECEIVED', 'ESTIMATED'])

export interface EstimateFacts {
  readonly repairNumber: string
  readonly stage: RepairStage
  readonly revision: number
  readonly status: EstimateStatus
  readonly lines: number
  readonly validUntil: BusinessDate | null
  readonly today: BusinessDate
}

const label = (facts: Pick<EstimateFacts, 'repairNumber' | 'revision'>): string => `Estimate ${facts.revision} of repair ${facts.repairNumber}`

export function draftHeld(facts: { readonly repairNumber: string; readonly stage: RepairStage; readonly live: { readonly revision: number; readonly status: EstimateStatus } | null; readonly replaces?: boolean }): string | null {
  if (isFinalRepair(facts.stage)) return `Repair ${facts.repairNumber} is ${stageWords(facts.stage)}: it takes no estimate.`
  if (!DRAFT_STAGES.includes(facts.stage)) return `Repair ${facts.repairNumber} is ${stageWords(facts.stage)}: the estimate is made before the work starts.`
  if (facts.live?.status === 'DRAFT') return `Estimate ${facts.live.revision} is a draft: change that one (one estimate at a time).`
  if (facts.live?.status === 'SENT' && !facts.replaces) return `Estimate ${facts.live.revision} waits for the customer's answer: make the new one in its place (it is withdrawn), or wait for the answer.`
  return null
}

/** Lines and terms change only while the estimate is a draft (from sending on, it is what the customer saw). */
export function editHeld(facts: Pick<EstimateFacts, 'repairNumber' | 'revision' | 'status' | 'stage'>): string | null {
  if (isFinalRepair(facts.stage)) return `Repair ${facts.repairNumber} is ${stageWords(facts.stage)}: its estimate changes no more.`
  if (facts.status !== 'DRAFT') return `${label(facts)} is ${statusWord(facts.status)}: it changes no more (make a new revision to change it).`
  return null
}

export function sendHeld(facts: EstimateFacts): string | null {
  const edit = editHeld(facts)
  if (edit) return edit
  if (!SEND_STAGES.includes(facts.stage)) return facts.stage === 'AWAITING_GOODS' ? `The garment of repair ${facts.repairNumber} has not arrived: send the estimate once it is here.` : `Repair ${facts.repairNumber} is ${stageWords(facts.stage)}: the estimate is sent before the work starts.`
  if (facts.lines === 0) return `${label(facts)} has no lines: add the parts and the work first.`
  if (facts.lines > DEPTH_LIMITS.lines) return `${label(facts)} has more than ${DEPTH_LIMITS.lines} lines.`
  if (facts.validUntil !== null && facts.validUntil < facts.today) return `${label(facts)} was valid until ${facts.validUntil}: give it a later day.`
  return null
}

/** The customer's answer is recorded (or given) once sent, while the repair waits for it and by its last day. */
export function answerHeld(facts: EstimateFacts): string | null {
  if (isFinalRepair(facts.stage)) return `Repair ${facts.repairNumber} is ${stageWords(facts.stage)}: its estimate is no longer answered.`
  if (facts.status !== 'SENT') return facts.status === 'DRAFT' ? `${label(facts)} is not sent yet.` : `${label(facts)} is ${statusWord(facts.status)} already.`
  if (facts.stage !== 'ESTIMATED') return `Repair ${facts.repairNumber} is ${stageWords(facts.stage)}: the estimate's answer is no longer asked.`
  if (facts.validUntil !== null && facts.validUntil < facts.today) return `${label(facts)} was valid until ${facts.validUntil}: send a new revision.`
  return null
}

export function withdrawHeld(facts: Pick<EstimateFacts, 'repairNumber' | 'revision' | 'status' | 'stage'>): string | null {
  if (!LIVE_ESTIMATE.includes(facts.status)) return `${label(facts)} is ${statusWord(facts.status)}: only a draft or a sent estimate is withdrawn.`
  return null
}

const STATUS_WORDS: Readonly<Record<EstimateStatus, string>> = Object.freeze({ DRAFT: 'a draft', SENT: 'sent', ACCEPTED: 'accepted', DECLINED: 'declined', WITHDRAWN: 'withdrawn' })
export const statusWord = (status: EstimateStatus): string => STATUS_WORDS[status]

/**
 * "Approved by the customer before work starts" (SAL-387; B-W2b-291's gap: the database does not refuse it): the newest
 * estimate that is not withdrawn decides. While it waits for the customer's answer (SENT) or the customer declined it, the
 * repair is not approved and not put into repair. A draft binds nothing yet (the customer has not seen it); with no
 * estimate, or an accepted one, the move is as before (W2a: a free repair, or a yes the office notes in words).
 */
export function workHeldByEstimate(repairNumber: string, to: 'APPROVED' | 'IN_REPAIR', newest: { readonly revision: number; readonly status: EstimateStatus } | null): string | null {
  if (!newest) return null
  const what = to === 'APPROVED' ? 'approved' : 'put into repair'
  if (newest.status === 'SENT') return `Estimate ${newest.revision} of repair ${repairNumber} waits for the customer's answer: record it (Estimate › Record the answer) before the repair is ${what}.`
  if (newest.status === 'DECLINED') return `The customer declined estimate ${newest.revision} of repair ${repairNumber}: make a new estimate, or send the garment back unrepaired.`
  return null
}

/** The newest estimate that is not withdrawn (the rule above reads it), from the repair's revisions. */
export function newestOf<T extends { readonly revision: number; readonly status: EstimateStatus }>(estimates: readonly T[]): T | null {
  return [...estimates].filter((estimate) => estimate.status !== 'WITHDRAWN').sort((a, b) => b.revision - a.revision)[0] ?? null
}

export const ESTIMATE_ACTIONS = ['edit', 'send', 'answer', 'withdraw', 'revise'] as const
export type EstimateAction = (typeof ESTIMATE_ACTIONS)[number]

/** Each action on an estimate: allowed, or held with the same words its route answers. */
export function estimateActions(facts: EstimateFacts & { readonly newest: boolean }): { action: EstimateAction; allowed: boolean; held: string | null }[] {
  const state = (action: EstimateAction, held: string | null) => ({ action, allowed: held === null, held })
  const revise = !facts.newest ? `${label(facts)} is an older revision.` : draftHeld({ repairNumber: facts.repairNumber, stage: facts.stage, live: LIVE_ESTIMATE.includes(facts.status) ? { revision: facts.revision, status: facts.status } : null, replaces: true })
  return [state('edit', editHeld(facts)), state('send', sendHeld(facts)), state('answer', answerHeld(facts)), state('withdraw', withdrawHeld(facts)), state('revise', revise)]
}

// ---- the customer's view (portal, claim link) -----------------------------------------------------------------------

export const CUSTOMER_NEXT = ['SEND_GARMENT', 'WE_ESTIMATE', 'ANSWER_ESTIMATE', 'WE_DECIDE', 'WE_REPAIR', 'WE_CHECK', 'ON_ITS_WAY', 'DONE', 'CANCELLED'] as const
export type CustomerNext = (typeof CUSTOMER_NEXT)[number]

/**
 * The customer's next step (codes: the pages say them in their own words): send us the garment, we estimate, answer the
 * estimate (theirs), we decide after a decline, we repair, we check it, it is on its way back, done, cancelled.
 */
export function customerNext(stage: RepairStage, newest: { readonly status: EstimateStatus } | null): { code: CustomerNext; forYou: boolean } {
  switch (stage) {
    case 'AWAITING_GOODS':
      return { code: 'SEND_GARMENT', forYou: true }
    case 'RECEIVED':
      return { code: 'WE_ESTIMATE', forYou: false }
    case 'ESTIMATED':
      return newest?.status === 'SENT' ? { code: 'ANSWER_ESTIMATE', forYou: true } : newest?.status === 'DECLINED' ? { code: 'WE_DECIDE', forYou: false } : { code: 'WE_ESTIMATE', forYou: false }
    case 'APPROVED':
    case 'IN_REPAIR':
      return { code: 'WE_REPAIR', forYou: false }
    case 'REPAIRED':
      return { code: 'WE_CHECK', forYou: false }
    case 'SHIPPED':
      return { code: 'DONE', forYou: false }
    case 'CANCELLED':
      return { code: 'CANCELLED', forYou: false }
  }
}

/** The customer may answer in the portal: a sent estimate, still waiting, by its last day; and the person sees prices. */
export function customerAnswerHeld(facts: EstimateFacts & { readonly seesPrices: boolean; readonly mayRequest: boolean; readonly preview: boolean }): string | null {
  if (facts.preview) return 'A preview reads the portal; it never acts for the customer.'
  if (!facts.mayRequest) return 'Your access lets you follow your repairs, not answer an estimate: ask your admin for the right to ask.'
  if (!facts.seesPrices) return 'Your access does not show prices: the estimate is answered by someone who sees them.'
  return answerHeld(facts)
}

// ---- the garment's safety check and its certificate (SAL-393) -------------------------------------------------------

export interface CoverFacts {
  readonly kind: RepairKind
  readonly required: boolean
  /** The style is known. */
  readonly styleKnown: boolean
  /** The certificate that covers the garment today, or null. */
  readonly certificateNumber: string | null
}

/**
 * The words of the record's safety rule: a protective garment (repaired or altered) goes back only after a passed check
 * that it still protects and that its certificate still covers it; an alteration keeps that check.
 */
export function coverWords(facts: CoverFacts): string {
  if (!facts.styleKnown) return UNKNOWN_STYLE_WORDS
  if (!facts.required) return 'Not a protective garment: it goes back without a safety check.'
  const certificate = facts.certificateNumber ? ` that certificate ${facts.certificateNumber} still covers it` : ' that a certificate still covers it (none covers its style, colour and size today)'
  return facts.kind === 'ALTERATION'
    ? `An alteration of a protective garment keeps its safety check: it goes back only after a passed check that it still protects and${certificate}.`
    : `A protective garment: it goes back only after a passed safety check that it still protects and${certificate}.`
}
