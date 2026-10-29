import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { floorRulesStatus } from '../production/settings/monitoring'
import {
  defaultLabel,
  labelProblems,
  nextVersionNo,
  noticeAckState,
  noticeFingerprint,
  normaliseNoticeBody,
  pickLanguage,
  publishProblems,
  requiredLanguages,
  textProblems,
} from './notices'
import { activityProblems, cleanList, dpiaScopeProblems, dpiaStoreProblems } from './records'
import { floorPrivacyStatus, floorReadiness, NO_DPIA_NOTE, NO_WORKER_NOTICE_NOTE } from './readiness'

// Made-up sample text: real notices come from the company's privacy consultant.
const SAMPLE = 'SAMPLE worker notice, made up for tests.\nThe tablet records which bundle you scanned, when and where.'

describe('notice texts and fingerprints', () => {
  it('fingerprints the exact text as stored: line ends as \\n, no trailing blanks', () => {
    expect(normaliseNoticeBody('line one\r\nline two  \r\n\r\n')).toBe('line one\nline two')
    expect(noticeFingerprint(SAMPLE)).toBe(createHash('sha256').update(SAMPLE, 'utf8').digest('hex'))
    expect(noticeFingerprint('è')).toBe(createHash('sha256').update(Buffer.from('è', 'utf8')).digest('hex'))
    expect(noticeFingerprint(SAMPLE)).not.toBe(noticeFingerprint(`${SAMPLE}.`))
  })

  it('checks the language code, an empty text and the label', () => {
    expect(textProblems({ locale: 'it', body: SAMPLE })).toEqual([])
    expect(textProblems({ locale: 'ita', body: ' \n ' }).map((issue) => issue.path)).toEqual(['params/locale', 'body/body'])
    expect(labelProblems('2026-10')).toEqual([])
    expect(labelProblems(' ')).toHaveLength(1)
    expect(labelProblems('x'.repeat(41))).toHaveLength(1)
    expect(defaultLabel(nextVersionNo([1, 3, 2]))).toBe('v4')
    expect(nextVersionNo([])).toBe(1)
  })

  it('publishes a worker notice only with Italian and English text (Q15), the others with Italian', () => {
    expect(requiredLanguages('WORKER_FLOOR')).toEqual(['it', 'en'])
    expect(requiredLanguages('PRIVACY_PUBLIC')).toEqual(['it'])
    const it = { locale: 'it', hasBody: true, hasPdf: false }
    const en = { locale: 'en', hasBody: true, hasPdf: false }
    const roPdf = { locale: 'ro', hasBody: false, hasPdf: true }
    expect(publishProblems({ kind: 'WORKER_FLOOR', status: 'DRAFT', languages: [it, roPdf] }).map((issue) => issue.path)).toEqual(['texts/en'])
    expect(publishProblems({ kind: 'WORKER_FLOOR', status: 'DRAFT', languages: [it, en, roPdf] })).toEqual([])
    expect(publishProblems({ kind: 'OFFICE_STAFF', status: 'DRAFT', languages: [it] })).toEqual([])
    expect(publishProblems({ kind: 'OFFICE_STAFF', status: 'DRAFT', languages: [{ locale: 'it', hasBody: false, hasPdf: true }] })).toHaveLength(1)
    expect(publishProblems({ kind: 'OFFICE_STAFF', status: 'PUBLISHED', languages: [it] })[0]!.path).toBe('state')
  })

  it("shows a person their language, else Italian, else English", () => {
    expect(pickLanguage(['it', 'en'], 'en')).toBe('en')
    expect(pickLanguage(['it', 'en'], 'ro')).toBe('it')
    expect(pickLanguage(['en'], 'ro')).toBe('en')
    expect(pickLanguage([], 'it')).toBeNull()
  })

  it('counts only an acknowledgement of the version in force', () => {
    expect(noticeAckState({ inForceId: null, acknowledgedIds: ['v1'] })).toBe('NONE_IN_FORCE')
    expect(noticeAckState({ inForceId: 'v2', acknowledgedIds: ['v1', null] })).toBe('DUE')
    expect(noticeAckState({ inForceId: 'v2', acknowledgedIds: ['v1', 'v2'] })).toBe('ACKNOWLEDGED')
  })
})

