import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { Activity, CompanyOverview, Dpia, Notice } from './api'
import { ACKS_NAMED, designScreen, NOTICES, REGISTER, WORKER_DRAFT, WORKER_NOW } from './fixtures'
import {
  activityDraftOf,
  activityErrors,
  activityFields,
  activityPatch,
  companyOf,
  csvOf,
  dutiesDone,
  dutyLines,
  editedLocales,
  emptyActivity,
  languageName,
  languagesInOrder,
  missingFromRefusal,
  missingLanguages,
  newNoticeHeld,
  notYetAcknowledged,
  paperHeld,
  privacyCan,
  problemOf,
  publicAddress,
  publishHeld,
  registerRows,
  reviewDefault,
  siteWords,
  storeHeld,
  suggestedLabel,
  viewOf,
} from './model'

/**
 * SCR-086 Privacy & notices: the duties in this web's words with their real state, each site's floor gate, the notice
 * rules (languages before Publish, one draft per notice, labels), names only in one notice and only with the manage
 * right, the DPIA's Store rules (factory-domain's), the register form, and every design case drawn in it and en with no
 * key left on screen, the sample texts said at rest.
 */

const MANAGE = privacyCan(['privacy.view', 'privacy.manage', 'files.read', 'files.upload'])
const VIEW = privacyCan(['privacy.view'])

const overview = (extra: Partial<CompanyOverview> = {}): CompanyOverview => ({
  company: { id: 'c1', code: 'DEMO', name: 'Officina Demo' },
  duties: [
    { key: 'register', done: true },
    { key: 'publicNotice', done: true },
    { key: 'staffNotice', done: false },
    { key: 'workerNotice', done: true },
    { key: 'dpia', done: true },
  ],
  notices: { WORKER_FLOOR: { id: 'n1', label: '2026-10', publishedAt: null }, OFFICE_STAFF: null, PRIVACY_PUBLIC: { id: 'n2', label: '2026-09', publishedAt: null } },
  dpia: { id: 'd1', versionNo: 2, signedOn: '2026-09-01', reviewDueOn: '2027-09-01' },
  activities: 3,
  sites: [{ id: 's1', code: 'DN1', name: 'Nord', readyForFloor: false }],
  ...extra,
})

describe('the duties and the floor gate', () => {
  it('says each duty in words with its law, in the design order, from the records (never a tick box)', () => {
    const lines = dutyLines(overview(), '2026-10-30')
    expect(lines.map((line) => line.key)).toEqual(['register', 'publicNotice', 'staffNotice', 'dpia', 'workerNotice'])
    expect(lines.find((line) => line.key === 'register')).toMatchObject({ state: 'done', words: { key: 'pv.duty.register.done', params: { count: 3 } }, law: 'pv.duty.register.law', view: 'register' })
    expect(lines.find((line) => line.key === 'staffNotice')).toMatchObject({ state: 'needs', words: { key: 'pv.duty.staffNotice.needs' } })
    expect(dutiesDone(lines)).toEqual({ done: 4, total: 5 })
  })

  it('a missing DPIA or worker notice says what it holds back; a passed review day asks for the review', () => {
    const none = dutyLines(overview({ dpia: null, duties: overview().duties.map((duty) => ({ ...duty, done: duty.key === 'dpia' || duty.key === 'workerNotice' ? false : duty.done })) }), '2026-10-30')
    expect(none.find((line) => line.key === 'dpia')).toMatchObject({ state: 'needs', gates: 'pv.duty.dpia.gates' })
    expect(none.find((line) => line.key === 'workerNotice')).toMatchObject({ state: 'needs', gates: 'pv.duty.workerNotice.gates' })
    const due = dutyLines(overview(), '2027-09-01').find((line) => line.key === 'dpia')!
    expect(due).toMatchObject({ state: 'review', words: { key: 'pv.duty.dpia.review', params: { version: 2, date: '2027-09-01' } } })
    expect(dutiesDone(dutyLines(overview(), '2027-09-01'))).toEqual({ done: 4, total: 5 })
  })

  it('a site waits for the DPIA, the worker notice, else its floor rules (the legal basis)', () => {
    const site = overview().sites[0]!
    expect(siteWords({ ...site, readyForFloor: true }, overview())).toEqual([{ key: 'pv.site.ready' }])
    expect(siteWords(site, overview())).toEqual([{ key: 'pv.site.noBasis' }])
    expect(siteWords(site, overview({ dpia: null, notices: { ...overview().notices, WORKER_FLOOR: null } }))).toEqual([{ key: 'pv.site.noDpia' }, { key: 'pv.site.noNotice' }])
  })

  it('reads the list and the company from the address, the session, else the first one', () => {
    expect(viewOf('dpia')).toBe('dpia')
    expect(viewOf('nope')).toBe('notices')
    const companies = [{ id: 'a', code: 'A', name: 'A' }, { id: 'b', code: 'B', name: 'B' }]
    expect(companyOf(companies, 'b', 'a')).toBe('b')
    expect(companyOf(companies, 'zzz', 'a')).toBe('a')
    expect(companyOf(companies, null, null)).toBe('a')
    expect(companyOf([], null, 'a')).toBeNull()
  })
})

