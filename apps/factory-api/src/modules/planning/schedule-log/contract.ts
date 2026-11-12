import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CHANGE_KINDS, CHANGE_LOG_LIMITS, UNDO_HOLDS } from '@nexus/factory-domain/planning/schedule-log/changes'
import { VERSION_COMPARE_STATES } from '@nexus/factory-domain/planning/schedule-log/compare'
import { SHEET_LANGUAGES } from '@nexus/factory-domain/planning/schedule-log/day-sheet'
import { SCHEDULE_LANE_KINDS, SLOT_LIMITS } from '@nexus/factory-domain/planning/schedule/slots'
import { overView, siteView, storedSlot } from '../schedule/contract'
import { floorStatusView } from './floor-contract'

/**
 * The board's record (B-W2b-329; PLN-133, PLN-149, PLN-154; design planning.board sec:log "Changes", pop "Print day sheets",
 * the new tabs "Day sheet per line (PDF)" and "Published version v12 (read-only)"). Instants are UTC ISO strings, days the
 * site's. No money; per line, work centre, workshop and work order; a planner (an office user) named inside an entry only,
 * never counted or totalled per person.
 */

const person = output({ id: id(), name: z.string() }).nullable()
const laneNamed = output({ kind: z.enum(SCHEDULE_LANE_KINDS), id: id(), code: z.string(), name: z.string() })
const place = output({ lane: laneNamed, startAt: instant(), endAt: instant() })

export const changeEntry = output({
  id: id(),
  kind: z.enum(CHANGE_KINDS),
  changedAt: instant(),
  changedBy: person,
  /** Every kind but PUBLISH: the slot (by id: a slot taken off the board keeps its id here). */
  slotId: id().nullable(),
  /** The slot is on the working plan now. */
  onBoard: z.boolean(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  /** null: a whole-order part (or a publish). */
  operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
  /** Where it was and where it went (ChangeValue from → to). */
  from: place.nullable(),
  to: place.nullable(),
  /** Why (the reason it was kept on an overbooked lane; a publish's note; an undo's). */
  reason: z.string().nullable(),
  whatIfScenarioId: id().nullable(),
  /** PUBLISH: the version it made. */
  publishedVersion: output({ id: id(), number: z.number().int() }).nullable(),
  /** UNDO: the change it put back. */
  undoes: output({ id: id(), kind: z.enum(CHANGE_KINDS) }).nullable(),
  /** The undo of it, when it was undone (who and when). */
  undoneBy: output({ id: id(), changedAt: instant(), changedBy: person }).nullable(),
  /** "Undo" on the entry: whether it may be undone now by the reader, and why not (code; words in `undo.words`). */
  undo: output({ may: z.boolean(), code: z.enum(UNDO_HOLDS).nullable(), permission: z.string().nullable(), words: z.string().nullable() }),
  words: z.string(),
})
export type ChangeEntry = z.infer<typeof changeEntry>

export const changesContract = defineContract({
  querystring: input({
    siteId: id(),
    /** PUBLISHED (default): the changes since the last published version ("No moves since v12"); ALL: the whole log. */
    since: z.enum(['PUBLISHED', 'ALL']).optional(),
    /** Kinds, comma separated (PLACE,MOVE,…). */
    kinds: z.string().max(80).optional(),
    /** One planner's changes ("Filter by planner"): an office user. */
    changedById: id().optional(),
    workOrderId: id().optional(),
    slotId: id().optional(),
    /** The `next` of the page before. */
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(CHANGE_LOG_LIMITS.maxPage).optional(),
  }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      plan: output({ id: id().nullable(), version: z.number().int().nullable() }),
      /** The published version the feed starts after (null: the whole log, or nothing published yet). */
      since: output({ id: id(), number: z.number().int(), publishedAt: instant() }).nullable(),
      entries: z.array(changeEntry),
      next: z.string().nullable(),
    }),
  },
})
export type ChangesQuery = z.infer<typeof changesContract.querystring>

