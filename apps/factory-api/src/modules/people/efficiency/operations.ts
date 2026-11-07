import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { PEOPLE_EFFICIENCY_VIEW } from '@nexus/factory-domain/people/efficiency/permissions'
import { cycleFiguresOf, operationDaysOf, operationFiguresOf, type OperationFigures, type OperationSample } from '@nexus/factory-domain/people/efficiency/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { rangeOf, siteFor } from '../attendance/access'
import { officeOf } from '../employees/access'
import { hideSmallGroups } from '../privacy/groups'
import { refuseAnyPerson, requireLine, reviewWindow, type PersonKeys } from './access'
import { reviewFacts } from './review'
import { reviewRuleFor } from './rule'
import { operationRefOf, readSamples, siteLines, stepOfSite, styleRefOf, stylesById, type Reader, type RoutingStep, type StepSamples } from './store'

/**
 * Planned against actual by operation (B-W2b-44; MES-250; design people.efficiency "Planned vs actual by operation") and
 * operation cycle time (ANA-016): per style's routing step and per operation, aggregated, never per person (ANA-016's legal
 * note). One operation is often one person's work on a line, so the same minimum group size holds here: an operation, or one
 * of its days, with fewer people behind it shows nothing. The detail gives no minutes per bundle for the same reason: a bundle
 * is usually one person's work, and a labour record names them.
 */

const NO_PERSON = 'Figures per operation, never per person.'

interface Query extends PersonKeys {
  readonly siteId: string
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly lineId?: string | undefined
  readonly styleId?: string | undefined
}

const byPlace = (a: StepSamples, b: StepSamples, styles: Awaited<ReturnType<typeof stylesById>>) => styleRefOf(styles, a.step).code.localeCompare(styleRefOf(styles, b.step).code) || a.step.revisionId.localeCompare(b.step.revisionId) || a.step.seq - b.step.seq

/** One operation's days per step, each masked on its own: a day may stand on fewer people than the period. */
async function maskedDays(db: Reader, companyId: string, entries: readonly { readonly step: RoutingStep; readonly samples: readonly OperationSample[] }[]) {
  const rows = entries.flatMap(({ step, samples }) => operationDaysOf(samples, step.standardMinutes).map((day) => ({ stepId: step.id, date: day.date, people: day.people, figures: { actualMinutes: day.actualMinutes, differencePercent: day.differencePercent } })))
  const out = new Map<string, { date: string; tooFew: boolean; actualMinutes: string | null; differencePercent: string | null }[]>()
  for (const { row, tooFew } of (await hideSmallGroups(db, companyId, rows)).rows) out.set(row.stepId, [...(out.get(row.stepId) ?? []), { date: row.date, tooFew, actualMinutes: row.figures.actualMinutes, differencePercent: row.figures.differencePercent }])
  return out
}

/** GET /people/efficiency/operations: Style · operation · SMV · actual · bundles · difference · sparkline · state. */
export async function listOperations(caller: CommandCaller, query: Query) {
  const context = officeOf(caller)
  refuseAnyPerson(query)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, [PEOPLE_EFFICIENCY_VIEW])
    const setup = await siteLines(db, site)
    requireLine(setup, query.lineId)
    const range = rangeOf(query, site.timezone, now)
    const read = await readSamples(db, site, setup.sources, range, { lineId: query.lineId, styleId: query.styleId })
    const rule = await reviewRuleFor(db, site.companyId)
    const styles = await stylesById(db, [...read.steps.values()].map((entry) => entry.step.styleId))
    const entries = [...read.steps.values()].sort((a, b) => byPlace(a, b, styles))
    const masked = await hideSmallGroups(db, site.companyId, entries.map((entry) => ({ entry, ...operationFiguresOf(entry.samples, entry.step.standardMinutes, rule) })))
    const days = await maskedDays(db, site.companyId, masked.rows.filter((row) => !row.tooFew).map((row) => row.row.entry))
    return {
      siteId: site.id,
      from: range.from,
      to: range.to,
      rule,
      operations: masked.rows.map(({ row, tooFew, words }) => ({
        routingOperationId: row.entry.step.id,
        style: styleRefOf(styles, row.entry.step),
        revisionId: row.entry.step.revisionId,
        operation: operationRefOf(row.entry.step),
        standardMinutes: row.entry.step.standardMinutes,
        people: row.people ?? null,
        tooFew,
        words,
        figures: row.figures as OperationFigures,
        series: days.get(row.entry.step.id) ?? [],
      })),
      hiddenGroups: masked.hidden,
      untimedReports: read.untimedReports,
      traineeBundles: read.traineeBundles,
      words: [NO_PERSON],
    }
  })
}