describe('notices', () => {
  it('names each language in its own words, Italian and English first', () => {
    expect(languageName('it')).toBe('Italiano')
    expect(languageName('en')).toBe('English')
    expect(languageName('ro')).toBe('Română')
    expect(languagesInOrder([{ locale: 'ro' }, { locale: 'en' }, { locale: 'it' }, { locale: 'ar' }])).toEqual(['it', 'en', 'ar', 'ro'])
  })

  it('a draft needs Italian, and the worker notice English too, as text before it is published (factory-domain\'s rule)', () => {
    expect(missingLanguages(WORKER_DRAFT)).toEqual(['en'])
    expect(missingLanguages(WORKER_NOW)).toEqual([])
    expect(missingLanguages({ ...WORKER_DRAFT, kind: 'OFFICE_STAFF' })).toEqual([])
    expect(publishHeld(WORKER_DRAFT, MANAGE, false)).toMatchObject({ key: 'pv.held.missing', params: { languages: 'English' } })
    const complete: Notice = { ...WORKER_DRAFT, languages: [...WORKER_DRAFT.languages, { locale: 'en', body: 'SAMPLE', hasText: true, fileId: null, sha256: 'b'.repeat(64) }] }
    expect(publishHeld(complete, MANAGE, false)).toBeNull()
    expect(publishHeld(complete, MANAGE, true)).toEqual({ key: 'pv.held.unsaved' })
    expect(publishHeld(complete, VIEW, false)).toEqual({ key: 'pv.held.manage' })
    expect(publishHeld(WORKER_NOW, MANAGE, false)).toEqual({ key: 'pv.held.notDraft' })
  })

  it('a refused publish names the missing languages from the API\'s issue paths, never its English', () => {
    const refused = new ApiError('conflict', 409, 'invalid_state', 'Version 2026-11 cannot be published yet.', null, [{ path: 'texts/en', message: 'Write the English text first…' }])
    expect(missingFromRefusal(refused)).toEqual(['en'])
    expect(missingFromRefusal(new ApiError('conflict', 409, 'conflict', 'A later version…'))).toBeNull()
    expect(problemOf(new ApiError('unavailable', 503, 'not_ready', 'x'))).toBe('pv.problem.unavailable')
  })

  it('one draft per notice; the label is free and at most 40 characters; this month is suggested', () => {
    expect(newNoticeHeld({ kind: 'WORKER_FLOOR', label: '2026-12', copyTexts: true }, NOTICES, MANAGE)).toEqual({ key: 'pv.held.draftExists', params: { label: '2026-11' } })
    expect(newNoticeHeld({ kind: 'OFFICE_STAFF', label: '2026-10', copyTexts: true }, NOTICES, MANAGE)).toEqual({ key: 'pv.held.labelTaken', params: { label: '2026-10' } })
    expect(newNoticeHeld({ kind: 'OFFICE_STAFF', label: ' ', copyTexts: true }, NOTICES, MANAGE)).toEqual({ key: 'pv.held.label' })
    expect(newNoticeHeld({ kind: 'OFFICE_STAFF', label: '2026-11', copyTexts: true }, NOTICES, MANAGE)).toBeNull()
    expect(newNoticeHeld({ kind: 'OFFICE_STAFF', label: '2026-11', copyTexts: true }, NOTICES, VIEW)).toEqual({ key: 'pv.held.manage' })
    expect(suggestedLabel(['2026-09'], '2026-10-30')).toBe('2026-10')
    expect(suggestedLabel(['2026-10', '2026-10-2'], '2026-10-30')).toBe('2026-10-3')
  })

  it('knows which typed texts are not saved yet', () => {
    expect(editedLocales(WORKER_DRAFT, { it: WORKER_DRAFT.languages[0]!.body!, en: 'SAMPLE' })).toEqual(['en'])
  })

  it('a paper copy: the worker notice in force, a worker who has not acknowledged it, a language of it', () => {
    const waiting = notYetAcknowledged(ACKS_NAMED.people)
    expect(waiting.map((person) => person.displayName)).toEqual(['Elena Modello', 'Fabio Saggio', 'Gina Test'])
    expect(paperHeld(WORKER_NOW, ACKS_NAMED, MANAGE, { workerId: '', locale: 'it' })).toEqual({ key: 'pv.held.pickWorker' })
    expect(paperHeld(WORKER_NOW, ACKS_NAMED, MANAGE, { workerId: waiting[0]!.id, locale: 'de' })).toEqual({ key: 'pv.held.pickLanguage' })
    expect(paperHeld(WORKER_NOW, ACKS_NAMED, MANAGE, { workerId: waiting[0]!.id, locale: 'ro' })).toBeNull()
    expect(paperHeld(WORKER_DRAFT, ACKS_NAMED, MANAGE, { workerId: waiting[0]!.id, locale: 'it' })).toEqual({ key: 'pv.held.paperInForce' })
    expect(paperHeld(WORKER_NOW, { ...ACKS_NAMED, people: null }, VIEW, { workerId: 'x', locale: 'it' })).toEqual({ key: 'pv.held.manage' })
  })

  it('the public notice lives at /privacy/<company id> on this web', () => {
    expect(publicAddress('https://fabbrica.example.com/', 'c1')).toBe('https://fabbrica.example.com/privacy/c1')
  })
})

