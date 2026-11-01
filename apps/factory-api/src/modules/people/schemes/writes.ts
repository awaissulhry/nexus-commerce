import { newId } from '@nexus/factory-domain/core/ids'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { INCENTIVE_SCHEME_CHANGES } from '@nexus/factory-domain/people/events'
import { PEOPLE_PIECERATES_MANAGE } from '@nexus/factory-domain/people/piecerates/permissions'
import {
  activationPlan,
  affectedPeriods,
  deleteRefusal,
  editRefusal,
  endRefusal,
  firstDayProblems,
  periodsInWords,
  reasonProblems,
  termsOf,
  type GuaranteedBasis,
  type IncentiveKind,
  type OwnFaultPay,
  type PaidTimeRate,
  type SchemeRow,
  type SchemeStatus,
  type SchemeTerms,
  type TeamSplit,
  type Terms,
} from '@nexus/factory-domain/people/schemes/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { payGuarded, refuseProblems, refuseScheme } from './access'
import type { SchemeDetail } from './contract'
import { dateOf, day, neighboursOf, ownerOf, periodsOf, SCHEME_SELECT, schemeDetailOf, schemeOf, schemeRowOf, switchesNaming, todayOf, type SchemeRecord } from './store'

/**
 * The writes of incentive schemes (B-W2b-38; MES-253, MES-257, MES-258, MES-259; design people.piecerates "Scheme" with its
 * EditModeBar). Each is ONE command with its audit rows and its event, under people.piecerates.manage on the scheme's
 * company (and every site of it for a company's scheme; the line's site for a line's); a guaranteed rate in a body needs
 * the pay grain (the grain filter refuses it otherwise). The rules are factory-domain people/schemes/rules (the database
 * holds the shapes again):
 *
 *   draft     a DRAFT for the company or one of its lines, from a first day today or later; changed freely while a
 *             DRAFT (a column another kind uses is cleared); deleted while no site's piece-pay switch names it
 *   start     DRAFT → ACTIVE with its guaranteed pay given (the labour consultant's answer), its first day today or later
 *             and in no LOCKED pay period; the open scheme of the same company and line before it ends the day before
 *             and is RETIRED in the same command (under the company's scheme lock, which the guard takes too)
 *   end       an ACTIVE scheme no later one follows: its last day (today or later, set once) with why, RETIRED; refused
 *             while piece pay is ON at a site with it
 * Every answer says which pay periods the scheme's days touch (OPEN accrues, PREVIEW / REVIEW run again, LOCKED never).
 */

type SchemeChange = (typeof INCENTIVE_SCHEME_CHANGES)[number]

/** The company's scheme lock: starting or ending a scheme (the guard's overlap check takes the same lock). */
const lockSchemes = (tools: CommandTools, tenantId: string, companyId: string) => tools.tx.$executeRaw`SELECT "factory_pay_lock"('factory.pay.scheme', ${tenantId}::uuid, ${companyId}::uuid)`

const termsAudit = (terms: Terms | SchemeRow) => ({
  name: terms.name,
  kind: terms.kind,
  efficiencyThresholdPct: terms.efficiencyThresholdPct,
  guaranteedBasis: terms.guaranteedBasis,
  guaranteedHourlyRate: terms.guaranteedHourlyRate === null ? null : markMoney('pay', terms.guaranteedHourlyRate),
  traineeHourlyRate: terms.traineeHourlyRate === null ? null : markMoney('pay', terms.traineeHourlyRate),
  teamSplit: terms.teamSplit,
  reworkOwnFault: terms.reworkOwnFault,
  scrapOwnFault: terms.scrapOwnFault,
  ownFaultRatePct: terms.ownFaultRatePct,
  othersFaultPay: terms.othersFaultPay,
  waitingPay: terms.waitingPay,
  payOnlyWhileClockedIn: terms.payOnlyWhileClockedIn,
  currency: terms.currency,
  validFrom: terms.validFrom,
})

const termsData = (terms: Terms) => ({
  name: terms.name,
  kind: terms.kind,
  efficiencyThresholdPct: terms.efficiencyThresholdPct,
  guaranteedBasis: terms.guaranteedBasis,
  guaranteedHourlyRate: terms.guaranteedHourlyRate,
  traineeHourlyRate: terms.traineeHourlyRate,
  teamSplit: terms.teamSplit,
  reworkOwnFault: terms.reworkOwnFault,
  scrapOwnFault: terms.scrapOwnFault,
  ownFaultRatePct: terms.ownFaultRatePct,
  othersFaultPay: terms.othersFaultPay,
  waitingPay: terms.waitingPay,
  payOnlyWhileClockedIn: terms.payOnlyWhileClockedIn,
  currency: terms.currency,
  validFrom: dateOf(terms.validFrom),
  note: terms.note,
})

