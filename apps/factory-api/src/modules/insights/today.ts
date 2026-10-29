import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  attentionFor,
  countsOf,
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

export interface TodayQuery {
  readonly kind?: AttentionKind | undefined
  /** One of the design's tiles: Approvals or Alerts on my records. */
  readonly category?: Category | undefined
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
  const kinds = sourcesFor(viewer.actor)
  const answers: SourceAnswer[] = []
  for (const kind of kinds) answers.push(await SOURCES[kind]({ caller, viewer }))
  const rows = attentionFor(
    viewer,
    answers.flatMap((answer) => answer.candidates),
  ).filter((item) => matchesScope(item, filter))
  const stored = await caller.withClient((db) => readActions(db, rows.map((item) => item.key)))
  const mine = withActions(rows, new Map([...stored].map(([key, row]) => [key, storedOf(row)]))).items
  const tiles = tileKindsFor(viewer.actor)
  const counts = countsOf(mine, tiles)
  const shown = mine.filter((item) => (!query.kind || item.kind === query.kind) && (!query.category || item.category === query.category))
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
