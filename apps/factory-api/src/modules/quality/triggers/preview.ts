import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Chip, Frequency } from '@nexus/factory-domain/quality/plans/rules'
import { decide, inOrder, previewWords, recordKindOf, ruleProblems, SCAN_KINDS, selects, TRIGGER_LIMITS, type PreviewCounts, type RuleFacts, type TriggerEvent } from '@nexus/factory-domain/quality/triggers/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { bundleSubjectsBetween, receiptSubjectsBetween, type Subject } from './facts'
import { LOOKBACK_MS, mayView, officeOf, plansOf, readRule, ruleFactsOf, TRIGGER_COLUMNS, type Db } from './store'

/**
 * The preview of a rule (B-W2b-101; design quality.plans pl-triggers "Preview: 'This rule would have created 14 inspections
 * last month.'" and "Trigger rules preview how many inspections they would have made last month before they go live"):
 *
 *   POST /quality/inspection-triggers/preview   a draft rule (new, or a saved one changed: `triggerId`), read only
 *
 * The last month = the 30 days before now. The subjects of those days (lots received, workshop receipts, bundles at an
 * operation) are judged against the company's ACTIVE rules of the event with the draft in its place: `fits` the draft and
 * its plan fit, `earlier` an earlier rule of the same kind took, `opened` the draft's frequency picked. Not counted: a
 * record already open on the subject, and the first piece held back because the run had gone on (the numbers are a
 * ceiling there). A share of the operations draws on the rule's id: a new rule's draw is made on a stand-in id, so its
 * count is the same share of other subjects. Read-only: nothing is written; the POST only carries the draft.
 */

/** The stand-in id of a rule not saved yet (its draw for a share of the operations). */
const DRAFT_ID = '00000000-0000-7000-8000-000000000101'

export interface PreviewBody {
  readonly companyId: string
  readonly triggerId?: string | undefined
  readonly event: TriggerEvent
  readonly planId: string
  readonly appliesTo?: readonly Chip[] | undefined
  readonly frequency: Frequency
  readonly frequencyValue?: number | null | undefined
  readonly position?: number | undefined
}

const refuse = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

export async function previewRule(caller: CommandCaller, body: PreviewBody) {
  const context = officeOf(caller)
  if (!mayView(context, body.companyId)) throw new NotFoundError('Company not found.')
  const now = serverClock.now()
  const from = new Date(now.getTime() - LOOKBACK_MS)
  return caller.withClient(async (client) => {
    const db = client as unknown as Db
    const plan = (await plansOf(db, [body.planId])).get(body.planId)
    if (!plan || plan.companyId !== body.companyId) refuse([{ path: 'planId', message: 'Not an inspection plan of this company.' }], 'Not an inspection plan of this company.')
    const saved = body.triggerId ? await readRule(db, context, body.triggerId) : null
    if (saved && saved.companyId !== body.companyId) refuse([{ path: 'triggerId', message: 'Not a rule of this company.' }], 'Not a rule of this company.')
    const appliesTo = body.appliesTo ?? []
    const frequencyValue = body.frequencyValue ?? null
    const problems = ruleProblems({ event: body.event, stage: plan!.stage, appliesTo, frequency: body.frequency, frequencyValue })
    if (problems.length > 0) refuse(problems, 'The rule is not valid.')
    const kind = recordKindOf(plan!.stage, body.frequency)!

    // The draft's place among ALL the company's rules (a place is the list's, whatever the event).
    const others = inOrder((await db.inspectionTrigger.findMany({ where: { companyId: body.companyId }, select: TRIGGER_COLUMNS })).filter((row) => row.id !== saved?.id))
    const last = others.at(-1)?.sortOrder ?? 0
    const sortOrder = body.position !== undefined ? (others[body.position - 1]?.sortOrder ?? last + 10) - 0.5 : (saved?.sortOrder ?? last + 10)
    const draft: RuleFacts & { readonly frequency: Frequency; readonly frequencyValue: number | null } = { id: saved?.id ?? DRAFT_ID, sortOrder, recordKind: kind, chips: appliesTo, planChips: plan!.appliesTo, frequency: body.frequency, frequencyValue }
    const otherPlans = await plansOf(db, others.map((row) => row.planId))
    const rules = [draft, ...others.filter((row) => row.active && row.event === body.event).flatMap((row) => ruleFactsOf(row, otherPlans.get(row.planId)) ?? [])]

    const read =
      body.event === 'GOODS_RECEIPT'
        ? await receiptSubjectsBetween(db, body.companyId, from, now, TRIGGER_LIMITS.previewLots)
        : await bundleSubjectsBetween(db, body.companyId, from, now, SCAN_KINDS[body.event] ?? [], TRIGGER_LIMITS.previewScans)
    const subjects: Subject[] = read.subjects
    let fits = 0
    let earlier = 0
    let opened = 0
    for (const subject of subjects) {
      if (!decide([draft], subject.facts).has(kind)) continue
      fits++
      const decided = decide(rules, subject.facts).get(kind)
      if (decided?.rule.id !== draft.id) {
        earlier++
        continue
      }
      const occurrence = subject.type === 'BUNDLE' ? subject.occurrence : { ordinal: 1, sampleKey: subject.key }
      if (selects(draft, occurrence)) opened++
    }
    const counts: PreviewCounts = { event: body.event, considered: subjects.length, fits, earlier, opened, from: businessDate(from), to: businessDate(now), truncated: read.truncated }
    return { preview: { ...counts, words: { it: previewWords(counts, 'it'), en: previewWords(counts, 'en') } } }
  })
}
