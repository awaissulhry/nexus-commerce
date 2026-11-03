import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DISPATCH_STATES } from '@nexus/factory-domain/planning/schedule/dispatch'
import { READINESS_WORDS } from '@nexus/factory-domain/planning/readiness/readiness'
import { HANDOVER_LIMITS, HANDOVER_TOPICS } from '@nexus/factory-domain/production/dispatch/handover'
import { LOAD_SOURCES, LOAD_STATES, PRESENCE_STATES } from '@nexus/factory-domain/production/dispatch/load'
import { MATERIAL_SCOPES, MATERIAL_STATES } from '@nexus/factory-domain/production/dispatch/material'
import { PAPER_LANGUAGES } from '@nexus/factory-domain/production/dispatch/paper'
import { ASSIGNMENT_KINDS, DISPATCH_LIMITS, SEQUENCE_STATES } from '@nexus/factory-domain/production/dispatch/rules'
import { QUALIFICATION_MODES } from '@nexus/factory-domain/people/skills/qualification'
import { SKILL_LEVELS } from '@nexus/factory-domain/people/skills/rules'
import { FLOOR_RULE_MODES } from '@nexus/factory-domain/production/settings/floor-rules'
import { SCAN_SUBJECTS } from '@nexus/factory-domain/production/settings/monitoring'

/**
 * The dispatch list per line or station (B-W2a-34; MES-021; design floor.mywork "Next" and "Then", the office's view of
 * the same list): read from the site's CURRENT published version of the plan (Owner answer P3), never the working plan.
 * Per work order, operation, line and station: no person, no money (Statuto dei Lavoratori art. 4; a floor session holds
 * no price, cost or margin grain).
 *
 * B-W2b-49: the entries also say what the site's sequence rule makes of them and the work order's material flag, and on a
 * day the board changed they follow it (a card with no slot names its assignment in `slotId`, the day in its times). Below
 * the W2a list, every route of dispatch every shift: the board, the operators, assigning, moving, My work, the team
 * leader's line view, handover notes, the printed list.
 */

const named = output({ id: id(), code: z.string(), name: z.string() })

const sequenceView = output({ rule: z.enum(FLOOR_RULE_MODES), state: z.enum(SEQUENCE_STATES), words: z.string().nullable() })

/** B-W2b-88: `scope` OPERATION where the BOM ties lines to steps (the operation's own material), else WORK_ORDER. */
const materialView = output({ state: z.enum(MATERIAL_STATES), word: z.enum(READINESS_WORDS), label: z.string(), date: businessDate().nullable(), words: z.string(), scope: z.enum(MATERIAL_SCOPES), icon: z.string(), tone: z.string() })

const entryView = output({
  slotId: id(),
  workOrder: output({
    id: id(),
    number: z.string(),
    status: z.string(),
    priority: z.number().int(),
    /** The work order's rush flag (B-W2b-51, MES-009): first in the list, with an icon and a word on the floor. */
    rush: z.boolean(),
    dueDate: businessDate().nullable(),
    style: output({ code: z.string(), name: z.string() }),
    holdReason: z.string().nullable(),
  }),
  operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }),
  /** The operation before it on the work order (B-W2a-74: the floor says "Waiting for Op 20 …" in its own words); null: the first. */
  previous: output({ seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
  startAt: instant(),
  endAt: instant(),
  /** The garments it is about: the work order's (a part of an order: the part's). */
  garments: z.number().int(),
  /** Standard minutes of the entry (standard minutes × garments still to do). */
  minutes: z.string(),
  state: z.enum(DISPATCH_STATES),
  /** The status word's sentence ("Waiting for Op 20 Sewing"). */
  words: z.string(),
  /** From the floor's scans at the operation: garments arrived, waiting (arrived, not reported), done (good + scrapped). */
  arrived: z.number().int(),
  waiting: z.number().int(),
  done: z.number().int(),
  /** B-W2b-49 (MES-025): the site's sequence rule on this work. */
  sequence: sequenceView,
  /**
   * B-W2b-49 (MES-026): its material flag; B-W2b-88: the operation's own where the BOM ties lines to steps (scope); null: not
   * read, or the operation uses no material.
   */
  material: materialView.nullable(),
})

