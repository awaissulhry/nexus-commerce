import { PROMISE_TILES, RISK_STATES } from '@nexus/factory-domain/planning/promise-keep/risk'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import { recordAddress } from '../../../lib/records/record-links'
import type { ListKey } from '../../../list-frame/model'
import { csvOf } from '../../_shared/buying/model'
import type { AskAnswer, Atp, AtpCell, AtpSize, AtpSource, Bridge, CalculateBody, PromiseLine, PromiseTile, Proposal, ProposeBody, RepromiseDraft, RiskState, SizeAnswer } from './api'

/**
 * Planning › Promise dates (SCR-109; design planning.promise, a workspace list), pure: the address (site, a tile, the risk,
 * the search, the style and weeks of Available to promise, the calculator, the re-promise of a line, a proposal from a task),
 * what a person may do (the planner proposes, sales gives the word; nobody decides their own proposal, the Owner included),
 * the lines' words (risk, slack, where the planned finish comes from, certificate cover, changes), the re-promise form and
 * its checks, the calculator's form and the bridge of its date in our words, Available to promise as rows and week cells,
 * refusals in words, the lines' CSV. No money; no person in a list (an office person only inside one line's history or proposal).
 */

export const NAMESPACE = 'planning-promise'

/** The saved-filter tiles in the design's order (At risk, Slipped this month, Re-promise waiting for sales, No valid certificate). */
export const TILE_ORDER: readonly PromiseTile[] = PROMISE_TILES
/** The horizons Available to promise offers (weeks); the API's own default is 12. */
export const ATP_WEEK_CHOICES = [8, 12, 26] as const
export const ATP_DEFAULT_WEEKS = 12

export interface PromiseControls {
  site: string | null
  /** A saved filter (`?tile=`). */
  tile: PromiseTile | null
  /** One risk state (`?risk=`). */
  risk: RiskState | null
  /** The lines' search: an order, a style or a customer. */
  q: string
  /** Available to promise: the style (`?style=`), the weeks (`?weeks=`), the week the size grid shows (`?week=`). */
  style: string | null
  weeks: number | null
  week: string | null
  /** The Promise calculator is open (`?calc=1`); from a quote (`?quote=<id>`, its "Suggest date"). */
  calc: boolean
  quote: string | null
  /** The re-promise of an order line (`?repromise=<order line id>`). */
  repromise: string | null
  /** A proposal opened from its task on the order (`?proposal=<id>`): the page reads it and opens its line. */
  proposal: string | null
}

export const isTile = (value: string | null | undefined): value is PromiseTile => (PROMISE_TILES as readonly string[]).includes(value ?? '')
export const isRisk = (value: string | null | undefined): value is RiskState => (RISK_STATES as readonly string[]).includes(value ?? '')

export function controlsOf(params: { get(name: string): string | null } | null | undefined): PromiseControls {
  const get = (name: string) => params?.get(name) ?? null
  const tile = get('tile')
  const risk = get('risk')
  const weeks = Number(get('weeks'))
  return {
    site: get('site'),
    tile: isTile(tile) ? tile : null,
    risk: isRisk(risk) ? risk : null,
    q: get('q') ?? '',
    style: get('style'),
    weeks: Number.isInteger(weeks) && weeks >= 1 && weeks <= 52 ? weeks : null,
    week: get('week'),
    calc: get('calc') === '1',
    quote: get('quote'),
    repromise: get('repromise'),
    proposal: get('proposal'),
  }
}

export function queryOf(controls: PromiseControls): string {
  const query = new URLSearchParams()
  if (controls.site) query.set('site', controls.site)
  if (controls.tile) query.set('tile', controls.tile)
  if (controls.risk) query.set('risk', controls.risk)
  if (controls.q.trim()) query.set('q', controls.q.trim())
  if (controls.style) query.set('style', controls.style)
  if (controls.weeks) query.set('weeks', String(controls.weeks))
  if (controls.week) query.set('week', controls.week)
  if (controls.calc) query.set('calc', '1')
  if (controls.quote) query.set('quote', controls.quote)
  if (controls.repromise) query.set('repromise', controls.repromise)
  if (controls.proposal) query.set('proposal', controls.proposal)
  return query.toString()
}

