import type { FactoryClient } from '@nexus/factory-db'
import { PARTY_WORK_GROUPS, type PartySort, type PartyWorkBand, type PartyWorkGroup } from '@nexus/factory-domain/parties/contracts'
import { PRIORITY_LEVELS, type PriorityLevel } from '@nexus/factory-domain/planning/backlog/rank'
import type { OrderPhase } from '@nexus/factory-domain/production-brand/stages'
import type { CommandCaller, CommandTx } from '../../core/command'
import type { KeyPart } from './cursor'

/**
 * B-CL-001 / B-CL-002 (customers list, 13-backend §1–§3): where each customer's work stands, as the parties list reads it — the
 * band (`band=true`), its door (`work=<GROUP>`) and the most urgent order (`sort=needs`).
 *
 * The facts are the SALES module's (modules/sales/orders/customer-work.ts partyWorkKeys: one function for the band, the filter, the
 * order and the row's chips, so they never disagree). The parties module never imports sales: the sales module registers its reader
 * here when it loads (`usePartyWork`, once, as customer-urgency's resolver hook), and the export source of the customers file loads it
 * in the worker. Until a reader is registered (a test without the sales module) nothing is known — an honest none: `work` keeps no row,
 * the band is null and `sort=needs` comes back by code (`sortedBy: 'code'`).
 *
 * What is pure lives here (the groups, the needs order, the band, the order of a page), so a unit test pins it without a database.
 */

/** One customer's work: counts only, never an amount, never a person. */
export interface PartyWork {
  /** The orders in each of the seven phases (0 as 0): the orders' own phase rule (production-brand/stages, phaseCountsByParty). */
  readonly phases: Readonly<Record<OrderPhase, number>>
  /** What waits on us: requests to answer (OPEN), conversations whose customer wrote last, late orders. */
  readonly waiting: { readonly requests: number; readonly replies: number; readonly late: number }
  /** The oldest request to answer (the review window's door); null: none. */
  readonly firstRequestId: string | null
  /** Orders waiting for a yes (PENDING_APPROVAL). */
  readonly waitsForYes: number
  /** Orders confirmed whose deposit is still open (inside Not sent). */
  readonly waitsForDeposit: number
  /** Its most urgent OPEN order (not shipped yet; T31) by our rule (level, priority number, promise); null: none. */
  readonly best: { readonly level: PriorityLevel; readonly priority: number; readonly promise: string | null } | null
}

/** The facts of every customer the reader's orders reach; a customer with nothing to count is absent (never a row of zeros). */
export interface PartyWorkFacts {
  readonly byParty: ReadonlyMap<string, PartyWork>
  /** Every reply candidate was read (false: more than the threads' read cap wait; the band says so in words). */
  readonly repliesComplete: boolean
  /** Every grant of the reader's orders.view names its customers ("Your customers"). */
  readonly limited: boolean
}

/** The sales module's reader (a test's fake too). */
export interface PartyWorkSource {
  of(caller: CommandCaller, client: FactoryClient | CommandTx): Promise<PartyWorkFacts>
}

let source: PartyWorkSource | null = null

/** Registers the reader; `undefined` takes it away again. */
export function usePartyWork(next: PartyWorkSource | undefined): void {
  source = next ?? null
}

/** The facts of the reader's customers, or null while no reader is registered. */
export async function partyWorkOf(caller: CommandCaller, client: FactoryClient | CommandTx): Promise<PartyWorkFacts | null> {
  return source ? source.of(caller, client) : null
}

/** The refusal of `work`, `sort=needs` and `band=true` to a reader without orders.view anywhere (names no role). */
export const PARTY_WORK_REFUSAL: Readonly<{ en: string; it: string }> = Object.freeze({
  en: "Seeing where customers' work stands needs the right to see orders.",
  it: 'Per vedere a che punto è il lavoro dei clienti serve il permesso di vedere gli ordini.',
})

/** Something waits on us: a request to answer, a reply waiting or a late order (the Work strip's group "us"). */
const waitsOnUs = (work: PartyWork): boolean => work.waiting.requests + work.waiting.replies + work.waiting.late > 0

/** The customer is in this group of the band: NEEDS_US when something waits on us, a phase when it has an order in it. */
export function inWorkGroup(work: PartyWork | undefined, group: PartyWorkGroup): boolean {
  if (!work) return false
  if (group === 'NEEDS_US') return waitsOnUs(work)
  return work.phases[group] > 0
}

// ---- the needs order: most urgent first ------------------------------------------------------------------------------------

/** [waits on us 0 / 1, our level (Top first; none 4), −priority number, promise (none last), code, id]. */
export type NeedsKey = readonly [waiting: number, level: number, priority: number, promise: string, code: string, id: string]

const NO_PROMISE = '9999-12-31'
const NO_LEVEL = PRIORITY_LEVELS.length

/**
 * A customer's place in "Most urgent first": something waiting on us first, then its most urgent OPEN order (T31: the set of the
 * Top / High chips) by planning's rule order (our level, our priority number, its promise), then code and id. The customer's own
 * urgency is not a key.
 * A customer without facts sits after every one with work: [1, 4, 0, '9999-12-31', code, id].
 */
