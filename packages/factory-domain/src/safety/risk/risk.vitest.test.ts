import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { isUuid } from '../../core/ids'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import {
  burnDown,
  completion,
  dvrSignatureId,
  freezeRefusal,
  measureDueState,
  measureProblems,
  moveRefusal,
  movesFor,
  reviewState,
  signatureRefusal,
  signersFor,
  type SignatureFacts,
  type SignerAppointment,
} from './rules'
import { dvrSeal, sealFingerprintText, type SealInput } from './seal'

/** B-W2b-122: the risk assessment (DVR versions, signatures, the improvement plan), pure. */

const TODAY = '2026-11-03'
const SITE = 'site-a1'

const held = (id: string, role: SignerAppointment['role'], fields: Partial<SignerAppointment> = {}): SignerAppointment => ({
  id,
  role,
  siteId: null,
  fromDate: '2020-01-01',
  untilDate: null,
  employeeId: null,
  outsideName: `Made-up ${id}`,
  name: `Made-up ${id}`,
  ...fields,
})

describe('who signs a version (QHS-230; art. 28 c.2)', () => {
  it('lists the employer always, then the RSPP, the RLS (else the RLST) and the doctor in force at the site', () => {
    const plan = signersFor([held('emp', 'EMPLOYER'), held('rspp', 'RSPP'), held('rls', 'RLS', { siteId: SITE, employeeId: 'e2', outsideName: null, name: 'Made-up Two' }), held('rlst', 'RLST'), held('doc', 'DOCTOR')], SITE, TODAY)
    expect(plan.signers.map((signer) => signer.role)).toEqual(['EMPLOYER', 'RSPP', 'RLS', 'DOCTOR'])
    expect(plan.missingEmployer).toBe(false)
    // Without an RLS the territorial RLS signs; an RLS of another site does not count; an ended term does not hold the role.
    const other = signersFor([held('emp', 'EMPLOYER'), held('rls', 'RLS', { siteId: 'site-b1', employeeId: 'e9', outsideName: null }), held('rlst', 'RLST'), held('doc', 'DOCTOR', { untilDate: '2026-11-02' })], SITE, TODAY)
    expect(other.signers.map((signer) => signer.role)).toEqual(['EMPLOYER', 'RLST'])
    expect(signersFor([held('rspp', 'RSPP')], SITE, TODAY).missingEmployer).toBe(true)
  })

  it('leaves out a role held by a person who signs already under an earlier one: nobody signs twice', () => {
    const plan = signersFor([held('emp', 'EMPLOYER', { outsideName: 'Anna Esempio', name: 'Anna Esempio' }), held('rspp', 'RSPP', { outsideName: ' anna  ESEMPIO ', name: ' anna  ESEMPIO ' }), held('doc', 'DOCTOR')], SITE, TODAY)
    expect(plan.signers.map((signer) => signer.role)).toEqual(['EMPLOYER', 'DOCTOR'])
    expect(plan.sameAs).toEqual([{ role: 'RSPP', as: 'EMPLOYER', name: ' anna  ESEMPIO ' }])
  })

  it('gives each role of a version one stable signature id (a UUID), so a paper scan is filed before the signature', () => {
    const id = dvrSignatureId('0192f0c4-0000-7000-8000-000000000001', 'RLS')
    expect(isUuid(id)).toBe(true)
    expect(dvrSignatureId('0192f0c4-0000-7000-8000-000000000001', 'RLS')).toBe(id)
    expect(dvrSignatureId('0192f0c4-0000-7000-8000-000000000001', 'DOCTOR')).not.toBe(id)
    expect(dvrSignatureId('0192f0c4-0000-7000-8000-000000000002', 'RLS')).not.toBe(id)
  })

  it('is complete once every listed signer signed; the certain date is the day of the last of them', () => {
    const signers = ['EMPLOYER', 'RSPP', 'RLS'] as const
    expect(completion(signers, [{ role: 'EMPLOYER', signedOn: '2026-10-01' }, { role: 'RLS', signedOn: '2026-10-03' }])).toEqual({ complete: false, missing: ['RSPP'], certainDateOn: null })
    expect(completion(signers, [{ role: 'EMPLOYER', signedOn: '2026-10-05' }, { role: 'RLS', signedOn: '2026-10-03' }, { role: 'RSPP', signedOn: '2026-10-04' }])).toEqual({ complete: true, missing: [], certainDateOn: '2026-10-05' })
  })
})