// ---- what a person may do ------------------------------------------------------------------------------------------------

export interface PromiseCan {
  /** planning.promise.view: the page (planner, production manager, sales, read-only, the owner). */
  view: boolean
  /** planning.promise.manage: propose a re-promise, take it back (planner, production manager, the owner). */
  manage: boolean
  /** orders.manage: give sales' word on a re-promise (accept or decline). */
  decide: boolean
  /** email.send: tell the customer when accepting. */
  tell: boolean
  /** planning.view: the planning sites list (else the person's own sites). */
  planning: boolean
  /** product.styles.view: the calculator's style list. */
  styles: boolean
}

export function promiseCan(permissions: readonly string[]): PromiseCan {
  const has = (name: string) => permissions.includes(name)
  return { view: has('planning.promise.view'), manage: has('planning.promise.manage'), decide: has('orders.manage'), tell: has('email.send'), planning: has('planning.view'), styles: has('product.styles.view') }
}

/** The row verb of a line: Re-promise (the planner), or Review (a proposal waits: anyone who sees the page reads it; its buttons say who decides). */
export function rowVerbOf(line: Pick<PromiseLine, 'waiting' | 'may'>, can: Pick<PromiseCan, 'manage'>): { label: 'row.repromise' | 'row.review'; held: string | null } {
  if (line.waiting) return { label: 'row.review', held: null }
  if (!can.manage) return { label: 'row.repromise', held: 'held.noManage' }
  if (!line.may.repromise) return { label: 'row.repromise', held: 'held.mayNot' }
  return { label: 'row.repromise', held: null }
}

export type DecisionHold = string | null

/**
 * Sales' word on a waiting proposal, held with the reason in words: nobody decides their own proposal (the Owner included),
 * accepting and declining are sales' (orders.manage), telling the customer needs the right to send mail, taking it back is
 * only the proposer's.
 */
export function decisionHolds(proposal: Pick<Proposal, 'state' | 'proposedBy' | 'may' | 'recipients'>, can: Pick<PromiseCan, 'decide' | 'tell' | 'manage'>, me: string): { accept: DecisionHold; decline: DecisionHold; tell: DecisionHold; withdraw: DecisionHold } {
  const waiting = proposal.state === 'WAITING'
  const own = proposal.proposedBy?.id === me
  const notWaiting = waiting ? null : 'held.notWaiting'
  const accept = notWaiting ?? (own ? 'held.ownProposal' : !can.decide ? 'held.noDecide' : !proposal.may.accept ? 'held.mayNotDecide' : null)
  const decline = notWaiting ?? (own ? 'held.ownProposal' : !can.decide ? 'held.noDecide' : !proposal.may.decline ? 'held.mayNotDecide' : null)
  const tell = accept ?? (!can.tell ? 'held.noTell' : proposal.recipients.length === 0 ? 'held.noRecipient' : !proposal.may.tell ? 'held.noTell' : null)
  const withdraw = notWaiting ?? (!own ? 'held.notProposer' : !can.manage || !proposal.may.withdraw ? 'held.noManage' : null)
  return { accept, decline, tell, withdraw }
}

// ---- words -----------------------------------------------------------------------------------------------------------------

export interface Words {
  readonly t: Translate
  readonly locale: Locale
}

/** A day as "4 Dec" (with the year: "4 Dec 2026"). */
export function dayWords(day: string | null | undefined, locale: Locale, withYear = false): string {
  if (!day) return '—'
  const [year, month, date] = day.slice(0, 10).split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).format(new Date(Date.UTC(year, month - 1, date)))
}

export const riskTone = (risk: RiskState | null): 'danger' | 'warning' | 'neutral' | 'success' => (risk === 'LATE' ? 'danger' : risk === 'AT_RISK' ? 'warning' : risk === 'ON_TIME' ? 'success' : 'neutral')
export const riskKey = (risk: RiskState | null): string => (risk ? `risk.${risk}` : 'risk.none')

