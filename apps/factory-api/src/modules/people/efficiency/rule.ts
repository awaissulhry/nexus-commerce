import { ConflictError, ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { PEOPLE_EFFICIENCY_REVIEW, PEOPLE_EFFICIENCY_VIEW } from '@nexus/factory-domain/people/efficiency/permissions'
import { reviewRuleOf, reviewRuleProblems, reviewRuleWords, STANDARD_REVIEW, type ReviewRule } from '@nexus/factory-domain/people/efficiency/rules'
import { command, type CommandCaller } from '../../../core/command'
import type { Client } from '../attendance/store'
import { companyFor, reachesCompany } from '../close/store'
import { officeOf } from '../employees/access'

/**
 * People settings › Standard review (B-W2b-89; follow-up of B-W2b-44; design people.efficiency "Standard review queue": "a set
 * %" over "enough bundles"): each company sets the two numbers; the window (60 days) stays the build's. The queue, an
 * operation's detail and a decision read them (`reviewRuleFor`); a company with no People settings row reads the defaults,
 * the same as the columns'. Settings, not a person's data: no legal gate.
 *
 *   GET /people/efficiency/review/rule?companyId  people.efficiency.view (or .review) over every site of the company
 *   PUT /people/efficiency/review/rule            people.efficiency.review over every site of it, with the version read
 *
 * The version is the People settings row's (one row per company, shared with the other cards of People settings).
 */

/** The company's rule: its People settings, else the defaults. */
export async function reviewRuleFor(db: Client, companyId: string): Promise<ReviewRule> {
  const row = await db.peopleSettings.findUnique({ where: { id: companyId }, select: { standardReviewPercent: true, standardReviewMinBundles: true } })
  return reviewRuleOf(row)
}

const answerOf = (companyId: string, version: number | null, rule: ReviewRule, canManage: boolean) => ({ companyId, version, ...rule, windowDays: STANDARD_REVIEW.windowDays, canManage, words: [reviewRuleWords(rule)] })

const manageWords = 'The standard review limits are set by a role with people.efficiency.review over every site of the company.'

/** GET /people/efficiency/review/rule. */
export async function readReviewRule(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const place = await companyFor(db, context, query.companyId, [PEOPLE_EFFICIENCY_VIEW, PEOPLE_EFFICIENCY_REVIEW])
    const row = await db.peopleSettings.findUnique({ where: { id: place.company.id }, select: { standardReviewPercent: true, standardReviewMinBundles: true, version: true } })
    return answerOf(place.company.id, row?.version ?? null, reviewRuleOf(row), reachesCompany(context, place, [PEOPLE_EFFICIENCY_REVIEW]))
  })
}

interface SaveRuleBody extends ReviewRule {
  readonly companyId: string
  readonly version: number | null
}

/** PUT /people/efficiency/review/rule: both numbers, the version read (null: the company has no People settings yet). */
export async function saveReviewRule(caller: CommandCaller, body: SaveRuleBody, key?: string) {
  const context = officeOf(caller)
  const next: ReviewRule = { tolerancePercent: body.tolerancePercent, minBundles: body.minBundles }
  const problems = reviewRuleProblems(next)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  await caller.withClient(async (db) => {
    const place = await companyFor(db, context, body.companyId, [PEOPLE_EFFICIENCY_VIEW, PEOPLE_EFFICIENCY_REVIEW])
    if (!reachesCompany(context, place, [PEOPLE_EFFICIENCY_REVIEW])) throw new ForbiddenError(manageWords)
  })
  const { result } = await command(caller, { name: 'people.changeStandardReviewRule', idempotencyKey: key, input: body }, async (tools) => {
    const row = await tools.tx.peopleSettings.findUnique({ where: { id: body.companyId }, select: { standardReviewPercent: true, standardReviewMinBundles: true, version: true } })
    const version = row?.version ?? null
    if (version !== body.version) throw new ConflictError(version === null ? 'This company has no People settings yet: send version null.' : `The People settings changed since you read them (version ${version}, not ${String(body.version)}): read them again.`)
    const before = reviewRuleOf(row)
    const data = { standardReviewPercent: next.tolerancePercent, standardReviewMinBundles: next.minBundles }
    const newVersion = row
      ? (await tools.tx.peopleSettings.update({ where: { id: body.companyId }, data: { ...data, version: { increment: 1 } }, select: { version: true } })).version
      : (await tools.tx.peopleSettings.create({ data: { id: body.companyId, companyId: body.companyId, ...data, createdById: context.actorId }, select: { version: true } })).version
    tools.audit({ recordType: 'PeopleSettings', recordId: body.companyId, companyId: body.companyId, before: { standardReview: before }, after: { standardReview: next } })
    tools.emit({ type: 'people_settings.review_changed', subject: body.companyId, companyId: body.companyId, payload: { companyId: body.companyId, version: newVersion } })
    return answerOf(body.companyId, newVersion, next, true)
  })
  return result
}
