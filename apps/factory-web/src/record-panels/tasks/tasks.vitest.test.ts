import { readFileSync } from 'node:fs' // F-CL-104
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../lib/i18n/locales' // F-CL-104
import { CATALOGUE } from '../../lib/i18n/messages' // F-CL-104
import { createApiClient } from '../../lib/api/client'
import { apiErrorFrom } from '../../lib/api/errors'
import { addFollower, bulkTasks, createTask, listAssignees, listTasks, setMyFollow, setTaskStatus, taskWriteProblem } from './api'
import { addTaskHeld, checklistLines, createBody, draftProblem, emptyDraft, followersChangeFor, taskChangeFor, taskDueWords, type TaskItem } from './model'
import { BATCH_HOST_WORDS, batchWordOf } from './model' // F-CL-104

/** Tasks and followers on any record (B-W2a-40 on B-W2a-20's API): the shared rules and calls. */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function client(answer: () => Response) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => answer())
  const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-1' })
  const sent = (index = 0) => {
    const [url, init] = fetch.mock.calls[index]!
    return { url, method: init.method, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined }
  }
  return { api, sent }
}

const TASK: TaskItem = {
  id: '0190f0e2-4444-7000-8000-000000000001',
  title: 'Call the tannery',
  description: null,
  record: { type: 'Company', id: '0190f0e2-1111-7000-8000-000000000001', label: 'C1' },
  companyId: '0190f0e2-1111-7000-8000-000000000001',
  siteId: null,
  partyId: null,
  assignee: { id: 'me', name: 'Alex Demo', me: true },
  assignedBy: null,
  assignedAt: null,
  dueDate: '2026-10-27',
  dueTime: null,
  due: { date: '2026-10-27', days: -2, word: 'OVERDUE' },
  checklist: [],
  progress: null,
  status: 'OPEN',
  tile: 'OVERDUE',
  closedAt: null,
  closedBy: null,
  snoozedUntil: null,
  snoozed: false,
  createdBy: { id: 'me', name: 'Alex Demo', me: true },
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
  version: 3,
  relation: 'ASSIGNEE',
  canChange: true,
}

describe('the tasks’ rules (shared by a record’s panels and My tasks)', () => {
  it('due words: overdue N days, today, in N days, a date, none', () => {
    expect(taskDueWords({ date: '2026-10-27', days: -2, word: 'OVERDUE' })).toEqual({ key: 'tasks.due.overdue', count: 2, date: '2026-10-27', late: true })
    expect(taskDueWords({ date: '2026-10-29', days: 0, word: 'TODAY' })?.key).toBe('tasks.due.today')
    expect(taskDueWords({ date: '2026-10-30', days: 1, word: 'SOON' })?.key).toBe('tasks.due.soon')
    expect(taskDueWords({ date: '2026-12-01', days: 33, word: null })?.key).toBe('tasks.due.on')
    expect(taskDueWords(null)).toBeNull()
  })

  it('a draft: a title is required; the checklist is one item per line; the body names the record or none', () => {
    expect(draftProblem(emptyDraft('me'))).toEqual({ key: 'tasks.new.held.title' })
    expect(draftProblem({ ...emptyDraft('me'), title: 'x'.repeat(201) })?.key).toBe('tasks.new.held.titleLong')
    expect(draftProblem({ ...emptyDraft('me'), title: 'Ok', checklist: Array.from({ length: 51 }, (_, i) => `item ${i}`).join('\n') })?.key).toBe('tasks.new.held.checklistMany')
    expect(draftProblem({ ...emptyDraft('me'), title: 'Ok' })).toBeNull()
    expect(checklistLines(' a \n\n  b  c ')).toEqual(['a', 'b c'])
    const draft = { title: '  Call   them ', assigneeId: null, dueDate: '2026-11-02', checklist: 'one\ntwo', description: ' ' }
    expect(createBody(draft, { type: 'Quote', id: 'q1' })).toEqual({ title: 'Call them', record: { type: 'Quote', id: 'q1' }, assigneeId: null, dueDate: '2026-11-02', checklist: [{ text: 'one' }, { text: 'two' }], description: null })
    expect(createBody({ ...draft, dueDate: '' }, null)).toMatchObject({ dueDate: null })
    expect(createBody(draft, null)).not.toHaveProperty('record')
  })

  it('who may make or change a task, said in words; live changes of this record only', () => {
    expect(addTaskHeld(new Set(['home.view']), false)).toBe('tasks.held.noManage')
    expect(addTaskHeld(new Set(['tasks.manage']), true)).toBe('tasks.held.noPost')
    expect(addTaskHeld(new Set(['tasks.manage', 'threads.post']), true)).toBeNull()
    expect(addTaskHeld(new Set(['tasks.manage']), false)).toBeNull()
    const record = { type: 'Quote', id: 'q1' }
    expect(taskChangeFor({ type: 'task.completed', fields: { recordType: 'Quote', recordId: 'q1' } }, record)).toBe(true)
    expect(taskChangeFor({ type: 'task.completed', fields: { recordType: 'Quote', recordId: 'q2' } }, record)).toBe(false)
    expect(followersChangeFor({ type: 'thread.followers_changed', fields: { recordType: 'Quote', recordId: 'q1' } }, record)).toBe(true)
  })
})