/** Days to spare (+) or short (−) in words. */
export function slackWords(slack: number | null, t: Translate): string {
  if (slack === null) return '—'
  if (slack > 0) return t('slack.spare', { count: slack })
  if (slack === 0) return t('slack.none')
  return t('slack.short', { count: -slack })
}

/** The slack as the column shows it: "+4 days", "−22 days", "0 days" (the full words in its tooltip). */
export function slackShort(slack: number | null, t: Translate): string {
  if (slack === null) return '—'
  return t('slack.signed', { count: Math.abs(slack), sign: slack > 0 ? '+' : slack < 0 ? '−' : '' })
}

/** The certificate cover through the promised day: "Valid until 31 Mar 2027", "Missing", "Not needed", "—". */
export function certificateWords(cover: PromiseLine['certificate'], words: Words): string {
  const { t, locale } = words
  if (!cover) return '—'
  if (cover.state === 'MISSING') return t('cert.MISSING')
  if (cover.state === 'NOT_NEEDED') return t('cert.NOT_NEEDED')
  if (!cover.validTo) return t(`cert.${cover.state}`)
  return t(cover.state === 'EXPIRING' ? 'cert.endsOn' : 'cert.validUntil', { day: dayWords(cover.validTo, locale, true) })
}

export const certificateTone = (cover: PromiseLine['certificate']): 'danger' | 'warning' | 'success' | 'neutral' => (!cover ? 'neutral' : cover.state === 'MISSING' ? 'danger' : cover.state === 'EXPIRING' ? 'warning' : cover.state === 'OK' ? 'success' : 'neutral')

/** "48–56" (the open sizes), "One made-to-measure unit". */
export function sizesWords(line: Pick<PromiseLine, 'sizes' | 'kind'>, t: Translate): string {
  if (line.kind === 'MADE_TO_MEASURE' || line.sizes.every((size) => size.size === null)) return t('line.mtm')
  const open = line.sizes.filter((size) => size.open > 0 && size.size !== null).map((size) => size.size!)
  const shown = open.length > 0 ? open : line.sizes.flatMap((size) => (size.size ? [size.size] : []))
  return rangeOf(shown)
}

/** Sizes as a run: "48–52" when more than two, else listed. */
export const rangeOf = (sizes: readonly string[]): string => (sizes.length > 2 ? `${sizes[0]}–${sizes[sizes.length - 1]}` : sizes.join(', '))

export const openPieces = (line: Pick<PromiseLine, 'sizes'>): number => line.sizes.reduce((sum, size) => sum + size.open, 0)

export function changesWords(changes: PromiseLine['changes'], t: Translate): string {
  if (changes.count === 0) return t('changes.none')
  return changes.slips > 0 ? `${t('changes.count', { count: changes.count })} · ${t('changes.slips', { count: changes.slips })}` : t('changes.count', { count: changes.count })
}

/** A size as said on screen: "Size 52", "Every size", "The made-to-measure unit". */
export const sizeName = (size: string | null, t: Translate, madeToMeasure = false): string => (size === null ? t(madeToMeasure ? 'size.unit' : 'size.every') : t('size.one', { size }))

/** Where an order record opens (record-links: a real link, so ⌘-click is the design's new tab). */
export const orderHref = (prefix: string, built: ReadonlySet<string>, order: { id: string; number: string }): string => `${prefix}${recordAddress({ type: 'SalesOrder', id: order.id, label: order.number }, built)}`

/** The page's own keys first (p, h, Enter), then the list frame's (the footer's info icon and the keys panel). */
export const OWN_KEYS = (t: (key: string) => string): ListKey[] => [
  { keys: ['p'], does: t('keys.repromise') },
  { keys: ['h'], does: t('keys.history') },
  { keys: ['Enter'], does: t('keys.order') },
]

// ---- the re-promise form -----------------------------------------------------------------------------------------------------

export const sizeKey = (size: string | null): string => size ?? '*'

