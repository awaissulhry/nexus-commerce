import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { CLAIMS_APPROVE, CLAIMS_MANAGE } from './permissions'
import { addDays, approveRefusal, blockedSince, blockReasons, claimProblems, claimStateOf, earliestExpiry, nextCode, useRefusal, validityOf, wordingCheck, wordingFindings, wordingOf, wordingRefused, type ClaimInput, type EvidenceFact } from './rules'

const TODAY = '2026-11-10'
const file = (id: string, over: Partial<EvidenceFact> = {}): EvidenceFact => ({ id, status: 'AVAILABLE', expiresOn: null, ...over })
const input = (over: Partial<ClaimInput> = {}): ClaimInput => ({
  code: 'CL-0001',
  kind: 'RECYCLED_CONTENT',
  wording: { it: 'Fodera in poliestere riciclato al 50 %', en: 'Lining made with 50 % recycled polyester' },
  phraseKey: null,
  scope: 'STYLE',
  styleId: '0190f0e2-0001-7000-8000-000000000001',
  itemId: null,
  scopeNote: 'The lining only.',
  evidenceFileIds: ['f1'],
  validUntil: '2027-06-30',
  note: null,
  ...over,
})

describe('the wording checker (Dir. (EU) 2024/825)', () => {
  it('refuses generic claims in English and Italian, with the reason and wording that is allowed', () => {
    const [en] = wordingFindings('en', 'Eco-friendly motorcycle jacket', 'RECYCLED_CONTENT')
    expect(en).toMatchObject({ code: 'GENERIC', severity: 'refuse', words: 'Eco-friendly', law: 'Dir. (EU) 2024/825, Annex I 4a', suggestion: 'Lining made with 50 % recycled polyester' })
    expect(wordingFindings('it', 'Giacca sostenibile', 'OTHER')[0]).toMatchObject({ code: 'GENERIC', words: 'sostenibile' })
    expect(wordingFindings('it-CH', 'Prodotto ecologico', 'OTHER')[0]?.code).toBe('GENERIC')
    expect(wordingRefused({ en: 'A green jacket' }, 'OTHER')).toBe(true)
  })

  it('refuses neutrality through offsetting and a product "certified" by LWG, offering the tannery wording', () => {
    expect(wordingFindings('en', 'Carbon neutral shipping', 'CARBON').map((finding) => finding.code)).toEqual(['OFFSETTING'])
    expect(wordingFindings('it', 'Giacca a impatto zero', 'CARBON')[0]?.law).toBe('Dir. (EU) 2024/825, Annex I 4c')
    const [lwg] = wordingFindings('en', 'LWG certified jacket', 'CERTIFICATION_LABEL')
    expect(lwg).toMatchObject({ code: 'CERTIFIED_PRODUCT', severity: 'refuse', suggestion: 'Leather from a tannery rated by LWG' })
    expect(wordingFindings('it', 'Giacca certificata LWG', 'CERTIFICATION_LABEL')[0]?.suggestion).toBe('Pelle da una conceria valutata LWG')
  })

  it('lets specific claims through and advises a share for content claims', () => {
    expect(wordingFindings('en', 'Leather from a tannery rated by LWG', 'RESPONSIBLE_SOURCING')).toEqual([])
    expect(wordingFindings('en', 'Made without PFAS', 'SUBSTANCE_FREE')).toEqual([])
    expect(wordingFindings('en', 'Lining made with recycled polyester', 'RECYCLED_CONTENT')).toMatchObject([{ code: 'NO_SHARE', severity: 'advise' }])
    expect(wordingFindings('de', 'Umweltfreundlich', 'OTHER')).toEqual([])
    expect(Object.keys(wordingCheck({ it: 'Fodera riciclata', en: 'Lining made with 50 % recycled polyester' }, 'RECYCLED_CONTENT'))).toEqual(['it'])
  })
})

describe('a claim as typed', () => {
  it('takes a well-formed claim and says each problem at its field', () => {
    expect(claimProblems(input())).toEqual([])
    const paths = claimProblems(input({ code: '-bad', wording: { en: 'Eco-friendly', xx_y: 'Words' }, scope: 'MATERIAL', styleId: 'x', itemId: null, evidenceFileIds: ['a', 'a'] })).map((problem) => problem.path)
    expect(paths).toEqual(['code', 'wording.en', 'wording.xx_y', 'itemId', 'styleId', 'evidenceFileIds'])
    expect(claimProblems(input({ wording: {} }))[0]?.path).toBe('wording')
    expect(wordingOf({ it: '  Pelle  ', en: '', de: null })).toEqual({ it: 'Pelle' })
  })
})

