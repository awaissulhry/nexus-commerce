import type { PlanningCard, PlanningLane, PlanningMark } from '@nexus/ui/patterns/planning-board/index'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Allocation, AllocationCard } from '../api'
import { laneKeyOf, laneRefOf, readProblemOf, WINDOW, type ReadProblem } from '../model'
import { MAX_PARTS, type AllocationWorkshop, type AllocationWorkshops, type DepthOperation, type FromAllocation, type FromAllocationResult, type HoldReason, type KitTiming, type OutsideAnswer, type Verdict, type WarningReason, type WorkshopCapacityLine } from './api'

/**
 * Lines & subcontractors in depth (SCR-126; B-W2b-338 on B-W2b-321's API; design planning.allocation board#1-#4,
 * pop:kit-timing, page.h#1), pure: the workshop columns with their reasons (a column held for what does not depend on the
 * work: not active, the supplier's status, no stock location, no valid DURC; a card held by its own verdict: not approved
 * for the work), the warnings said and never held, the card's operations chip, the kit timing in words, "Create
 * subcontract orders (n)" (which parts, when it is held), and every refusal and result in our words.
 *
 * The API's English (`held[].words`, `warnings[].words`, `problems`, `orderWords`) is never drawn: the codes and the facts
 * (the DURC's date, the location, the qualification per kind) say it; where a code carries detail only in its sentence
 * (which operation is not approved and how it stands, the load % of an over-capacity warning) its shape is read and said
 * again in the page's language, else a sentence of our own without the detail. No money, no person.
 */

export const DEPTH_NAMESPACE = 'planning-allocation-depth'

export interface Words {
  t: Translate
  locale: Locale
}

export type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T }

const number = (value: number | string, locale: Locale, digits = 0): string => formatNumber(Number(value), locale, { maximumFractionDigits: digits })

export function dayWords(date: string, locale: Locale): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(year, month - 1, day)))
}

const KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING', 'SUBCONTRACT'] as const

/** A kind of work in words ("sewing"); an unknown kind stays as the code says it, in lower case. */
export function kindWords(kind: string | null, words: Words): string {
  if (kind === null) return words.t('al.kind.ALL')
  return (KINDS as readonly string[]).includes(kind.toUpperCase()) ? words.t(`al.kind.${kind.toUpperCase()}`) : kind.toLowerCase()
}

// ---- the workshops ------------------------------------------------------------------------------------------------------

export const workshopOf = (workshops: AllocationWorkshops | null, partyId: string): AllocationWorkshop | null => workshops?.workshops.find((entry) => entry.id === partyId) ?? null

/** The holds a workshop has whatever the work (the column is held for every card). */
export function laneHoldCodes(workshop: AllocationWorkshop): HoldReason['code'][] {
  const codes: HoldReason['code'][] = []
  if (!workshop.active) codes.push('NOT_ACTIVE')
  if (workshop.supplierProblem) codes.push('SUPPLIER_STATUS')
  if (workshop.location === null) codes.push('NO_LOCATION')
  if (workshop.durc.checked && (workshop.durc.state === 'MISSING' || workshop.durc.state === 'EXPIRED')) codes.push('NO_VALID_DURC')
  return codes
}

const SUPPLIER_STATUS = /\bis (on hold|blocked|inactive) as a supplier\b/
const STATUS_KEY: Record<string, string> = { 'on hold': 'ON_HOLD', blocked: 'BLOCKED', inactive: 'INACTIVE' }

/** The person's own reason inside a standing sentence ("Suspended: <reason>"): typed by a person, shown as typed. */
const tail = (text: string, prefix: RegExp): string | null => {
  const found = prefix.exec(text)
  if (!found) return null
  const rest = text.slice(found.index + found[0].length).trim().replace(/\.$/, '')
  return rest === '' ? null : rest
}

