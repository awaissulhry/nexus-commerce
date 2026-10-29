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
  type AttentionItem,
  type AttentionKind,
  type ItemAmounts,
} from '@nexus/factory-domain/insights/attention'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../core/command'
import type { SourceAnswer } from './sources/common'
import { SOURCES } from './sources'
import { scopeFilterOf, viewerOf } from './viewer'

/**
 * GET /home/today (B-W1-52; ANA-037; A2 SCR-029 "Needs me now" and "Your day"): every source the person can see is read
 * (one after another), the rows are matched to the person (factory-domain insights/attention whyMine: the right to act,
 * four eyes, the grain a decision rests on), filtered by company and site, ranked, counted per kind for the tiles, and
 * paged after the cursor. The tiles count the rows under the company and site filters, never the kind filter (a tile is a
 * filter of the same list: pressing it shows exactly its count). Read only.
 */

export interface TodayQuery {
  readonly kind?: AttentionKind | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

export function itemView(item: AttentionItem) {
  return {
    key: item.key,
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
    due: item.due,
    since: toUtcIso(item.since),
    ageDays: item.ageDays,
    decide: item.decide,
    figures: amountsView(item.amounts),
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
  const mine = attentionFor(
    viewer,
    answers.flatMap((answer) => answer.candidates),
  ).filter((item) => matchesScope(item, filter))
  const tiles = tileKindsFor(viewer.actor)
  const counts = countsOf(mine, tiles)
  const shown = query.kind ? mine.filter((item) => item.kind === query.kind) : mine
  const page = pageOf(shown, cursor, query.limit)
  return {
    asOf: toUtcIso(viewer.now),
    today: viewer.today,
    counts: {
      total: counts.total,
      now: counts.now,
      byCategory: counts.byCategory,
      tiles: counts.byKind.map((tile) => ({ ...tile, complete: answers.find((answer) => answer.kind === tile.kind)?.complete ?? true, filter: { kind: tile.kind } })),
    },
    total: shown.length,
    items: page.items.map(itemView),
    nextCursor: page.nextCursor,
    // The kinds the person acts on: their rows change after these events (every one has a live rule: GET /live).
    live: { events: liveEventsOf(tiles) },
  }
}
