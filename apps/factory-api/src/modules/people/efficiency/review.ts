import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_EFFICIENCY_REVIEW, PEOPLE_EFFICIENCY_VIEW } from '@nexus/factory-domain/people/efficiency/permissions'
import { decisionProblems, offSinceOf, operationDaysOf, operationFiguresOf, REVIEW_DECISIONS, REVIEW_MOVED, REVIEW_WORDS, reviewPlaceOf, STANDARD_REVIEW, TOO_FEW_PEOPLE, type OperationFigures, type OperationSample, type ReviewDecision, type ReviewMark, type ReviewReason } from '@nexus/factory-domain/people/efficiency/rules'
import { groupShown } from '@nexus/factory-domain/people/privacy/groups'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { isoDay, jsonObject, peopleNames } from '../../production/labour/store'
import { siteFor } from '../attendance/access'
import { officeOf, refuse } from '../employees/access'
import { hideSmallGroups, minimumGroupSizeFor } from '../privacy/groups'
import { reviewWindow } from './access'
import { decisionsOf, DECIDE_ACTION, operationRefOf, readSamples, siteLines, stepOfSite, stepsById, styleRefOf, stylesById, type Decision, type Place, type Reader, type RoutingStep, type SiteLines } from './store'

/**
 * The standard review queue (B-W2b-44; MES-251; design people.efficiency "Standard review queue", pop-up "Standard review";
 * c.c. art. 2101: rates change only when conditions change): operations off their standard by more than the tolerance, in
 * both directions, over enough bundles, at one site. A person decides, with a reason: keep the standard, change it (a new
 * routing revision in Products: the decision says what to, the revision does it), or investigate. Rule and decisions:
 * factory-domain people/efficiency/rules.
 *
 * Decisions are audit rows of the routing step (action people.decideStandardReview, with the site): there is no table for
 * them yet (a schema need of this step), so the queue reads them back as compliance's renewals do. Under an advisory lock per
 * site and step the last decision read (`basedOn`) must still be the last one.
 *
 * An operation with fewer people behind it than the company's minimum never shows on the queue: its actual minutes would be
 * those people's figures. The queue says how many it left out. One already under investigation or sent by hand stays
 * listed with its figures empty, so a person can close it.
 */

const OPEN_MARKS: ReadonlySet<ReviewDecision> = new Set(['INVESTIGATE', 'SEND'])

const isDecision = (value: unknown): value is ReviewDecision => (REVIEW_DECISIONS as readonly unknown[]).includes(value)

function decisionOf(row: Decision): ReviewDecision | null {
  const value = jsonObject(row.after).decision
  return isDecision(value) ? value : null
}

const markOf = (row: Decision | undefined): ReviewMark | null => {
  const decision = row ? decisionOf(row) : null
  return row && decision ? { decision, at: row.at } : null
}

const lastOf = (row: Decision | undefined) => {
  const decision = row ? decisionOf(row) : null
  return row && decision ? { id: row.id, decision, at: toUtcIso(row.at) } : null
}

const sinceOf = (reason: ReviewReason, samples: readonly OperationSample[], standardMinutes: string, mark: ReviewMark | null, timeZoneDay: (at: Date) => BusinessDate): BusinessDate | null => {
  if (reason !== 'OFF_STANDARD') return mark ? timeZoneDay(mark.at) : null
  const days = operationDaysOf(samples, standardMinutes)
  return offSinceOf(days) ?? days[0]?.date ?? null
}

const directionOf = (figures: OperationFigures): 'OVER' | 'UNDER' | null => (figures.differencePercent === null ? null : Number(figures.differencePercent) > 0 ? 'OVER' : Number(figures.differencePercent) < 0 ? 'UNDER' : null)

const dayIn = (at: Date): BusinessDate => isoDay(at)

/** GET /people/efficiency/review: the queue of a site. */
export async function reviewQueue(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, [PEOPLE_EFFICIENCY_VIEW])
    const setup = await siteLines(db, site)
    const range = reviewWindow(site.timezone, now)
    const read = await readSamples(db, site, setup.sources, range)
    const last = new Map<string, Decision>()
    for (const row of await decisionsOf(db, site.id)) last.set(row.routingOperationId, row)
    const stillOpen = [...last.entries()].filter(([, row]) => OPEN_MARKS.has(decisionOf(row) as ReviewDecision)).map(([id]) => id)
    const steps = await stepsById(db, stillOpen.filter((id) => !read.steps.has(id)))
    const entries = [...[...read.steps.values()], ...[...steps.values()].map((step) => ({ step, samples: [] as OperationSample[] }))].flatMap(({ step, samples }) => {
      const mark = markOf(last.get(step.id))
      const place = reviewPlaceOf(samples, mark, step.standardMinutes)
      if (!place.reason) return []
      return [{ step, mark, reason: place.reason, samples: place.samples, ...operationFiguresOf(place.samples, step.standardMinutes) }]
    })
    const styles = await stylesById(db, entries.map((entry) => entry.step.styleId))
    const masked = await hideSmallGroups(db, site.companyId, entries)
    const listed = masked.rows.filter(({ row, tooFew }) => !tooFew || row.reason !== 'OFF_STANDARD')
    const queue = listed
      .map(({ row, tooFew, words }) => ({
        routingOperationId: row.step.id,
        style: styleRefOf(styles, row.step),
        revisionId: row.step.revisionId,
        operation: operationRefOf(row.step),
        standardMinutes: row.step.standardMinutes,
        people: row.people ?? null,
        tooFew,
        words,
        figures: row.figures as OperationFigures,
        direction: directionOf(row.figures as OperationFigures),
        reason: row.reason,
        since: tooFew ? null : sinceOf(row.reason, row.samples, row.step.standardMinutes, row.mark, dayIn),
        lastDecision: lastOf(last.get(row.step.id)),
      }))
      .sort((a, b) => a.style.code.localeCompare(b.style.code) || a.revisionId.localeCompare(b.revisionId) || a.operation.seq - b.operation.seq)
    const leftOut = masked.rows.length - listed.length
    return {
      siteId: site.id,
      from: range.from,
      to: range.to,
      rule: { tolerancePercent: STANDARD_REVIEW.tolerancePercent, minBundles: STANDARD_REVIEW.minBundles },
      count: queue.length,
      queue,
      leftOut,
      words: [
        `Operations more than ${STANDARD_REVIEW.tolerancePercent}% off their standard, in either direction, over at least ${STANDARD_REVIEW.minBundles} bundles of the last ${STANDARD_REVIEW.windowDays} days.`,
        ...(leftOut > 0 ? [`${leftOut} left out: too few people worked on them to show without identifying them.`] : []),
      ],
    }
  })
}