describe('the calls (one client: company header, CSRF, Idempotency-Key, the version as read)', () => {
  const LIST = { asOf: '2026-10-29T10:00:00.000Z', today: '2026-10-29', tiles: [], total: 1, complete: true, items: [TASK], nextCursor: null, live: { events: ['task.created'] } }
  it('lists a record’s tasks, mine with a tile, made by me with a search', async () => {
    const c = client(() => json(200, LIST))
    await listTasks(c.api, { scope: 'RECORD', record: { type: 'Quote', id: 'q1' }, status: 'OPEN', limit: 100 })
    expect(c.sent().url).toBe('/api/tasks?scope=RECORD&recordType=Quote&recordId=q1&status=OPEN&limit=100')
    await listTasks(c.api, { scope: 'MINE', tile: 'DONE_7D' })
    expect(c.sent(1).url).toBe('/api/tasks?scope=MINE&tile=DONE_7D&limit=50')
    await listTasks(c.api, { scope: 'CREATED', q: ' tannery ', cursor: 'c2' })
    expect(c.sent(2).url).toBe('/api/tasks?scope=CREATED&q=tannery&cursor=c2&limit=50')
    expect(c.sent().headers.get('x-factory-company')).toBe('DEMO')
  })

  it('makes, ticks, bulk-changes a task with its version and a key; asks who may be given one', async () => {
    const c = client(() => json(201, { task: TASK }))
    await createTask(c.api, { title: 'Call' })
    expect(c.sent().method).toBe('POST')
    expect(c.sent().headers.get('idempotency-key')).toBeTruthy()
    expect(c.sent().headers.get('x-csrf-token')).toBe('csrf-1')
    const d = client(() => json(200, { task: { ...TASK, status: 'DONE', version: 4 } }))
    await setTaskStatus(d.api, TASK, 'DONE')
    expect(d.sent()).toMatchObject({ url: `/api/tasks/${TASK.id}/status`, body: { version: 3, status: 'DONE' } })
    const b = client(() => json(200, { action: 'REASSIGN', tasks: [TASK] }))
    await bulkTasks(b.api, 'REASSIGN', [TASK], { assigneeId: 'p1' })
    expect(b.sent().body).toEqual({ action: 'REASSIGN', items: [{ id: TASK.id, version: 3 }], assigneeId: 'p1' })
    await bulkTasks(b.api, 'SET_DUE', [TASK], { dueDate: null })
    expect(b.sent(1).body).toEqual({ action: 'SET_DUE', items: [{ id: TASK.id, version: 3 }], dueDate: null })
    const a = client(() => json(200, { people: [{ id: 'p1', name: 'Bea', me: false }], complete: true }))
    expect(await listAssignees(a.api, { type: 'Quote', id: 'q1' })).toEqual([{ id: 'p1', name: 'Bea', me: false }])
    expect(a.sent().url).toBe('/api/tasks/assignees?recordType=Quote&recordId=q1')
    await listAssignees(a.api, null)
    expect(a.sent(1).url).toBe('/api/tasks/assignees')
  })

  it('follows, mutes and adds a colleague on the record', async () => {
    const answer = { record: { type: 'Quote', id: 'q1' }, count: 1, me: { following: true, muted: true, reason: 'CHOSE' }, followers: [] }
    const c = client(() => json(200, answer))
    await setMyFollow(c.api, { type: 'Quote', id: 'q1' }, { following: true, muted: true })
    expect(c.sent()).toMatchObject({ url: '/api/threads/Quote/q1/followers/me', method: 'PUT', body: { following: true, muted: true } })
    await addFollower(c.api, { type: 'Quote', id: 'q1' }, 'p3')
    expect(c.sent(1)).toMatchObject({ url: '/api/threads/Quote/q1/followers', method: 'POST', body: { userId: 'p3' } })
  })

  it('a refusal in words: moved (read again), an assignee who may not keep it, gone', () => {
    expect(taskWriteProblem(apiErrorFrom(409, { error: { code: 'conflict', message: 'x', issues: [{ path: 'task/CLOSED' }] } }))).toMatchObject({ key: 'tasks.problem.changed', reload: true })
    expect(taskWriteProblem(apiErrorFrom(400, { error: { code: 'invalid', message: 'x', issues: [{ path: 'body/assigneeId' }] } }))).toMatchObject({ key: 'tasks.problem.assignee', reload: true })
    expect(taskWriteProblem(apiErrorFrom(404, { error: { code: 'not_found', message: 'x' } }))).toMatchObject({ key: 'tasks.problem.gone' })
  })
})

