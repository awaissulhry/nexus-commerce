import { describe, expect, it } from 'vitest'
import { DESCRIPTION_MAX, TITLE_MAX } from '../tasks/rules'
import {
  ESCALATION_ROLE_KEYS,
  ESCALATION_STEP_WORDS,
  escalationAudienceOf,
  escalationCommandKey,
  escalationTaskWords,
  escalationUnitsOf,
  firstTaker,
  ISSUE_SOURCE_WORDS,
  ISSUE_STATUS_WORDS,
  PROBLEM_ORDERS_MAX,
  PROBLEM_WORDS,
  problemTaskWords,
  type EscalatingIssue,
} from './issues'

/**
 * B-PR-45 (production plan §1 "Report a problem", §3 "Issues", §7.12; R-41, R-43, R-44): the pure rules of the customer's report
 * and of the escalation — who each step goes to, what one escalation is (one per batch and its task, never two customers), the
 * batch task's and the escalation tasks' words in both languages within the task's limits. Every name is made up.
 */

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const COMPANY = '00000000-0000-4000-8000-0000000000c1'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = (iso: string) => new Date(iso)

const issue = (n: number, over: Partial<EscalatingIssue> = {}): EscalatingIssue => ({
  id: id(n),
  companyId: COMPANY,
  partyId: B,
  taskId: id(900),
  batchId: id(800),
  source: 'BRAND',
  status: 'OPEN',
  raisedAt: at('2026-11-17T09:00:00.000Z'),
  escalationStep: 0,
  ...over,
})

describe('B-PR-45 who an escalation step goes to (R-44)', () => {
  it('step 1: the backup when they may take it, else the production managers; step 2: the Owner and Admin', () => {
    expect(escalationAudienceOf(1, true)).toBe('BACKUP')
    expect(escalationAudienceOf(1, false)).toBe('PRODUCTION_MANAGERS')
    expect(escalationAudienceOf(2, true)).toBe('OWNER_AND_ADMIN')
    expect(escalationAudienceOf(2, false)).toBe('OWNER_AND_ADMIN')
    expect(ESCALATION_ROLE_KEYS[1]).toEqual(['production_manager'])
    expect([...ESCALATION_ROLE_KEYS[2]].sort()).toEqual(['admin', 'owner'])
  })

  it('the batch task goes to the first of the chain who may take it (supervisor, backup, production managers), else nobody', () => {
    expect(firstTaker(['s', 'b', 'p1', 'p2'], new Set(['s', 'p1']))).toBe('s')
    expect(firstTaker([null, 'b', 'p1'], new Set(['p1', 'b']))).toBe('b')
    expect(firstTaker(['s', null, 'p1', 'p2'], new Set(['p2']))).toBe('p2')
    expect(firstTaker(['s', 'b'], new Set())).toBeNull()
    expect(firstTaker([], new Set(['s']))).toBeNull()
  })
})

describe('B-PR-45 one escalation per batch and its task (R-43)', () => {
  it('a batch with one task is one escalation from its earliest raise; a lone issue is its own; answered issues are left out', () => {
    const units = escalationUnitsOf([
      issue(1, { raisedAt: at('2026-11-17T09:05:00.000Z') }),
      issue(2, { raisedAt: at('2026-11-17T09:00:00.000Z') }),
      issue(3, { batchId: null, taskId: id(901), raisedAt: at('2026-11-16T10:00:00.000Z') }),
      issue(4, { status: 'ANSWERED' }),
      issue(5, { status: 'CANCELLED', batchId: null, taskId: id(902) }),
    ])
    expect(units.map((unit) => unit.key)).toEqual([id(3), `${id(800)}.${id(900)}`])
    const batch = units[1]!
    expect(batch.issueIds).toEqual([id(1), id(2)])
    expect(batch.raisedAt).toEqual(at('2026-11-17T09:00:00.000Z'))
    expect(batch).toMatchObject({ partyId: B, companyId: COMPANY, taskId: id(900), batchId: id(800), taken: 0 })
    expect(units[0]).toMatchObject({ batchId: null, taskId: id(901), issueIds: [id(3)] })
  })

  it('an office batch with a task per supervisor escalates per task; the step taken is the lowest of its issues', () => {
    const units = escalationUnitsOf([issue(1, { source: 'OFFICE', taskId: id(910), escalationStep: 1 }), issue(2, { source: 'OFFICE', taskId: id(910) }), issue(3, { source: 'OFFICE', taskId: id(911), escalationStep: 2 })])
    expect(units.map((unit) => [unit.taskId, unit.taken, unit.issueIds])).toEqual([
      [id(910), 0, [id(1), id(2)]],
      [id(911), 2, [id(3)]],
    ])
  })

  it('never merges two customers: an issue of another customer under the same batch id escalates alone, to its own people', () => {
    const units = escalationUnitsOf([issue(1), issue(2, { partyId: A })])
    expect(units).toHaveLength(2)
    expect(units.map((unit) => [unit.partyId, unit.issueIds])).toEqual(
      expect.arrayContaining([
        [B, [id(1)]],
        [A, [id(2)]],
      ]),
    )
  })

  it('the system command of a step: one per batch and step, a valid Idempotency-Key', () => {
    const [unit] = escalationUnitsOf([issue(1)])
    const key1 = escalationCommandKey(unit!, 1)
    expect(key1).toBe(`issue-escalate:${id(800)}.${id(900)}:1`)
    expect(escalationCommandKey(unit!, 2)).not.toBe(key1)
    for (const key of [key1, escalationCommandKey({ key: id(3) }, 2)]) expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  })
})

