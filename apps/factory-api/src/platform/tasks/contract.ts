import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { RECORD_TYPE } from '@nexus/factory-domain/threads/rules'
import { BULK_ACTIONS, BULK_MAX, CHECKLIST_MAX, CHECKLIST_TEXT_MAX, DESCRIPTION_MAX, DUE_TIME, TASK_STATUSES, TASK_TILES, TITLE_MAX } from '@nexus/factory-domain/tasks/rules'

/**
 * The tasks' contracts (B-W2a-20; COL-037; design home.tasks, shell.panels popup task-new). Dates are business days
 * (YYYY-MM-DD), a due time HH:MM in the person's zone; people come as {id, name, me}. Every change sends the task's
 * version as read (409 when it moved). No amount and no figure about a person: a list is one person's own, or a record's.
 */

const person = output({ id: id(), name: z.string(), me: z.boolean() })

export const taskView = output({
  id: id(),
  title: z.string(),
  description: z.string().nullable(),
  /** The record it is on, with its label when the task was made; null: a task of its own. */
  record: output({ type: z.string(), id: id(), label: z.string() }).nullable(),
  companyId: id().nullable(),
  siteId: id().nullable(),
  partyId: id().nullable(),
  assignee: person.nullable(),
  assignedBy: person.nullable(),
  assignedAt: instant().nullable(),
  dueDate: z.string().nullable(),
  dueTime: z.string().nullable(),
  /** Due in days from today (negative: overdue) and its word. */
  due: output({ date: z.string(), days: z.number().int(), word: z.enum(['OVERDUE', 'TODAY', 'SOON']).nullable() }).nullable(),
  checklist: z.array(output({ id: z.string(), text: z.string(), done: z.boolean(), doneAt: z.string().nullable(), doneBy: output({ id: id(), name: z.string() }).nullable() })),
  /** "2 / 5"; null without a checklist. */
  progress: output({ done: z.number().int(), total: notMoney(z.number().int()) }).nullable(),
  status: z.enum(TASK_STATUSES),
  /** The tile of My tasks it counts in (null: later than this week, or closed long ago). */
  tile: z.enum(TASK_TILES).nullable(),
  closedAt: instant().nullable(),
  closedBy: person.nullable(),
  snoozedUntil: instant().nullable(),
  /** Off Today until snoozedUntil. */
  snoozed: z.boolean(),
  createdBy: person.nullable(),
  createdAt: instant(),
  updatedAt: instant(),
  version: z.number().int(),
  /** Why the reader sees it: assigned to them, made by them, or on a record they may read. */
  relation: z.enum(['CREATOR', 'ASSIGNEE', 'RECORD']).nullable(),
  /** Whether the reader may change it (tasks.manage, and on a record they only read: threads.post there). */
  canChange: z.boolean(),
})

const one = output({ task: taskView })
const taskParams = input({ id: id() })
const version = z.number().int().min(1)
const checklistInput = z.array(input({ id: z.string().max(64).optional(), text: z.string().max(CHECKLIST_TEXT_MAX * 2), done: z.boolean().optional() })).max(CHECKLIST_MAX)
const fields = {
  description: z.string().max(DESCRIPTION_MAX * 2).nullable().optional(),
  dueDate: businessDate().nullable().optional(),
  dueTime: z.string().regex(DUE_TIME).nullable().optional(),
  checklist: checklistInput.optional(),
}

export const listTasksContract = defineContract({
  querystring: input({
    /** MINE: assigned to me (My tasks); CREATED: made by me; RECORD: the tasks of one record (its side panel). */
    scope: z.enum(['MINE', 'CREATED', 'RECORD']).default('MINE'),
    recordType: z.string().regex(RECORD_TYPE).optional(),
    recordId: id().optional(),
    /** A tile pressed (Overdue · Today · This week · No date · Done in 7 days). */
    tile: z.enum(TASK_TILES).optional(),
    /** Default OPEN (DONE for the Done tile). */
    status: z.enum([...TASK_STATUSES, 'ALL']).optional(),
    q: z.string().max(100).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      asOf: instant(),
      today: z.string(),
      /** The tiles over the whole scope (never the tile or status filter): each count is its rows. */
      tiles: z.array(output({ tile: z.enum(TASK_TILES), count: z.number().int() })),
      total: notMoney(z.number().int()),
      /** False: the scope holds more than 500 tasks and only the newest were read. */
      complete: z.boolean(),
      items: z.array(taskView),
      nextCursor: z.string().nullable(),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})

export const getTaskContract = defineContract({ params: taskParams, response: { 200: one } })

export const createTaskContract = defineContract({
  body: input({
    title: z.string().max(TITLE_MAX * 2),
    /** The record it is on (a type with a thread); its company, site and customer come from it. */
    record: input({ type: z.string().regex(RECORD_TYPE), id: id() }).nullable().optional(),
    /** A task of its own: the company it is about, if any. */
    companyId: id().nullable().optional(),
    assigneeId: id().nullable().optional(),
    ...fields,
  }),
  response: { 201: one },
})

export const updateTaskContract = defineContract({
  params: taskParams,
  body: input({ version, title: z.string().max(TITLE_MAX * 2).optional(), ...fields }),
  response: { 200: one },
})

export const assignTaskContract = defineContract({ params: taskParams, body: input({ version, /** null: take it back. */ assigneeId: id().nullable() }), response: { 200: one } })

export const taskStatusContract = defineContract({ params: taskParams, body: input({ version, /** DONE (done), OPEN (reopen, Undo), CANCELLED. */ status: z.enum(TASK_STATUSES) }), response: { 200: one } })

export const snoozeTaskContract = defineContract({ params: taskParams, body: input({ version, /** Off Today until then; null: awake again. */ until: instant().nullable() }), response: { 200: one } })

export const bulkTasksContract = defineContract({
  body: input({
    action: z.enum(BULK_ACTIONS),
    items: z.array(input({ id: id(), version })).min(1).max(BULK_MAX),
    /** REASSIGN: to whom (null: nobody). */
    assigneeId: id().nullable().optional(),
    /** SET_DUE: the day (null: none). */
    dueDate: businessDate().nullable().optional(),
  }),
  response: { 200: output({ action: z.enum(BULK_ACTIONS), tasks: z.array(taskView) }) },
})

/**
 * B-W2a-40 (My tasks' Reassign and New task, a record's "+ Add task"): who may be given a task here — on the record named
 * (ACTIVE people who keep tasks there and read its thread), or of its own (people who keep tasks). Names only.
 */
export const taskAssigneesContract = defineContract({
  querystring: input({ recordType: z.string().regex(RECORD_TYPE).optional(), recordId: id().optional() }),
  response: {
    200: output({
      people: z.array(output({ id: id(), name: z.string(), me: z.boolean() })),
      /** False: the tenant has more active people than were read (the first 500 by name). */
      complete: z.boolean(),
    }),
  },
})