function emitScheme(tools: CommandTools, row: { id: string; companyId: string; siteId: string | null; lineId: string | null }, change: SchemeChange, status: SchemeStatus): void {
  tools.emit({ type: 'incentive_scheme.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { schemeId: row.id, companyId: row.companyId, lineId: row.lineId, change, status } })
}

/** What a body may set of a scheme's terms (all optional on an edit). */
export interface TermsBody {
  readonly name?: string | undefined
  readonly kind?: IncentiveKind | undefined
  readonly efficiencyThresholdPct?: string | null | undefined
  readonly guaranteedBasis?: GuaranteedBasis | undefined
  readonly guaranteedHourlyRate?: string | null | undefined
  readonly traineeHourlyRate?: string | null | undefined
  readonly teamSplit?: TeamSplit | null | undefined
  readonly reworkOwnFault?: OwnFaultPay | undefined
  readonly scrapOwnFault?: OwnFaultPay | undefined
  readonly ownFaultRatePct?: string | null | undefined
  readonly othersFaultPay?: PaidTimeRate | undefined
  readonly waitingPay?: PaidTimeRate | undefined
  readonly payOnlyWhileClockedIn?: boolean | undefined
  readonly currency?: string | undefined
  readonly validFrom?: string | undefined
  readonly note?: string | null | undefined
}

export interface CreateSchemeBody extends TermsBody {
  readonly companyId: string
  readonly lineId?: string | null | undefined
  readonly name: string
  readonly kind: IncentiveKind
  readonly validFrom: string
}

/** "New scheme": a DRAFT of the company or of one of its lines. */
export async function createScheme(caller: CommandCaller, body: CreateSchemeBody, idempotencyKey?: string): Promise<SchemeDetail & { replayed: boolean }> {
  const owner = await ownerOf(caller, body.companyId, body.lineId ?? null, PEOPLE_PIECERATES_MANAGE)
  const { terms, problems } = termsOf(body as SchemeTerms)
  refuseProblems([...problems, ...firstDayProblems(body.validFrom, todayOf(serverClock.now()))], 'This scheme cannot be drafted yet.')
  const { result, replayed } = await command(caller, { name: 'people.createIncentiveScheme', idempotencyKey, input: body }, async (tools) => {
    const id = newId()
    await payGuarded(() =>
      tools.tx.incentiveScheme.create({ data: { id, companyId: owner.companyId, siteId: owner.siteId, lineId: owner.lineId, ...termsData(terms!), createdById: owner.context.actorId }, select: { id: true } }),
    )
    tools.audit({ action: 'people.createIncentiveScheme', recordType: 'IncentiveScheme', recordId: id, companyId: owner.companyId, siteId: owner.siteId, after: { ...termsAudit(terms!), lineId: owner.lineId, status: 'DRAFT' } })
    emitScheme(tools, { id, companyId: owner.companyId, siteId: owner.siteId, lineId: owner.lineId }, 'CREATED', 'DRAFT')
    return schemeDetailOf(tools.tx, owner.context, id, tools.now)
  })
  return { ...result, replayed }
}

/** The terms of a DRAFT with a body's changes over them. */
function mergedTerms(current: SchemeRow & { note: string | null }, body: TermsBody): SchemeTerms {
  const pick = <K extends keyof TermsBody>(key: K, fallback: NonNullable<TermsBody[K]> | null): TermsBody[K] | null => (body[key] !== undefined ? body[key] : fallback)
  return {
    name: body.name ?? current.name,
    kind: body.kind ?? current.kind,
    efficiencyThresholdPct: pick('efficiencyThresholdPct', current.efficiencyThresholdPct),
    guaranteedBasis: body.guaranteedBasis ?? current.guaranteedBasis,
    guaranteedHourlyRate: pick('guaranteedHourlyRate', current.guaranteedHourlyRate),
    traineeHourlyRate: pick('traineeHourlyRate', current.traineeHourlyRate),
    teamSplit: pick('teamSplit', current.teamSplit),
    reworkOwnFault: body.reworkOwnFault ?? current.reworkOwnFault,
    scrapOwnFault: body.scrapOwnFault ?? current.scrapOwnFault,
    ownFaultRatePct: pick('ownFaultRatePct', current.ownFaultRatePct),
    othersFaultPay: body.othersFaultPay ?? current.othersFaultPay,
    waitingPay: body.waitingPay ?? current.waitingPay,
    payOnlyWhileClockedIn: body.payOnlyWhileClockedIn ?? current.payOnlyWhileClockedIn,
    currency: body.currency ?? current.currency,
    validFrom: body.validFrom ?? current.validFrom,
    note: pick('note', current.note),
  }
}

/** The EditModeBar's save on a DRAFT: the changed terms, checked whole. */
export async function updateScheme(caller: CommandCaller, schemeId: string, body: TermsBody & { readonly version: number }, idempotencyKey?: string): Promise<SchemeDetail> {
  const { context, scheme } = await schemeOf(caller, schemeId, PEOPLE_PIECERATES_MANAGE)
  refuseScheme(editRefusal(schemeRowOf(scheme)))
  const { terms, problems } = termsOf(mergedTerms({ ...schemeRowOf(scheme), note: scheme.note }, body))
  refuseProblems([...problems, ...(body.validFrom !== undefined ? firstDayProblems(body.validFrom, todayOf(serverClock.now())) : [])], 'This scheme cannot change this way.')
  const { result } = await command(caller, { name: 'people.updateIncentiveScheme', idempotencyKey, input: body, record: { type: 'IncentiveScheme', id: scheme.id, expectedVersion: body.version } }, async (tools) => {
    const before = (await tools.tx.incentiveScheme.findUnique({ where: { id: scheme.id }, select: SCHEME_SELECT }))!
    refuseScheme(editRefusal(schemeRowOf(before)))
    await payGuarded(() => tools.tx.incentiveScheme.update({ where: { id: scheme.id }, data: termsData(terms!), select: { id: true } }))
    tools.audit({ action: 'people.updateIncentiveScheme', recordType: 'IncentiveScheme', recordId: scheme.id, companyId: scheme.companyId, siteId: scheme.siteId, before: termsAudit(schemeRowOf(before)), after: termsAudit(terms!) })
    emitScheme(tools, scheme, 'EDITED', 'DRAFT')
    return schemeDetailOf(tools.tx, context, scheme.id, tools.now)
  })
  return result
}

/** "Start the scheme": DRAFT → ACTIVE; the open scheme before it of the same company and line ends the day before (RETIRED). */
export async function activateScheme(caller: CommandCaller, schemeId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<SchemeDetail & { words: string[] }> {
  const { context, scheme } = await schemeOf(caller, schemeId, PEOPLE_PIECERATES_MANAGE)
  refuseScheme(editRefusal(schemeRowOf(scheme)))
  const { result } = await command(caller, { name: 'people.activateIncentiveScheme', idempotencyKey, input: body, record: { type: 'IncentiveScheme', id: scheme.id, expectedVersion: body.version } }, async (tools) => {
    await lockSchemes(tools, context.tenantId, scheme.companyId)
    const current = (await tools.tx.incentiveScheme.findUnique({ where: { id: scheme.id }, select: SCHEME_SELECT }))!
    const row = schemeRowOf(current)
    const periods = await periodsOf(tools.tx, scheme.companyId)
    const others = await neighboursOf(tools.tx, scheme)
    const { plan, refusal } = activationPlan({ scheme: row, today: todayOf(tools.now), others: others.map(schemeRowOf), periods })
    refuseScheme(refusal)
    const words: string[] = []
    for (const retired of plan!.retires) {
      const previous = others.find((other) => other.id === retired.id)!
      await payGuarded(() => tools.tx.incentiveScheme.update({ where: { id: retired.id }, data: { validTo: dateOf(retired.validTo), status: 'RETIRED', version: { increment: 1 } }, select: { id: true } }))
      tools.audit({ action: 'people.retireIncentiveScheme', recordType: 'IncentiveScheme', recordId: retired.id, companyId: previous.companyId, siteId: previous.siteId, before: { status: 'ACTIVE', validTo: null }, after: { status: 'RETIRED', validTo: retired.validTo, followedBy: scheme.id } })
      emitScheme(tools, previous, 'RETIRED', 'RETIRED')
      words.push(`"${retired.name}" applies until ${retired.validTo}: this scheme takes over the day after.`)
    }
    await payGuarded(() => tools.tx.incentiveScheme.update({ where: { id: scheme.id }, data: { status: 'ACTIVE', activatedAt: tools.now, activatedById: context.actorId }, select: { id: true } }))
    tools.audit({ action: 'people.activateIncentiveScheme', recordType: 'IncentiveScheme', recordId: scheme.id, companyId: scheme.companyId, siteId: scheme.siteId, before: { status: 'DRAFT' }, after: { status: 'ACTIVE', validFrom: row.validFrom, retired: plan!.retires.map((retired) => retired.id) } })
    emitScheme(tools, scheme, 'ACTIVATED', 'ACTIVE')
    const touched = affectedPeriods(periods, row.validFrom, null)
    words.unshift(`"${row.name}" starts on ${row.validFrom}.`)
    words.push(periodsInWords(row.validFrom, null, touched))
    return { ...(await schemeDetailOf(tools.tx, context, scheme.id, tools.now)), words }
  })
  return result
}

/** "End the scheme": an ACTIVE scheme's last day, with why (RETIRED; it still pays on its own days). */
export async function endScheme(caller: CommandCaller, schemeId: string, body: { readonly version: number; readonly lastDay: string; readonly reason: string }, idempotencyKey?: string): Promise<SchemeDetail & { words: string[] }> {
  const { context, scheme } = await schemeOf(caller, schemeId, PEOPLE_PIECERATES_MANAGE)
  refuseProblems(reasonProblems(body.reason), 'Say why the scheme ends.')
  if (scheme.status !== 'ACTIVE') refuseScheme(endRefusal({ scheme: schemeRowOf(scheme), lastDay: body.lastDay, today: todayOf(serverClock.now()), onAt: [] }))
  const { result } = await command(caller, { name: 'people.endIncentiveScheme', idempotencyKey, input: body, record: { type: 'IncentiveScheme', id: scheme.id, expectedVersion: body.version } }, async (tools) => {
    await lockSchemes(tools, context.tenantId, scheme.companyId)
    const current = schemeRowOf((await tools.tx.incentiveScheme.findUnique({ where: { id: scheme.id }, select: SCHEME_SELECT }))!)
    const onAt = (await switchesNaming(tools.tx, scheme.id)).filter((row) => row.state === 'ON').map((row) => row.site.name)
    refuseScheme(endRefusal({ scheme: current, lastDay: body.lastDay, today: todayOf(tools.now), onAt }))
    await payGuarded(() => tools.tx.incentiveScheme.update({ where: { id: scheme.id }, data: { validTo: dateOf(body.lastDay), status: 'RETIRED' }, select: { id: true } }))
    tools.audit({ action: 'people.endIncentiveScheme', recordType: 'IncentiveScheme', recordId: scheme.id, companyId: scheme.companyId, siteId: scheme.siteId, before: { status: 'ACTIVE', validTo: null }, after: { status: 'RETIRED', validTo: body.lastDay }, reason: body.reason.trim() })
    emitScheme(tools, scheme, 'ENDED', 'RETIRED')
    const words = [`"${current.name}" applies until ${body.lastDay}.`, scheme.lineId ? 'From the day after, work on this line is paid under the company\'s scheme in force, if any.' : 'From the day after, no company scheme applies until a new one starts (a line\'s own scheme still applies on its line).']
    return { ...(await schemeDetailOf(tools.tx, context, scheme.id, tools.now)), words }
  })
  return result
}

/** Delete a DRAFT (no site's piece-pay switch may name it). */
export async function deleteScheme(caller: CommandCaller, schemeId: string, query: { readonly version: number }, idempotencyKey?: string): Promise<{ deleted: { id: string; name: string } }> {
  const { scheme } = await schemeOf(caller, schemeId, PEOPLE_PIECERATES_MANAGE)
  refuseScheme(editRefusal(schemeRowOf(scheme)) === null ? null : deleteRefusal(schemeRowOf(scheme), []))
  const { result } = await command(caller, { name: 'people.deleteIncentiveScheme', idempotencyKey, input: { schemeId, ...query }, record: { type: 'IncentiveScheme', id: scheme.id, expectedVersion: query.version } }, async (tools) => {
    const current: SchemeRecord = (await tools.tx.incentiveScheme.findUnique({ where: { id: scheme.id }, select: SCHEME_SELECT }))!
    const namedAt = (await switchesNaming(tools.tx, scheme.id)).map((row) => row.site.name)
    refuseScheme(deleteRefusal(schemeRowOf(current), namedAt))
    await payGuarded(() => tools.tx.incentiveScheme.delete({ where: { id: scheme.id }, select: { id: true } }))
    tools.audit({ action: 'people.deleteIncentiveScheme', recordType: 'IncentiveScheme', recordId: scheme.id, companyId: scheme.companyId, siteId: scheme.siteId, before: { ...termsAudit(schemeRowOf(current)), lineId: current.lineId, validTo: day(current.validTo), status: 'DRAFT' } })
    emitScheme(tools, scheme, 'DELETED', 'DRAFT')
    return { deleted: { id: scheme.id, name: current.name } }
  })
  return result
}
