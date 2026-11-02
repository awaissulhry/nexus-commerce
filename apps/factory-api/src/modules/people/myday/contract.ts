import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { PACES } from '@nexus/factory-domain/production/boards/hourly'
import { floorMineContract } from '../earnings/contract'

/**
 * My day (B-W2b-68; design floor.myday "Today", "Statement for the period"). One person's own day and nothing else: no line
 * output, no average, no rank, no other person (Owner answer F2). Pieces are the worker's own records (GDPR art. 15); minutes,
 * efficiency and pace come with the site's PERFORMANCE legal gate (`performance` null: it is off); every rate and amount is
 * `money.pay`, and `pay` is null for a month the site's piece-pay switch does not cover.
 */

const month = z.string().regex(/^\d{4}-\d{2}$/)
const minutes = z.string()
const statementParams = input({ statementId: id() })

const pace = output({
  /** The line whose target it is; null: none known for this person here. */
  line: output({ code: z.string(), name: z.string() }).nullable(),
  /** The worker's own pieces on that line today (solo reports). */
  done: z.number().int(),
  target: z.number().int().nullable(),
  targetSoFar: z.number().int().nullable(),
  /** The running hour's target. */
  hourTarget: z.number().int().nullable(),
  percent: z.number().int().nullable(),
  pace: z.enum(PACES),
  look: output({ icon: z.string(), tone: z.string() }),
})

export const myDayContract = defineContract({
  querystring: input({ month: month.optional() }),
  response: {
    200: output({
      subject: z.enum(['WORKER', 'STATION']),
      /** The floor sign-in is linked to an employee record (no: no figures and no pay can be found). */
      linked: z.boolean(),
      today: businessDate(),
      month,
      asOf: instant(),
      /** What the worker reported today (their own records). */
      work: output({ pieces: z.number().int(), scrap: z.number().int(), rework: z.number().int(), reports: z.number().int() }),
      /** Null: the site's PERFORMANCE legal gate is off, or the sign-in is not linked. */
      performance: output({
        earnedMinutes: minutes,
        timedMinutes: minutes,
        offStandardMinutes: minutes,
        /** Earned ÷ the person's own timed minutes on the same reports; null: nothing timed today. */
        efficiency: z.string().nullable(),
        traineeDay: z.boolean(),
        /** Reports shared with others: left out of the minutes and the pace. */
        sharedReports: z.number().int(),
        pace,
      }).nullable(),
      /** Today pays by the piece. */
      paysToday: z.boolean(),
      /** Null: no piece pay in this month: no money at all. */
      pay: floorMineContract.response[200].nullable(),
      /** The site's office printer is known. */
      printer: z.boolean(),
    }),
  },
})

export const answersContract = defineContract({ response: { 200: output({ ids: z.array(id()) }) } })

export const statementPdfContract = defineContract({ params: statementParams, response: {} })

export const printContract = defineContract({
  params: statementParams,
  body: input({}),
  response: { 201: output({ job: output({ id: id(), status: z.string() }), printer: output({ code: z.string(), name: z.string() }) }) },
})

export type MyDayQuery = z.infer<typeof myDayContract.querystring>
