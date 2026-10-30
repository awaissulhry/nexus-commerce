import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  attentionFor,
  countsOf,
  isPersonalKind,
  liveEventsOf,
  matchesScope,
  pageOf,
  parseCursor,
  sourcesFor,
  tileKindsFor,
  KIND_RULES,
  type AttentionItem,
  type AttentionKind,
  type Category,
  type ItemAmounts,
} from '@nexus/factory-domain/insights/attention'
import { withActions, type RowActions } from '@nexus/factory-domain/insights/actions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../core/command'
import { actionsView, handledCount } from './actions'
import { peopleNames, readActions, storedOf } from './actions-store'
import type { SourceAnswer } from './sources/common'
import { SOURCES } from './sources'
import { scopeFilterOf, viewerOf } from './viewer'

/**
 * GET /home/today (B-W1-52; ANA-037; A2 SCR-029 "Needs me now" and "Your day"): every source the person can see is read
 * (one after another), the rows are matched to the person (factory-domain insights/attention whyMine: the right to act,
 * four eyes, the grain a decision rests on), filtered by company and site, ranked, counted per kind for the tiles, and
 * paged after the cursor. The tiles count the rows under the company and site filters, never the kind filter (a tile is a
 * filter of the same list: pressing it shows exactly its count). What people did about the rows (insights/actions) is
 * laid over them: a row resolved in its present condition is not on Today (for anyone, until the condition changes), an
 * assigned row says to whom, an acknowledged one by whom; each row says which verbs its reader may use. Read only.
 */

/** The W2a parts a screen asks for (B-W2a-20): my tasks due or overdue, my mentions, and their tiles; B-W2a-33: my open alerts. */
export const TODAY_INCLUDES = ['TASKS', 'MENTIONS', 'ALERTS'] as const

/**
 * B-W2a-33: with my stored alerts asked for, the W1 checks the exception rules replace are not computed again (the rule
 * of the same kind raises the alert, or is switched off): an order late or at risk, a purchase order not confirmed.
 */
const REPLACED_BY_RULES: ReadonlySet<AttentionKind> = new Set(['ORDER_PROMISE', 'PO_NOT_CONFIRMED'])
const includeOf = (kind: AttentionKind): TodayInclude => (kind === 'TASK_DUE' ? 'TASKS' : kind === 'RULE_ALERT' ? 'ALERTS' : 'MENTIONS')
export type TodayInclude = (typeof TODAY_INCLUDES)[number]

