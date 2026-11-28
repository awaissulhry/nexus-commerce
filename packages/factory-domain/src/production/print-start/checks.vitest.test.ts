import { describe, expect, it } from 'vitest'
import { RELEASE_CHECKS, type ReleaseCheck, type ReleaseChecklist } from '../work-orders/release'
import { CHECK_CLASS, PRINT_EXTRA_CHECKS, printProblems } from './checks'

// Made-up facts: work order numbers and words are invented for the test.
const check = (code: ReleaseCheck['code'], state: ReleaseCheck['state'] = 'BLOCKED', message = `${code} is not ready.`): ReleaseCheck => ({ code, state, message, problems: state === 'BLOCKED' ? [{ path: `checks/${code}`, message }] : [] })
const list = (...checks: ReleaseCheck[]): ReleaseChecklist => ({ checks, releasable: checks.every((entry) => entry.state !== 'BLOCKED'), blockers: checks.flatMap((entry) => (entry.state === 'BLOCKED' ? entry.problems : [])) })

describe('every release check has a class (settle L1)', () => {
  it('structure, law, money, hold refuse; material and a credit warning warn', () => {
    for (const code of [...RELEASE_CHECKS, ...PRINT_EXTRA_CHECKS]) expect(CHECK_CLASS[code], code).toBeDefined()
    expect(['REVISION', 'LABEL_TEMPLATE', 'WORK_CENTRES', 'BOM', 'CELLS', 'BATCH_NUMBER'].map((code) => CHECK_CLASS[code as keyof typeof CHECK_CLASS])).toEqual(Array(6).fill('STRUCTURE'))
    expect([CHECK_CLASS.CERTIFICATE, CHECK_CLASS.COMPLIANCE_GATE]).toEqual(['LAW', 'LAW'])
    expect([CHECK_CLASS.DEPOSIT, CHECK_CLASS.CREDIT_HOLD]).toEqual(['MONEY', 'MONEY'])
    expect(CHECK_CLASS.HOLDS).toBe('HOLD')
    expect([CHECK_CLASS.MATERIAL, CHECK_CLASS.CREDIT_WARN]).toEqual(['WARN', 'WARN'])
  })
})

describe('printProblems: only WARN rows let it go on', () => {
  it('lists every problem of every work order with its class and number', () => {
    const answer = printProblems([
      { workOrderNumber: 'WO-T-1', checklist: list(check('REVISION', 'OK'), check('BOM'), check('MATERIAL')) },
      { workOrderNumber: 'WO-T-2', checklist: list(check('DEPOSIT')) },
    ])
    expect(answer.problems).toEqual([
      { code: 'BOM', class: 'STRUCTURE', workOrderNumber: 'WO-T-1', words: 'BOM is not ready.' },
      { code: 'MATERIAL', class: 'WARN', workOrderNumber: 'WO-T-1', words: 'MATERIAL is not ready.' },
      { code: 'DEPOSIT', class: 'MONEY', workOrderNumber: 'WO-T-2', words: 'DEPOSIT is not ready.' },
    ])
    expect(answer).toMatchObject({ refused: true, needsMaterialReason: true })
  })

  it('a material shortage alone (and a credit warning) goes on, asking a reason for the material', () => {
    const answer = printProblems([{ workOrderNumber: 'WO-T-1', checklist: list(check('MATERIAL'), check('HOLDS', 'OK')) }], [{ code: 'CREDIT_WARN', workOrderNumber: null, words: 'Over the credit limit (a warning).' }])
    expect(answer).toMatchObject({ refused: false, needsMaterialReason: true })
    expect(answer.problems.map((problem) => problem.class)).toEqual(['WARN', 'WARN'])
  })

  it('a hold, a certificate, a credit hold or the gate refuse; nothing blocked: nothing listed', () => {
    for (const code of ['HOLDS', 'CERTIFICATE'] as const) expect(printProblems([{ workOrderNumber: 'WO-T-1', checklist: list(check(code)) }]).refused, code).toBe(true)
    for (const code of ['CREDIT_HOLD', 'COMPLIANCE_GATE'] as const) expect(printProblems([], [{ code, workOrderNumber: null, words: 'No.' }]).refused, code).toBe(true)
    expect(printProblems([{ workOrderNumber: 'WO-T-1', checklist: list(check('REVISION', 'OK'), check('MATERIAL', 'OVERRIDDEN')) }])).toEqual({ problems: [], refused: false, needsMaterialReason: false })
  })
})
