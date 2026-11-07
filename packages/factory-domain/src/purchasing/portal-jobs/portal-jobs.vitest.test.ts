import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { PARTNER_LIVE_EVENTS } from '../../portal/notifications/live'
import {
  acceptedWords,
  acceptPlanOf,
  acceptProblems,
  declineProblems,
  declineText,
  dateDecisionProblem,
  jobActsOf,
  jobChipOf,
  jobStateOf,
  kitCheckPlan,
  nextStepOf,
  progressPlan,
  receivePrefillOf,
  returnPlan,
  returnQuantitiesOf,
  returnWords,
  SCRAP_REASONS,
  type JobFacts,
  type ReturnOperation,
} from './jobs'
import { PORTAL_JOBS_VIEW } from './permissions'

const OP = '00000000-0000-4000-8000-000000000001'
const OP2 = '00000000-0000-4000-8000-000000000002'
const CELL_A = '00000000-0000-4000-8000-0000000000a1'
const CELL_B = '00000000-0000-4000-8000-0000000000b1'
const BUNDLE = '00000000-0000-4000-8000-0000000000c1'
const KIT = '00000000-0000-4000-8000-0000000000d1'
const KIT2 = '00000000-0000-4000-8000-0000000000d2'

const counts = { pieces: 10, piecesSent: 10, piecesBackGood: 0, piecesBackDefective: 0, piecesScrapped: 0, finished: 0, announced: 0 }
const facts = (over: Partial<JobFacts>): JobFacts => ({ status: 'ISSUED', accepted: false, declined: false, kitLines: [], operations: [counts], ...over })

describe('the job as the workshop sees it', () => {
  it('sits under one chip with one next step', () => {
    expect(jobChipOf(facts({}))).toBe('NEW')
    expect(nextStepOf(facts({}))).toBe('ACCEPT')
    expect(jobChipOf(facts({ accepted: true }))).toBe('WORK')
    expect(nextStepOf(facts({ accepted: true }))).toBe('WAIT_KIT')
    const atWorkshop = facts({ status: 'AT_WORKSHOP', accepted: true, kitLines: [{ status: 'SENT', checked: false }] })
    expect(jobChipOf(atWorkshop)).toBe('KIT')
    const checked = { ...atWorkshop, kitLines: [{ status: 'SENT' as const, checked: true }] }
    expect(nextStepOf(checked)).toBe('REPORT')
    expect(jobChipOf({ ...checked, operations: [{ ...counts, finished: 4 }] })).toBe('BACK')
    // Announced already: nothing ready any more.
    expect(jobChipOf({ ...checked, operations: [{ ...counts, finished: 4, announced: 4 }] })).toBe('WORK')
    expect(jobChipOf(facts({ declined: true }))).toBe('DONE')
    expect(jobChipOf(facts({ status: 'RECEIVED', accepted: true }))).toBe('DONE')
    expect(jobStateOf(facts({ status: 'PARTLY_RECEIVED', accepted: true }))).toBe('PARTLY_BACK')
    expect(jobStateOf(facts({}))).toBe('TO_ANSWER')
  })

  it('says why an act is held, in the workshop’s words', () => {
    const fresh = jobActsOf(facts({}))
    expect(fresh.accept).toBeNull()
    expect(fresh.decline).toBeNull()
    expect(fresh.progress?.en).toBe('Accept the job first.')
    const accepted = jobActsOf(facts({ accepted: true }))
    expect(accepted.accept?.en).toBe('You accepted this job already.')
    expect(accepted.sendBack?.en).toContain('has not left yet')
    expect(jobActsOf(facts({ status: 'PARTLY_RECEIVED' })).decline?.en).toContain('came back already')
  })
})

describe('the answer', () => {
  const job = { orderDate: '2026-11-01', expectedBackDate: '2026-11-20' }
  it('accepts as asked, or with another day and why', () => {
    expect(acceptProblems(job, {}, '2026-11-05')).toEqual([])
    expect(acceptProblems(job, { proposedDate: '2026-11-25', reason: 'Two machines down' }, '2026-11-05')).toEqual([])
    expect(acceptProblems(job, { proposedDate: '2026-11-25' }, '2026-11-05').map((issue) => issue.path)).toEqual(['reason'])
    expect(acceptProblems(job, { proposedDate: '2026-11-20', reason: 'x' }, '2026-11-05')[0]!.message).toContain('accept as asked')
    expect(acceptProblems(job, { proposedDate: '2026-11-04', reason: 'x' }, '2026-11-05')[0]!.path).toBe('proposedDate')
    expect(acceptProblems(job, { reason: 'why' }, '2026-11-05')[0]!.path).toBe('proposedDate')
    expect(acceptPlanOf({ proposedDate: null, reason: '  ', name: ' Rosa ' })).toEqual({ proposedDate: null, reason: null, name: 'Rosa' })
    expect(acceptedWords({ proposedDate: null, reason: null, name: null }, '2026-11-04', 'en')).toBe('Accepted — we send the kit on 4 Nov with our DDT.')
    expect(acceptedWords({ proposedDate: '2026-11-25', reason: 'x', name: null }, null, 'it')).toContain('25 nov')
  })

  it('declines with a reason; Other needs words', () => {
    expect(declineProblems({ reason: 'NO_CAPACITY' })).toEqual([])
    expect(declineProblems({ reason: 'OTHER' })[0]!.path).toBe('note')
    expect(declineText({ reason: 'DATES', note: 'Busy until December' })).toBe('The dates do not work: Busy until December')
    expect(declineText({ reason: 'OTHER', note: 'Closed for holidays' })).toBe('Closed for holidays')
  })

  it('lets the office answer a proposed date once, while the order is out', () => {
    expect(dateDecisionProblem({ status: 'ISSUED', proposedDate: '2026-11-25', decided: false })).toBeNull()
    expect(dateDecisionProblem({ status: 'ISSUED', proposedDate: null, decided: false })).toContain('no other date')
    expect(dateDecisionProblem({ status: 'ISSUED', proposedDate: '2026-11-25', decided: true })).toContain('already')
    expect(dateDecisionProblem({ status: 'CLOSED', proposedDate: '2026-11-25', decided: false })).toContain('closed')
  })
})

