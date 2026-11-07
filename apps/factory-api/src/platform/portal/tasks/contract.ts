import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { PARTNER_TASK_KINDS, PARTNER_TASK_STATUSES, PORTAL_AREAS } from '@nexus/factory-domain/portal/tasks/kinds'
import { ASKABLE_KINDS } from '@nexus/factory-domain/portal/tasks/rules'

/**
 * The one task list's contracts (B-W2b-167, COL-043; design portal.frame action-needed, portal.*.home "Waiting for you" / "To
 * do", the rail's badges; office: a party's requests). A task's words come in both languages (`words`) with its kind (the
 * web's catalogue may say them itself); never an amount, never an office person's id (`askedBy` is the name the partner sees).
 */

const words = output({ it: z.string(), en: z.string() })
const kind = z.enum(PARTNER_TASK_KINDS)
const status = z.enum(PARTNER_TASK_STATUSES)

const task = output({
  id: id(),
  kind,
  /** The one verb in the row ("Confirm", "Upload"). */
  verb: words,
  /** The request in words ("Confirm order PO-2026-0101"). */
  words,
  record: output({ type: z.string(), id: id(), label: z.string() }),
  companyId: id(),
  dueAt: instant().nullable(),
  /** Where the due date stands today (the row's Countdown words are the web's). */
  due: z.enum(['OVERDUE', 'TODAY', 'SOON', 'LATER', 'NONE']),
  /** Who at the factory asked (null: the system). */
  askedBy: z.string().nullable(),
  status,
  closedAt: instant().nullable(),
  /** The rail area whose badge counts it. */
  area: z.enum(PORTAL_AREAS),
  /** B-W2b-F14: the colleague of the party it was handed to (their name as the party reads it); null: anyone of the party. */
  assignee: output({ id: id(), displayName: z.string().nullable() }).nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

const partnerTask = task.extend({
  /** The record's page in the portal, at this task (`/p/<party>/open/<type>/<id>#task:<id>`). */
  link: z.string(),
  /** The partner may mark it done here (a request with no answer of its own); else the verb opens the record. */
  canMarkDone: z.boolean(),
  /** Done by this person in the last minutes: Undo is still offered. */
  canUndo: z.boolean(),
  /** B-W2b-F14: handed to this person. */
  mine: z.boolean(),
  /** B-W2b-F14: open, and not a preview: the person may take it, hand it to a colleague or give it back to everyone. */
  canAssign: z.boolean(),
})

const badge = output({ area: z.enum(PORTAL_AREAS), count: z.number().int(), words: words, kinds: z.record(z.string(), z.number().int()) })

export const portalTasksContract = defineContract({
  querystring: input({
    /** OPEN (default: what waits for you, due first) or DONE (done in the last 7 days). */
    state: z.enum(['OPEN', 'DONE']).default('OPEN'),
    /** B-W2b-F14: true shows only the requests handed to you ("Mine"); the badges and counts stay the whole list's. */
    mine: z.enum(['true', 'false']).default('false'),
  }),
  response: {
    200: output({
      asOf: instant(),
      state: z.enum(['OPEN', 'DONE']),
      /** The "Mine" filter is on. */
      mine: z.boolean(),
      items: z.array(partnerTask),
      badges: z.array(badge),
      /** `mine` (B-W2b-F14): the open requests handed to you. */
      counts: output({ open: z.number().int(), overdue: z.number().int(), dueSoon: z.number().int(), mine: z.number().int() }),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})

const taskParams = input({ taskId: id() })
const versionBody = input({ version: z.number().int().min(1) })

export const portalDoneContract = defineContract({ params: taskParams, body: versionBody, response: { 200: output({ task: partnerTask }) } })
export const portalUndoContract = defineContract({ params: taskParams, response: { 200: output({ task: partnerTask }) } })

/** B-W2b-F14: take it (your own id), hand it to an active colleague who can act on it, or give it back to everyone (null). */
export const portalAssignContract = defineContract({ params: taskParams, body: input({ version: z.number().int().min(1), assigneeId: id().nullable() }), response: { 200: output({ task: partnerTask }) } })

export const handoverContract = defineContract({
  params: input({ userId: id() }),
  response: {
    200: output({
      /** Open requests the colleague could act on. */
      open: z.number().int(),
      /** Of those, the ones another active colleague can act on too: they stay with the organisation. */
      kept: z.number().int(),
      /** B-W2b-F14: of those, the ones handed to the colleague: deactivating them gives these back to everyone. */
      assigned: z.number().int(),
      /** The ones nobody else could act on: give someone the role (or the capability) they need. */
      alone: z.array(output({ id: id(), kind, words, record: output({ type: z.string(), id: id(), label: z.string() }), dueAt: instant().nullable() })),
      /** Who else could act on the colleague's open requests, and on how many. */
      colleagues: z.array(output({ id: id(), displayName: z.string(), count: z.number().int() })),
    }),
  },
})

// --- the office ---------------------------------------------------------------------------------------------------------------

export const officeTasksContract = defineContract({
  params: input({ partyId: id() }),
  querystring: input({ status: z.enum(['OPEN', 'DONE', 'CANCELLED', 'ALL']).default('OPEN') }),
  response: { 200: output({ asOf: instant(), items: z.array(task), complete: z.boolean() }) },
})

export const askContract = defineContract({
  params: input({ partyId: id() }),
  body: input({
    kind: z.enum(ASKABLE_KINDS as unknown as [string, ...string[]]),
    recordType: z.string().trim().min(1).max(100),
    recordId: id(),
    /** The due time; null: no date. */
    dueAt: instant().nullable(),
    /** For a tenant-wide record of a tenant-wide partner: the company whose portal shows the request. */
    companyId: id().optional(),
  }),
  response: { 200: output({ task, made: z.boolean() }) },
})

export const cancelContract = defineContract({ params: taskParams, body: versionBody, response: { 200: output({ task }) } })
export const reopenContract = defineContract({ params: taskParams, body: versionBody, response: { 200: output({ task }) } })
export const moveDueContract = defineContract({ params: taskParams, body: input({ version: z.number().int().min(1), dueAt: instant().nullable() }), response: { 200: output({ task }) } })
