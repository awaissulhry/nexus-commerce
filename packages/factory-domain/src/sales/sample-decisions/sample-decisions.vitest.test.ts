import { describe, expect, it } from 'vitest'
import { kindsFor } from '../../approvals-out/kinds'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { decisionBody, fitSaveBody } from './contracts'
import { SALES_SAMPLES_DECIDE, SALES_SAMPLES_MEASURE } from './permissions'
import {
  answerHeldWords,
  askRefusal,
  decisionOfAnswer,
  decisionProblems,
  decisionRefusal,
  differenceOf,
  fitRefusal,
  measuredProblems,
  nextRoundRefusal,
  outsideWords,
  passOf,
  swatchAskRefusal,
  swatchDecisionRefusal,
  swatchRoundRefusal,
  swatchSentOnceRefusal,
  swatchSentRefusal,
  testResultRefusal,
} from './rules'

/** Sample decisions (B-W2b-252): the refusals in words, the fit's arithmetic, the brand's answer, the catalogues. */

const DUE = new Date('2026-11-20T10:00:00Z')
const round = (stage: 'REQUESTED' | 'IN_MAKING' | 'SENT' | 'UNDER_REVIEW' | 'DECIDED' | 'CANCELLED', partyId: string | null = 'p') => ({ number: 'SR-2026-0007', stage, partyId })

describe('the decision of a round (SAL-312)', () => {
  it('is recorded once, on a made sample, never over a request the brand has not answered', () => {
    expect(decisionRefusal(round('UNDER_REVIEW'), null)).toBeNull()
    expect(decisionRefusal(round('IN_MAKING', null), null)).toBeNull()
    expect(decisionRefusal(round('REQUESTED'), null)?.code).toBe('NOTHING_MADE')
    expect(decisionRefusal(round('DECIDED'), null)).toMatchObject({ code: 'ROUND_CLOSED', message: 'Sample round SR-2026-0007 is decided: its decision is recorded once.' })
    expect(decisionRefusal(round('CANCELLED'), null)?.code).toBe('ROUND_CLOSED')
    expect(decisionRefusal(round('UNDER_REVIEW'), { dueAt: DUE })).toMatchObject({ code: 'BRAND_ASKED', message: expect.stringContaining('by 2026-11-20): withdraw the request first') })
    expect(decisionProblems('APPROVED', undefined)).toEqual([])
    expect(decisionProblems('REJECTED', '  ')).toEqual([{ path: 'body/comments', message: 'Say why it is rejected.' }])
    expect(decisionProblems('APPROVED_WITH_COMMENTS', null)[0]?.message).toBe('Say what the comments are.')
    expect(decisionBody.safeParse({ version: 1, decision: 'APPROVED', comments: '' }).success).toBe(false)
  })

  it('asks only a brand, of a made and open round, once at a time; the next round follows a rejection', () => {
    expect(askRefusal(round('SENT'), null)).toBeNull()
    expect(askRefusal(round('SENT', null), null)?.code).toBe('INTERNAL_ROUND')
    expect(askRefusal(round('REQUESTED'), null)?.code).toBe('NOTHING_MADE')
    expect(askRefusal(round('SENT'), { dueAt: DUE })?.code).toBe('BRAND_ASKED')
    expect(askRefusal(round('DECIDED'), null)?.code).toBe('ROUND_CLOSED')
    expect(nextRoundRefusal({ number: 'SR-1', decision: 'REJECTED' })).toBeNull()
    expect(nextRoundRefusal({ number: 'SR-1', decision: 'APPROVED_WITH_COMMENTS' })).toMatchObject({ code: 'NOT_REJECTED', message: expect.stringContaining('is approved with comments') })
    expect(nextRoundRefusal({ number: 'SR-1', decision: null })?.message).toContain('is not decided')
  })

  it("takes the brand's answer as the database maps it, and holds it once the round moved on", () => {
    expect(decisionOfAnswer('APPROVED')).toBe('APPROVED')
    expect(decisionOfAnswer('APPROVED_WITH_CHANGES')).toBe('APPROVED_WITH_COMMENTS')
    expect(decisionOfAnswer('REFUSED')).toBe('REJECTED')
    expect(decisionOfAnswer('WITHDRAWN')).toBeNull()
    expect(answerHeldWords({ stage: 'UNDER_REVIEW', approvalRequestId: 'r1' }, 'r1', 'en')).toBeNull()
    expect(answerHeldWords({ stage: 'UNDER_REVIEW', approvalRequestId: null }, 'r1', 'en')).toBeNull()
    expect(answerHeldWords({ stage: 'DECIDED', approvalRequestId: 'r1' }, 'r1', 'it')).toBe('Questo campione è già stato deciso.')
    expect(answerHeldWords({ stage: 'SENT', approvalRequestId: 'r2' }, 'r1', 'en')).toBe('We sent you a newer request for this sample.')
    // A sample round is asked as a SAMPLE, a swatch as its own COLOUR or LEATHER.
    expect(kindsFor('SampleRound')).toEqual(['SAMPLE'])
    expect(kindsFor('SampleSwatch')).toEqual(['COLOUR', 'LEATHER'])
  })
})

describe('the CE test sample (PRD-158)', () => {
  it('records the result and the certificate once each, on a certification round only', () => {
    const cert = { number: 'SR-9', kind: 'CERTIFICATION' as const, testResult: null, certificateId: null }
    expect(testResultRefusal(cert, { testResult: 'PASSED' })).toBeNull()
    expect(testResultRefusal({ ...cert, kind: 'FIT' }, { testResult: 'PASSED' })?.code).toBe('CERTIFICATION_ONLY')
    expect(testResultRefusal({ ...cert, testResult: 'PASSED' }, { testResult: 'FAILED' })?.code).toBe('RESULT_ONCE')
    expect(testResultRefusal({ ...cert, testResult: 'PASSED' }, { testResult: 'PASSED', certificateId: 'c' })).toBeNull()
    expect(testResultRefusal({ ...cert, certificateId: 'c' }, { certificateId: 'd' })?.code).toBe('CERTIFICATE_ONCE')
    expect(testResultRefusal({ ...cert, testResult: 'PASSED' }, { testResult: 'PASSED' })?.code).toBe('NOTHING_TO_RECORD')
  })
})

