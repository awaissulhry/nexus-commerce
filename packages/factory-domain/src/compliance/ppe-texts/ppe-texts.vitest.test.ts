import { describe, expect, it } from 'vitest'
import { madeWhileInForce, recordRefusal } from '../declarations/batches'
import { needsAction, NOT_SOLD_CELL, CELL_WORDS, cellOf } from '../status/board'
import { TEMPLATE_ID as DOC_TEMPLATE } from '../declarations/template'
import { TEMPLATE_ID as LEAFLET_TEMPLATE } from '../user-information/template'
import {
  approvalCovering,
  GENERATOR_TEMPLATES,
  languagesApproved,
  languagesWaiting,
  normaliseLanguages,
  ppeGateOf,
  recordProblems,
  templateIdOf,
  templateOfId,
  withdrawProblems,
  type ApprovalFacts,
} from './rules'

/** B-W2b-288 — the compliance follow-ups' pure rules (FU2:01 the PPE text approvals, FU2:02 Not sold there, FU2:04 a late batch). */

const A = '0190f0e2-0001-7000-8000-000000000001'
const B = '0190f0e2-0001-7000-8000-000000000002'
const approval = (over: Partial<ApprovalFacts & { id: string }> = {}): ApprovalFacts & { id: string } => ({ id: 'a1', companyId: A, templateKind: 'DOC', templateKey: 'annex-ix', templateVersion: 1, languages: ['it', 'en'], withdrawnAt: null, ...over })

describe('the templates (FU2:01)', () => {
  it('names a template as key.version and reads it back from the last dot', () => {
    expect(templateIdOf('annex-ii-1.4', 1)).toBe('annex-ii-1.4.1')
    expect(templateOfId('annex-ii-1.4.1')).toEqual({ key: 'annex-ii-1.4', version: 1 })
    expect(templateOfId('SEED-LBL-JKT-02.12')).toEqual({ key: 'SEED-LBL-JKT-02', version: 12 })
    expect(templateOfId('annex-ix')).toBeNull()
    expect(templateOfId('annex-ix.0')).toBeNull()
  })

  it('the generators’ own templates are the ones they write on every generated text', () => {
    expect(GENERATOR_TEMPLATES.DOC.id).toBe(DOC_TEMPLATE)
    expect(GENERATOR_TEMPLATES.USER_INFORMATION.id).toBe(LEAFLET_TEMPLATE)
    expect(GENERATOR_TEMPLATES.USER_INFORMATION).toMatchObject({ key: 'annex-ii-1.4', version: 1 })
  })
})

describe('the gate a generated text reads (FU2:01)', () => {
  const ask = { kind: 'DOC' as const, templateId: 'annex-ix.1', companyId: A, language: 'it' }

  it('a live approval of the template covers its languages for its company', () => {
    expect(approvalCovering([approval()], ask)?.id).toBe('a1')
    expect(approvalCovering([approval()], { ...ask, language: 'de' })).toBeNull()
    expect(approvalCovering([approval()], { ...ask, companyId: B })).toBeNull()
    expect(approvalCovering([approval({ templateVersion: 2 })], ask)).toBeNull()
    expect(approvalCovering([approval({ templateKind: 'USER_INFORMATION' })], ask)).toBeNull()
  })

  it('one of every company covers every company; a text of every company needs one of every company', () => {
    expect(approvalCovering([approval({ companyId: null })], { ...ask, companyId: B })).not.toBeNull()
    expect(approvalCovering([approval({ companyId: null })], { ...ask, companyId: null })).not.toBeNull()
    expect(approvalCovering([approval({ companyId: A })], { ...ask, companyId: null })).toBeNull()
  })

  it('a withdrawn approval covers nothing; the gate says it was withdrawn', () => {
    const withdrawn = approval({ withdrawnAt: '2026-11-11T10:00:00.000Z' })
    expect(approvalCovering([withdrawn], ask)).toBeNull()
    expect(ppeGateOf([withdrawn], ask)).toMatchObject({ state: 'WAITING', approval: null, languages: [], withdrawn: true })
    expect(ppeGateOf([withdrawn, approval({ id: 'a2' })], ask)).toMatchObject({ state: 'APPROVED', withdrawn: false, languages: ['en', 'it'] })
    expect(ppeGateOf([], ask)).toMatchObject({ state: 'WAITING', withdrawn: false })
  })

  it('a text without a template is never covered', () => {
    expect(approvalCovering([approval()], { ...ask, templateId: null })).toBeNull()
  })

  it('a label’s languages: the ones approvals cover and the ones still waiting', () => {
    const label = { kind: 'LABEL_WARNING' as const, templateId: 'DEMO-LBL.1', companyId: A }
    const approvals = [approval({ templateKind: 'LABEL_WARNING', templateKey: 'DEMO-LBL', languages: ['it'] }), approval({ templateKind: 'LABEL_WARNING', templateKey: 'DEMO-LBL', languages: ['de'], companyId: null })]
    expect(languagesApproved(approvals, label)).toEqual(['de', 'it'])
    expect(languagesWaiting(languagesApproved(approvals, label), ['it', 'en', 'de'])).toEqual(['en'])
  })
})

