import { countryOf } from '../../compliance/gates/facts'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { ATP_DEFAULT_WEEKS, atpRow, atpTotal, atpWeeks } from '@nexus/factory-domain/planning/promise/atp'
import { PLANNING_PROMISE_VIEW } from '@nexus/factory-domain/planning/promise/permissions'
import { dayWords } from '@nexus/factory-domain/planning/promise/rules'
import { QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../access'
import type { Reader, SiteRow } from '../store'
import { marketFor } from './certificates'
import { answerPromises, type AskAnswer, type PromiseAsk, type PromiseWhere } from './engine'
import { mayPromiseAt, plantOf, promiseSite, readSkuFlows, readStockStyles, readStyleFacts } from './store'
// B-W2b-365: the options asked or chosen on the quote line.
import { askedOptions, quoteLineOptionsOf } from './steps'

/**
 * Reading promise dates (B-W2b-301; design planning.promise › atp, the Promise calculator, Sales › Quote "Suggest date"):
 * available to promise of a style at a site by size, colour and week; the calculator for one style, colourway and size run;
 * a quote version's suggested dates per line and size with the delivery schedule they make. planning.promise.view over the
 * site (a quote also with quotes.view over its company and customer). Nothing is written; no money; no person.
 */

export interface WhereView {
  readonly site: { readonly id: string; readonly companyId: string; readonly code: string; readonly name: string }
  readonly today: BusinessDate
  readonly asOf: string
  readonly market: { readonly code: string; readonly name: string } | null
  readonly destination: string | null
  readonly planVersion: { readonly id: string; readonly version: number } | null
}

/** Where the question is asked: the site's day, the market of the destination, the working plan read. */
export async function whereOf(db: Reader, site: SiteRow, now: Date, country: string | null): Promise<{ where: PromiseWhere; view: WhereView }> {
  const today = businessDate(now, site.timezone)
  const { market, destination } = await marketFor(db, country)
  const plan = await db.planVersion.findFirst({ where: { siteId: site.id, kind: 'WORKING' }, select: { id: true, version: true } })
  return {
    where: { site, today, now, market, destination },
    view: { site: { id: site.id, companyId: site.companyId, code: site.code, name: site.name }, today, asOf: toUtcIso(now), market: market ? { code: market.code, name: market.name } : null, destination, planVersion: plan },
  }
}

// ---- available to promise --------------------------------------------------------------------------------------------------

/** GET /planning/promise/atp */
export async function availableToPromise(caller: CommandCaller, query: { readonly siteId: string; readonly styleId: string; readonly weeks?: number | undefined }) {
  return caller.withClient(async (db) => {
    const site = await promiseSite(caller, query.siteId, PLANNING_PROMISE_VIEW, db)
    const facts = await readStyleFacts(db, query.styleId)
    if (!facts) throw new NotFoundError('Style not found.')
    const now = serverClock.now()
    const { view } = await whereOf(db, site, now, null)
    const weeks = atpWeeks(view.today, query.weeks ?? ATP_DEFAULT_WEEKS)
    const flows = await readSkuFlows(db, site, facts)
    const colourways = facts.colourways.map((colourway) => {
      const sizes = facts.style.sizes.map((size) => {
        const flow = flows.find((candidate) => candidate.colourwayId === colourway.id && candidate.size === size)!
        const row = atpRow(flow, weeks)
        return { size, sku: flow.sku, strategy: flow.strategy, onHand: row.onHand, availableNow: row.availableNow, later: row.later, cells: [...row.cells], sources: flow.sources.map((source) => ({ ...source })) }
      })
      const total = atpTotal(
        sizes.map((size) => ({ onHand: size.onHand, availableNow: size.availableNow, later: size.later, cells: size.cells })),
        weeks,
      )
      return { colourway, onHand: total.onHand, availableNow: total.availableNow, later: total.later, cells: [...total.cells], sizes }
    })
    return {
      ...view,
      style: { id: facts.style.id, code: facts.style.code, name: facts.style.name, sizes: facts.style.sizes },
      stockStyle: flows.some((flow) => flow.strategy === 'MAKE_TO_STOCK'),
      weeks: weeks.map((week) => ({ key: week.key, from: week.from, to: week.to })),
      colourways,
      empty: flows.every((flow) => flow.onHand === 0 && flow.receipts.length === 0),
    }
  })
}

/** GET /planning/promise/atp/styles */
export async function stockStyles(caller: CommandCaller, query: { readonly siteId: string; readonly q?: string | undefined; readonly limit?: number | undefined }) {
  return caller.withClient(async (db) => {
    const site = await promiseSite(caller, query.siteId, PLANNING_PROMISE_VIEW, db)
    return { siteId: site.id, styles: await readStockStyles(db, site, query.q, query.limit ?? 50) }
  })
}

// ---- the calculator -----------------------------------------------------------------------------------------------------------

export interface CalculateBody {
  readonly siteId: string
  readonly styleId: string
  readonly colourwayId: string
  readonly revisionId?: string | undefined
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
  readonly wantedDate?: BusinessDate | undefined
  readonly country?: string | undefined
  /** B-W2b-365: the options of the garment asked (a step only for some options counts when one of them is asked). */
  readonly optionValueIds?: readonly string[] | undefined
}

/** POST /planning/promise/calculate — the Promise calculator: nothing is written. */
export async function calculatePromise(caller: CommandCaller, body: CalculateBody) {
  const seen = new Set<string>()
  const twice = body.sizes.flatMap((entry, index) => {
    const repeated = seen.has(entry.size)
    seen.add(entry.size)
    return repeated ? [{ path: `body/sizes/${index}/size`, message: `Size ${entry.size} is named twice.` }] : []
  })
  if (twice.length > 0) throw new ValidationError('Each size once.', twice)
  return caller.withClient(async (db) => {
    const site = await promiseSite(caller, body.siteId, PLANNING_PROMISE_VIEW, db)
    const { where, view } = await whereOf(db, site, serverClock.now(), body.country ?? null)
    const optionValueIds = await askedOptions(db, body.styleId, body.optionValueIds) // B-W2b-365
    const [answer] = await answerPromises(db, where, [{ key: 'calculator', styleId: body.styleId, colourwayId: body.colourwayId, revisionId: body.revisionId ?? null, sizes: body.sizes, wantedDate: body.wantedDate ?? null, optionValueIds }])
    return { ...view, answer: answer! }
  })
}

// ---- a quote's suggested dates --------------------------------------------------------------------------------------------

/** The delivery schedule a line's dates suggest: one delivery per day with its sizes (a made-to-measure unit: one piece). */
export function deliveriesOf(answer: AskAnswer): { deliveryDate: BusinessDate; sizeQuantities: Record<string, number> | null; quantity: number }[] {
  const days = new Map<BusinessDate, Record<string, number>>()
  for (const size of answer.sizes) {
    if (size.date === null) continue
    days.set(size.date, { ...(days.get(size.date) ?? {}), [size.size]: size.quantity })
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([deliveryDate, sizes]) => ({ deliveryDate, sizeQuantities: answer.madeToMeasure ? null : sizes, quantity: answer.madeToMeasure ? 1 : Object.values(sizes).reduce((sum, value) => sum + value, 0) }))
}

/** GET /planning/promise/quotes/:quoteId — "Suggest date": every line of the version asked at once. */
export async function quoteSuggestion(caller: CommandCaller, quoteId: string, query: { readonly revision?: number | undefined; readonly siteId?: string | undefined; readonly wantedDate?: BusinessDate | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const quote = isUuid(quoteId) ? await db.quote.findUnique({ where: { id: quoteId }, select: { id: true, number: true, companyId: true, partyId: true, currentRevision: true } }) : null
    if (!quote || !can(actor, QUOTES_VIEW, { companyId: quote.companyId, partyId: quote.partyId })) throw new NotFoundError('Quote not found.')
    const site = await plantOf(db, quote.companyId, query.siteId, 'querystring/siteId')
    if (!mayPromiseAt(context, PLANNING_PROMISE_VIEW, site)) throw new ForbiddenError()
    const revision = query.revision ?? quote.currentRevision
    const version = await db.quoteVersion.findFirst({
      where: { quoteId: quote.id, revision },
      select: {
        id: true,
        revision: true,
        status: true,
        promiseDate: true,
        shipTo: true,
        billTo: true,
        version: true,
        lines: { select: { id: true, seq: true, kind: true, styleId: true, styleRevisionId: true, colourwayId: true, baseSize: true, sizes: { select: { size: true, quantity: true }, orderBy: { size: 'asc' } }, style: { select: { baseSize: true, sizes: true } } }, orderBy: { seq: 'asc' } },
      },
    })
    if (!version) throw new NotFoundError(`Revision ${revision} of the quote not found.`)
    const { where, view } = await whereOf(db, site, serverClock.now(), countryOf(version.shipTo) ?? countryOf(version.billTo))
    const wanted = query.wantedDate ?? (version.promiseDate ? version.promiseDate.toISOString().slice(0, 10) : null)
    const asks: PromiseAsk[] = []
    const skipped: { lineId: string; seq: number; why: string }[] = []
    const options = await quoteLineOptionsOf(db, version.lines.map((line) => line.id)) // B-W2b-365
    for (const line of version.lines) {
      if (line.kind === 'FEE') {
        skipped.push({ lineId: line.id, seq: line.seq, why: 'A fee is not made.' })
        continue
      }
      if (line.kind === 'MADE_TO_MEASURE') {
        const size = line.baseSize ?? line.style.baseSize
        if (!size) {
          skipped.push({ lineId: line.id, seq: line.seq, why: 'A made-to-measure line without a base size cannot be planned.' })
          continue
        }
        asks.push({ key: line.id, styleId: line.styleId, colourwayId: line.colourwayId, revisionId: line.styleRevisionId, sizes: [{ size, quantity: 1 }], madeToMeasure: true, wantedDate: wanted, optionValueIds: options.get(line.id) ?? [] })
        continue
      }
      // The style's size order (the quote line's sizes are read alphabetically).
      const order = line.style.sizes
      const sizes = [...line.sizes].filter((size) => size.quantity > 0).sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size))
      if (sizes.length === 0) {
        skipped.push({ lineId: line.id, seq: line.seq, why: 'The line has no pieces.' })
        continue
      }
      asks.push({ key: line.id, styleId: line.styleId, colourwayId: line.colourwayId, revisionId: line.styleRevisionId, sizes, wantedDate: wanted, optionValueIds: options.get(line.id) ?? [] })
    }
    const answers = asks.length === 0 ? [] : await answerPromises(db, where, asks)
    const lines = answers.map((answer) => {
      const line = version.lines.find((candidate) => candidate.id === answer.key)!
      return { lineId: line.id, seq: line.seq, answer, deliveries: deliveriesOf(answer) }
    })
    const dated = answers.flatMap((answer) => (answer.date ? [answer.date] : []))
    const promiseDate = dated.length === 0 ? null : dated.reduce((a, b) => (a > b ? a : b))
    const incomplete = answers.filter((answer) => !answer.complete).length
    const words =
      promiseDate === null
        ? 'No line of the quote can be promised.'
        : `Every line ready by ${dayWords(promiseDate, view.today)}${incomplete > 0 ? `; ${incomplete} line(s) have sizes that are not promised` : ''}.`
    return {
      ...view,
      quote: { id: quote.id, number: quote.number, revision: version.revision, status: version.status, promiseDate: version.promiseDate ? version.promiseDate.toISOString().slice(0, 10) : null, version: version.version },
      promiseDate,
      lines,
      skipped,
      mayUse: version.status === 'DRAFT' && can(actor, QUOTES_MANAGE, { companyId: quote.companyId, partyId: quote.partyId }),
      words,
    }
  })
}