describe('the DPIA', () => {
  const draft: Dpia = { id: 'd2', companyId: 'c1', versionNo: 2, scope: 'SAMPLE', status: 'DRAFT', fileId: null, fileSha256: null, signedByName: null, signedOn: null, reviewDueOn: null, storedAt: null, supersededAt: null, version: 1 }
  const form = { signedByName: 'Alex Demo', signedOn: '2026-10-29', reviewDueOn: '2027-10-29' }
  it('Store waits for the signed PDF, the signer and the days (factory-domain\'s rules), in this page\'s words', () => {
    expect(storeHeld(draft, form, MANAGE, '2026-10-30')).toEqual({ key: 'pv.held.dpiaPdf' })
    const withPdf = { ...draft, fileId: 'f1', fileSha256: 'a'.repeat(64) }
    expect(storeHeld(withPdf, form, MANAGE, '2026-10-30')).toBeNull()
    expect(storeHeld(withPdf, { ...form, signedByName: ' ' }, MANAGE, '2026-10-30')).toEqual({ key: 'pv.held.dpiaSigner' })
    expect(storeHeld(withPdf, { ...form, signedOn: '2026-11-02' }, MANAGE, '2026-10-30')).toEqual({ key: 'pv.held.dpiaSignedOn' })
    expect(storeHeld(withPdf, { ...form, reviewDueOn: '2026-10-01' }, MANAGE, '2026-10-30')).toEqual({ key: 'pv.held.dpiaReview' })
    expect(storeHeld(withPdf, { ...form, signedOn: '' }, MANAGE, '2026-10-30')).toEqual({ key: 'pv.held.dpiaSignedOnMissing' })
    expect(storeHeld(null, form, MANAGE, '2026-10-30')).toEqual({ key: 'pv.held.noDraft' })
    expect(storeHeld(withPdf, form, VIEW, '2026-10-30')).toEqual({ key: 'pv.held.manage' })
    expect(reviewDefault('2026-10-29')).toBe('2027-10-29')
  })
})