export interface RepromiseForm {
  /** The new date per size key (empty: this size keeps its promise). */
  dates: Readonly<Record<string, string>>
  reasonCode: string
  /** The office's note (never shown to the customer). */
  note: string
  /** Other words to the customer than the composed ones. */
  own: boolean
  subject: string
  body: string
}

/** The form as the plan proposes it: each size the plan moves at its day, the reason the plan suggests, the composed message. */
export function formOf(draft: RepromiseDraft): RepromiseForm {
  const dates: Record<string, string> = {}
  for (const entry of draft.proposed) dates[sizeKey(entry.size)] = entry.to
  return { dates, reasonCode: draft.reasonCode ?? '', note: '', own: false, subject: draft.message?.subject ?? '', body: draft.message?.body ?? '' }
}

/** The sizes the form moves, from their promise now to the new day (only the sizes with a day different from now). */
export function movedSizes(draft: Pick<RepromiseDraft, 'plan'>, form: Pick<RepromiseForm, 'dates'>): { size: string | null; from: string | null; to: string }[] {
  return draft.plan.flatMap((row) => {
    const to = form.dates[sizeKey(row.size)]
    return to && to !== row.current ? [{ size: row.size, from: row.current, to }] : []
  })
}

export interface FormProblems {
  sizes: Readonly<Record<string, string>>
  reason: string | null
  message: string | null
  /** Nothing would change. */
  nothing: boolean
}

/** Every problem of the form at once, as the API would say it (each a key of this catalogue). */
export function formProblems(draft: Pick<RepromiseDraft, 'plan' | 'today'>, form: RepromiseForm): FormProblems {
  const sizes: Record<string, string> = {}
  for (const row of draft.plan) {
    const to = form.dates[sizeKey(row.size)]
    if (!to) continue
    if (row.current === null) sizes[sizeKey(row.size)] = 'problem.noPromise'
    else if (to < draft.today) sizes[sizeKey(row.size)] = 'problem.past'
    else if (row.state === 'NOT_CERTIFIED') sizes[sizeKey(row.size)] = 'problem.notCertified'
  }
  const moved = movedSizes(draft, form)
  const message = form.own && (!form.subject.trim() || !form.body.trim()) ? 'problem.message' : form.own && (form.subject.trim().length > 200 || form.body.trim().length > 10_000) ? 'problem.messageLong' : null
  return { sizes, reason: form.reasonCode ? null : 'problem.reason', message, nothing: moved.length === 0 }
}

export const formHeld = (problems: FormProblems): string | null =>
  problems.nothing ? 'held.nothingMoved' : Object.keys(problems.sizes).length > 0 ? 'held.sizeProblem' : problems.reason ? 'held.noReason' : problems.message ? 'held.message' : null

/** The body of "Send to sales for acceptance": the moved sizes (a made-to-measure unit: no size), the reason, the note, own words only when written. */
export function proposeBodyOf(draft: Pick<RepromiseDraft, 'plan'>, form: RepromiseForm): ProposeBody {
  const sizes = movedSizes(draft, form).map((entry) => (entry.size === null ? { date: entry.to } : { size: entry.size, date: entry.to }))
  return {
    sizes,
    reasonCode: form.reasonCode,
    ...(form.note.trim() ? { reason: form.note.trim() } : {}),
    ...(form.own ? { message: { subject: form.subject.trim(), body: form.body.trim() } } : {}),
  }
}