describe('the floor gate', () => {
  const today = '2026-11-01'
  const basis = floorRulesStatus({ scanSubject: 'WORKER', basisOnRecord: true })

  it('stays shut without a stored DPIA, in words (GDPR art. 35)', () => {
    const status = floorPrivacyStatus({ dpia: null, workerNotice: { label: 'v1' }, today })
    expect(status).toMatchObject({ ready: false, dpiaStored: false, workerNoticePublished: true })
    expect(status.notes[0]).toBe(NO_DPIA_NOTE)
    expect(floorReadiness(status, basis).readyForFloor).toBe(false)
  })

  it('stays shut without a published worker notice (art. 4 c.3)', () => {
    const status = floorPrivacyStatus({ dpia: { versionNo: 1, reviewDueOn: '2027-11-01' }, workerNotice: null, today })
    expect(status).toMatchObject({ ready: false, dpiaStored: true, workerNoticePublished: false, notes: [NO_WORKER_NOTICE_NOTE] })
  })

  it('opens with both, and joins the floor rules (a WORKER site without a legal basis stays shut)', () => {
    const status = floorPrivacyStatus({ dpia: { versionNo: 1, reviewDueOn: '2027-11-01' }, workerNotice: { label: 'v1' }, today })
    expect(status.ready).toBe(true)
    expect(floorReadiness(status, basis)).toMatchObject({ readyForFloor: true })
    const noBasis = floorReadiness(status, floorRulesStatus({ scanSubject: 'WORKER', basisOnRecord: false }))
    expect(noBasis.readyForFloor).toBe(false)
    expect(noBasis.notes.at(-1)).toMatch(/no legal basis is on record/)
    expect(floorReadiness(status, floorRulesStatus({ scanSubject: 'STATION', basisOnRecord: false })).readyForFloor).toBe(true)
  })

  it('says when the DPIA is due for review, without shutting the floor', () => {
    const status = floorPrivacyStatus({ dpia: { versionNo: 1, reviewDueOn: '2026-10-31' }, workerNotice: { label: 'v1' }, today })
    expect(status.ready).toBe(true)
    expect(status.notes[0]).toMatch(/review was due on 2026-10-31/)
  })
})

describe('the DPIA and the record of processing activities', () => {
  const store = { status: 'DRAFT' as const, hasPdf: true, signedByName: 'Sample Signer, legal representative', signedOn: '2026-10-30', reviewDueOn: '2027-10-30', today: '2026-11-01' }

  it('stores a DPIA with its signed PDF, signer, day signed (not in the future) and a later review day', () => {
    expect(dpiaStoreProblems(store)).toEqual([])
    expect(dpiaStoreProblems({ ...store, hasPdf: false })).toHaveLength(1)
    expect(dpiaStoreProblems({ ...store, signedByName: ' ' })[0]!.path).toBe('body/signedByName')
    expect(dpiaStoreProblems({ ...store, signedOn: '2026-11-02' })[0]!.path).toBe('body/signedOn')
    expect(dpiaStoreProblems({ ...store, reviewDueOn: '2026-10-30' })[0]!.path).toBe('body/reviewDueOn')
    expect(dpiaStoreProblems({ ...store, status: 'STORED' })[0]!.path).toBe('state')
    expect(dpiaScopeProblems('')).toHaveLength(1)
  })

  it('asks what, why, on which basis, about whom and which data of each processing activity (art. 30(1))', () => {
    const activity = {
      code: 'FLOOR-SCANS',
      name: 'Floor scans',
      purpose: 'Production records',
      legalBasis: 'Contract and legal obligation (art. 6(1)(b), (c))',
      dataSubjects: ['floor workers'],
      dataCategories: ['name', 'badge'],
      recipients: [],
      processors: ['hosting, EU'],
      transfers: 'None',
      retention: '10 years',
      security: 'Row-level security; encrypted backups',
    }
    expect(activityProblems(activity)).toEqual([])
    expect(activityProblems({ ...activity, code: 'floor scans', dataSubjects: [] }).map((issue) => issue.path)).toEqual(['body/code', 'body/dataSubjects'])
    expect(activityProblems({ purpose: ' ' }, true).map((issue) => issue.path)).toEqual(['body/purpose'])
    expect(activityProblems({}, true)).toEqual([])
    expect(cleanList([' a ', 'a', '', 'b'])).toEqual(['a', 'b'])
  })
})

describe('permissions, templates and events', () => {
  it('declares privacy.view (read) and privacy.manage (write) and gives them to the administrator', () => {
    expect(FACTORY_PERMISSIONS.get('privacy.view')?.risk).toBe('read')
    expect(FACTORY_PERMISSIONS.get('privacy.manage')?.risk).toBe('write')
    expect(templateOf('admin')?.permissions).toEqual(expect.arrayContaining(['privacy.view', 'privacy.manage']))
    expect(templateOf('owner')?.permissions).toEqual(expect.arrayContaining(['privacy.view', 'privacy.manage']))
    expect(templateOf('read_only')?.permissions).toContain('privacy.view')
    expect(templateOf('read_only')?.permissions).not.toContain('privacy.manage')
    expect(templateOf('operator')?.permissions).not.toContain('privacy.view')
  })

  it('declares its events with no name or text in a payload', () => {
    const published = EVENT_CATALOGUE.get('privacy.notice_published', 1)
    expect(() => published.payload.parse({ noticeId: crypto.randomUUID(), companyId: crypto.randomUUID(), kind: 'WORKER_FLOOR', versionNo: 2, label: 'v2', supersededId: null })).not.toThrow()
    expect(() => EVENT_CATALOGUE.parse('privacy.notice_acknowledged', 1, { noticeId: crypto.randomUUID(), kind: 'OFFICE_STAFF', channel: 'OFFICE', userId: crypto.randomUUID() })).toThrow()
    expect(EVENT_CATALOGUE.get('privacy.dpia_stored', 1).live?.permission).toBe('privacy.view')
  })
})