describe('a signature (the signing rules)', () => {
  const facts: SignatureFacts = {
    status: 'AWAITING_SIGNATURES',
    signersRequired: ['EMPLOYER', 'RSPP', 'DOCTOR'],
    signed: [{ role: 'EMPLOYER', name: 'Made-up Employer', persons: ['outside:made up employer', 'user:u1'] }],
    role: 'DOCTOR',
    method: 'OFFICE',
    signerName: 'made-up  DOCTOR',
    signedOn: TODAY,
    today: TODAY,
    frozenOn: '2026-10-30',
    appointment: { name: 'Made-up Doctor', persons: ['outside:made up doctor', 'user:u2'] },
    isTheSigner: true,
    scanOnFile: false,
  }
  it('takes the holder signing for themselves with their own name', () => {
    expect(signatureRefusal(facts)).toBeNull()
  })
  it('refuses, in the order a person fixes them', () => {
    expect(signatureRefusal({ ...facts, status: 'SIGNED' })?.code).toBe('NOT_AWAITING')
    expect(signatureRefusal({ ...facts, status: 'WITHDRAWN' })?.code).toBe('NOT_AWAITING')
    expect(signatureRefusal({ ...facts, role: 'RLS' })).toMatchObject({ code: 'NOT_A_SIGNER', field: 'role' })
    expect(signatureRefusal({ ...facts, role: 'EMPLOYER' })?.code).toBe('SIGNED_ALREADY')
    expect(signatureRefusal({ ...facts, appointment: null })).toMatchObject({ code: 'NO_APPOINTMENT', field: 'appointmentId' })
    expect(signatureRefusal({ ...facts, method: 'PAPER', signedOn: '2026-11-04' })).toMatchObject({ code: 'SIGNED_IN_FUTURE', field: 'signedOn' })
    expect(signatureRefusal({ ...facts, method: 'PAPER', signedOn: '2026-10-29' })).toMatchObject({ code: 'SIGNED_BEFORE_FROZEN', field: 'signedOn' })
    expect(signatureRefusal({ ...facts, signerName: 'Somebody Else' })).toMatchObject({ code: 'NAME_MISMATCH', field: 'signerName' })
    expect(signatureRefusal({ ...facts, isTheSigner: false })?.code).toBe('NOT_THE_SIGNER')
    // The same office user (or the same person) under another role: nobody signs twice.
    expect(signatureRefusal({ ...facts, appointment: { name: 'Made-up Doctor', persons: ['outside:made up doctor', 'user:u1'] } })?.code).toBe('SAME_PERSON')
    expect(signatureRefusal({ ...facts, method: 'PAPER', isTheSigner: false, appointment: { name: 'Made-up Doctor', persons: ['outside:made up employer'] } })?.code).toBe('SAME_PERSON')
    expect(signatureRefusal({ ...facts, method: 'PAPER', isTheSigner: false, appointment: { name: 'Made-up Doctor', persons: ['outside:made up doctor'] } })?.code).toBe('SCAN_MISSING')
    expect(signatureRefusal({ ...facts, method: 'PAPER', isTheSigner: false, scanOnFile: true, appointment: { name: 'Made-up Doctor', persons: ['outside:made up doctor'] } })).toBeNull()
  })
})

describe('freezing a version', () => {
  const facts = { archived: false, waiting: null, file: { status: 'AVAILABLE', contentType: 'application/pdf' }, frozenAlready: null, missingEmployer: false }
  it('freezes an uploaded PDF of the assessment, one version waiting at a time, with an employer to sign it', () => {
    expect(freezeRefusal(facts)).toBeNull()
    expect(freezeRefusal({ ...facts, archived: true })?.code).toBe('ARCHIVED')
    expect(freezeRefusal({ ...facts, waiting: { label: 'v2' } })?.code).toBe('VERSION_WAITING')
    expect(freezeRefusal({ ...facts, file: null })).toMatchObject({ code: 'FILE_NOT_READY', field: 'fileId' })
    expect(freezeRefusal({ ...facts, file: { status: 'PENDING_UPLOAD', contentType: 'application/pdf' } })?.code).toBe('FILE_NOT_READY')
    expect(freezeRefusal({ ...facts, file: { status: 'AVAILABLE', contentType: 'image/png' } })?.code).toBe('NOT_PDF')
    expect(freezeRefusal({ ...facts, frozenAlready: { label: 'v1' } })?.code).toBe('FROZEN_ALREADY')
    expect(freezeRefusal({ ...facts, missingEmployer: true })?.code).toBe('NO_EMPLOYER')
  })
})