describe('recording and withdrawing an approval (FU2:01)', () => {
  const draft = { templateKind: 'DOC', templateKey: 'annex-ix', templateVersion: 1, languages: ['it', 'en'], checkedBy: 'Demo consultant, Studio Demo' }

  it('takes the generator’s own template, ISO 639 languages each once and the consultant on one line', () => {
    expect(recordProblems(draft)).toEqual([])
    expect(recordProblems({ ...draft, templateKind: 'USER_INFORMATION', templateKey: 'annex-ii-1.4' })).toEqual([])
    expect(recordProblems({ ...draft, templateKind: 'LABEL_WARNING', templateKey: 'DEMO-LBL-01', templateVersion: 3 })).toEqual([])
  })

  it('refuses each problem in words, by field', () => {
    const paths = (over: Record<string, unknown>) => recordProblems({ ...draft, ...over }).map((problem) => problem.path)
    expect(paths({ templateKind: 'NOPE' })).toContain('body/templateKind')
    expect(paths({ templateVersion: 2 })).toEqual(['body/templateKey'])
    expect(paths({ templateKind: 'LABEL_WARNING', templateKey: 'with space' })).toEqual(['body/templateKey'])
    expect(paths({ templateVersion: 0 })).toContain('body/templateVersion')
    expect(paths({ languages: [] })).toEqual(['body/languages'])
    expect(paths({ languages: ['it', 'IT'] })).toEqual(['body/languages'])
    expect(paths({ languages: ['italiano'] })).toEqual(['body/languages/0'])
    expect(paths({ checkedBy: '  ' })).toEqual(['body/checkedBy'])
    expect(paths({ checkedBy: 'two\nlines' })).toEqual(['body/checkedBy'])
    expect(recordProblems({ ...draft, templateVersion: 2 })[0]!.message).toBe('The declaration generator writes template annex-ix version 1: that is the one a consultant checks.')
  })

  it('normalises the languages and asks a reason to withdraw', () => {
    expect(normaliseLanguages([' IT', 'en', 'it'])).toEqual(['it', 'en'])
    expect(withdrawProblems('no')).toHaveLength(1)
    expect(withdrawProblems('The consultant asked for a new wording.')).toEqual([])
  })
})

describe('a late batch of an older DoC (FU2:04)', () => {
  const superseded = { styleId: 'S', kind: 'DECLARATION_OF_CONFORMITY', revision: 1, status: 'SUPERSEDED', language: 'it' }
  const order = { styleId: 'S', batchNumber: 'DEMO-BT-1', frozenRevision: 1, number: 'DEMO-WO-1' }

  it('a work order made to the superseded revision keeps that document', () => {
    expect(madeWhileInForce({ document: superseded, workOrder: order })).toBe(true)
    expect(recordRefusal({ document: superseded, workOrder: order, batchNumber: null, shipment: null })).toBeNull()
  })

  it('a batch typed is kept only when it was recorded with that document before', () => {
    expect(recordRefusal({ document: superseded, workOrder: null, batchNumber: 'LEGACY-1', shipment: null })?.code).toBe('NOT_IN_FORCE')
    expect(recordRefusal({ document: superseded, workOrder: null, batchNumber: 'LEGACY-1', shipment: null, recordedBefore: true })).toBeNull()
  })

  it('a work order made to another revision still goes with its own revision’s document', () => {
    expect(recordRefusal({ document: superseded, workOrder: { ...order, frozenRevision: 2 }, batchNumber: null, shipment: null })?.code).toBe('NOT_IN_FORCE')
    expect(recordRefusal({ document: { ...superseded, status: 'WITHDRAWN' }, workOrder: order, batchNumber: null, shipment: null })?.code).toBe('NOT_ISSUED')
  })
})

describe('Not sold there on the status board (FU2:02)', () => {
  it('is a state of its own: no line, never in Needs action', () => {
    expect(NOT_SOLD_CELL).toMatchObject({ state: 'NOT_SOLD', missing: 0, first: null })
    expect(CELL_WORDS.NOT_SOLD).toBe('Not sold there')
    expect(cellOf([]).state).toBe('READY')
    expect(needsAction([{ styleId: 'S', styleCode: 'DEMO-1', marketCode: 'FR', marketName: 'France', cell: NOT_SOLD_CELL }])).toEqual({ lines: [], count: 0 })
  })
})