export interface TodayQuery {
  readonly kind?: AttentionKind | undefined
  /** One of the design's tiles: Approvals or Alerts on my records (W2a: my tasks, my mentions). */
  readonly category?: Category | undefined
  /** W2a tiles "Due today" and "Overdue": the rows due today, or overdue (any kind). */
  readonly due?: 'TODAY' | 'OVERDUE' | undefined
  /** W2a (B-W2a-20): the person's own rows. Without it the answer is W1's, unchanged. */
  readonly include?: readonly TodayInclude[] | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

export function itemView(item: AttentionItem & { readonly actions: RowActions }, names: ReadonlyMap<string, string>, me: string) {
  return {
    key: item.key,
    condition: item.condition,
    kind: item.kind,
    state: item.state,
    category: item.category,
    severity: item.severity,
    severityWord: item.severityWord,
    group: item.group,
    record: item.record,
    companyId: item.companyId,
    siteId: item.siteId,
    partyId: item.partyId,
    sentence: item.sentence,
    why: item.why,
    blocks: item.blocks,
    words: item.words,
    sentenceFigure: item.sentenceFigure,
    due: item.due,
    since: toUtcIso(item.since),
    ageDays: item.ageDays,
    decide: item.decide,
    figures: amountsView(item.amounts),
    actions: actionsView(item.actions, names, me),
  }
}

/** A row's amounts, each marked with its grain (the grain filter drops what the caller does not hold, again). */
export function amountsView(amounts: ItemAmounts | null) {
  if (!amounts) return null
  return {
    currency: amounts.currency,
    ...(amounts.netAmount === undefined ? {} : { netAmount: asMoney('price', amounts.netAmount) }),
    ...(amounts.purchaseAmount === undefined ? {} : { purchaseAmount: asMoney('cost', amounts.purchaseAmount) }),
    ...(amounts.marginPct === undefined ? {} : { marginPct: asMoney('margin', amounts.marginPct) }),
    ...(amounts.marginAmount === undefined ? {} : { marginAmount: asMoney('cost', amounts.marginAmount) }),
  }
}

export async function today(caller: CommandCaller, query: TodayQuery) {
  const viewer = viewerOf(caller)
  const cursor = query.cursor === undefined ? null : parseCursor(query.cursor)
  if (query.cursor !== undefined && cursor === null) throw new ValidationError('The cursor is not one this list gave.', [{ path: 'cursor', message: 'Not a cursor of this list.' }])
  const filter = await scopeFilterOf(caller, query)
  const included = new Set(query.include ?? [])
  // The person's own kinds only when the screen asks for them (a W1 screen reads W1's answer).
  const wanted = (kind: AttentionKind) => (isPersonalKind(kind) ? included.has(includeOf(kind)) : !(included.has('ALERTS') && REPLACED_BY_RULES.has(kind)))
  const kinds = sourcesFor(viewer.actor).filter(wanted)
  const answers: SourceAnswer[] = []
  for (const kind of kinds) answers.push(await SOURCES[kind]({ caller, viewer }))
  const rows = attentionFor(
    viewer,
    answers.flatMap((answer) => answer.candidates),
  ).filter((item) => matchesScope(item, filter))
  const stored = await caller.withClient((db) => readActions(db, rows.map((item) => item.key)))
  // Resolved rows, and (W2a) rows snoozed now, are not on Today.
  const mine = withActions(rows, new Map([...stored].map(([key, row]) => [key, storedOf(row)])), viewer.now).items
  const tiles = tileKindsFor(viewer.actor).filter(wanted)
  const counts = countsOf(mine, tiles)
  const dueWord = (item: { due: { word: string | null } | null }) => item.due?.word ?? null
  const shown = mine.filter(
    (item) => (!query.kind || item.kind === query.kind) && (!query.category || item.category === query.category) && (!query.due || dueWord(item) === query.due),
  )
  // A tile's count is a lower bound when a source of one of its kinds stopped at its limit.
  const completeFor = (category: Category | null) => answers.every((answer) => answer.complete || (category !== null && KIND_RULES[answer.kind].category !== category))
  const page = pageOf(shown, cursor, query.limit)
  const names = await caller.withClient((db) => peopleNames(db, page.items.flatMap((item) => [item.actions.assigned?.toId, item.actions.assigned?.byId, item.actions.acknowledged?.byId])))
  return {
    asOf: toUtcIso(viewer.now),
    today: viewer.today,
    counts: {
      total: counts.total,
      now: counts.now,
      // The design's three tiles (home.today focus-strip, W1): every row, the approvals, the alerts. Always all three.
      tiles: [
        { tile: 'ALL' as const, count: counts.total, complete: completeFor(null) },
        { tile: 'APPROVAL' as const, count: counts.byCategory.APPROVAL, complete: completeFor('APPROVAL') },
        { tile: 'ALERT' as const, count: counts.byCategory.ALERT, complete: completeFor('ALERT') },
        // W2a (design focus-strip "Due today · Overdue · Mentions"), only for a screen that asks for its own rows.
        ...(included.size > 0
          ? [
              { tile: 'DUE_TODAY' as const, count: mine.filter((item) => dueWord(item) === 'TODAY').length, complete: completeFor(null) },
              { tile: 'OVERDUE' as const, count: mine.filter((item) => dueWord(item) === 'OVERDUE').length, complete: completeFor(null) },
              ...(included.has('MENTIONS') ? [{ tile: 'MENTION' as const, count: counts.byCategory.MENTION, complete: completeFor('MENTION') }] : []),
            ]
          : []),
      ],
      byKind: counts.byKind.map((entry) => ({ ...entry, complete: answers.find((answer) => answer.kind === entry.kind)?.complete ?? true })),
    },
    total: shown.length,
    items: page.items.map((item) => itemView(item, names, viewer.personId)),
    nextCursor: page.nextCursor,
    /** "Handled today: N" (what I decided today: GET /home/today/handled). */
    handled: { today: await handledCount(caller, viewer) },
    // The kinds the person acts on: their rows change after these events (every one has a live rule: GET /live).
    live: { events: liveEventsOf(tiles) },
  }
}