export const dispatchView = output({
  site: output({ id: id(), code: z.string(), name: z.string(), timeZone: z.string() }),
  target: output({ kind: z.enum(['LINE', 'WORK_CENTRE', 'STATION']), id: id(), code: z.string(), name: z.string(), line: named.nullable(), workCentre: named.nullable() }).nullable(),
  asOf: instant(),
  /** The version the floor works to now; null: nothing published (or started) yet. */
  version: output({ id: id(), number: z.number().int(), coversFrom: businessDate(), coversTo: businessDate(), effectiveFrom: instant(), publishedAt: instant() }).nullable(),
  /** A later version waiting for its start ("New schedule v13 from 06:00"). */
  upcoming: output({ id: id(), number: z.number().int(), effectiveFrom: instant() }).nullable(),
  /** The one next task (the first READY entry). */
  next: entryView.nullable(),
  entries: z.array(entryView),
  /** The empty or held state in words; null when there are entries. */
  words: z.string().nullable(),
})

export const officeDispatchContract = defineContract({
  querystring: input({ lineId: id().optional(), workCentreId: id().optional(), stationId: id().optional() }),
  response: { 200: dispatchView },
})
export type OfficeDispatchQuery = z.infer<typeof officeDispatchContract.querystring>

export const stationDispatchContract = defineContract({
  response: { 200: dispatchView },
})

// ---- B-W2b-49: dispatch every shift --------------------------------------------------------------------------------------

const siteView = output({ id: id(), code: z.string(), name: z.string(), timeZone: z.string() })
const versionView = output({ id: id(), number: z.number().int(), coversFrom: businessDate(), coversTo: businessDate(), effectiveFrom: instant(), publishedAt: instant() })
const refView = output({ id: id(), code: z.string(), name: z.string() })

const loadView = output({
  queuedMinutes: z.number().int(),
  availableMinutes: z.number().int(),
  overMinutes: z.number().int(),
  spareMinutes: z.number().int(),
  state: z.enum(LOAD_STATES),
  source: z.enum(LOAD_SOURCES),
  /** People counted; null under the company's minimum group size. */
  people: z.number().int().nullable(),
  efficiencyPct: z.string(),
  /** Assigned operators not in, a line's count; null under the minimum group size. */
  absent: z.number().int().nullable(),
  /** "Queued 2,410 min · available 2,160 min · 250 min over". */
  words: z.string(),
  sourceWords: z.string().nullable(),
})

/** A name beside a station or a card: a floor name and a skill level, never a figure. `presence` only for whoever runs the board. */
const operatorView = output({
  assignmentId: id(),
  version: z.number().int(),
  kind: z.enum(ASSIGNMENT_KINDS),
  workerId: id(),
  name: z.string(),
  level: z.enum(SKILL_LEVELS).nullable(),
  levelLabel: z.string().nullable(),
  trainee: z.boolean(),
  overridden: z.boolean(),
  presence: z.enum(PRESENCE_STATES).nullable(),
  reassign: z.boolean(),
  words: z.string().nullable(),
})

const cardView = output({
  id: z.string(),
  /** What a move names as `from`. */
  key: z.string(),
  workOrder: output({ id: id(), number: z.string(), status: z.string(), priority: z.number().int(), rush: z.boolean(), dueDate: businessDate().nullable(), style: output({ code: z.string(), name: z.string() }), holdReason: z.string().nullable() }),
  operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string(), workCentreId: id() }),
  previous: output({ seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
  /** B-W2b-88 (MES-025): the operations it runs side by side with (its parallel group); null: in sequence. */
  parallel: output({ group: z.number().int(), with: z.array(output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() })) }).nullable(),
  stationId: id().nullable(),
  lineId: id().nullable(),
  bundles: z.array(output({ id: id(), code: z.string(), garments: z.number().int() })),
  whole: z.boolean(),
  pieces: z.number().int(),
  standardMinutes: z.string(),
  minutes: z.string(),
  state: z.enum(DISPATCH_STATES),
  words: z.string(),
  sequence: sequenceView,
  material: materialView.nullable(),
  order: z.number().int().nullable(),
  /** It counts in the line's load (released work, not on hold). */
  counted: z.boolean(),
  movable: z.boolean(),
  operators: z.array(operatorView),
  reassign: z.boolean(),
})

const stationLaneView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  lineId: id().nullable(),
  workCentreId: id(),
  operators: z.array(operatorView),
  queuedMinutes: z.string(),
  cards: z.array(cardView),
  reassign: z.boolean(),
})