describe('the kit received', () => {
  const lines = [
    { id: KIT, seq: 10, status: 'SENT' as const, quantity: '12.6000', checked: false },
    { id: KIT2, seq: 20, status: 'PLANNED' as const, quantity: '4.0000', checked: false },
  ]
  it('confirms all as listed, or line by line with words for a shortfall', () => {
    expect(kitCheckPlan(lines, { all: true }).lines).toEqual([{ kitLineId: KIT, seq: 10, quantity: '12.6000', note: null, short: false }])
    const short = kitCheckPlan(lines, { lines: [{ kitLineId: KIT, quantity: '11', note: 'One roll end torn' }] })
    expect(short.problems).toEqual([])
    expect(short.lines[0]).toMatchObject({ quantity: '11.0000', short: true, note: 'One roll end torn' })
    expect(kitCheckPlan(lines, { lines: [{ kitLineId: KIT, quantity: '11' }] }).problems[0]!.path).toBe('lines/0/note')
    expect(kitCheckPlan(lines, { lines: [{ kitLineId: KIT, quantity: '13' }] }).problems[0]!.message).toContain('We sent 12.6')
    expect(kitCheckPlan(lines, { lines: [{ kitLineId: KIT2, quantity: '4' }] }).problems[0]!.message).toContain('not left')
    expect(kitCheckPlan([{ ...lines[0]!, checked: true }], { all: true }).problems[0]!.path).toBe('all')
  })
})

describe('progress', () => {
  const job = {
    orderDate: '2026-11-01',
    operations: [
      { id: OP, seq: 10, pieces: 7, sizes: [{ workOrderSizeId: CELL_A, pieces: 4 }, { workOrderSizeId: CELL_B, pieces: 3 }] },
      { id: OP2, seq: 20, pieces: 7, sizes: [] },
    ],
    bundles: [{ id: BUNDLE, code: 'B-1', workOrderSizeId: CELL_A, quantity: 2 }],
    reported: [{ subcontractOperationId: OP, workOrderSizeId: CELL_A, bundleId: null, finishedQuantity: 3 }],
  }
  it('reports per size or bundle and never passes the pieces', () => {
    const plan = progressPlan(job, { entries: [{ operationId: OP, workOrderSizeId: CELL_B, finished: 3 }, { operationId: OP2, finished: 5 }], finishBy: '2026-11-20' })
    expect(plan.problems).toEqual([])
    expect(plan.finished).toBe(8)
    expect(plan.rows).toEqual([
      { subcontractOperationId: OP, workOrderSizeId: CELL_B, bundleId: null, finishedQuantity: 3 },
      { subcontractOperationId: OP2, workOrderSizeId: null, bundleId: null, finishedQuantity: 5 },
    ])
    expect(progressPlan(job, { entries: [{ operationId: OP, workOrderSizeId: CELL_A, finished: 2 }] }).problems[0]!.message).toBe('This size has 4 piece(s); 3 reported already.')
    // The bundle names its size: 1 more of CELL_A fits, 2 do not (the bundle holds 2, the size 1 more).
    expect(progressPlan(job, { entries: [{ operationId: OP, bundleId: BUNDLE, finished: 1 }] }).rows[0]).toMatchObject({ workOrderSizeId: CELL_A, bundleId: BUNDLE })
    expect(progressPlan(job, { entries: [{ operationId: OP2, finished: 4 }, { operationId: OP2, finished: 4 }] }).problems[0]!.path).toBe('entries/1/finished')
    expect(progressPlan(job, { entries: [{ operationId: OP, finished: 0 }] }).problems[0]!.path).toBe('entries/0/finished')
    expect(progressPlan(job, { entries: [] }).problems[0]!.path).toBe('entries')
    expect(progressPlan(job, { entries: [{ operationId: OP2, finished: 1 }], finishBy: '2026-10-01' }).problems[0]!.path).toBe('finishBy')
  })
})