/** The plan's proposal differs from the form: the composed words will name the days and the reason sent (said under the preview). */
export function previewStale(draft: Pick<RepromiseDraft, 'proposed' | 'reasonCode'>, form: RepromiseForm, moved: readonly { size: string | null; to: string }[]): boolean {
  if (form.reasonCode !== (draft.reasonCode ?? '')) return true
  if (moved.length !== draft.proposed.length) return true
  return moved.some((entry) => !draft.proposed.some((plan) => plan.size === entry.size && plan.to === entry.to))
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------

const KNOWN_REFUSALS = ['WAITING_EXISTS', 'NOT_WAITING', 'OWN_PROPOSAL', 'NOT_PROPOSER', 'STALE', 'NO_RECIPIENT'] as const

/** A refused write in words (a key of this catalogue), with the sizes and fields the API named (`body/sizes/<i>/…`). */
export function refusalOf(error: unknown): { key: string; sizes: number[]; fields: string[] } {
  if (!isApiError(error)) return { key: 'refusal.failed', sizes: [], fields: [] }
  const paths = error.issues.map(issuePath)
  const sizes = [...new Set(paths.flatMap((path) => /sizes[/.](\d+)/.exec(path)?.[1] ?? []).map(Number))]
  const fields = paths.map((path) => path.replace(/^body[/.]/, ''))
  if (error.kind === 'conflict') {
    const code = KNOWN_REFUSALS.find((name) => paths.includes(`refusal/${name}`))
    if (code) return { key: `refusal.${code}`, sizes, fields }
    if (paths.includes('orderLineId')) return { key: 'refusal.WAITING_EXISTS', sizes, fields }
    if (paths.includes('body/to')) return { key: 'refusal.NO_RECIPIENT', sizes, fields }
    if (sizes.length > 0) return { key: 'refusal.CERTIFICATE', sizes, fields }
    return { key: 'refusal.changed', sizes, fields }
  }
  if (error.kind === 'invalid') return { key: fields.includes('reason') ? 'refusal.declineReason' : fields.includes('reasonCode') ? 'refusal.reason' : sizes.length > 0 ? 'refusal.sizes' : 'refusal.invalid', sizes, fields }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'refusal.forbidden', sizes, fields }
  if (error.kind === 'not_found') return { key: 'refusal.gone', sizes, fields }
  if (error.kind === 'unavailable') return { key: 'refusal.offline', sizes, fields }
  return { key: 'refusal.failed', sizes, fields }
}

/** A failed read in words. */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'error.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'error.forbidden'
  if (error.kind === 'unavailable') return 'error.offline'
  if (error.kind === 'not_found') return 'error.gone'
  if (error.kind === 'invalid') return 'error.invalid'
  return 'error.failed'
}

// ---- the Promise calculator --------------------------------------------------------------------------------------------------

export interface CalcForm {
  styleId: string
  colourwayId: string
  /** Pieces per size (a size left out or 0: not asked). */
  quantities: Readonly<Record<string, number>>
  wanted: string
  /** Where the goods go (ISO country code; empty: none named). */
  country: string
}

export const EMPTY_CALC: CalcForm = Object.freeze({ styleId: '', colourwayId: '', quantities: {}, wanted: '', country: '' })

export function calcHeld(form: CalcForm, siteId: string | null): string | null {
  if (!siteId) return 'held.noSite'
  if (!form.styleId) return 'calc.held.style'
  if (!form.colourwayId) return 'calc.held.colour'
  if (!Object.values(form.quantities).some((quantity) => quantity > 0)) return 'calc.held.quantity'
  if (form.country.trim() && !/^[A-Za-z]{2,3}$/.test(form.country.trim())) return 'calc.held.country'
  return null
}

export function calcBodyOf(form: CalcForm, siteId: string, sizeOrder: readonly string[]): CalculateBody {
  const sizes = sizeOrder.flatMap((size) => (form.quantities[size] ?? 0) > 0 ? [{ size, quantity: Math.trunc(form.quantities[size]!) }] : [])
  return { siteId, styleId: form.styleId, colourwayId: form.colourwayId, sizes, ...(form.wanted ? { wantedDate: form.wanted } : {}), ...(form.country.trim() ? { country: form.country.trim().toUpperCase() } : {}) }
}

const SOURCE_WORD: Readonly<Record<string, string>> = { STOCK: 'bridge.source.STOCK', PURCHASE_ORDER: 'bridge.source.PURCHASE_ORDER', FIRM: 'bridge.source.FIRM', BUY: 'bridge.source.BUY', MAKE: 'bridge.source.MAKE' }

/**
 * The bridge of a date in our words: "base lead time 15 days + queue at today's load 6 days + Nappa BLK to buy 14 days = 35
 * days → 4 Dec" (the material part named by what sets it).
 */