export const boardContract = defineContract({
  querystring: input({ siteId: id(), date: businessDate().optional(), lineId: id().optional() }),
  response: {
    200: output({
      site: siteView,
      day: businessDate(),
      today: businessDate(),
      past: z.boolean(),
      asOf: instant(),
      version: versionView.nullable(),
      rules: output({ sequence: z.enum(FLOOR_RULE_MODES), qualification: z.enum(QUALIFICATION_MODES), qualificationWords: z.string(), scanSubject: z.enum(SCAN_SUBJECTS), namesWorkers: z.boolean() }),
      attendance: output({ open: z.boolean(), words: z.string().nullable() }),
      lines: z.array(output({ id: id(), code: z.string(), name: z.string(), load: loadView, stations: z.array(stationLaneView) })),
      otherStations: z.array(stationLaneView),
      notAssigned: z.array(cardView),
      words: z.string().nullable(),
      mayManage: z.boolean(),
      mayWriteHandover: z.boolean(),
    }),
  },
})

export const operatorsContract = defineContract({
  querystring: input({ siteId: id().optional(), date: businessDate().optional(), stationId: id().optional(), lineId: id().optional(), workOrderOperationId: id().optional(), assignmentId: id().optional() }),
  response: {
    200: output({
      siteId: id(),
      day: businessDate(),
      asOf: instant(),
      attendance: output({ open: z.boolean(), words: z.string().nullable() }),
      clockedOnly: z.boolean(),
      operators: z.array(
        output({
          workerId: id(),
          name: z.string(),
          level: z.enum(SKILL_LEVELS).nullable(),
          levelLabel: z.string().nullable(),
          trainee: z.boolean(),
          clockedIn: z.boolean().nullable(),
          onBreak: z.boolean().nullable(),
          onThisLine: z.boolean(),
          decision: z.enum(['ALLOW', 'WARN', 'HOLD']),
          overridable: z.boolean(),
          words: z.string().nullable(),
        }),
      ),
      complete: z.boolean(),
      mayManage: z.boolean(),
    }),
  },
})

const overrideReason = z.string().trim().min(1).max(DISPATCH_LIMITS.overrideReason)

const assignmentView = output({
  id: id(),
  kind: z.enum(ASSIGNMENT_KINDS),
  day: businessDate(),
  lineId: id().nullable(),
  stationId: id().nullable(),
  workOrderId: id().nullable(),
  workOrderOperationId: id().nullable(),
  bundleIds: z.array(id()),
  workerId: id().nullable(),
  sequence: z.number().int().nullable(),
  overridden: z.boolean(),
  note: z.string().nullable(),
  version: z.number().int(),
})

const assignedAnswer = output({ assignment: assignmentView, overridden: z.boolean() })

export const assignContract = defineContract({
  body: input({
    date: businessDate().optional(),
    workerId: id(),
    stationId: id().optional(),
    workOrderOperationId: id().optional(),
    bundleIds: z.array(id()).max(DISPATCH_LIMITS.bundles).optional(),
    overrideReason: overrideReason.optional(),
    note: z.string().trim().max(DISPATCH_LIMITS.note).optional(),
  }),
  response: { 201: assignedAnswer },
})

const assignmentParams = input({ assignmentId: id() })

export const reassignContract = defineContract({
  params: assignmentParams,
  body: input({ version: z.number().int(), workerId: id(), overrideReason: overrideReason.optional() }),
  response: { 200: assignedAnswer },
})

export const removeContract = defineContract({
  params: assignmentParams,
  body: input({ version: z.number().int() }),
  response: { 200: output({ removed: id() }) },
})

const moveTarget = input({ stationId: id().nullable().optional(), lineId: id().nullable().optional(), workerId: id().nullable().optional(), unplaced: z.boolean().optional(), clearWorker: z.boolean().optional() })

export const moveContract = defineContract({
  body: input({
    date: businessDate().optional(),
    workOrderOperationId: id(),
    from: z.string().min(1).max(200),
    bundleIds: z.array(id()).max(DISPATCH_LIMITS.bundles).optional(),
    to: moveTarget,
    position: z.number().int().min(1).max(10_000).optional(),
    overrideReason: overrideReason.optional(),
  }),
  response: {
    200: output({
      moved: output({ key: z.string(), bundleIds: z.array(id()), whole: z.boolean(), stationId: id().nullable(), lineId: id().nullable() }),
      warnings: z.array(z.string()),
      /** The body that puts it back (design: "every move has Undo"). */
      undo: output({
        date: businessDate(),
        workOrderOperationId: id(),
        from: z.string(),
        bundleIds: z.array(id()).optional(),
        to: output({ stationId: id().nullable(), lineId: id().nullable(), workerId: id().nullable(), unplaced: z.boolean(), clearWorker: z.boolean() }),
        position: z.number().int().optional(),
      }),
    }),
  },
})