/** How a qualification stands, in our words, from the API's sentence (B-W2b-315's standingOf, lower-cased first). */
export function standingWords(sentence: string, words: Words): string {
  const { t } = words
  const text = sentence.trim()
  if (/^being reviewed/i.test(text)) return t('al.standing.PENDING')
  if (/^suspended/i.test(text)) {
    const reason = tail(text, /^suspended:?/i)
    return reason ? t('al.standing.SUSPENDED_WHY', { reason }) : t('al.standing.SUSPENDED')
  }
  if (/^not qualified for this work/i.test(text)) return t('al.standing.NO_COVER')
  if (/^not qualified/i.test(text)) {
    const reason = tail(text, /^not qualified:?/i)
    return reason ? t('al.standing.REFUSED_WHY', { reason }) : t('al.standing.REFUSED')
  }
  if (/^withdrawn/i.test(text)) return t('al.standing.NONE')
  if (/^qualified from/i.test(text)) return t('al.standing.NOT_YET')
  if (/^the qualification ended/i.test(text)) return t('al.standing.EXPIRED')
  if (/^a document it rests on expired/i.test(text)) return t('al.standing.EVIDENCE_EXPIRED')
  return t('al.standing.OTHER')
}

const NEED = /^(?:Not approved|Approved) for ([a-z]+) \(Op (\d+) (.+?)\)(?: with conditions)?: ([\s\S]*)$/

/** A hold of a workshop for some work, in our words. */
export function holdWords(reason: HoldReason, workshop: { name: string; durc: AllocationWorkshop['durc'] } | null, site: string, words: Words): string {
  const { t, locale } = words
  const name = workshop?.name ?? t('al.workshop')
  switch (reason.code) {
    case 'NOT_A_WORKSHOP':
      return t('al.hold.NOT_A_WORKSHOP', { workshop: name })
    case 'NOT_ACTIVE':
      return t('al.hold.NOT_ACTIVE', { workshop: name })
    case 'SUPPLIER_STATUS': {
      const status = SUPPLIER_STATUS.exec(reason.words)?.[1]
      return t(`al.hold.SUPPLIER_STATUS.${status ? STATUS_KEY[status] : 'OTHER'}`, { workshop: name })
    }
    case 'NO_LOCATION':
      return t('al.hold.NO_LOCATION', { workshop: name, site })
    case 'NO_VALID_DURC':
      return workshop?.durc.state === 'EXPIRED' && workshop.durc.expiresOn ? t('al.hold.DURC_EXPIRED', { date: dayWords(workshop.durc.expiresOn, locale) }) : t('al.hold.DURC_MISSING')
    case 'NOT_QUALIFIED': {
      const need = NEED.exec(reason.words)
      if (!need) return t('al.hold.NOT_QUALIFIED_ANY', { workshop: name })
      return t('al.hold.NOT_QUALIFIED', { kind: kindWords(need[1]!, words), seq: need[2]!, operation: need[3]!, standing: standingWords(need[4]!, words) })
    }
  }
}

/** A warning of a workshop for some work, said beside the drop (never held), in our words. */
export function warningWords(reason: WarningReason, workshop: { name: string; durc: AllocationWorkshop['durc'] } | null, words: Words): string {
  const { t, locale } = words
  const name = workshop?.name ?? t('al.workshop')
  switch (reason.code) {
    case 'CONDITIONAL': {
      const need = NEED.exec(reason.words)
      return need ? t('al.warn.CONDITIONAL', { kind: kindWords(need[1]!, words), seq: need[2]!, operation: need[3]!, conditions: need[4]!.trim().replace(/\.$/, '') || '—' }) : t('al.warn.CONDITIONAL_ANY')
    }
    case 'DURC_EXPIRING':
      return workshop?.durc.expiresOn ? t('al.warn.DURC_EXPIRING', { date: dayWords(workshop.durc.expiresOn, locale) }) : t('al.warn.DURC_EXPIRING_ANY')
    case 'DURC_NOT_CHECKED':
      return t('al.warn.DURC_NOT_CHECKED', { workshop: name })
    case 'OVER_CAPACITY': {
      const pct = /at ([\d.]+)% of its capacity/.exec(reason.words)?.[1]
      return pct ? t('al.warn.OVER_CAPACITY', { workshop: name, pct: number(pct, locale) }) : t('al.warn.OVER_CAPACITY_ANY', { workshop: name })
    }
    case 'NO_CAPACITY_SET':
      return t('al.warn.NO_CAPACITY_SET', { workshop: name })
  }
}