export function bridgeWords(bridge: Bridge | null, setBy: { label: string; source: string } | null | undefined, words: Words): string | null {
  if (!bridge) return null
  const { t, locale } = words
  const material = setBy ? t('bridge.material', { what: setBy.label, how: t(SOURCE_WORD[setBy.source] ?? 'bridge.source.other'), count: bridge.materialDays }) : t('bridge.materialPlain', { count: bridge.materialDays })
  return t('bridge.sum', { base: t('bridge.base', { count: bridge.baseDays }), queue: t('bridge.queue', { count: bridge.queueDays }), material, total: t('bridge.days', { count: bridge.spanDays }), day: dayWords(bridge.finish, locale) })
}

/** The material part that sets an answer's bridge: the latest size's own arrival. */
export function bridgeSetter(answer: Pick<AskAnswer, 'sizes' | 'bridge'>): { label: string; source: string } | null {
  const bridge = answer.bridge
  if (!bridge) return null
  const size = answer.sizes.find((entry) => entry.material?.date === bridge.materialDate && entry.material.setBy) ?? answer.sizes.find((entry) => entry.material?.setBy)
  return size?.material?.setBy ? { label: size.material.setBy.label, source: size.material.setBy.source } : null
}

/** "48–52 4 Dec, 54 11 Dec, 56 not promised". */
export function groupsWords(groups: AskAnswer['groups'], words: Words): string {
  const { t, locale } = words
  // A group is a run of sizes in the scale's order with one day (factory-domain sizeGroupsOf): "48–52".
  const run = (sizes: readonly string[]) => (sizes.length === 1 ? sizes[0]! : `${sizes[0]}–${sizes[sizes.length - 1]}`)
  return groups.map((group) => t('calc.group', { sizes: run(group.sizes), day: group.date ? dayWords(group.date, locale) : t('calc.notPromised') })).join(', ')
}

export const sizeStateKey = (state: SizeAnswer['state']): string => `state.${state}`

/** A warning code in words (a code this screen does not know: "Something in the plan needs a look", never the code). */
const KNOWN_WARNINGS = ['NO_RELEASED_BOM', 'REVISION_NOT_RELEASED', 'NO_ROUTING', 'NO_LEAD_TIME', 'NO_MAKE_LEAD_TIME', 'PURCHASE_OVERDUE', 'NO_LANE', 'NO_CAPACITY', 'BEYOND_HORIZON', 'HELD_AT_SHIPMENT'] as const
export const warningKey = (code: string): string => ((KNOWN_WARNINGS as readonly string[]).includes(code) ? `warning.${code}` : 'warning.other')

/** A size's certificate on its day in words. */
export function sizeCertificateWords(size: Pick<SizeAnswer, 'certificate' | 'state'>, words: Words): string {
  const { t, locale } = words
  const cert = size.certificate
  if (size.state === 'NOT_CERTIFIED') return cert?.certificate ? t('calc.cert.refusedBy', { certificate: cert.certificate }) : t('calc.cert.refused')
  if (!cert) return '—'
  if (cert.state === 'NOT_NEEDED') return t('cert.NOT_NEEDED')
  if (cert.state === 'MISSING') return t('cert.MISSING')
  const base = cert.validTo ? t(cert.state === 'EXPIRING' ? 'cert.endsOn' : 'cert.validUntil', { day: dayWords(cert.validTo, locale, true) }) : t(`cert.${cert.state}`)
  return cert.heldAtShipment ? `${base} · ${t('calc.cert.held')}` : base
}

// ---- available to promise ----------------------------------------------------------------------------------------------------

export interface AtpRow {
  /** The colourway's id, or `<colourway id>|<size>`. */
  readonly key: string
  readonly kind: 'colour' | 'size'
  readonly colourway: Atp['colourways'][number]['colourway']
  readonly size: string | null
  readonly line: Pick<AtpSize, 'onHand' | 'availableNow' | 'later' | 'cells'>
  readonly size$: AtpSize | null
}

