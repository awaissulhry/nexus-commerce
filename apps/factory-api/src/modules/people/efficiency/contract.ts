import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { OPERATION_STATES, REVIEW_DECISIONS, REVIEW_REASONS, EFFICIENCY_LIMITS } from '@nexus/factory-domain/people/efficiency/rules'
import { OPEN_REASONS, OPEN_NOTE_MAX } from '@nexus/factory-domain/people/privacy/figures'

/**
 * Efficiency (B-W2b-44; MES-247, MES-250, MES-251, ANA-016, ANA-017; design people.efficiency). Office only. No money. Per
 * line and per operation, never per person (Statuto dei Lavoratori art. 4; Owner answers W1, F2): a person key in a filter or
 * a group is refused in words; a group under the company's minimum size answers `tooFew` with every figure empty. One
 * person's figures are one route of their own, behind the site's PERFORMANCE legal gate.
 */

const minutes = z.string()
const percent = z.string()
const tooFew = { people: z.number().int().min(0).nullable(), tooFew: z.boolean(), words: z.string().nullable() }
const lineRef = output({ id: id(), code: z.string(), name: z.string() }).nullable()

/** The scope: a site, days and a line; a person key is taken so it can be refused in words. */
const scope = {
  siteId: id(),
  from: businessDate().optional(),
  to: businessDate().optional(),
  lineId: id().optional(),
  employeeId: z.string().max(64).optional(),
  workerId: z.string().max(64).optional(),
  groupBy: z.enum(['line', 'day', 'operation', 'style', 'employeeId', 'workerId', 'personId', 'operatorId']).optional(),
}

const lineFiguresOut = output({
  earnedMinutes: minutes.nullable(),
  attendedMinutes: minutes.nullable(),
  plannedMinutes: minutes.nullable(),
  offStandardMinutes: minutes.nullable(),
  onStandardMinutes: minutes.nullable(),
  efficiency: percent.nullable(),
  onStandardEfficiency: percent.nullable(),
  plannedEfficiency: percent.nullable(),
})

export const overviewContract = defineContract({
  querystring: input({ ...scope, compare: z.enum(['previous']).optional() }),
  response: {
    200: output({
      siteId: id(),
      from: businessDate(),
      to: businessDate(),
      asOf: instant(),
      attendance: output({ open: z.boolean(), provisional: z.boolean() }),
      /** The sum of the lines shown; null when none is shown. */
      tiles: lineFiguresOut.nullable(),
      previous: output({ from: businessDate(), to: businessDate(), tiles: lineFiguresOut.nullable() }).nullable(),
      lines: z.array(output({ line: lineRef, ...tooFew, figures: lineFiguresOut })),
      hiddenGroups: z.number().int().min(0),
      traineeDaysLeftOut: z.number().int().min(0),
      individual: output({ available: z.boolean(), words: z.string() }),
      how: output({ formulas: z.array(z.string()), sources: z.array(z.string()), exclusions: z.array(z.string()) }),
      words: z.array(z.string()),
    }),
  },
})

export const trendContract = defineContract({
  querystring: input(scope),
  response: {
    200: output({
      siteId: id(),
      from: businessDate(),
      to: businessDate(),
      lines: z.array(
        output({
          line: lineRef,
          /** The line's planned efficiency (Planning), the chart's target line. */
          targetPercent: percent.nullable(),
          points: z.array(output({ date: businessDate(), tooFew: z.boolean(), efficiency: percent.nullable(), onStandardEfficiency: percent.nullable(), earnedMinutes: minutes.nullable(), attendedMinutes: minutes.nullable() })),
        }),
      ),
      words: z.array(z.string()),
    }),
  },
})

const operationRef = output({ id: id(), code: z.string(), name: z.string(), seq: z.number().int() })
const styleRef = output({ id: id(), code: z.string(), name: z.string() })
const operationFiguresOut = output({
  bundles: z.number().int().nullable(),
  pieces: z.number().int().nullable(),
  actualMinutes: minutes.nullable(),
  differencePercent: percent.nullable(),
  state: z.enum(OPERATION_STATES).nullable(),
})
const dayPoint = output({ date: businessDate(), tooFew: z.boolean(), actualMinutes: minutes.nullable(), differencePercent: percent.nullable() })
const rule = output({ tolerancePercent: z.number(), minBundles: z.number().int() })

export const operationsContract = defineContract({
  querystring: input({ ...scope, styleId: id().optional() }),
  response: {
    200: output({
      siteId: id(),
      from: businessDate(),
      to: businessDate(),
      rule,
      operations: z.array(output({ routingOperationId: id(), style: styleRef, revisionId: id(), operation: operationRef, standardMinutes: minutes, ...tooFew, figures: operationFiguresOut, series: z.array(dayPoint) })),
      hiddenGroups: z.number().int().min(0),
      untimedReports: z.number().int().min(0),
      traineeBundles: z.number().int().min(0),
      words: z.array(z.string()),
    }),
  },
})