/** The workshop's column held for every card (the first reason that does not depend on the work), or null. */
export function laneHeld(workshop: AllocationWorkshop, site: string, words: Words): string | null {
  const code = laneHoldCodes(workshop)[0]
  return code ? holdWords({ code, words: code === 'SUPPLIER_STATUS' ? (workshop.supplierProblem ?? '') : '' }, workshop, site, words) : null
}

/** The fullest capacity line of a workshop over the next four weeks (the lane's tile draws it), or null when none is known. */
export function fullestLine(workshop: AllocationWorkshop): WorkshopCapacityLine | null {
  const known = workshop.capacity.filter((line) => line.available !== null && line.unit !== null)
  return known.reduce<WorkshopCapacityLine | null>((best, line) => (best === null || Number(line.loadPct ?? 0) > Number(best.loadPct ?? 0) ? line : best), null)
}

/** One capacity line over the next four weeks: "Sewing: 338 of 2,400 min (14%), 772 more proposed by the plan". */
export function capacityLineWords(line: WorkshopCapacityLine, words: Words): string {
  const { t, locale } = words
  const kind = kindWords(line.workCentreKind, words)
  if (line.available === null || line.unit === null) return t('al.capacity.none', { kind })
  const base = t(`al.capacity.${line.unit}`, { kind, booked: number(line.booked, locale, 1), available: number(line.available, locale, 1), pct: line.loadPct === null ? '—' : number(line.loadPct, locale) })
  return Number(line.proposed) > 0 ? `${base} ${t(`al.capacity.proposed.${line.unit}`, { proposed: number(line.proposed, locale, 1) })}` : base
}

/** The capacity words of a workshop's column (the DS popover of its load row). */
export function workshopCapacityWords(workshop: AllocationWorkshop, words: Words): string {
  const lines = workshop.capacity.filter((line) => line.unit !== null)
  return lines.length === 0 ? words.t('al.capacity.unknown', { workshop: workshop.name }) : `${words.t('al.capacity.head')} ${lines.map((line) => capacityLineWords(line, words)).join(' · ')}`
}

/** Under a workshop column's name: the kinds of work it is approved for, and its DURC. */
export function workshopDetail(workshop: AllocationWorkshop, words: Words): string {
  const { t, locale } = words
  const approved = workshop.qualifications.filter((entry) => entry.qualified).map((entry) => kindWords(entry.workCentreKind, words))
  const parts = [approved.length > 0 ? t('al.lane.approved', { kinds: approved.join(', ') }) : t('al.lane.approvedNone')]
  if (!workshop.durc.checked) parts.push(t('al.lane.durcNotChecked'))
  else if (workshop.durc.state === 'MET' || workshop.durc.state === 'EXPIRING') parts.push(workshop.durc.expiresOn ? t('al.lane.durcUntil', { date: dayWords(workshop.durc.expiresOn, locale) }) : t('al.lane.durcValid'))
  return parts.join(' · ')
}

/**
 * The board's columns with the W2b facts: a workshop column says what it is approved for and its DURC, its capacity over
 * the next four weeks (in words: the column's standard minutes are every operation's, a workshop's capacity counts one
 * kind of work, so no number is compared), and is held with the reason when it takes no work whatever the card. While the
 * check is read (or failed) every workshop column is held: an unchecked workshop never takes a drop.
 */
export function decorateLanes(lanes: readonly PlanningLane[], workshops: Loaded<AllocationWorkshops>, site: string, words: Words): PlanningLane[] {
  const { t } = words
  return lanes.map((lane) => {
    const ref = laneRefOf(lane.id)
    if (ref?.kind !== 'WORKSHOP') return lane
    if (workshops.status !== 'ready') return { ...lane, held: t(workshops.status === 'loading' ? 'al.held.checking' : 'al.held.notChecked') }
    const workshop = workshopOf(workshops.value, ref.id)
    if (!workshop) return { ...lane, held: t('al.held.notOffered', { workshop: lane.label }) }
    return { ...lane, detail: `${lane.detail ?? ''}${lane.detail ? ' · ' : ''}${workshopDetail(workshop, words)}`, held: laneHeld(workshop, site, words), capacityWords: { [WINDOW]: workshopCapacityWords(workshop, words) } }
  })
}

// ---- a card at a workshop -------------------------------------------------------------------------------------------------