describe('the fit (PRD-070)', () => {
  it('is inside the tolerance with both bounds included, the difference signed, a measure above 0 with 2 decimals', () => {
    expect(passOf('63.5', '64.5', '1', '1')).toBe(true)
    expect(passOf('65.5', '64.5', '1', '1')).toBe(true)
    expect(passOf('65.51', '64.5', '1', '1')).toBe(false)
    expect(passOf('63', '64.5', '0.5', '2')).toBe(false)
    expect(differenceOf('65.8', '64.50')).toBe('+1.3')
    expect(differenceOf('64', '64.5')).toBe('-0.5')
    expect(differenceOf('64.50', '64.5')).toBe('0')
    expect(measuredProblems('65.8', 'p')).toEqual([])
    expect(measuredProblems('0', 'p')).toEqual([{ path: 'p', message: 'A measure above 0.' }])
    expect(measuredProblems('65.123', 'p')).toHaveLength(1)
    expect(measuredProblems('1234567', 'p')).toHaveLength(1)
    expect(outsideWords({ pomCode: 'SLEEVE_LEN', size: '52', measured: '65.80', nominal: '64.50', toleranceMinus: '0.50', tolerancePlus: '1.00', uom: 'CM' })).toBe('SLEEVE_LEN 52: 65.8 cm, 1.3 over 64.5 −0.5/+1')
    expect(outsideWords({ pomCode: 'CHEST_W', size: '50', measured: '54', nominal: '56', toleranceMinus: '1', tolerancePlus: '1', uom: 'CM' })).toBe('CHEST_W 50: 54 cm, 2 under 56 ± 1')
    expect(fitRefusal({ number: 'SR-1', stage: 'SENT' })).toBeNull()
    expect(fitRefusal({ number: 'SR-1', stage: 'DECIDED' })?.code).toBe('FIT_CLOSED')
    expect(fitSaveBody.safeParse({ cells: [] }).success).toBe(false)
  })
})

describe('swatches (SAL-314)', () => {
  const swatch = { kind: 'LEATHER' as const, sentAt: null as Date | null, decision: null as 'APPROVED' | null }
  it('is changed and removed until sent, sent once, asked with its own kind and decided once after it is sent', () => {
    const sent = { ...swatch, sentAt: new Date('2026-11-02T09:00:00Z') }
    expect(swatchSentRefusal(swatch, 'change')).toBeNull()
    expect(swatchSentRefusal(sent, 'remove')?.code).toBe('SWATCH_SENT')
    expect(swatchSentOnceRefusal(sent, new Date('2026-11-03T09:00:00Z'))?.code).toBe('SENT_ONCE')
    expect(swatchSentOnceRefusal(sent, new Date('2026-11-02T09:00:00Z'))).toBeNull()
    expect(swatchDecisionRefusal(swatch, null)?.code).toBe('SWATCH_NOT_SENT')
    expect(swatchDecisionRefusal(sent, null)).toBeNull()
    expect(swatchDecisionRefusal(sent, { dueAt: DUE })?.code).toBe('BRAND_ASKED')
    expect(swatchDecisionRefusal({ ...sent, decision: 'APPROVED' }, null)?.code).toBe('SWATCH_DECIDED')
    expect(swatchAskRefusal(sent, 'COLOUR', null)).toMatchObject({ code: 'SWATCH_KIND', message: 'This is a leather swatch: ask with Leather.' })
    expect(swatchAskRefusal(sent, 'LEATHER', null)).toBeNull()
    expect(swatchAskRefusal(swatch, 'LEATHER', null)?.code).toBe('SWATCH_NOT_SENT')
    expect(swatchRoundRefusal({ number: 'SR-1', stage: 'CANCELLED', partyId: 'p' }, 'p')?.code).toBe('SWATCH_ROUND_CANCELLED')
    expect(swatchRoundRefusal({ number: 'SR-1', stage: 'SENT', partyId: 'p' }, 'q')?.code).toBe('NOT_THE_ROUNDS_PARTY')
    expect(swatchRoundRefusal({ number: 'SR-1', stage: 'SENT', partyId: null }, 'q')).toBeNull()
  })
})

describe('the catalogues', () => {
  it('declares the two permissions, gives them to their templates, and declares the five events without a person or money', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(SALES_SAMPLES_DECIDE)).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared(SALES_SAMPLES_MEASURE)).toBe(true)
    const holds = (key: string) => ROLE_TEMPLATES.find((entry) => entry.key === key)!.permissions as readonly string[]
    expect(holds('sales')).toContain(SALES_SAMPLES_DECIDE)
    expect(holds('sales')).not.toContain(SALES_SAMPLES_MEASURE)
    expect(holds('production_manager')).toEqual(expect.arrayContaining([SALES_SAMPLES_DECIDE, SALES_SAMPLES_MEASURE]))
    expect(holds('quality_inspector')).toContain(SALES_SAMPLES_MEASURE)
    expect(holds('quality_inspector')).not.toContain(SALES_SAMPLES_DECIDE)
    for (const type of ['sample_round.decided', 'sample_round.asked', 'sample_round.fit_changed', 'sample_round.test_recorded', 'sample_swatch.changed']) expect(EVENT_CATALOGUE.find(type, 1), type).toBeDefined()
  })
})
