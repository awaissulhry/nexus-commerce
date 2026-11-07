import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES, ROLE_TEMPLATES } from '../../auth/roles/templates'
import type { Actor, Grant } from '../../core/permissions'
import { KIND_RULES, PARTNER_TASK_KINDS, taskWords } from './kinds'
import { PARTNERS_TASKS_MANAGE, PORTAL_HOME_VIEW } from './permissions'
import { askProblems, badgesOf, byDue, DAY_MS, dueStateOf, isTaskFor, reminderDue, undoProblem, UNDO_WINDOW_MS } from './rules'

const T = '00000000-0000-7000-8000-0000000000aa'
const C1 = '00000000-0000-7000-8000-0000000000c1'
const C2 = '00000000-0000-7000-8000-0000000000c2'
const P1 = '00000000-0000-7000-8000-0000000000d1'
const P2 = '00000000-0000-7000-8000-0000000000d2'

const grant = (permissions: string[], companies: string[] = [C1], parties: string[] = [P1]): Grant => ({ permissions: permissions as Grant['permissions'], companies, sites: [], parties })
const partner = (...grants: Grant[]): Actor => ({ audience: 'partner', tenantId: T, partyId: P1, grants })
const task = (kind: (typeof PARTNER_TASK_KINDS)[number], companyId = C1, partyId = P1) => ({ kind, companyId, partyId })