export const verdictsOf = (workshops: AllocationWorkshops | null, workOrderId: string) => workshops?.workOrders.find((entry) => entry.workOrder.id === workOrderId) ?? null

export function verdictFor(workshops: AllocationWorkshops | null, workOrderId: string, partyId: string): Verdict | null {
  return verdictsOf(workshops, workOrderId)?.workshops.find((entry) => entry.partyId === partyId) ?? null
}

/**
 * Why a card cannot go to a column (the DS `dropHeld`, said while the drag is under way): a workshop not offered for this
 * work order's outside work, with its first hold; null for a line, the tray, or an offered workshop (its warnings are said
 * in the kit timing). A work order the check does not list is held: its workshops were not checked.
 */
export function dropHeldFor(data: Allocation, workshops: Loaded<AllocationWorkshops>, cardId: string, laneId: string | null, words: Words): string | null {
  const ref = laneRefOf(laneId)
  if (ref?.kind !== 'WORKSHOP') return null
  const card = data.cards.find((entry) => entry.id === cardId)
  if (!card) return null
  if (workshops.status !== 'ready') return words.t(workshops.status === 'loading' ? 'al.held.checking' : 'al.held.notChecked')
  const workshop = workshopOf(workshops.value, ref.id)
  const name = workshop?.name ?? data.lanes.find((lane) => laneKeyOf(lane) === laneId)?.name ?? words.t('al.workshop')
  const verdict = verdictFor(workshops.value, card.workOrder.id, ref.id)
  if (!verdict) return words.t('al.held.notListed', { workshop: name, order: card.workOrder.number })
  // Nothing it makes is left (no outside work): it stays on our lines (the kit timing would refuse it too).
  if (verdictsOf(workshops.value, card.workOrder.id)?.operations.length === 0) return words.t('al.held.noWork', { order: card.workOrder.number })
  if (verdict.offered) return null
  const first = verdict.held[0]
  return first ? holdWords(first, workshop, data.site.name, words) : words.t('al.held.notOffered', { workshop: name })
}

/** Every hold and warning of a workshop for a card, in our words (the kit timing, the card's operations). */
export function verdictWords(workshops: AllocationWorkshops | null, site: string, workOrderId: string, partyId: string, words: Words): { held: string[]; warnings: string[] } {
  const verdict = verdictFor(workshops, workOrderId, partyId)
  const workshop = workshopOf(workshops, partyId)
  return { held: (verdict?.held ?? []).map((reason) => holdWords(reason, workshop, site, words)), warnings: (verdict?.warnings ?? []).map((reason) => warningWords(reason, workshop, words)) }
}

/** The operations of a work order sent outside, as the check lists them (its outside work). */
export const outsideOperations = (workshops: AllocationWorkshops | null, workOrderId: string): DepthOperation[] => (verdictsOf(workshops, workOrderId)?.operations ?? []).filter((operation) => operation.outsourced)

/** The card's operations chip (design board#4): "Sewing outside" / "2 operations outside"; the card opens to switch them. */
export function operationsMark(workshops: AllocationWorkshops | null, card: Pick<AllocationCard, 'workOrder'>, words: Words): PlanningMark | null {
  const outside = outsideOperations(workshops, card.workOrder.id)
  if (outside.length === 0) return null
  if (outside.length === 1) return { label: words.t('al.mark.oneOutside', { kind: kindWords(outside[0]!.workCentreKind, words), seq: String(outside[0]!.seq) }), tone: 'info' }
  return { label: words.t('al.mark.manyOutside', { count: outside.length }), tone: 'info' }
}

/** The cards with their operations chip. */
export function decorateCards(cards: readonly PlanningCard[], data: Allocation, workshops: Loaded<AllocationWorkshops>, words: Words): PlanningCard[] {
  if (workshops.status !== 'ready') return [...cards]
  return cards.map((card) => {
    const source = data.cards.find((entry) => entry.id === card.id)
    const mark = source ? operationsMark(workshops.value, source, words) : null
    return mark ? { ...card, marks: [...(card.marks ?? []), mark] } : card
  })
}

// ---- kit timing (design pop:kit-timing) ---------------------------------------------------------------------------------