// ---- F-CL-104 (customers list 13-backend §8.4, settle T12): the batch window's four additive options, the shape agreed with cq ----
describe('F-CL-104: the batch window reads as today without the new options, and in the host’s own noun with `words`', () => {
  it('without `words` every batch word is home-tasks’ (the Orders sheet unchanged); with them the record-noun words are the host’s', () => {
    for (const key of [...BATCH_HOST_WORDS, 'assignee', 'note', 'send', 'held.assignee']) expect(batchWordOf(key, null)).toEqual({ ns: 'home-tasks', key: `batch.${key}` })
    const words = { ns: 'customers-list', prefix: 'task' }
    expect(batchWordOf('title', words)).toEqual({ ns: 'customers-list', key: 'task.title' })
    expect(batchWordOf('held.tooMany', words)).toEqual({ ns: 'customers-list', key: 'task.held.tooMany' })
    // Words that name no record stay home-tasks' (one word for one thing).
    for (const key of ['assignee', 'note', 'send', 'made', 'receipt', 'held.assignee']) expect(batchWordOf(key, words).ns, key).toBe('home-tasks')
  })

  it('the customers list’s words exist for every record-noun key, in it and en, with the same placeholders as home-tasks', () => {
    const plural = (dictionary: Readonly<Record<string, string>>, key: string) => dictionary[key] ?? dictionary[`${key}_other`]
    for (const locale of LOCALES) {
      const host = CATALOGUE[locale]['customers-list'] ?? {}
      const home = CATALOGUE[locale]['home-tasks'] ?? {}
      for (const key of [...BATCH_HOST_WORDS, 'namesOther.warn', 'namesOther.tick', 'namesOther.held', 'made', 'due']) expect(plural(host, `task.${key}`), `${locale} task.${key}`).toBeTruthy()
      for (const key of BATCH_HOST_WORDS) {
        const ours = (plural(host, `task.${key}`)!.match(/\{\w+\}/g) ?? []).sort()
        expect(ours, `${locale} task.${key}`).toEqual((plural(home, `batch.${key}`)!.match(/\{\w+\}/g) ?? []).sort())
      }
    }
  })

  it('the four options are additive and optional (null: today’s rule)', () => {
    const view = readFileSync(new URL('./view/TaskNewDialog.tsx', import.meta.url), 'utf8')
    expect(view).toContain('readonly words?: { readonly ns: string; readonly prefix: string } | null')
    expect(view).toContain('readonly namesOther?: ((text: string) => readonly string[]) | null')
    expect(view).toContain('readonly hrefOf?: ((record: { readonly type: string; readonly id: string }) => string | null) | null')
    expect(view).toContain("readonly defaultAssignee?: 'me' | 'supervisor' | null")
    // The window starts on each record's supervisor unless the host asks for the person.
    expect(view).toContain("useState<BatchAssignee>({ kind: 'SUPERVISOR' })")
  })
})
// ---- end F-CL-104