describe('the record of processing activities', () => {
  it('a new activity says each missing field in our words; lists are one per line, trimmed, no repeats', () => {
    const errors = activityErrors({ ...emptyActivity(), code: 'bad code', name: 'Spedizioni' }, true)
    expect(errors).toMatchObject({ code: 'pv.form.codeRule', purpose: 'pv.form.required', dataSubjects: 'pv.form.atLeastOne', dataCategories: 'pv.form.atLeastOne' })
    expect(errors.name).toBeUndefined()
    expect(activityFields({ ...emptyActivity(), dataSubjects: ' Lavoratori \n\nLavoratori\nVisitatori' }).dataSubjects).toEqual(['Lavoratori', 'Visitatori'])
  })

  it('an edit sends only what changed (none: nothing)', () => {
    const activity = REGISTER[0]!
    expect(activityPatch(activity, activityDraftOf(activity))).toBeNull()
    expect(activityPatch(activity, { ...activityDraftOf(activity), retention: '5 anni', processors: 'Hosting Demo — UE (Amsterdam)\nArchivio file Demo — UE' })).toEqual({ retention: '5 anni', processors: ['Hosting Demo — UE (Amsterdam)', 'Archivio file Demo — UE'] })
    expect(activityErrors(activityDraftOf(activity), false)).toEqual({})
  })

  it('lists in use by default, archived on ask, by code', () => {
    expect(registerRows(REGISTER, 'ACTIVE').map((row: Activity) => row.code)).toEqual(['CUSTOMER-MAIL', 'FLOOR-SCANS', 'STAFF-AUDIT'])
    expect(registerRows(REGISTER, 'ARCHIVED').map((row) => row.code)).toEqual(['OLD-PAPER'])
    expect(registerRows(REGISTER, 'all')).toHaveLength(4)
    expect(csvOf(['code', 'name'], [['=SUM(1)', 'a;b']])).toBe('code;name\n\'=SUM(1);"a;b"')
  })
})

const LEFT_KEY = /\b(?:page|duty|duties|site|floor|views|keys|list|common|kind|status|notices|col|notice|ack|paper|newNotice|dpia|dpiaStatus|register|activityStatus|form|archive|held|stepUp|done|problem|sample|live)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = designScreen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model }))).replace(/<!-- -->/g, '')
}
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => render(designScreen.cases.find((item) => item.id === id)!.model, locale)

describe('SCR-086 draws every case in both languages with no key left on screen', () => {
  it('has every state and role case', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['owner', 'admin', 'read-only', 'sales', 'loading', 'error', 'empty', 'notice-draft', 'notice-published', 'publish-refused', 'step-up', 'dpia-stored', 'dpia-none', 'register-edit', 'archive']) expect(ids).toContain(id)
  })
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const item of designScreen.cases) {
        const html = render(item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('says the sample texts at rest, the duties, and the floor gate in words', () => {
    const owner = draw('owner')
    expect(owner).toContain('SAMPLE texts until the privacy consultant writes the real ones')
    expect(owner).toContain('5 of 5 privacy duties done')
    expect(owner).toContain('GDPR art. 35: before the processing starts')
    expect(owner).toContain('The site names workers in its floor records, but no legal basis is on record.')
    expect(draw('owner', 'it')).toContain('testi di ESEMPIO')
    expect(draw('empty')).toContain('No worker notice yet: floor sign-in waits for one.')
    expect(draw('empty')).toContain('Floor sign-in stays off until the DPIA is stored.')
  })

  it('the worker versions are the list frame; counts, never a name, in the list', () => {
    const owner = draw('owner')
    expect(owner).toContain('3 versions')
    expect(owner).toContain('aria-label="Keyboard keys of this list"')
    expect(owner).not.toContain('Anna Esempio')
    expect(draw('selected')).toContain('2 selected')
  })

  it('who may: read-only has no New version; sales sees which right is missing', () => {
    expect(draw('owner')).toContain('New notice version')
    expect(draw('read-only')).not.toContain('New notice version')
    expect(draw('sales')).toContain('See privacy &amp; notices')
  })
})