export interface KitLine {
  label: string
  value: string
}

/** The popover's facts in our words: the start, transport, when the kit leaves, the days of work, when it is back. */
export function kitFacts(timing: KitTiming, timeZone: string, words: Words): KitLine[] {
  const { t, locale } = words
  return [
    { label: t('al.kit.start'), value: t(`al.kit.startFrom.${timing.startSource}`, { date: dayWords(timing.start, locale) }) },
    { label: t('al.kit.transport'), value: t(`al.kit.transportFrom.${timing.transportSource}`, { count: timing.transportDays, days: String(timing.transportDays) }) },
    { label: t('al.kit.ship'), value: t('al.kit.shipValue', { date: dayWords(timing.kitShipOn, locale), time: formatTime(timing.kitDueAt, { locale, timeZone }) }) },
    { label: t('al.kit.work'), value: t(`al.kit.workFrom.${timing.workDaysSource}`, { count: timing.workDays, days: String(timing.workDays) }) },
    { label: t('al.kit.back'), value: timing.closedDaysSkipped > 0 ? t('al.kit.backSkipped', { date: dayWords(timing.backOn, locale), count: timing.closedDaysSkipped, days: String(timing.closedDaysSkipped) }) : dayWords(timing.backOn, locale) },
  ]
}

/** The kit's ship-out sentence (the design's "Kit ship-out date = start − 2 transport days"). */
export function kitSentence(timing: KitTiming, words: Words): string {
  const { t, locale } = words
  const args = { date: dayWords(timing.kitShipOn, locale), start: dayWords(timing.start, locale), workshop: timing.workshop.name, count: timing.transportDays, days: String(timing.transportDays) }
  return timing.late ? t('al.kit.late', args) : t('al.kit.onTime', args)
}

/** A later operation the return date drives: "Op 40 Pack · can start Thu 10 Dec · latest Tue 8 Dec". */
export function laterWords(operation: KitTiming['laterOperations'][number], words: Words): string {
  const { t, locale } = words
  const base = t('al.kit.laterOp', { seq: String(operation.seq), operation: operation.name, date: dayWords(operation.earliestStart, locale) })
  if (operation.latestStart === null) return base
  return `${base} · ${t(operation.finishesLate ? 'al.kit.laterLate' : 'al.kit.laterOk', { date: dayWords(operation.latestStart, locale) })}`
}

/** A kit line's quantity in the page's language: "13.23 m", "14 pz" (the unit's words from the buying catalogue). */
export function quantityWords(line: KitTiming['kit']['lines'][number], uom: Translate, locale: Locale): string {
  const key = `uom.${line.uom}`
  const unit = uom(key)
  return `${number(line.quantity, locale, 3)} ${unit === key ? line.uom.toLowerCase() : unit}`
}

/** A kit timing that could not be read: a work order with nothing left to make outside says so; else the read's problem. */
export function kitProblemOf(error: unknown): ReadProblem | 'noWork' {
  if (isApiError(error) && error.kind === 'conflict' && /has no work left to send out/.test(error.message)) return 'noWork'
  return readProblemOf(error)
}

// ---- in-house or outside (design board#4) -----------------------------------------------------------------------------------

export type SwitchRefusal =
  | 'CHANGED'
  | 'HELD'
  | 'ALREADY_OUTSIDE'
  | 'ALREADY_IN_HOUSE'
  | 'NO_WORK_LEFT'
  | 'NOT_SWITCHABLE'
  | 'KIT_OUT'
  | 'ISSUED_WITH_OTHERS'
  | 'NEEDS_SUBCONTRACT'
  | 'FORBIDDEN'
  | 'PIECES'
  | 'ON_ORDERS'
  | 'LOCATION'
  | 'REASON'
  | 'NOT_FOUND'
  | 'OFFLINE'
  | 'FAILED'

const ON_ORDERS = /are on other subcontract orders already; at most (\d+) more/
const LOCATION = /stock location of this workshop|locations on the site|is archived\.$/

/**
 * A refused switch, by the API's kind, its issue paths (`refusal/<HOLD>`, `version`) and the shape of its sentence. The
 * order W2a's createOrder makes refuses garments already on other subcontract orders (`more`: how many may still go out)
 * and a workshop without one active stock location on the site.
 */