describe('send back', () => {
  const operation: ReturnOperation = { id: OP, seq: 10, ...counts, piecesSent: 7, pieces: 7, piecesBackGood: 2, announced: 1, sizes: [] }
  const job = {
    operations: [operation],
    bundles: [{ id: BUNDLE, code: 'B-1', workOrderSizeId: CELL_A, quantity: 2 }],
    announced: [{ subcontractOperationId: OP, bundleId: BUNDLE, finished: 1, scrapped: 0 }],
    kitLines: [{ id: KIT, seq: 10, status: 'SENT' as const, quantity: '12.6000', checked: true }],
  }
  const base = { parcels: 2, expectedDate: '2026-11-18', weCollect: false }
  it('announces at most what is with the workshop, scrap with its reason, the material and the DDT', () => {
    const plan = returnPlan(job, { ...base, quantities: [{ operationId: OP, finished: 3, scrapped: 1, reasonCode: SCRAP_REASONS[0]!.code }], materialBack: [{ kitLineId: KIT, quantity: '1.5' }], ddt: { number: ' W-77 ', date: '2026-11-17' } }, '2026-11-10')
    expect(plan.problems).toEqual([])
    expect(plan.pieces).toBe(4)
    expect(plan.quantities).toEqual([{ subcontractOperationId: OP, bundleId: null, workOrderSizeId: null, finished: 3, scrapped: 1, reasonCode: 'LEATHER_FLAW' }])
    expect(plan.materialBack).toEqual([{ kitLineId: KIT, quantity: '1.5000' }])
    expect(plan.ddt).toEqual({ number: 'W-77', date: '2026-11-17' })
    expect(returnWords(plan.pieces, plan.expectedDate, 'en')).toBe('We expect 4 piece(s) on 18 Nov.')
    // 7 sent − 2 back − 1 announced = 4 left.
    expect(returnPlan(job, { ...base, quantities: [{ operationId: OP, finished: 5 }] }, '2026-11-10').problems[0]!.message).toBe('Operation 10: 4 piece(s) are with you and not announced yet.')
    expect(returnPlan(job, { ...base, quantities: [{ operationId: OP, finished: 0, scrapped: 1 }] }, '2026-11-10').problems[0]!.path).toBe('quantities/0/reasonCode')
    expect(returnPlan(job, { ...base, quantities: [{ operationId: OP, bundleId: BUNDLE, finished: 2 }] }, '2026-11-10').problems[0]!.message).toContain('1 announced already')
    expect(returnPlan(job, { ...base, quantities: [{ operationId: OP, finished: 1 }], materialBack: [{ kitLineId: KIT, quantity: '13' }] }, '2026-11-10').problems[0]!.path).toBe('materialBack/0/quantity')
    expect(returnPlan(job, { ...base, parcels: 0, quantities: [{ operationId: OP, finished: 1 }] }, '2026-11-10').problems[0]!.path).toBe('parcels')
    expect(returnPlan(job, { ...base, quantities: [{ operationId: OP, finished: 1 }] }, '2026-11-19').problems[0]!.path).toBe('expectedDate')
  })

  it('reads a notice back and prefills the receive back from it', () => {
    const stored = returnQuantitiesOf([{ subcontractOperationId: OP, bundleId: BUNDLE, workOrderSizeId: CELL_A, finished: 1, scrapped: 1, reasonCode: 'STAIN' }, { nonsense: true }])
    expect(stored).toHaveLength(1)
    expect(receivePrefillOf({ quantities: stored, workshopDdtNumber: 'W-9', workshopDdtDate: null })).toEqual({
      lines: [{ operationId: OP, bundleId: BUNDLE, good: 1, defective: 0, scrapped: 1, reason: 'STAIN' }],
      supplierDdt: { number: 'W-9', date: null },
    })
  })
})

describe('the catalogues', () => {
  it('declares portal.jobs.view as a partner permission, given to the Jobs role and its Admin', () => {
    expect(FACTORY_PERMISSIONS.get(PORTAL_JOBS_VIEW)?.partner).toBe(true)
    const holders = PARTNER_ROLE_TEMPLATES.filter((template) => template.permissions.includes(PORTAL_JOBS_VIEW)).map((template) => template.key)
    expect(holders.sort()).toEqual(['subcontractor-admin', 'subcontractor-jobs'])
  })

  it('declares the job events, live for the office and the workshop’s own party', () => {
    for (const type of ['job_sent', 'job_answered', 'date_decided', 'kit_checked', 'progress_reported', 'return_announced', 'return_cancelled']) {
      expect(EVENT_CATALOGUE.find(`subcontract_order.${type}`, 1)?.live?.permission).toBe('purchasing.view')
      expect(PARTNER_LIVE_EVENTS[`subcontract_order.${type}`]).toMatchObject({ permission: PORTAL_JOBS_VIEW, party: 'partyId' })
    }
  })
})