describe('evidence, approval and use', () => {
  it('reads an approved claim as blocked once its last valid day passed or an evidence file expired or is gone', () => {
    const approved = { status: 'APPROVED' as const, validUntil: '2026-11-09', evidenceFileIds: ['f1', 'f2'] }
    const reasons = blockReasons(approved, [file('f1', { expiresOn: '2026-10-31' }), file('f2', { status: 'DELETED' })], TODAY)
    expect(reasons.map((reason) => reason.cause)).toEqual(['VALID_UNTIL', 'FILE_EXPIRED', 'FILE_GONE'])
    expect(blockedSince(reasons)).toBe('2026-11-01')
    expect(blockedSince([{ cause: 'FILE_GONE', fileId: 'f2', day: null }])).toBe('gone')
    expect(claimStateOf(approved, [file('f1'), file('f2')], TODAY)).toBe('BLOCKED')
    expect(claimStateOf({ ...approved, validUntil: TODAY }, [file('f1'), file('f2')], TODAY)).toBe('APPROVED')
    expect(claimStateOf({ ...approved, status: 'WITHDRAWN' }, [], TODAY)).toBe('RETIRED')
    expect(claimStateOf({ ...approved, status: 'DRAFT' }, [], TODAY)).toBe('DRAFT')
  })

  it('approves a draft only with available evidence that still holds', () => {
    const draft = { status: 'DRAFT' as const, validUntil: '2027-01-31', evidenceFileIds: ['f1'] }
    expect(approveRefusal(draft, [file('f1')], TODAY)).toBeNull()
    expect(approveRefusal({ ...draft, evidenceFileIds: [] }, [], TODAY)?.code).toBe('NO_EVIDENCE')
    expect(approveRefusal(draft, [file('f1', { status: 'PENDING_UPLOAD' })], TODAY)?.code).toBe('EVIDENCE_NOT_AVAILABLE')
    expect(approveRefusal(draft, [file('f1', { expiresOn: '2026-11-01' })], TODAY)?.code).toBe('EVIDENCE_EXPIRED')
    expect(approveRefusal({ ...draft, validUntil: '2026-11-09' }, [file('f1')], TODAY)?.code).toBe('VALID_UNTIL_PAST')
    expect(approveRefusal({ ...draft, status: 'APPROVED' }, [file('f1')], TODAY)?.code).toBe('NOT_DRAFT')
    expect(useRefusal('APPROVED')).toBeNull()
    expect(useRefusal('BLOCKED')?.code).toBe('NOT_HOLDING')
    expect(useRefusal('DRAFT')?.code).toBe('NOT_APPROVED')
  })

  it('reads a validity against the 180 / 90 / 30 day thresholds, the earliest file expiry and the next code', () => {
    expect(validityOf(null, TODAY)).toEqual({ state: 'NONE', daysLeft: null, threshold: null })
    expect(validityOf('2027-12-31', TODAY).state).toBe('OK')
    expect(validityOf(addDays(TODAY, 80), TODAY)).toEqual({ state: 'SOON', daysLeft: 80, threshold: 90 })
    expect(validityOf(addDays(TODAY, 12), TODAY).threshold).toBe(30)
    expect(validityOf('2026-11-09', TODAY)).toMatchObject({ state: 'EXPIRED', daysLeft: -1 })
    expect(earliestExpiry([{ expiresOn: '2027-03-01' }, { expiresOn: null }, { expiresOn: '2026-12-31' }])).toBe('2026-12-31')
    expect(nextCode(['CL-0003', 'SEED-CL-01', 'cl-0009'])).toBe('CL-0010')
    expect(nextCode([])).toBe('CL-0001')
  })
})

describe('permissions, templates and events', () => {
  it('declares the two permissions, gives them to the quality inspector and declares the three events', () => {
    expect(FACTORY_PERMISSIONS.get(CLAIMS_MANAGE)?.risk).toBe('write')
    expect(FACTORY_PERMISSIONS.get(CLAIMS_APPROVE)?.risk).toBe('stepUp')
    expect(templateOf('quality_inspector')?.permissions).toEqual(expect.arrayContaining([CLAIMS_MANAGE, CLAIMS_APPROVE, 'compliance.certificates.view']))
    expect(templateOf('production_manager')?.permissions).not.toContain(CLAIMS_MANAGE)
    for (const type of ['claim.changed', 'claim.use_changed', 'claim.evidence_expired']) expect(EVENT_CATALOGUE.get(type, 1).live?.permission).toBe('compliance.certificates.view')
  })
})