describe('the one task list (B-W2b-167, COL-043)', () => {
  it('declares every kind with its verb, words, needs (home first), area and topic', () => {
    for (const kind of PARTNER_TASK_KINDS) {
      const rule = KIND_RULES[kind]
      expect(rule.needs[0]).toBe(PORTAL_HOME_VIEW)
      expect(rule.verb.it && rule.verb.en && rule.badge.it && rule.badge.en).toBeTruthy()
      expect(taskWords(kind, 'PO-2026-0101', 'en')).toContain('PO-2026-0101')
      expect(taskWords(kind, 'PO-2026-0101', 'it')).toContain('PO-2026-0101')
      for (const permission of rule.needs) expect(FACTORY_PERMISSIONS.isDeclared(permission)).toBe(true)
    }
  })

  it('a task is for a person whose role and capabilities hold its verb over its company and party, with the price grain where it shows money', () => {
    const viewer = partner(grant([PORTAL_HOME_VIEW]))
    const approver = partner(grant([PORTAL_HOME_VIEW, 'portal.approve']))
    const buyer = partner(grant([PORTAL_HOME_VIEW, 'portal.approve', 'money.price']))
    expect(isTaskFor(viewer, task('CONFIRM_PO'))).toBe(false)
    expect(isTaskFor(approver, task('CONFIRM_PO'))).toBe(true)
    // Accepting a quote shows its amount: the price grain too.
    expect(isTaskFor(approver, task('ACCEPT_QUOTE'))).toBe(false)
    expect(isTaskFor(buyer, task('ACCEPT_QUOTE'))).toBe(true)
    // B-W2b-185: paying is Finance's and Admin's (portal.payments.pay), with the price grain.
    expect(isTaskFor(partner(grant([PORTAL_HOME_VIEW, 'money.price'])), task('PAY_INVOICE'))).toBe(false)
    expect(isTaskFor(partner(grant([PORTAL_HOME_VIEW, 'portal.payments.pay'])), task('PAY_INVOICE'))).toBe(false)
    expect(isTaskFor(partner(grant([PORTAL_HOME_VIEW, 'portal.payments.pay', 'money.price'])), task('PAY_INVOICE'))).toBe(true)
    expect(isTaskFor(partner(grant([PORTAL_HOME_VIEW, 'portal.upload'])), task('UPLOAD_DOCUMENT'))).toBe(true)
    expect(isTaskFor(partner(grant([PORTAL_HOME_VIEW, 'portal.comment'])), task('ANSWER_MESSAGE'))).toBe(true)
    // Another company's portal, another party: never.
    expect(isTaskFor(approver, task('CONFIRM_PO', C2))).toBe(false)
    expect(isTaskFor(approver, task('CONFIRM_PO', C1, P2))).toBe(false)
    // No grant (before the first visit): nothing.
    expect(isTaskFor(partner(), task('ANSWER_MESSAGE'))).toBe(false)
  })

  it('reads due first: overdue, then by date, then the ones without a date (oldest first)', () => {
    const at = (iso: string | null, created: string, id: string) => ({ id, dueAt: iso ? new Date(iso) : null, createdAt: new Date(created) })
    const rows = [at(null, '2026-11-01T08:00:00Z', 'd'), at('2026-11-10T08:00:00Z', '2026-11-01T08:00:00Z', 'c'), at('2026-11-02T08:00:00Z', '2026-11-01T09:00:00Z', 'a'), at(null, '2026-10-30T08:00:00Z', 'e'), at('2026-11-05T08:00:00Z', '2026-11-01T08:00:00Z', 'b')]
    expect(rows.sort(byDue).map((row) => row.id)).toEqual(['a', 'b', 'c', 'e', 'd'])
    const now = new Date('2026-11-04T10:00:00Z')
    expect(dueStateOf(new Date('2026-11-03T10:00:00Z'), now)).toBe('OVERDUE')
    expect(dueStateOf(new Date('2026-11-04T17:00:00Z'), now)).toBe('TODAY')
    expect(dueStateOf(new Date('2026-11-06T10:00:00Z'), now)).toBe('SOON')
    expect(dueStateOf(new Date('2026-11-20T10:00:00Z'), now)).toBe('LATER')
    expect(dueStateOf(null, now)).toBe('NONE')
  })

  it('counts the badges per area with their nouns', () => {
    expect(badgesOf([task('CONFIRM_PO'), task('CONFIRM_PO'), task('UPLOAD_DOCUMENT'), task('RECONFIRM_ORDER')])).toEqual([
      { area: 'orders', count: 3, kinds: { CONFIRM_PO: 2, RECONFIRM_ORDER: 1 } },
      { area: 'documents', count: 1, kinds: { UPLOAD_DOCUMENT: 1 } },
    ])
  })

  it('the office asks by hand for a document, an answer, measurements or progress, due in the future within 180 days', () => {
    const now = new Date('2026-11-04T10:00:00Z')
    expect(askProblems({ kind: 'UPLOAD_DOCUMENT', dueAt: new Date('2026-11-10T10:00:00Z') }, now)).toEqual([])
    expect(askProblems({ kind: 'ANSWER_MESSAGE', dueAt: null }, now)).toEqual([])
    expect(askProblems({ kind: 'CONFIRM_PO', dueAt: null }, now)[0]?.path).toBe('body/kind')
    expect(askProblems({ kind: 'UPLOAD_DOCUMENT', dueAt: new Date('2026-11-01T10:00:00Z') }, now)[0]?.path).toBe('body/dueAt')
    expect(askProblems({ kind: 'UPLOAD_DOCUMENT', dueAt: new Date(now.getTime() + 181 * DAY_MS) }, now)[0]?.path).toBe('body/dueAt')
  })

  it('reminds once within 2 days before the due date, once when past, then weekly for 30 days, never twice a day', () => {
    const due = new Date('2026-11-10T12:00:00Z')
    const created = new Date('2026-11-01T08:00:00Z')
    const base = { status: 'OPEN' as const, dueAt: due, createdAt: created, remindedAt: null as Date | null }
    const at = (offsetHours: number) => new Date(due.getTime() + offsetHours * 3_600_000)
    expect(reminderDue(base, at(-72))).toBe(false)
    expect(reminderDue(base, at(-47))).toBe(true)
    expect(reminderDue({ ...base, remindedAt: at(-47) }, at(-10))).toBe(false)
    expect(reminderDue({ ...base, remindedAt: at(-47) }, at(1))).toBe(true)
    expect(reminderDue({ ...base, remindedAt: at(1) }, at(20))).toBe(false)
    expect(reminderDue({ ...base, remindedAt: at(1) }, at(24 * 7 + 2))).toBe(true)
    expect(reminderDue({ ...base, remindedAt: at(24 * 28) }, at(24 * 31))).toBe(false)
    // Asked inside the window: it was just mailed when made; the next reminder is when it is past.
    expect(reminderDue({ ...base, createdAt: at(-20) }, at(-10))).toBe(false)
    expect(reminderDue({ ...base, createdAt: at(-20) }, at(2))).toBe(true)
    expect(reminderDue({ ...base, status: 'DONE' }, at(2))).toBe(false)
    expect(reminderDue({ ...base, dueAt: null }, at(2))).toBe(false)
  })

  it('a portal "done" is undone by the same person within 10 minutes', () => {
    const closedAt = new Date('2026-11-04T10:00:00Z')
    const done = { status: 'DONE' as const, doneById: 'me', closedAt }
    expect(undoProblem(done, 'me', new Date(closedAt.getTime() + UNDO_WINDOW_MS - 1))).toBeNull()
    expect(undoProblem(done, 'colleague', closedAt)).toMatch(/Only the person/)
    expect(undoProblem(done, 'me', new Date(closedAt.getTime() + UNDO_WINDOW_MS + 1))).toMatch(/too late/)
    expect(undoProblem({ ...done, status: 'OPEN', closedAt: null }, 'me', closedAt)).toMatch(/not done/)
  })

  it('gives portal.home.view to every main partner role (a partner permission) and partners.tasks.manage to admin, sales and buyer', () => {
    expect(FACTORY_PERMISSIONS.get(PORTAL_HOME_VIEW)?.partner).toBe(true)
    expect(FACTORY_PERMISSIONS.get(PARTNERS_TASKS_MANAGE)?.partner).not.toBe(true)
    for (const template of PARTNER_ROLE_TEMPLATES) expect(template.permissions.includes(PORTAL_HOME_VIEW)).toBe(template.kind !== null)
    const holders = ROLE_TEMPLATES.filter((template) => template.permissions.includes(PARTNERS_TASKS_MANAGE)).map((template) => template.key).sort()
    expect(holders).toEqual(expect.arrayContaining(['admin', 'buyer', 'sales']))
    expect(holders.every((key) => ['admin', 'buyer', 'sales', 'owner'].includes(key))).toBe(true)
  })
})