/** The operation's place on the queue and its decisions, for its detail. */
export async function reviewFacts(db: Reader, place: Place, setup: SiteLines, step: RoutingStep, now: Date) {
  const decisions = await decisionsOf(db, place.id, step.id)
  const last = decisions.at(-1)
  const mark = markOf(last)
  const read = await readSamples(db, place, setup.sources, reviewWindow(place.timezone, now), { step })
  const position = reviewPlaceOf(read.steps.get(step.id)?.samples ?? [], mark, step.standardMinutes)
  const names = await peopleNames(db, decisions.map((row) => row.actorId))
  const minimum = await minimumGroupSizeFor(db, place.companyId)
  const shown = groupShown(operationFiguresOf(position.samples, step.standardMinutes).people, minimum)
  return {
    place: { reason: position.reason !== 'OFF_STANDARD' || shown ? position.reason : null, since: position.reason && shown ? sinceOf(position.reason, position.samples, step.standardMinutes, mark, dayIn) : null, lastDecision: lastOf(last) },
    history: [...decisions].reverse().flatMap((row) => {
      const decision = decisionOf(row)
      const proposed = jsonObject(row.after).proposedMinutes
      return decision ? [{ id: row.id, decision, at: toUtcIso(row.at), by: names.get(row.actorId) ?? '—', reason: row.reason, proposedMinutes: typeof proposed === 'string' ? proposed : null }] : []
    }),
  }
}

async function lockReview(tx: CommandTx, tenantId: string, siteId: string, routingOperationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.people.standard-review', ${tenantId}::uuid, ${siteId}::uuid, ${routingOperationId}::uuid), 0))`
}

interface DecideBody {
  readonly siteId: string
  readonly decision: ReviewDecision
  readonly reason?: string | null | undefined
  readonly proposedMinutes?: string | null | undefined
  readonly basedOn: string | null
}

/**
 * POST /people/efficiency/review/:routingOperationId/decide: keep, change or investigate with a reason, or send an operation
 * to the review. ONE command: it writes the decision down, and nothing else: a standard changes only through a new routing
 * revision in Products, and a rate only as c.c. art. 2101 allows.
 */
export async function decide(caller: CommandCaller, routingOperationId: string, body: DecideBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = decisionProblems(body)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const { result } = await command(caller, { name: 'people.decideStandardReview', idempotencyKey, input: { routingOperationId, ...body } }, async (tools) => {
    const site = await siteFor(tools.tx, context, body.siteId, [PEOPLE_EFFICIENCY_REVIEW])
    const found = await stepOfSite(tools.tx, site, routingOperationId)
    if (!found) throw new NotFoundError('Operation not found.')
    const { step } = found
    await lockReview(tools.tx, context.tenantId, site.id, step.id)
    const decisions = await decisionsOf(tools.tx, site.id, step.id)
    const last = decisions.at(-1)
    if ((last?.id ?? null) !== body.basedOn) refuse(REVIEW_MOVED.code, REVIEW_MOVED.message)
    const mark = markOf(last)
    const setup = await siteLines(tools.tx, site)
    const read = await readSamples(tools.tx, site, setup.sources, reviewWindow(site.timezone, tools.now), { step })
    // The group the decision stands on is every bundle of the window, also those older than the last decision.
    const { people, figures } = operationFiguresOf(read.steps.get(step.id)?.samples ?? [], step.standardMinutes)
    const open = mark !== null && OPEN_MARKS.has(mark.decision)
    const shown = groupShown(people, await minimumGroupSizeFor(tools.tx, site.companyId))
    if (!shown && !open) refuse(TOO_FEW_PEOPLE.code, TOO_FEW_PEOPLE.message)
    const reason = body.reason?.trim() ? body.reason.trim() : null
    const proposedMinutes = body.decision === 'CHANGE' ? (body.proposedMinutes ?? null) : null
    tools.audit({
      action: DECIDE_ACTION,
      recordType: 'RoutingOperation',
      recordId: step.id,
      companyId: site.companyId,
      siteId: site.id,
      after: { decision: body.decision, standardMinutes: step.standardMinutes, proposedMinutes, ...(shown ? { actualMinutes: figures.actualMinutes, bundles: figures.bundles } : {}) },
      ...(reason ? { reason } : {}),
    })
    tools.emit({ type: 'standard_review.decided', subject: step.id, companyId: site.companyId, siteId: site.id, payload: { routingOperationId: step.id, siteId: site.id, decision: body.decision } })
    return { routingOperationId: step.id, siteId: site.id, decision: body.decision, decidedAt: toUtcIso(tools.now), reason, proposedMinutes, style: { id: step.styleId, revisionId: step.revisionId }, words: [REVIEW_WORDS[body.decision]] }
  })
  return result
}