describe('the improvement plan (QHS-234; art. 28 c.2 c-d)', () => {
  it('holds a measure’s shape: a title, roles once, a cost from 0, its source named as the source asks', () => {
    expect(measureProblems({ title: 'Noise enclosure', roleSheetIds: ['a', 'b'], cost: 0, source: 'DVR' })).toEqual([])
    expect(measureProblems({ title: ' ' }).map((problem) => problem.path)).toEqual(['title'])
    expect(measureProblems({ roleSheetIds: ['a', 'a'] }).map((problem) => problem.path)).toEqual(['roleSheetIds'])
    expect(measureProblems({ cost: -1 }).map((problem) => problem.path)).toEqual(['cost'])
    expect(measureProblems({ cost: 1.5 }).map((problem) => problem.path)).toEqual(['cost'])
    expect(measureProblems({ source: 'INCIDENT' }).map((problem) => problem.path)).toEqual(['sourceRecordId'])
    expect(measureProblems({ source: 'INCIDENT', sourceRecordType: 'SafetyDeadline', sourceRecordId: 'x' }).map((problem) => problem.path)).toEqual(['sourceRecordType'])
    expect(measureProblems({ source: 'MEETING', sourceRecordType: 'SafetyDeadline', sourceRecordId: 'x' })).toEqual([])
    expect(measureProblems({ source: 'DVR', sourceRecordType: 'Incident', sourceRecordId: 'x' }).map((problem) => problem.path)).toEqual(['sourceRecordType'])
    expect(measureProblems({ source: 'OTHER', versionId: 'v' }).map((problem) => problem.path)).toEqual(['versionId'])
    expect(measureProblems({ source: 'OTHER', sourceRecordId: 'x' }).map((problem) => problem.path)).toEqual(['sourceRecordType'])
  })

  it('moves as the schema does; the owner moves it along, a manager also verifies or cancels', () => {
    expect(moveRefusal('PLANNED', 'IN_PROGRESS')).toBeNull()
    expect(moveRefusal('DONE', 'IN_PROGRESS')).toBeNull()
    expect(moveRefusal('DONE', 'VERIFIED')).toBeNull()
    expect(moveRefusal('PLANNED', 'VERIFIED')?.code).toBe('BAD_MOVE')
    expect(moveRefusal('DONE', 'CANCELLED')?.code).toBe('BAD_MOVE')
    expect(moveRefusal('VERIFIED', 'IN_PROGRESS')?.code).toBe('MEASURE_FINAL')
    expect(moveRefusal('CANCELLED', 'PLANNED')?.code).toBe('MEASURE_FINAL')
    expect(movesFor('PLANNED', { manager: false, owner: true })).toEqual(['IN_PROGRESS', 'DONE'])
    expect(movesFor('DONE', { manager: false, owner: true })).toEqual(['IN_PROGRESS'])
    expect(movesFor('DONE', { manager: true, owner: false })).toEqual(['VERIFIED', 'IN_PROGRESS'])
    expect(movesFor('IN_PROGRESS', { manager: false, owner: false })).toEqual([])
  })

  it('says where a measure and a review stand today, and how many measures were open over time', () => {
    expect(measureDueState({ status: 'PLANNED', dueOn: '2026-11-02' }, TODAY)).toBe('OVERDUE')
    expect(measureDueState({ status: 'IN_PROGRESS', dueOn: '2026-12-03' }, TODAY)).toBe('DUE_SOON')
    expect(measureDueState({ status: 'PLANNED', dueOn: '2026-12-04' }, TODAY)).toBe('PLANNED')
    expect(measureDueState({ status: 'PLANNED', dueOn: null }, TODAY)).toBeNull()
    expect(measureDueState({ status: 'VERIFIED', dueOn: '2020-01-01' }, TODAY)).toBe('DONE')
    expect(measureDueState({ status: 'CANCELLED', dueOn: null }, TODAY)).toBe('CANCELLED')
    expect(reviewState(null, TODAY)).toBeNull()
    expect(reviewState('2026-11-01', TODAY)).toBe('OVERDUE')
    expect(reviewState('2027-06-01', TODAY)).toBe('PLANNED')
    const points = burnDown([{ addedOn: '2026-10-01', closedOn: '2026-10-20' }, { addedOn: '2026-10-15', closedOn: null }], '2026-10-06', '2026-10-27')
    expect(points).toEqual([
      { on: '2026-10-06', open: 1 },
      { on: '2026-10-13', open: 1 },
      { on: '2026-10-20', open: 1 },
      { on: '2026-10-27', open: 1 },
    ])
    expect(burnDown([{ addedOn: '2026-10-01', closedOn: '2026-10-20' }, { addedOn: '2026-10-15', closedOn: null }], '2026-10-19', '2026-10-19')).toEqual([{ on: '2026-10-19', open: 2 }])
  })
})