export function switchRefusalOf(error: unknown): { code: SwitchRefusal; holds: HoldReason[]; more?: number } {
  const none = (code: SwitchRefusal) => ({ code, holds: [] as HoldReason[] })
  if (!isApiError(error)) return none('FAILED')
  const holds = error.issues.flatMap((issue) => {
    const path = issuePath(issue)
    const code = path.startsWith('refusal/') ? path.slice('refusal/'.length) : null
    return code ? [{ code: code as HoldReason['code'], words: issue.message ?? '' }] : []
  })
  if (holds.length > 0) return { code: 'HELD', holds }
  if (error.kind === 'conflict') {
    if (error.issues.some((issue) => /(^|\/)version$/.test(issuePath(issue)))) return none('CHANGED')
    if (/is outside already/.test(error.message)) return none('ALREADY_OUTSIDE')
    if (/is done in-house already/.test(error.message)) return none('ALREADY_IN_HOUSE')
    if (/has no work left/.test(error.message)) return none('NO_WORK_LEFT')
    if (/its operations stay where they are/.test(error.message)) return none('NOT_SWITCHABLE')
    if (/are at the workshop: take them back/.test(error.message)) return none('KIT_OUT')
    if (/issued with other operations/.test(error.message)) return none('ISSUED_WITH_OTHERS')
    return none('CHANGED')
  }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return none(/purchasing\.subcontract\.manage/.test(error.message) ? 'NEEDS_SUBCONTRACT' : 'FORBIDDEN')
  if (error.kind === 'invalid') {
    const messages = [error.message, ...error.issues.map((issue) => issue.message ?? '')]
    const onOrders = messages.map((message) => ON_ORDERS.exec(message)).find((found) => found !== null)
    if (onOrders) return { code: 'ON_ORDERS', holds: [], more: Number(onOrders[1]) }
    if (messages.some((message) => LOCATION.test(message))) return none('LOCATION')
    return none(error.issues.some((issue) => /reason$/.test(issuePath(issue))) ? 'REASON' : 'PIECES')
  }
  if (error.kind === 'not_found') return none('NOT_FOUND')
  if (error.kind === 'unavailable' || error.code === 'network') return none('OFFLINE')
  return none('FAILED')
}

/** One full stop where a name that ends in one ("… S.p.A.") closes a sentence. */
export const oneStop = (text: string): string => text.replace(/\.\.(?=\s|$)/g, '.')

/** A refused switch in our words (a hold is said by holdWords). */
export function switchRefusalWords(refusal: { code: SwitchRefusal; more?: number }, words: Words): string {
  if (refusal.code === 'ON_ORDERS') return refusal.more ? words.t('al.op.refusal.ON_ORDERS', { count: refusal.more, more: String(refusal.more) }) : words.t('al.op.refusal.ON_ORDERS_NONE')
  return words.t(`al.op.refusal.${refusal.code}`)
}