describe('B-PR-45 the words (it + en), within the task limits', () => {
  it("the batch task of a customer's report: its first order names it, every order is listed, how to answer", () => {
    expect(problemTaskWords({ locale: 'en', labels: ['SO-1'], customer: 'Brand Beta', excerpt: 'Made-up: the zip is broken.' })).toEqual({
      title: 'Answer the problem Brand Beta reported on SO-1',
      description: `Made-up: the zip is broken.\n\nOrders: SO-1\n\n${PROBLEM_WORDS.TASK_HOW.en}`,
    })
    const many = problemTaskWords({ locale: null, labels: ['SO-1', 'SO-2'], customer: 'Brand Beta', excerpt: 'x' })
    expect(many.title).toBe('Rispondi al problema segnalato da Brand Beta su 2 ordini')
    expect(many.description).toContain('Ordini: SO-1, SO-2')
    const long = problemTaskWords({ locale: 'en', labels: Array.from({ length: PROBLEM_ORDERS_MAX }, (_, n) => `SO-${String(n).padStart(80, '0')}`), customer: 'x'.repeat(400), excerpt: 'y'.repeat(5000) })
    expect(long.title.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(long.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
  })

  it('an escalation task says the step and what waits — a customer’s report or the office’s note', () => {
    expect(escalationTaskWords({ locale: 'en', step: 1, source: 'BRAND', labels: ['SO-1'], customer: 'Brand Beta', excerpt: 'Made-up.' }).title).toBe('No answer after 1 working day: the problem Brand Beta reported on SO-1')
    expect(escalationTaskWords({ locale: 'en', step: 2, source: 'BRAND', labels: ['SO-1', 'SO-2'], customer: 'Brand Beta', excerpt: 'Made-up.' }).title).toBe('No answer after 2 working days: the problem Brand Beta reported on 2 orders')
    expect(escalationTaskWords({ locale: 'it', step: 1, source: 'OFFICE', labels: ['WO-9'], customer: 'Brand Beta', excerpt: 'Made-up.' }).title).toBe('Senza risposta da 1 giorno lavorativo: la nota su WO-9')
    const office = escalationTaskWords({ locale: 'en', step: 2, source: 'OFFICE', labels: ['SO-1', 'WO-9'], customer: 'Brand Beta', excerpt: 'Made-up.' })
    expect(office.title).toBe('No answer after 2 working days: the note on 2 records of Brand Beta')
    expect(office.description).toBe('Made-up.\n\nRecords: SO-1, WO-9')
    const long = escalationTaskWords({ locale: 'en', step: 1, source: 'BRAND', labels: Array.from({ length: 50 }, (_, n) => `SO-${String(n).padStart(90, '0')}`), customer: 'x'.repeat(400), excerpt: 'y'.repeat(5000) })
    expect(long.title.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(long.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
  })

  it('every word in both languages; the ones the customer reads name nobody', () => {
    for (const group of [PROBLEM_WORDS, ISSUE_STATUS_WORDS, ISSUE_SOURCE_WORDS, ESCALATION_STEP_WORDS] as const) {
      for (const words of Object.values(group)) {
        expect(words.it.trim()).not.toBe('')
        expect(words.en.trim()).not.toBe('')
      }
    }
    for (const words of [PROBLEM_WORDS.NOT_IN_PRODUCTION, PROBLEM_WORDS.NOT_SENT, PROBLEM_WORDS.NONE_SENT]) expect(`${words.it} ${words.en}`).not.toMatch(/\{|supervis|backup|manager|Owner|Admin/i)
    expect(PROBLEM_ORDERS_MAX).toBe(50)
  })
})