/** The grid's rows: each colourway's total, then its sizes in the style's order. */
export function atpRows(atp: Atp): AtpRow[] {
  const order = new Map(atp.style.sizes.map((size, index) => [size, index]))
  return atp.colourways.flatMap((entry) => [
    { key: entry.colourway.id, kind: 'colour' as const, colourway: entry.colourway, size: null, line: entry, size$: null },
    ...[...entry.sizes]
      .sort((a, b) => (order.get(a.size) ?? 999) - (order.get(b.size) ?? 999))
      .map((size) => ({ key: `${entry.colourway.id}|${size.size}`, kind: 'size' as const, colourway: entry.colourway, size: size.size, line: size, size$: size })),
  ])
}

/** A week's head: "Wk 47" (its days in the head's tooltip). */
export function weekLabel(key: string, t: Translate): string {
  const week = /W(\d+)$/.exec(key)?.[1]
  return week ? t('atp.week', { week: Number(week) }) : key
}

/** The sources that land in a week (the first week also takes what is past due or has no day). */
export function sourcesInWeek(sources: readonly AtpSource[], cell: Pick<AtpCell, 'from' | 'to'>, first: boolean): AtpSource[] {
  return sources.filter((source) => (source.date === null ? first : source.date <= cell.to && (first || source.date >= cell.from)))
}

/** The week the size grid shows: the one asked for, else this week. */
export const weekShown = (atp: Pick<Atp, 'weeks'>, asked: string | null): string | null => (asked && atp.weeks.some((week) => week.key === asked) ? asked : (atp.weeks[0]?.key ?? null))

/** The size grid of one week: colourways × sizes, the available pieces. */
export function sizeGridOf(atp: Atp, week: string): { colours: { key: string; label: string; offered: string[] }[]; sizes: { key: string; label: string }[]; value: Record<string, Record<string, number>> } {
  const value: Record<string, Record<string, number>> = {}
  const colours = atp.colourways.map((entry) => {
    value[entry.colourway.id] = Object.fromEntries(entry.sizes.map((size) => [size.size, Math.max(0, size.cells.find((cell) => cell.key === week)?.available ?? 0)]))
    return { key: entry.colourway.id, label: entry.colourway.name, offered: entry.sizes.map((size) => size.size) }
  })
  return { colours, sizes: atp.style.sizes.map((size) => ({ key: size, label: size })), value }
}

/** Ticked sizes of one colourway → the calculator's form (the pieces still to promise this week, at least 1). */
export function calcFromAtp(rows: readonly AtpRow[], styleId: string): CalcForm | null {
  const sizes = rows.filter((row) => row.kind === 'size')
  const colourway = sizes[0]?.colourway.id
  if (!colourway || sizes.some((row) => row.colourway.id !== colourway)) return null
  return { ...EMPTY_CALC, styleId, colourwayId: colourway, quantities: Object.fromEntries(sizes.map((row) => [row.size!, 1])) }
}

// ---- the lines' file -----------------------------------------------------------------------------------------------------

export function csvOfLines(lines: readonly PromiseLine[], words: Words): string {
  const { t, locale } = words
  const day = (value: string | null) => (value ? dayWords(value, locale, true) : '')
  return csvOf(
    [t('csv.customer'), t('csv.order'), t('csv.line'), t('csv.style'), t('csv.colour'), t('csv.sizes'), t('csv.open'), t('csv.first'), t('csv.current'), t('csv.finish'), t('csv.finishFrom'), t('csv.slack'), t('csv.risk'), t('csv.certificate'), t('csv.changes'), t('csv.slips')],
    lines.map((line) => [
      line.customer.name,
      line.order.number,
      line.seq,
      `${line.style.code} ${line.style.name}`,
      line.colourway.name,
      sizesWords(line, t),
      openPieces(line),
      day(line.first),
      day(line.current),
      day(line.finish),
      t(`finish.${line.finishSource}`),
      line.slackDays ?? '',
      t(riskKey(line.risk)),
      certificateWords(line.certificate, words),
      line.changes.count,
      line.changes.slips,
    ]),
  )
}