/** GET /people/efficiency/operations/:routingOperationId: the operation pop-over and the review's detail. */
export async function operationDetail(caller: CommandCaller, routingOperationId: string, query: { readonly siteId: string; readonly from?: string | undefined; readonly to?: string | undefined }) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, [PEOPLE_EFFICIENCY_VIEW])
    const found = await stepOfSite(db, site, routingOperationId)
    if (!found) throw new NotFoundError('Operation not found.')
    const { step, styles } = found
    const setup = await siteLines(db, site)
    const range = query.from !== undefined || query.to !== undefined ? rangeOf(query, site.timezone, now) : reviewWindow(site.timezone, now)
    const read = await readSamples(db, site, setup.sources, range, { step })
    const samples = read.steps.get(step.id)?.samples ?? []
    const rule = await reviewRuleFor(db, site.companyId)
    const masked = await hideSmallGroups(db, site.companyId, [operationFiguresOf(samples, step.standardMinutes, rule)])
    const { row, tooFew, words } = masked.rows[0]!
    const days = tooFew ? [] : ((await maskedDays(db, site.companyId, [{ step, samples }])).get(step.id) ?? [])
    const review = await reviewFacts(db, site, setup, step, now, rule)
    return {
      siteId: site.id,
      from: range.from,
      to: range.to,
      routingOperationId: step.id,
      style: styleRefOf(styles, step),
      revisionId: step.revisionId,
      operation: operationRefOf(step),
      standardMinutes: step.standardMinutes,
      people: row.people ?? null,
      tooFew,
      figures: row.figures as OperationFigures,
      days,
      review: review.place,
      history: review.history,
      rule,
      words: [...(words ? [words] : []), NO_PERSON],
    }
  })
}

/** GET /people/efficiency/cycle-time: how long each operation runs, across styles; never per person (ANA-016). */
export async function cycleTime(caller: CommandCaller, query: Query) {
  const context = officeOf(caller)
  refuseAnyPerson(query)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, [PEOPLE_EFFICIENCY_VIEW])
    const setup = await siteLines(db, site)
    requireLine(setup, query.lineId)
    const range = rangeOf(query, site.timezone, now)
    const read = await readSamples(db, site, setup.sources, range, { lineId: query.lineId, styleId: query.styleId })
    const perOperation = new Map<string, { operation: { id: string; code: string; name: string }; samples: OperationSample[] }>()
    for (const { step, samples } of read.steps.values()) {
      const held = perOperation.get(step.operationId) ?? { operation: { id: step.operationId, code: step.code, name: step.name }, samples: [] }
      held.samples.push(...samples)
      perOperation.set(step.operationId, held)
    }
    const groups = [...perOperation.values()].sort((a, b) => a.operation.code.localeCompare(b.operation.code)).map((entry) => ({ operation: entry.operation, ...cycleFiguresOf(entry.samples) }))
    const masked = await hideSmallGroups(db, site.companyId, groups)
    return {
      siteId: site.id,
      from: range.from,
      to: range.to,
      operations: masked.rows.map(({ row, tooFew, words }) => ({ operation: row.operation, people: row.people ?? null, tooFew, words, figures: row.figures })),
      hiddenGroups: masked.hidden,
      words: [NO_PERSON, 'Running time, a team counted once; pauses are shown apart. One-tap reports have no timing and are not counted.'],
    }
  })
}