const decisionOut = output({ id: id(), decision: z.enum(REVIEW_DECISIONS), at: instant(), by: z.string(), reason: z.string().nullable(), proposedMinutes: minutes.nullable() })
const lastDecision = output({ id: id(), decision: z.enum(REVIEW_DECISIONS), at: instant() }).nullable()

export const operationDetailContract = defineContract({
  params: input({ routingOperationId: id() }),
  querystring: input({ siteId: id(), from: businessDate().optional(), to: businessDate().optional() }),
  response: {
    200: output({
      siteId: id(),
      from: businessDate(),
      to: businessDate(),
      routingOperationId: id(),
      style: styleRef,
      revisionId: id(),
      operation: operationRef,
      standardMinutes: minutes,
      people: z.number().int().min(0).nullable(),
      tooFew: z.boolean(),
      figures: operationFiguresOut,
      days: z.array(dayPoint),
      review: output({ reason: z.enum(REVIEW_REASONS).nullable(), since: businessDate().nullable(), lastDecision }),
      history: z.array(decisionOut),
      rule,
      words: z.array(z.string()),
    }),
  },
})

export const cycleTimeContract = defineContract({
  querystring: input({ ...scope, styleId: id().optional() }),
  response: {
    200: output({
      siteId: id(),
      from: businessDate(),
      to: businessDate(),
      operations: z.array(
        output({
          operation: output({ id: id(), code: z.string(), name: z.string() }),
          ...tooFew,
          figures: output({
            bundles: z.number().int().nullable(),
            pieces: z.number().int().nullable(),
            cycleMinutesPerBundle: minutes.nullable(),
            cycleMinutesPerPiece: minutes.nullable(),
            pausedMinutesPerBundle: minutes.nullable(),
            elapsedMinutesPerBundle: minutes.nullable(),
          }),
        }),
      ),
      hiddenGroups: z.number().int().min(0),
      words: z.array(z.string()),
    }),
  },
})

export const reviewQueueContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      siteId: id(),
      from: businessDate(),
      to: businessDate(),
      rule,
      count: z.number().int().min(0),
      queue: z.array(
        output({
          routingOperationId: id(),
          style: styleRef,
          revisionId: id(),
          operation: operationRef,
          standardMinutes: minutes,
          ...tooFew,
          figures: operationFiguresOut,
          direction: z.enum(['OVER', 'UNDER']).nullable(),
          reason: z.enum(REVIEW_REASONS),
          since: businessDate().nullable(),
          lastDecision,
        }),
      ),
      /** Off their standard, left out: too few people worked on them to show without identifying them. */
      leftOut: z.number().int().min(0),
      words: z.array(z.string()),
    }),
  },
})

export const decideContract = defineContract({
  params: input({ routingOperationId: id() }),
  body: input({
    siteId: id(),
    decision: z.enum(REVIEW_DECISIONS),
    reason: z.string().max(EFFICIENCY_LIMITS.reasonMax).nullable().optional(),
    /** CHANGE: what the standard should become, minutes per piece. */
    proposedMinutes: z.string().regex(/^\d{1,4}(\.\d{1,3})?$/).nullable().optional(),
    /** The last decision read (the queue's `lastDecision.id`; null: none): a decision made since is not overruled unseen. */
    basedOn: id().nullable(),
  }),
  response: { 200: output({ routingOperationId: id(), siteId: id(), decision: z.enum(REVIEW_DECISIONS), decidedAt: instant(), reason: z.string().nullable(), proposedMinutes: minutes.nullable(), style: output({ id: id(), revisionId: id() }), words: z.array(z.string()) }) },
})

export const personFiguresContract = defineContract({
  params: input({ employeeId: id() }),
  body: input({ siteId: id(), from: businessDate().optional(), to: businessDate().optional(), reason: z.enum(OPEN_REASONS).optional(), note: z.string().max(OPEN_NOTE_MAX).nullable().optional() }),
  response: {
    200: output({
      person: output({ employeeId: id(), name: z.string() }),
      siteId: id(),
      from: businessDate(),
      to: businessDate(),
      as: z.enum(['SELF', 'FIGURE_ROLE']),
      denominator: z.literal('TIMED_MINUTES'),
      days: z.array(output({ date: businessDate(), pieces: z.number().int(), earnedMinutes: minutes, timedEarnedMinutes: minutes, timedMinutes: minutes, offStandardMinutes: minutes, efficiency: percent.nullable() })),
      leftOut: output({ traineeDays: z.number().int().min(0), sharedReports: z.number().int().min(0) }),
      recorded: z.literal(true),
      words: z.array(z.string()),
    }),
  },
})