describe('the seal of a version (DocumentSeal)', () => {
  const input: SealInput = {
    language: 'en',
    createdAt: '2026-11-03T10:00:00.000Z',
    company: { name: 'Made-up Leather Srl', lines: ['Via Esempio 1', 'Made-up town'], legal: 'Made-up legal footer' },
    site: { code: 'A1', name: 'Plant A1' },
    assessment: { name: 'Plant A1' },
    version: {
      versionNo: 2,
      label: 'v2',
      effectiveOn: '2026-11-10',
      authorKind: 'CONSULTANT',
      authorName: 'Made-up Consultancy',
      changeSummary: 'The new clicking press.',
      fileName: 'DVR A1 v2.pdf',
      sha256: 'a'.repeat(64),
      frozenAt: '2026-10-30T09:00:00.000Z',
      frozenBy: 'Made-up Officer',
      status: 'AWAITING_SIGNATURES',
      certainDateOn: null,
      signersRequired: ['EMPLOYER', 'RLS', 'DOCTOR'],
    },
    signatures: [{ role: 'EMPLOYER', signerName: 'Made-up Employer', signedOn: '2026-10-31', signedAt: '2026-10-31T08:00:00.000Z', method: 'OFFICE', recordedBy: 'Made-up Employer' }],
    sample: true,
  }
  it('binds the PDF by its SHA-256, lists every signer (signed or not) and says it is a preview while waiting', () => {
    const seal = dvrSeal(input)
    expect(seal.sample).toBe('AWAITING SIGNATURES - preview')
    expect(seal.facts).toContainEqual({ label: 'SHA-256 fingerprint', value: 'a'.repeat(64) })
    expect(seal.facts).toContainEqual({ label: 'Legal basis', value: 'D.Lgs. 81/2008 artt. 28-29' })
    expect(seal.rows.map((row) => [row.material, row.kind])).toEqual([
      ['Employer', 'Made-up Employer'],
      ['RLS', 'not signed yet'],
      ['Occupational doctor', 'not signed yet'],
    ])
    expect(seal.fileName).toBe('DVR-A1-v2-seal.pdf')
    expect(dvrSeal({ ...input, language: 'it', sample: false, version: { ...input.version, status: 'SIGNED', certainDateOn: '2026-11-02' } })).toMatchObject({ sample: null, title: 'Valutazione dei rischi: versione e data certa' })
  })
  it('has one fingerprint for the same contents, whatever the day it is made; a new signature changes it', () => {
    const { createdAt: _created, sample: _sample, ...contents } = input
    expect(sealFingerprintText(contents)).toBe(sealFingerprintText({ ...contents }))
    expect(sealFingerprintText({ ...contents, signatures: [] })).not.toBe(sealFingerprintText(contents))
  })
})

describe('permissions, templates and events', () => {
  it('declares the two permissions (signing is a step-up act) and gives them to the safety roles', () => {
    expect(FACTORY_PERMISSIONS.get('safety.risk.manage')?.risk).toBe('write')
    expect(FACTORY_PERMISSIONS.get('safety.risk.sign')?.risk).toBe('stepUp')
    expect(templateOf('safety_officer')?.permissions).toEqual(expect.arrayContaining(['safety.risk.manage', 'safety.risk.sign']))
    expect(templateOf('company_doctor')?.permissions).toContain('safety.risk.sign')
    expect(templateOf('company_doctor')?.permissions).not.toContain('safety.risk.manage')
    expect(templateOf('read_only')?.permissions).not.toContain('safety.risk.manage')
  })
  it('declares its events, safety.view live, never a name or a cost', () => {
    for (const type of ['risk_assessment.changed', 'risk_assessment_version.changed', 'risk_signature.collected', 'risk_measure.changed']) {
      const event = EVENT_CATALOGUE.find(type, 1)
      expect(event?.live?.permission, type).toBe('safety.view')
      expect(JSON.stringify(event?.live?.fields)).not.toMatch(/name|cost/i)
    }
  })
})