const myEntryView = entryView.extend({ station: output({ id: id(), code: z.string(), name: z.string() }).nullable(), bundles: z.number().int(), current: z.boolean() })

export const mineContract = defineContract({
  response: {
    200: output({ site: siteView, asOf: instant(), day: businessDate(), version: versionView.nullable(), current: myEntryView.nullable(), next: myEntryView.nullable(), entries: z.array(myEntryView), words: z.string().nullable() }),
  },
})

export const floorLineContract = defineContract({
  querystring: input({ lineId: id().optional() }),
  response: {
    200: output({
      line: refView,
      site: siteView,
      day: businessDate(),
      asOf: instant(),
      shift: z.string(),
      load: loadView,
      stations: z.array(
        output({
          id: id(),
          code: z.string(),
          name: z.string(),
          /** Someone is signed in on a tablet of the station (Owner answer F2: "nobody signed in", never who). */
          signedIn: z.boolean(),
          work: output({ cards: z.number().int(), pieces: z.number().int(), minutes: z.string() }),
          material: output({ state: z.enum(MATERIAL_STATES), icon: z.string(), tone: z.string() }).nullable(),
          reassign: z.array(output({ assignmentId: id(), version: z.number().int(), kind: z.enum(ASSIGNMENT_KINDS), workOrder: output({ number: z.string() }).nullable(), operation: output({ seq: z.number().int(), name: z.string() }).nullable(), words: z.string() })),
        }),
      ),
      mayManage: z.boolean(),
      mayWriteHandover: z.boolean(),
    }),
  },
})

const noteView = output({
  id: id(),
  lineId: id(),
  shiftDate: businessDate(),
  shiftLabel: z.string(),
  topics: z.array(output({ topic: z.enum(HANDOVER_TOPICS), icon: z.string(), tone: z.string(), labelIt: z.string(), labelEn: z.string() })),
  text: z.string().nullable(),
  writtenAt: instant(),
  updatedAt: instant(),
  version: z.number().int(),
})

export const handoverContract = defineContract({
  querystring: input({ lineId: id(), days: z.coerce.number().int().min(1).max(31).optional() }),
  response: { 200: output({ line: refView, day: businessDate(), shift: z.string(), current: noteView.nullable(), notes: z.array(noteView), mayWrite: z.boolean() }) },
})

export const writeHandoverBody = input({
  lineId: id(),
  date: businessDate().optional(),
  shiftLabel: z.string().trim().min(1).max(HANDOVER_LIMITS.shiftLabel).optional(),
  topics: z.array(z.enum(HANDOVER_TOPICS)).max(HANDOVER_TOPICS.length),
  text: z.string().max(HANDOVER_LIMITS.text).nullable().optional(),
  version: z.number().int().optional(),
  at: instant().optional(),
})

export const writeHandoverContract = defineContract({
  body: writeHandoverBody,
  response: { 200: output({ note: noteView, created: z.boolean() }) },
})

export const newHandoverContract = defineContract({
  response: { 200: output({ line: refView.nullable(), since: instant().nullable(), notes: z.array(noteView) }) },
})

const printQuery = input({ lineId: id().optional(), stationId: id().optional(), date: businessDate().optional(), language: z.enum(PAPER_LANGUAGES).optional() })

export const printContract = defineContract({ querystring: printQuery, response: {} })

export const paperContract = defineContract({
  querystring: printQuery,
  response: {
    200: output({
      language: z.enum(PAPER_LANGUAGES),
      title: z.string(),
      heading: z.string(),
      facts: z.array(output({ label: z.string(), value: z.string() })),
      columns: z.array(z.string()),
      sections: z.array(output({ title: z.string(), operators: z.string().nullable(), rows: z.array(output({ rush: z.boolean(), cells: z.array(z.string()) })), footer: z.string() })),
      empty: z.string().nullable(),
      foot: z.string(),
      pageLabel: z.string(),
      fileName: z.string(),
    }),
  },
})
