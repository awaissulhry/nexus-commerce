import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ISSUE_RECORD_TYPES, ISSUE_SOURCES, ISSUE_STATUSES } from '@nexus/factory-domain/production-brand/issues'
import { SUPERVISOR_MARKS } from '@nexus/factory-domain/production-brand/supervisor'
import { TASK_STATUSES } from '@nexus/factory-domain/tasks/rules'

/**
 * B-PR-45 — the office's list of the issues that need an answer (production plan §5 Customer card "open problems", Overview
 * "open issues"; L24; R-42 "No reply sent yet"). Office only, every customer the reader reaches (the brand wall: a person
 * limited to some customers reads only theirs). Words in Italian and English. Lists name no person (worker privacy): the task's
 * assignee is Me / Someone else / Not set. B-PT-010: inside ONE sales order (`salesOrderId`), for a reader of the record's thread,
 * an office ask names who asked and who replied — office people the order's thread already shows; never a worker.
 */

const words = output({ it: z.string(), en: z.string() })
const bool = z.enum(['true', 'false']).transform((value) => value === 'true')

export const ISSUE_LIST_STATUSES = [...ISSUE_STATUSES, 'ALL'] as const

export const listIssuesContract = defineContract({
  querystring: input({
    /** One customer (the Customer card); none: every customer the reader reaches (the Overview). */
    partyId: id().optional(),
    /**
     * B-SA-033 (Sales page plan P2, the order page's Quality section): one sales order's issues — on the order itself, or on one
     * of its live work orders (not a repair, not cancelled). The order is checked with orders.view first: one the reader does not
     * reach is "Sales order not found." (the words of an unknown id); the counts are then over that order's issues only.
     */
    salesOrderId: id().optional(),
    /** OPEN by default (oldest first); ANSWERED, CANCELLED or ALL newest first. */
    status: z.enum(ISSUE_LIST_STATUSES).default('OPEN'),
    /** Only the issues whose open task (the batch's, or an escalation's) is the reader's. */
    mine: bool.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      asOf: instant(),
      /** Over every issue of the customer filter the reader reaches (not the status or mine filters). */
      counts: output({
        open: z.number().int(),
        /** A customer's issue whose task was ticked while no reply went out: it still waits ("No reply sent yet"). */
        noReplyYet: z.number().int(),
        escalated: z.number().int(),
        mine: z.number().int(),
      }),
      issues: z.array(
        output({
          id: id(),
          source: z.enum(ISSUE_SOURCES),
          sourceWords: words,
          status: z.enum(ISSUE_STATUSES),
          statusWords: words,
          /** "No reply sent yet" beside a ticked task of a customer's issue (R-42); null: its status says it all. */
          note: z.enum(['NO_REPLY_YET']).nullable(),
          noteWords: words.nullable(),
          record: output({ type: z.enum(ISSUE_RECORD_TYPES), id: id(), label: z.string() }),
          salesOrder: output({ id: id(), number: z.string() }).nullable(),
          customer: output({ id: id(), name: z.string() }),
          raisedAt: instant(),
          dueOn: businessDate(),
          answeredAt: instant().nullable(),
          escalation: output({ step: z.number().int().min(1).max(2), at: instant(), words }).nullable(),
          task: output({ id: id(), status: z.enum(TASK_STATUSES), assignee: z.enum(SUPERVISOR_MARKS) }).nullable(),
          /** The reader holds its open task (the batch's or an escalation's). */
          mine: z.boolean(),
          /**
           * Its batch and how many issues it holds (answered together). B-PT-010b (18-lead-settles L8): for an office ask, the OTHER
           * orders of the asks that share its task (one reply or tick answers them all: "Answered for SEED-SO-0088, SEED-SO-0090") —
           * `orders` those the reader may open (orders.view over each), `more` the rest, counted, never named; a customer's report and
           * an ask alone: none ([] and 0).
           */
          batch: output({ id: id(), issues: z.number().int(), orders: z.array(output({ id: id(), number: z.string() })), more: z.number().int() }).nullable(),
          /** The words it was raised with, only for a reader of the record's thread. */
          excerpt: z.string().nullable(),
          // ── B-PT-010 (order production tab R10) ──
          /** The note it was raised with ("Show in the thread"), only for a reader of the record's thread; else null. */
          messageId: id().nullable(),
          /** An office ask's asker, only inside ONE sales order (`salesOrderId`) and for a reader of the thread; else null. */
          askedBy: output({ id: id(), name: z.string() }).nullable(),
          /**
           * The reply that answers an office ask (B-PT-015's rule: the first reply to its note by a person other than the asker),
           * only inside ONE sales order and for a reader of the thread; else null ("Latest update · Mario · 21 Nov 14:10 · …").
           */
          reply: output({ at: instant(), messageId: id(), by: output({ id: id(), name: z.string() }).nullable(), excerpt: z.string() }).nullable(),
          // ── end B-PT-010 ──
        }),
      ),
      /** More issues than `limit` (or than the read's cap) match. */
      more: z.boolean(),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})