export function needsKeyOf(work: PartyWork | undefined, code: string, id: string): NeedsKey {
  const best = work?.best ?? null
  return [work && waitsOnUs(work) ? 0 : 1, best ? PRIORITY_LEVELS.indexOf(best.level) : NO_LEVEL, best ? 0 - best.priority : 0, best?.promise ?? NO_PROMISE, code, id]
}

const textOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
/** The name order's first part (trade name, else legal name): Italian, letter case and accents aside, numbers as numbers. */
const nameCollator = new Intl.Collator('it', { sensitivity: 'base', numeric: true })

/** Part by part: numbers as numbers, words by `first` for the first part (else by their characters), a shorter key first. */
function compareParts(a: readonly KeyPart[], b: readonly KeyPart[], first: (x: string, y: string) => number = textOrder): number {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const x = a[index]
    const y = b[index]
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : (index === 0 ? first : textOrder)(String(x), String(y))
    if (order !== 0) return order
  }
  return 0
}

/** The needs order of two keys (needsKeyOf). */
export function compareNeeds(a: NeedsKey, b: NeedsKey): number {
  return compareParts(a, b)
}

/** The order of two row keys in one of the list's orders (needs: needsKeyOf; name: [name, code, id]; code: [code, id]). */
export function compareRowKeys(sort: PartySort, a: readonly KeyPart[], b: readonly KeyPart[]): number {
  return sort === 'name' ? compareParts(a, b, nameCollator.compare) : compareParts(a, b)
}

// ---- the band -----------------------------------------------------------------------------------------------------------

/**
 * The band over these customers (the rows the view's other terms keep, `work` aside): per group the customers in it and (phases) the
 * orders of that phase, 0 as 0; the parts of "Needs us" and the two whys inside "Not sent" summed over them.
 */
export function workBandOf(ids: readonly string[], facts: PartyWorkFacts): PartyWorkBand {
  const works = ids.flatMap((id) => {
    const work = facts.byParty.get(id)
    return work ? [work] : []
  })
  const sum = (of: (work: PartyWork) => number): number => works.reduce((total, work) => total + of(work), 0)
  return {
    groups: PARTY_WORK_GROUPS.map((group) => ({
      group,
      customers: works.filter((work) => inWorkGroup(work, group)).length,
      orders: group === 'NEEDS_US' ? null : sum((work) => work.phases[group]),
    })),
    needsUs: { requests: sum((work) => work.waiting.requests), replies: sum((work) => work.waiting.replies), late: sum((work) => work.waiting.late), repliesComplete: facts.repliesComplete },
    notSent: { waitsForYes: sum((work) => work.waitsForYes), waitsForDeposit: sum((work) => work.waitsForDeposit) },
    limited: facts.limited,
  }
}

// ---- one view of the list in memory (GET /parties' memory path, steps 5–7) --------------------------------------------------

/** The most rows the needs and name orders sort in memory; above it the rows come by code (`sortedBy: 'code'`) and the web says so. */
export const PARTY_SORT_CAP = 2000

/** What the order needs of a candidate party. */
export interface WorkCandidate {
  readonly id: string
  readonly code: string
  readonly legalName: string
  readonly tradeName: string | null
}

/** The work terms of one read. */
export interface WorkAsk {
  readonly work: PartyWorkGroup | undefined
  readonly sort: PartySort
  readonly band: boolean
}

/** The view's rows in their order, the order they are in, the band (null unless asked and known) and each row's key (the cursor's). */
export interface ArrangedParties<C extends WorkCandidate> {
  readonly rows: readonly C[]
  readonly sortedBy: PartySort
  readonly band: PartyWorkBand | null
  readonly keyOf: (row: C) => readonly KeyPart[]
}

/**
 * The band over every candidate (before `work`), then `work` (only the customers in that group), then the order: needs (needsKeyOf),
 * name (trade name, else legal name, then code, then id) or code (code, then id). Without facts (no reader registered) `work` keeps
 * no row, the band is null and needs comes back by code; needs and name over more than PARTY_SORT_CAP rows come back by code.
 */
export function arrangeParties<C extends WorkCandidate>(candidates: readonly C[], facts: PartyWorkFacts | null, ask: WorkAsk): ArrangedParties<C> {
  const band = ask.band && facts ? workBandOf(candidates.map((row) => row.id), facts) : null
  const group = ask.work
  const kept: readonly C[] = group === undefined ? candidates : facts ? candidates.filter((row) => inWorkGroup(facts.byParty.get(row.id), group)) : []
  const wanted: PartySort = ask.sort === 'needs' && !facts ? 'code' : ask.sort
  const sortedBy: PartySort = wanted !== 'code' && kept.length > PARTY_SORT_CAP ? 'code' : wanted
  const keyOf = (row: C): readonly KeyPart[] =>
    sortedBy === 'needs' ? needsKeyOf(facts?.byParty.get(row.id), row.code, row.id) : sortedBy === 'name' ? [row.tradeName ?? row.legalName, row.code, row.id] : [row.code, row.id]
  const rows = kept
    .map((row) => ({ row, key: keyOf(row) }))
    .sort((a, b) => compareRowKeys(sortedBy, a.key, b.key))
    .map((entry) => entry.row)
  return { rows, sortedBy, band, keyOf }
}