/** The site's calendar day of an instant ("2026-11-12"), or null when it is not one. */
function siteDay(instant: string, timeZone: string): string | null {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/**
 * What became of the subcontract order when an operation went outside (the API's `orderWords`, said again). The kit day
 * is the order's own kit time (a kit already late is due today), else the timing's.
 */
export function outsideDoneWords(answer: OutsideAnswer, words: Words, timeZone = 'UTC'): string {
  const { t, locale } = words
  const head = t('al.op.sentOutside', { seq: String(answer.operation.seq), operation: answer.operation.name, workshop: answer.workshop.name })
  if (answer.order) {
    const kitDay = siteDay(answer.order.kitDueAt, timeZone) ?? answer.timing.kitShipOn
    return oneStop(`${head} ${t('al.op.orderMade', { order: answer.order.number, date: dayWords(kitDay, locale), back: dayWords(answer.timing.backOn, locale) })}`)
  }
  const why = answer.orderWords ?? ''
  const key = /purchasing\.subcontract\.manage/.test(why) ? 'al.op.noOrder.PERMISSION' : /once it is released/.test(why) ? 'al.op.noOrder.NOT_RELEASED' : 'al.op.noOrder.OTHER'
  return oneStop(`${head} ${t(key)}`)
}

/** Why the switch of one operation cannot be asked now (the dialog's held button), or null. */
export function switchHeld(input: { mayOutsource: boolean; offline: boolean; busy: boolean; mode: 'outside' | 'in-house'; partyId: string | null; offered: boolean; reason: string }, words: Words): string | null {
  const { t } = words
  if (!input.mayOutsource) return t('al.op.held.permission')
  if (input.offline) return t('al.op.held.offline')
  if (input.busy) return t('al.op.held.busy')
  if (input.mode === 'outside') {
    if (!input.partyId) return t('al.op.held.pick')
    if (!input.offered) return t('al.op.held.notOffered')
    return null
  }
  return input.reason.trim().length < 3 ? t('al.op.held.reason') : null
}

// ---- Create subcontract orders (n) (design page.h#1) ------------------------------------------------------------------

/** The board's workshop parts (a slot on a workshop's column). */
export const workshopParts = (data: Allocation): AllocationCard[] => data.cards.filter((card) => card.slot !== null && card.lane?.kind === 'WORKSHOP')

/**
 * The parts "Create subcontract orders (n)" offers: a workshop part whose work order's outside work is not all on an
 * order yet (as the check shows it). The preview tells the rest (garments on an order already, no work left).
 */
export function orderableParts(data: Allocation, workshops: AllocationWorkshops | null): AllocationCard[] {
  return workshopParts(data).filter((card) => {
    const operations = verdictsOf(workshops, card.workOrder.id)?.operations ?? []
    return operations.length === 0 || operations.some((operation) => !operation.outsourced || operation.subcontractOrderId === null)
  })
}

/** Why the header's primary is held, or null. */
export function createOrdersHeld(input: { data: Allocation | null; workshops: Loaded<AllocationWorkshops>; mayOutsource: boolean; mayOrder: boolean; offline: boolean }, words: Words): string | null {
  const { t } = words
  if (!input.data) return t('al.orders.held.reading')
  if (input.offline) return t('al.orders.held.offline')
  if (!input.mayOutsource) return t('al.orders.held.permission')
  if (!input.mayOrder) return t('al.orders.held.subcontract')
  if (workshopParts(input.data).length === 0) return t('al.orders.held.none')
  if (input.workshops.status !== 'ready') return t(input.workshops.status === 'loading' ? 'al.held.checking' : 'al.held.notChecked')
  if (orderableParts(input.data, input.workshops.value).length === 0) return t('al.orders.held.allOrdered')
  return null
}

/** The slots the request names (at most MAX_PARTS; the rest wait for the next one). */
export const slotsOf = (cards: readonly AllocationCard[]): string[] => cards.flatMap((card) => (card.slot ? [card.slot.id] : [])).slice(0, MAX_PARTS)

const PROBLEMS: ReadonlyArray<[RegExp, string]> = [
  [/^Not a part of a work order at a workshop/, 'NOT_A_PART'],
  [/on a subcontract order already/, 'ORDERED'],
  [/has no work left to send out/, 'NO_WORK'],
  [/needs purchasing\.subcontract\.manage/, 'PERMISSION'],
  [/its order is made once it is released/, 'NOT_RELEASED'],
]
const HOLD_SHAPES: ReadonlyArray<[RegExp, HoldReason['code']]> = [
  [/has no subcontractor role/, 'NOT_A_WORKSHOP'],
  [/ is not active\.$/, 'NOT_ACTIVE'],
  [/ as a supplier/, 'SUPPLIER_STATUS'],
  [/has no stock location at/, 'NO_LOCATION'],
  [/^Not approved for /, 'NOT_QUALIFIED'],
  [/DURC/, 'NO_VALID_DURC'],
]

/** One problem of a part (the API's English sentence) in our words. */
export function partProblemWords(problem: string, part: Pick<FromAllocationResult, 'workOrder' | 'workshop'>, workshops: AllocationWorkshops | null, site: string, words: Words): string {
  const { t } = words
  const own = PROBLEMS.find(([shape]) => shape.test(problem))?.[1]
  if (own) return t(`al.orders.problem.${own}`, { order: part.workOrder?.number ?? '—' })
  const hold = HOLD_SHAPES.find(([shape]) => shape.test(problem))?.[1]
  if (hold) {
    const workshop = part.workshop ? workshopOf(workshops, part.workshop.id) : null
    return holdWords({ code: hold, words: problem }, workshop ?? (part.workshop ? { name: part.workshop.name, durc: { checked: true, state: 'MISSING', expiresOn: null } } : null), site, words)
  }
  return t('al.orders.problem.OTHER')
}

/** A part's line in the review: where, what goes, now → next, and the note (its warnings). */
export function partChange(result: FromAllocationResult, card: AllocationCard | undefined, workshops: AllocationWorkshops | null, words: Words, today = '') {
  const { t, locale } = words
  const order = result.workOrder?.number ?? card?.workOrder.number ?? '—'
  const workshop = result.workshop?.name ?? '—'
  const what = result.operations.length > 0 ? t('al.orders.what', { operations: result.operations.map((operation) => t('al.orders.op', { seq: String(operation.seq), operation: operation.name })).join(', '), count: result.pieces, pieces: number(result.pieces, locale) }) : t('al.orders.whatNone')
  // A kit already late leaves today (the order's kit time is today 08:00): said so, not a day in the past.
  const next = result.kitShipOn && result.backOn ? t(today !== '' && result.kitShipOn < today ? 'al.orders.nextLate' : 'al.orders.next', { date: dayWords(result.kitShipOn, locale), back: dayWords(result.backOn, locale) }) : t('al.orders.nextPlain')
  const known = result.workshop ? workshopOf(workshops, result.workshop.id) : null
  const note = result.warnings.map((reason) => warningWords(reason, known ?? (result.workshop ? { name: result.workshop.name, durc: { checked: false, state: 'MISSING', expiresOn: null } } : null), words)).join(' ')
  return { where: t('al.orders.where', { order, workshop }), what, now: t('al.orders.now'), next, note: note || undefined }
}

/** The parts the preview leaves out, each with why. */
export function leftOutWords(preview: FromAllocation, workshops: AllocationWorkshops | null, site: string, words: Words): Array<{ id: string; label: string; why: string }> {
  return preview.results
    .filter((result) => !result.ok)
    .map((result) => ({
      id: result.slotId,
      label: words.t('al.orders.where', { order: result.workOrder?.number ?? '—', workshop: result.workshop?.name ?? '—' }),
      why: result.problems.map((problem) => partProblemWords(problem, result, workshops, site, words)).join(' '),
    }))
}

/** A made part's result words (the done screen): "SC-2026-0002 drafted · the kit leaves Thu 3 Dec" (the order's own kit day). */
export function madeWords(result: FromAllocationResult, workshops: AllocationWorkshops | null, site: string, words: Words, timeZone = 'UTC'): string {
  const { t, locale } = words
  if (result.ok && result.order) {
    const kitDay = siteDay(result.order.kitDueAt, timeZone) ?? result.kitShipOn
    return t('al.orders.made', { order: result.order.number, date: kitDay ? dayWords(kitDay, locale) : '—' })
  }
  return result.problems.map((problem) => partProblemWords(problem, result, workshops, site, words)).join(' ') || t('al.orders.problem.OTHER')
}

/** A refused request as a whole (not a part), in our words. */
export function ordersRefusalOf(error: unknown): string {
  if (!isApiError(error)) return 'al.orders.failed.FAILED'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'al.orders.failed.FORBIDDEN'
  if (error.kind === 'unavailable' || error.code === 'network') return 'al.orders.failed.OFFLINE'
  if (error.kind === 'not_found') return 'al.orders.failed.NOT_FOUND'
  return 'al.orders.failed.FAILED'
}

// ---- load words in garments ---------------------------------------------------------------------------------------------

const LOAD_KEYS = ['minutes', 'over', 'booked', 'sentence', 'sentenceOver', 'sentenceNone', 'sentenceClosed'] as const

/** The DS LoadBar's words for a capacity counted in garments (a workshop's PIECES line): the minutes words otherwise. */
export function pieceLoadWords(t: Translate): Readonly<Record<(typeof LOAD_KEYS)[number], string>> {
  return Object.fromEntries(LOAD_KEYS.map((key) => [key, t(`al.load.${key}`)])) as Record<(typeof LOAD_KEYS)[number], string>
}