export const undoContract = defineContract({
  params: input({ changeId: id() }),
  body: input({
    /** "Keep with a reason": required when putting the bar back overbooks its lane. */
    overloadReason: z.string().max(SLOT_LIMITS.reason).nullable().optional(),
  }),
  response: {
    200: output({
      /** The UNDO entry, and the change it undid (now undone). */
      undo: changeEntry,
      undone: changeEntry,
      /** The slot after the undo (null: it is off the board). */
      slot: storedSlot.nullable(),
      planVersion: z.number().int(),
      over: z.array(overView),
      replayed: z.boolean(),
    }),
  },
})
export type UndoBody = z.infer<typeof undoContract.body>

const sheetQuery = input({
  siteId: id(),
  /** Default today (the site's day). */
  date: businessDate().optional(),
  /** Lines and work centres, comma separated (≤ 30 in all); default every active line of the site. */
  lineIds: z.string().max(30 * 37).optional(),
  workCentreIds: z.string().max(30 * 37).optional(),
  /** PUBLISHED (default): the version the floor works to that day (or `versionId`); WORKING: the working plan. */
  plan: z.enum(['PUBLISHED', 'WORKING']).optional(),
  versionId: id().optional(),
  language: z.enum(SHEET_LANGUAGES).optional(),
})
export type SheetQuery = z.infer<typeof sheetQuery>

export const daySheetsContract = defineContract({ querystring: sheetQuery, response: {} })

export const daySheetsPaperContract = defineContract({
  querystring: sheetQuery,
  response: {
    200: output({
      language: z.enum(SHEET_LANGUAGES),
      title: z.string(),
      columns: z.array(z.string()),
      sheets: z.array(
        output({
          heading: z.string(),
          facts: z.array(output({ label: z.string(), value: z.string() })),
          banner: z.string().nullable(),
          rows: z.array(output({ rush: z.boolean(), pinned: z.boolean(), cells: z.array(z.string()) })),
          empty: z.string().nullable(),
          footer: z.string(),
        }),
      ),
      foot: z.string(),
      pageLabel: z.string(),
      fileName: z.string(),
    }),
  },
})

const versionHeader = output({
  id: id(),
  number: z.number().int(),
  previousId: id().nullable(),
  coversFrom: businessDate(),
  coversTo: businessDate(),
  effectiveFrom: instant(),
  publishedAt: instant(),
  publishedBy: person,
  note: z.string().nullable(),
})

const versionSlot = storedSlot.extend({
  workOrder: output({ id: id(), number: z.string(), status: z.string(), rush: z.boolean(), dueDate: businessDate().nullable(), style: output({ id: id(), code: z.string(), name: z.string() }) }),
  operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
  laneCode: z.string(),
  laneName: z.string(),
  /** Its state on the floor now (null: its work order is not open). */
  floor: floorStatusView.nullable(),
  /** The working plan beside it: SAME, MOVED (where it is now), REMOVED. */
  working: output({ state: z.enum(VERSION_COMPARE_STATES), slot: output({ id: id(), lane: output({ kind: z.enum(SCHEDULE_LANE_KINDS), id: id() }), startAt: instant(), endAt: instant() }).nullable() }),
})

export const versionBoardContract = defineContract({
  params: input({ versionId: id() }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      version: versionHeader,
      /** It never changes: no move, pin or publish from it. */
      readOnly: z.literal(true),
      /** The floor works to it now; it waits for its start; or a later version replaced it. */
      floor: z.enum(['CURRENT', 'UPCOMING', 'REPLACED']),
      lanes: z.array(laneNamed),
      slots: z.array(versionSlot),
      /** The working plan on the version's days against it. */
      compare: output({
        moved: z.number().int(),
        added: z.number().int(),
        removed: z.number().int(),
        words: z.string(),
        addedSlots: z.array(output({ id: id(), workOrderId: id(), operationId: id().nullable(), lane: output({ kind: z.enum(SCHEDULE_LANE_KINDS), id: id() }), startAt: instant(), endAt: instant() })),
      }),
    }),
  },
})
