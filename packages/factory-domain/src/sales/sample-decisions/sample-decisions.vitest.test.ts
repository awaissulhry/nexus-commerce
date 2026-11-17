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
  // B-PR-29
  materialKindRefusal,
  SWATCH_MATERIAL_KINDS,
  swatchAnswerHeldWords,
  SWATCH_KINDS,
  SWATCH_WORDS,
  // B-PR-38
  customerDecidesRefusal,
} from './rules'
import { ITEM_KINDS } from '../../product/materials/rules'

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
    // A sample round is asked as a SAMPLE, a swatch as its own COLOUR or LEATHER (B-PR-24: or FABRIC or TRIM).
    expect(kindsFor('SampleRound')).toEqual(['SAMPLE'])
    expect(kindsFor('SampleSwatch')).toEqual(['COLOUR', 'LEATHER', 'FABRIC', 'TRIM'])
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
    // B-PR-23: a fabric or a trim swatch is asked with its own kind, named on the office's button.
    expect(swatchAskRefusal({ ...sent, kind: 'FABRIC' }, 'COLOUR', null)).toMatchObject({ code: 'SWATCH_KIND', message: 'This is a fabric swatch: ask with Fabric.' })
    expect(swatchAskRefusal({ ...sent, kind: 'TRIM' }, 'LEATHER', null)).toMatchObject({ code: 'SWATCH_KIND', message: 'This is a trim swatch: ask with Trim.' })
    expect(swatchAskRefusal({ ...sent, kind: 'FABRIC' }, 'FABRIC', null)).toBeNull()
    expect(swatchAskRefusal(swatch, 'LEATHER', null)?.code).toBe('SWATCH_NOT_SENT')
    expect(swatchRoundRefusal({ number: 'SR-1', stage: 'CANCELLED', partyId: 'p' }, 'p')?.code).toBe('SWATCH_ROUND_CANCELLED')
    expect(swatchRoundRefusal({ number: 'SR-1', stage: 'SENT', partyId: 'p' }, 'q')?.code).toBe('NOT_THE_ROUNDS_PARTY')
    expect(swatchRoundRefusal({ number: 'SR-1', stage: 'SENT', partyId: null }, 'q')).toBeNull()
  })
})

// ---- B-PR-29 (production plan §3 "Brand alone: … fabric, trims"; 08-backend §4.4) ----------------------------------------------
describe('fabric and trim swatches (B-PR-29)', () => {
  it('a swatch is of a material of its kind, said before the database says it (MATERIAL_KIND, LEATHER_ONLY)', () => {
    expect(materialKindRefusal('FABRIC', 'SEED-LIN-200', 'LINING')).toBeNull()
    expect(materialKindRefusal('FABRIC', 'T-TEX', 'TEXTILE')).toBeNull()
    expect(materialKindRefusal('TRIM', 'T-ZIP', 'HARDWARE')).toBeNull()
    expect(materialKindRefusal('TRIM', 'T-LBL', 'LABEL')).toBeNull()
    expect(materialKindRefusal('COLOUR', 'SEED-PRO-300', 'PROTECTOR')).toBeNull()
    expect(materialKindRefusal('LEATHER', 'SEED-LEA-100', 'LEATHER')).toBeNull()
    expect(materialKindRefusal('TRIM', 'SEED-PRO-300', 'PROTECTOR')).toEqual({
      code: 'MATERIAL_KIND',
      message: 'SEED-PRO-300 is protector: a trim swatch is of a trim, hardware, thread or label (or make it a colour swatch).',
    })
    expect(materialKindRefusal('FABRIC', 'SEED-LEA-100', 'LEATHER')?.code).toBe('MATERIAL_KIND')
    expect(materialKindRefusal('LEATHER', 'SEED-LIN-200', 'LINING')?.code).toBe('LEATHER_ONLY')
  })

  it('names only material kinds the catalogue has, one word per swatch kind in both languages, the same held words for every kind', () => {
    for (const kind of SWATCH_KINDS) {
      for (const material of SWATCH_MATERIAL_KINDS[kind] ?? []) expect(ITEM_KINDS as readonly string[], `${kind} ${material}`).toContain(material)
      expect(SWATCH_WORDS[kind].it.length > 0 && SWATCH_WORDS[kind].en.length > 0, kind).toBe(true)
    }
    // The database's lists (…_brand_asks_guards factory_sample_swatch_guard).
    expect(SWATCH_MATERIAL_KINDS.FABRIC).toEqual(['TEXTILE', 'LINING', 'MEMBRANE', 'PADDING'])
    expect(SWATCH_MATERIAL_KINDS.TRIM).toEqual(['TRIM', 'HARDWARE', 'THREAD', 'LABEL'])
    expect(swatchAnswerHeldWords({ decision: 'APPROVED', approvalRequestId: 'r' }, 'r', 'it')).toBe('Questo campione di materiale è già stato deciso.')
    expect(swatchAnswerHeldWords({ decision: 'APPROVED', approvalRequestId: 'r' }, 'r', 'en')).toBe('This swatch is decided already.')
  })

  it('a fabric and a trim are asked on a swatch and on the records with a thread, never on a round', () => {
    expect(kindsFor('SampleSwatch')).toEqual(expect.arrayContaining(['COLOUR', 'LEATHER', 'FABRIC', 'TRIM']))
    expect(kindsFor('SampleRound')).toEqual(['SAMPLE'])
    expect(kindsFor('Style')).toEqual(expect.arrayContaining(['FABRIC', 'TRIM']))
  })
})

