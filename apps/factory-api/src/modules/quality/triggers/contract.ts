import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CHIP_KINDS, FREQUENCIES, PLAN_LIMITS, PLAN_STAGES } from '@nexus/factory-domain/quality/plans/rules'
import { RECORD_KINDS, TRIGGER_EVENTS } from '@nexus/factory-domain/quality/triggers/rules'
import { chipView } from '../plans/contract'

/**
 * Inspection triggers (B-W2b-101; QHS-010, QHS-011): the contracts of ./rules-read.ts, ./commands.ts, ./preview.ts and
 * ./pick.ts. The rules and their words are factory-domain quality/triggers (answers in words at `body/<field>`); the
 * lengths here only stop oversized bodies. No money, no person anywhere.
 */

const version = z.number().int().min(1)
const event = z.enum(TRIGGER_EVENTS)
const stage = z.enum(PLAN_STAGES)
const frequency = z.enum(FREQUENCIES)
const itEn = () => output({ it: z.string(), en: z.string() })
const chipIn = input({ kind: z.enum(CHIP_KINDS), value: z.string().max(80) })
const chipsIn = z.array(chipIn).max(PLAN_LIMITS.chips * 2)

const planRef = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  stage,
  stageWords: itEn(),
  /** The version a rule opens records on now; null: none approved (the rule opens nothing until one is). */
  approved: output({ id: id(), number: z.number().int() }).nullable(),
  appliesTo: z.array(chipView),
})

export const ruleView = output({
  id: id(),
  companyId: id(),
  /** 1, 2, 3 … in the company's list. */
  position: z.number().int(),
  sortOrder: z.number().int(),
  event,
  eventWords: itEn(),
  appliesTo: z.array(chipView),
  plan: planRef,
  frequency,
  frequencyValue: z.number().int().nullable(),
  frequencyWords: itEn(),
  /** What it opens (an incoming inspection, a cutting check, a first piece, a roving check, an end-of-line check). */
  recordKind: z.enum(RECORD_KINDS).nullable(),
  recordKindWords: itEn().nullable(),
  active: z.boolean(),
  /** What it really did in the last 30 days: the records it opened, and the times it opened nothing (with why, the latest). */
  opened: output({ last30Days: z.number().int(), lastAt: instant().nullable() }),
  skipped: output({ last30Days: z.number().int(), lastAt: instant().nullable(), lastWords: itEn().nullable() }),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type RuleView = z.infer<typeof ruleView>

const eventInfo = output({
  event,
  words: itEn(),
  /** A rule of this event can be kept now; else `held` says why, in words. */
  available: z.boolean(),
  held: itEn().nullable(),
  stages: z.array(stage),
  frequencies: z.array(output({ frequency, words: itEn(), takesValue: z.boolean() })),
  chipKinds: z.array(z.enum(CHIP_KINDS)),
})

const listAnswer = output({
  rules: z.array(ruleView),
  events: z.array(eventInfo),
  canManage: z.boolean(),
})

// ---- reads -------------------------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({ companyId: id().optional(), event: event.optional(), active: z.enum(['true', 'false']).optional() }),
  response: { 200: listAnswer },
})

export const ruleContract = defineContract({ params: input({ triggerId: id() }), response: { 200: output({ rule: ruleView }) } })

// ---- writes ------------------------------------------------------------------------------------------------------------

export const createContract = defineContract({
  body: input({
    companyId: id(),
    event,
    planId: id(),
    appliesTo: chipsIn.optional(),
    /** Left out: the plan's approved version's frequency, when this event takes it; else every lot. */
    frequency: frequency.optional(),
    frequencyValue: z.number().int().nullable().optional(),
    active: z.boolean().optional(),
    /** 1, 2, 3 … where to put it in the list; left out: at the end. */
    position: z.number().int().min(1).max(10_000).optional(),
  }),
  response: { 201: output({ rule: ruleView, rules: z.array(ruleView) }) },
})

export const editContract = defineContract({
  params: input({ triggerId: id() }),
  body: input({
    version,
    event: event.optional(),
    planId: id().optional(),
    appliesTo: chipsIn.optional(),
    frequency: frequency.optional(),
    frequencyValue: z.number().int().nullable().optional(),
    active: z.boolean().optional(),
  }),
  response: { 200: output({ rule: ruleView }) },
})

export const deleteContract = defineContract({
  params: input({ triggerId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: output({ id: id(), event, planCode: z.string() }), rules: z.array(ruleView) }) },
})

export const orderContract = defineContract({
  body: input({ companyId: id(), order: z.array(id()).max(400) }),
  response: { 200: output({ rules: z.array(ruleView) }) },
})

// ---- the preview -------------------------------------------------------------------------------------------------------

export const previewContract = defineContract({
  body: input({
    companyId: id(),
    /** A saved rule being changed: the draft takes its place (left out: a new rule). */
    triggerId: id().optional(),
    event,
    planId: id(),
    appliesTo: chipsIn.optional(),
    frequency,
    frequencyValue: z.number().int().nullable().optional(),
    /** Where the draft would stand (left out: a changed rule keeps its place, a new one goes last). */
    position: z.number().int().min(1).max(10_000).optional(),
  }),
  response: {
    200: output({
      preview: output({
        event,
        considered: z.number().int(),
        fits: z.number().int(),
        earlier: z.number().int(),
        opened: z.number().int(),
        from: z.string(),
        to: z.string(),
        truncated: z.boolean(),
        /** "This rule would have created 14 inspections in the last month (…): 40 of 120 lots received fit it." */
        words: itEn(),
      }),
    }),
  },
})

// ---- which plan the rules pick (design quality.inspections qi-new "Plan: picked by the trigger rules and explained") ----

export const pickContract = defineContract({
  querystring: input({
    stage,
    lotId: id().optional(),
    subcontractReceiptId: id().optional(),
    workOrderId: id().optional(),
    workOrderOperationId: id().optional(),
  }),
  response: {
    200: output({
      pick: output({
        /** RULE: the first rule in order that fits; PLAN: no rule fits, a plan of the stage whose own chips fit. */
        source: z.enum(['RULE', 'PLAN']),
        rule: output({ id: id(), position: z.number().int(), event }).nullable(),
        plan: output({ id: id(), code: z.string(), name: z.string(), stage }),
        version: output({ id: id(), number: z.number().int() }),
        because: z.array(chipView),
        /** "FIN-JACKET v3 applies because: category Jackets, customer P1 Moto". */
        words: itEn(),
      }).nullable(),
      /** Why nothing was picked, in words; null when something was. */
      none: itEn().nullable(),
    }),
  },
})