// ---- B-PR-38 (production plan §3 "No silent decisions"; review fix R-06) -------------------------------------------------------
describe('no silent office decision on a customer\'s own round or swatch (B-PR-38)', () => {
  const made = { number: 'SR-2026-0007', stage: 'UNDER_REVIEW' as const, partyId: 'p1' }
  it('a round of a customer whose portal is on is refused in words that point to Decide for the customer, asked or not', () => {
    const words = "Sample round SR-2026-0007 is the customer's to decide: ask them to approve it in their portal, or use Decide for the customer (a reason they read; a second person when their switch is on)."
    expect(decisionRefusal(made, null, true)).toEqual({ code: 'CUSTOMER_DECIDES', message: words })
    expect(decisionRefusal(made, { dueAt: DUE }, true)?.code).toBe('CUSTOMER_DECIDES')
    // Closed and not made yet keep their own words; an internal round and a customer without a portal stay the office's.
    expect(decisionRefusal({ ...made, stage: 'DECIDED' }, null, true)?.code).toBe('ROUND_CLOSED')
    expect(decisionRefusal({ ...made, stage: 'REQUESTED' }, null, true)?.code).toBe('NOTHING_MADE')
    expect(decisionRefusal({ ...made, partyId: null }, null, true)).toBeNull()
    expect(decisionRefusal(made, null, false)).toBeNull()
    expect(decisionRefusal(made, null)).toBeNull()
    expect(decisionRefusal(made, { dueAt: DUE }, false)?.code).toBe('BRAND_ASKED')
  })

  it('a swatch the same way, its kind in the words; never naming the customer', () => {
    const sent = { kind: 'FABRIC' as const, sentAt: new Date('2026-11-02T09:00:00Z'), decision: null }
    expect(swatchDecisionRefusal(sent, null, true)).toMatchObject({ code: 'CUSTOMER_DECIDES', message: expect.stringMatching(/^This fabric swatch is the customer's to decide: /) })
    expect(swatchDecisionRefusal({ ...sent, sentAt: null }, null, true)?.code).toBe('SWATCH_NOT_SENT')
    expect(swatchDecisionRefusal({ ...sent, decision: 'APPROVED' }, null, true)?.code).toBe('SWATCH_DECIDED')
    expect(swatchDecisionRefusal(sent, null, false)).toBeNull()
    expect(customerDecidesRefusal('X').message).not.toMatch(/brand alpha|another customer/i)
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
