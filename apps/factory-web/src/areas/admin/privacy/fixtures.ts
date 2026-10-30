import { createElement } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { inShell } from '../shared/fixtures'
import type { Activity, AckPerson, CompanyOverview, Dpia, DpiaList, Notice, NoticeAcks } from './api'
import { activityDraftOf, emptyActivity, LOADING, privacyCan, STEP_UP_SHUT, type PrivacyDialog, type PrivacyViewModel } from './model'
import { PrivacyView } from './view/PrivacyView'

/**
 * SCR-086 Privacy & notices with made-up data: the two Demo companies, invented sites, notices whose texts say SAMPLE /
 * ESEMPIO (the privacy consultant's real texts come later), invented people ("Anna Esempio" …) and processors ("Servizio
 * e-mail Demo"). Nothing here is a real company, person, notice or processor. Design-only (a fixtures file).
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0, month = 10) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
const [demo, esempio] = DEMO_COMPANIES as unknown as [{ id: string; code: string; name: string }, { id: string; code: string; name: string }]
const sha = (n: number) => String(n).repeat(64).slice(0, 64)

const SAMPLE_IT =
  'ESEMPIO — testo di prova, non definitivo. Il consulente privacy scriverà il testo vero.\n\nInformativa ai lavoratori (art. 13 GDPR; art. 4 L. 300/1970): sui tablet di reparto Nexus registra l’accesso con il badge e le scansioni delle fasi di lavoro. I dati servono alla tracciabilità del prodotto, non a valutare le persone.\n\nConservazione: …\nTitolare: Officina Demo S.r.l.'
const SAMPLE_EN =
  'SAMPLE — test text, not final. The privacy consultant will write the real text.\n\nWorker notice (GDPR art. 13; L. 300/1970 art. 4): on the floor tablets Nexus records the badge sign-in and the scans of each work step. The data serve product traceability, never to rate people.\n\nKept for: …\nController: Officina Demo S.r.l.'

const language = (locale: string, body: string | null, fileId: string | null = null, n = 1) => ({ locale, body, hasText: body !== null, fileId, sha256: sha(n) })

function notice(n: number, extra: Partial<Notice> & Pick<Notice, 'kind' | 'label' | 'status' | 'versionNo'>): Notice {
  return {
    id: uid('8686', n),
    companyId: demo.id,
    publishedAt: extra.status === 'DRAFT' ? null : at(1, 10),
    publishedById: extra.status === 'DRAFT' ? null : uid('3333', 1),
    supersededAt: null,
    version: 2,
    languages: [language('it', SAMPLE_IT), language('en', SAMPLE_EN, null, 2)],
    acknowledgements: null,
    ...extra,
  }
}

const WORKER_NOW = notice(1, { kind: 'WORKER_FLOOR', label: '2026-10', status: 'PUBLISHED', versionNo: 2, languages: [language('it', SAMPLE_IT), language('en', SAMPLE_EN, null, 2), language('ro', null, uid('7777', 1), 3)], acknowledgements: { active: 48, acknowledged: 41, notAcknowledged: 7 } })
const WORKER_OLD = notice(2, { kind: 'WORKER_FLOOR', label: '2026-04', status: 'SUPERSEDED', versionNo: 1, publishedAt: at(2, 9, 0, 4), supersededAt: at(1, 10), acknowledgements: { active: 48, acknowledged: 45, notAcknowledged: 3 } })
const WORKER_DRAFT = notice(3, { kind: 'WORKER_FLOOR', label: '2026-11', status: 'DRAFT', versionNo: 3, languages: [language('it', SAMPLE_IT)], version: 1 })
const STAFF_NOW = notice(4, { kind: 'OFFICE_STAFF', label: '2026-10', status: 'PUBLISHED', versionNo: 1, acknowledgements: { active: 14, acknowledged: 12, notAcknowledged: 2 } })
const PUBLIC_NOW = notice(5, { kind: 'PRIVACY_PUBLIC', label: '2026-10', status: 'PUBLISHED', versionNo: 1, languages: [language('it', SAMPLE_IT.replace('Informativa ai lavoratori', 'Informativa privacy'))] })
const NOTICES: Notice[] = [WORKER_DRAFT, WORKER_NOW, WORKER_OLD, STAFF_NOW, PUBLIC_NOW]

const SITES = [
  { id: uid('2222', 1), code: 'DN1', name: 'Stabilimento Demo Nord', readyForFloor: true },
  { id: uid('2222', 2), code: 'DS1', name: 'Magazzino Demo Sud', readyForFloor: false },
]

const STORED: Dpia = {
  id: uid('8787', 1),
  companyId: demo.id,
  versionNo: 1,
  scope: 'ESEMPIO — Strumenti di reparto: accesso con badge sui tablet, scansioni e registri di taglio che nominano il lavoratore. Dati del personale d’ufficio: storico delle modifiche.',
  status: 'STORED',
  fileId: uid('7777', 2),
  fileSha256: sha(4),
  signedByName: 'Alex Demo (legale rappresentante)',
  signedOn: '2026-09-28',
  reviewDueOn: '2027-09-28',
  storedAt: at(29, 16, 5, 9),
  supersededAt: null,
  version: 2,
}
const DRAFT_DPIA: Dpia = { ...STORED, id: uid('8787', 2), versionNo: 2, status: 'DRAFT', fileId: null, fileSha256: null, signedByName: null, signedOn: null, reviewDueOn: null, storedAt: null, version: 1, scope: `${STORED.scope}\nNuovo: il secondo stabilimento (DS1).` }
const DPIA: DpiaList = { company: demo, stored: STORED, versions: [STORED] }
const DPIA_WITH_DRAFT: DpiaList = { company: demo, stored: STORED, versions: [STORED, { ...DRAFT_DPIA, fileId: uid('7777', 3), fileSha256: sha(5) }] }
const DPIA_NONE: DpiaList = { company: demo, stored: null, versions: [DRAFT_DPIA] }

const activity = (n: number, code: string, name: string, extra: Partial<Activity> = {}): Activity => ({
  id: uid('8888', n),
  companyId: demo.id,
  code,
  name,
  purpose: 'ESEMPIO — Tracciabilità di ogni capo: chi ha fatto quale fase, su quale tablet.',
  legalBasis: 'Art. 6(1)(c) GDPR · Reg. UE 2016/425 (tracciabilità DPI)',
  dataSubjects: ['Lavoratori di reparto'],
  dataCategories: ['Nome', 'Badge', 'Scansioni con ora'],
  recipients: ['Responsabile qualità'],
  processors: ['Hosting Demo — UE (Amsterdam)'],
  transfers: 'Nessuno fuori dall’UE',
  retention: '10 anni dalla consegna del lotto',
  security: 'Accesso per ruolo, cifratura, registro delle modifiche',
  status: 'ACTIVE',
  version: 3,
  updatedAt: at(27, 11),
  ...extra,
})
const REGISTER: Activity[] = [
  activity(1, 'FLOOR-SCANS', 'Scansioni di reparto'),
  activity(2, 'STAFF-AUDIT', 'Storico delle modifiche (ufficio)', { purpose: 'ESEMPIO — Chi ha cambiato cosa e quando, per la responsabilità del dato.', dataSubjects: ['Personale d’ufficio'], dataCategories: ['Nome', 'E-mail di lavoro', 'Azioni con ora'], processors: ['Hosting Demo — UE (Amsterdam)'], retention: '10 anni' }),
  activity(3, 'CUSTOMER-MAIL', 'Posta con clienti e fornitori', { purpose: 'ESEMPIO — Messaggi sui documenti di vendita e acquisto.', dataSubjects: ['Referenti di clienti', 'Referenti di fornitori'], dataCategories: ['Nome', 'E-mail', 'Testo dei messaggi'], processors: ['Servizio e-mail Demo — UE (Irlanda)', 'Archivio file Demo — UE'], retention: '10 anni (art. 2220 c.c.)' }),
  activity(4, 'OLD-PAPER', 'Registro cartaceo presenze (dismesso)', { status: 'ARCHIVED', processors: [], dataCategories: ['Nome', 'Firma'], retention: 'Conservato fino al 2027' }),
]

const people = (count: number): AckPerson[] => {
  const names = ['Anna Esempio', 'Bruno Prova', 'Carla Demo', 'Dario Campione', 'Elena Modello', 'Fabio Saggio', 'Gina Test']
  return names.slice(0, count).map((displayName, index) => ({
    id: uid('4444', index + 1),
    displayName,
    siteId: SITES[index % 2]!.id,
    acknowledgedAt: index < 4 ? at(2 + index, 7, 30) : null,
    channel: index < 4 ? (index === 2 ? 'PAPER' : 'DEVICE') : null,
    locale: index < 4 ? (index === 1 ? 'ro' : 'it') : null,
  }))
}
const ACKS_NAMED: NoticeAcks = { notice: { id: WORKER_NOW.id, kind: 'WORKER_FLOOR', label: '2026-10', status: 'PUBLISHED' }, counts: WORKER_NOW.acknowledgements, people: people(7) }
const ACKS_COUNTS: NoticeAcks = { ...ACKS_NAMED, people: null }

const overviewOf = (company: { id: string; code: string; name: string }, extra: Partial<CompanyOverview> = {}): CompanyOverview => ({
  company,
  duties: [
    { key: 'register', done: true },
    { key: 'publicNotice', done: true },
    { key: 'staffNotice', done: true },
    { key: 'workerNotice', done: true },
    { key: 'dpia', done: true },
  ],
  notices: { WORKER_FLOOR: { id: WORKER_NOW.id, label: '2026-10', publishedAt: at(1, 10) }, OFFICE_STAFF: { id: STAFF_NOW.id, label: '2026-10', publishedAt: at(1, 10) }, PRIVACY_PUBLIC: { id: PUBLIC_NOW.id, label: '2026-10', publishedAt: at(1, 10) } },
  dpia: { id: STORED.id, versionNo: 1, signedOn: STORED.signedOn, reviewDueOn: STORED.reviewDueOn },
  activities: 3,
  sites: SITES,
  ...extra,
})
const OVERVIEW = [overviewOf(demo)]
const EMPTY_OVERVIEW = [
  overviewOf(demo, {
    duties: [
      { key: 'register', done: false },
      { key: 'publicNotice', done: false },
      { key: 'staffNotice', done: false },
      { key: 'workerNotice', done: false },
      { key: 'dpia', done: false },
    ],
    notices: { WORKER_FLOOR: null, OFFICE_STAFF: null, PRIVACY_PUBLIC: null },
    dpia: null,
    activities: 0,
    sites: SITES.map((site) => ({ ...site, readyForFloor: false })),
  }),
]

// ---- roles ----

const templatePermissions = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'privacy.view', 'privacy.manage', 'files.read', 'files.upload'],
  admin: templatePermissions('admin'),
  readOnly: templatePermissions('read_only'),
  sales: templatePermissions('sales'),
} as const
type Role = keyof typeof ROLES

interface Case {
  model: PrivacyViewModel
  role: Role
}

function base(extra: Partial<PrivacyViewModel> = {}, role: Role = 'owner'): Case {
  return {
    role,
    model: {
      prefix: '/w/DEMO',
      can: privacyCan(ROLES[role]),
      view: 'notices',
      overview: { value: OVERVIEW, problem: null },
      companyId: demo.id,
      notices: { value: NOTICES, problem: null },
      dpia: { value: DPIA, problem: null },
      register: { value: REGISTER, problem: null },
      registerFilter: 'ACTIVE',
      selectedNotices: [],
      selectedActivities: [],
      dpiaForm: { signedByName: '', signedOn: '', reviewDueOn: '' },
      uploading: false,
      dpiaProblem: null,
      dialog: null,
      stepUp: STEP_UP_SHUT,
      asOf: at(30, 9, 42),
      live: 'live',
      updates: 0,
      notice: null,
      origin: 'https://fabbrica.example.com',
      today: '2026-10-30',
      timeZone: 'Europe/Rome',
      ...extra,
    },
  }
}

const noticeDialog = (found: Notice, extra: Partial<Extract<PrivacyDialog, { kind: 'notice' }>> = {}): PrivacyDialog => ({
  kind: 'notice',
  noticeId: found.id,
  notice: { value: found, problem: null },
  acks: LOADING,
  texts: {},
  adding: null,
  paper: { workerId: '', locale: 'it' },
  confirmDelete: false,
  busy: false,
  problem: null,
  done: null,
  ...extra,
})

function PrivacyDesign({ model }: { model: Case }) {
  return inShell('/admin/privacy', createElement(PrivacyView, { model: model.model }), ROLES[model.role])
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-086',
  title: 'Privacy & notices',
  view: PrivacyDesign,
  cases: [
    { id: 'owner', label: 'Owner: every duty done, the worker notice versions', model: base(), note: 'The duties in words with the law named; DS1 waits for its floor rules (the site names workers, no legal basis on record). Sample texts are said at rest.' },
    { id: 'admin', label: 'Administrator (the admin role)', model: base({}, 'admin') },
    { id: 'read-only', label: 'Read-only: sees, changes nothing', model: base({}, 'readOnly'), note: 'No New version, no names of people: counts only.' },
    { id: 'sales', label: 'Sales: no access', model: base({}, 'sales'), note: 'The page says which right is missing; the navigation has no row for this person.' },
    { id: 'loading', label: 'Loading', model: base({ overview: LOADING, notices: LOADING, dpia: LOADING, register: LOADING, asOf: null }) },
    { id: 'error', label: 'The API did not answer', model: base({ overview: { value: null, problem: 'pv.problem.unavailable' }, asOf: null }) },
    { id: 'notices-error', label: 'The notices did not load', model: base({ notices: { value: null, problem: 'pv.problem.unavailable' } }), note: 'A failed read is never drawn as an empty list.' },
    {
      id: 'empty',
      label: 'Nothing yet: no notice, no DPIA, an empty register',
      model: base({ overview: { value: EMPTY_OVERVIEW, problem: null }, notices: { value: [], problem: null }, dpia: { value: { company: demo, stored: null, versions: [] }, problem: null }, register: { value: [], problem: null } }),
      note: 'No worker notice yet: floor sign-in waits for one. Each duty says what it holds back.',
    },
    { id: 'two-companies', label: 'Two companies: pick one', model: base({ overview: { value: [overviewOf(demo), overviewOf(esempio, { activities: 0, duties: overviewOf(esempio).duties.map((duty) => ({ ...duty, done: duty.key === 'register' ? false : duty.done })) })], problem: null } }) },
    { id: 'selected', label: 'Two versions selected: Export 2', model: base({ selectedNotices: [WORKER_NOW.id, WORKER_OLD.id] }) },
    { id: 'updates', label: 'A newer version came in: "1 update · Show"', model: base({ updates: 1, live: 'live' }) },
    {
      id: 'notice-draft',
      label: 'A draft: the Italian text, English missing',
      model: base({ dialog: noticeDialog(WORKER_DRAFT) }),
      note: 'Publish is held: the worker notice is shown on the tablet in Italian and English. Each language is named in its own words.',
    },
    { id: 'notice-draft-typing', label: 'A draft: English typed, not saved yet', model: base({ dialog: noticeDialog(WORKER_DRAFT, { texts: { en: SAMPLE_EN } }) }), note: 'Publish waits for Save.' },
    { id: 'notice-add-pdf', label: 'A draft: adding Romanian as a PDF', model: base({ dialog: noticeDialog(WORKER_DRAFT, { adding: { locale: 'ro', as: 'pdf' } }) }) },
    { id: 'publish-refused', label: 'Publish refused: English is missing', model: base({ dialog: noticeDialog(WORKER_DRAFT, { problem: { key: 'pv.notice.missing', params: { languages: 'English' } } }) }) },
    { id: 'step-up', label: 'Publish asks a fresh code', model: base({ dialog: noticeDialog({ ...WORKER_DRAFT, languages: [...WORKER_DRAFT.languages, { locale: 'en', body: SAMPLE_EN, hasText: true, fileId: null, sha256: sha(2) }] }, { busy: true }), stepUp: { open: true, busy: false, sentence: 'pv.stepUp.publish', problem: null } }) },
    { id: 'step-up-wrong', label: 'A wrong code', model: base({ dialog: noticeDialog(WORKER_DRAFT, { busy: true }), stepUp: { open: true, busy: false, sentence: 'pv.stepUp.publish', problem: 'stepUp.problem.wrong' } }) },
    { id: 'delete-draft', label: 'Delete the draft: confirm', model: base({ dialog: noticeDialog(WORKER_DRAFT, { confirmDelete: true }) }) },
    {
      id: 'notice-published',
      label: 'The version in force: who acknowledged it (this one record)',
      model: base({ dialog: noticeDialog(WORKER_NOW, { acks: { value: ACKS_NAMED, problem: null }, paper: { workerId: uid('4444', 5), locale: 'it' } }) }),
      note: 'Names only inside this one notice and only with the manage right, sorted by name (never a ranking). A signed paper copy for a worker who has not acknowledged it.',
    },
    { id: 'notice-published-read-only', label: 'The version in force, read-only: counts only', model: base({ dialog: noticeDialog(WORKER_NOW, { acks: { value: ACKS_COUNTS, problem: null } }) }, 'readOnly') },
    { id: 'notice-replaced', label: 'A replaced version', model: base({ dialog: noticeDialog(WORKER_OLD, { acks: { value: { ...ACKS_COUNTS, counts: WORKER_OLD.acknowledgements }, problem: null } }) }) },
    { id: 'notice-public', label: 'The public notice', model: base({ dialog: noticeDialog(PUBLIC_NOW) }) },
    { id: 'new-notice', label: 'New notice version', model: base({ dialog: { kind: 'newNotice', draft: { kind: 'OFFICE_STAFF', label: '2026-11', copyTexts: true }, busy: false, problem: null } }) },
    { id: 'new-notice-held', label: 'New version held: a draft exists', model: base({ dialog: { kind: 'newNotice', draft: { kind: 'WORKER_FLOOR', label: '2026-12', copyTexts: true }, busy: false, problem: null } }), note: 'Open draft 2026-11 instead: one draft per notice.' },
    { id: 'dpia-stored', label: 'DPIA: stored, a new draft with its signed PDF', model: base({ view: 'dpia', dpia: { value: DPIA_WITH_DRAFT, problem: null }, dpiaForm: { signedByName: 'Alex Demo (legale rappresentante)', signedOn: '2026-10-29', reviewDueOn: '2027-10-29' } }) },
    { id: 'dpia-none', label: 'DPIA: none stored, a draft without its PDF', model: base({ view: 'dpia', dpia: { value: DPIA_NONE, problem: null }, overview: { value: [overviewOf(demo, { dpia: null, duties: overviewOf(demo).duties.map((duty) => (duty.key === 'dpia' ? { ...duty, done: false } : duty)), sites: SITES.map((site) => ({ ...site, readyForFloor: false })) })], problem: null } }), note: 'Store is held until the signed PDF is uploaded. The floor stays off until a DPIA is stored.' },
    { id: 'dpia-review-due', label: 'DPIA: its review day passed', model: base({ view: 'dpia', today: '2027-10-02', overview: { value: [overviewOf(demo, { dpia: { id: STORED.id, versionNo: 1, signedOn: STORED.signedOn, reviewDueOn: STORED.reviewDueOn } })], problem: null } }) },
    { id: 'dpia-start', label: 'DPIA: start a new version', model: base({ view: 'dpia', dialog: { kind: 'newDpia', scope: '', busy: false, problem: null } }) },
    { id: 'dpia-step-up', label: 'DPIA: Store asks a fresh code', model: base({ view: 'dpia', dpia: { value: DPIA_WITH_DRAFT, problem: null }, dpiaForm: { signedByName: 'Alex Demo', signedOn: '2026-10-29', reviewDueOn: '2027-10-29' }, stepUp: { open: true, busy: false, sentence: 'pv.stepUp.dpia', problem: null } }) },
    { id: 'register', label: 'The record of processing activities', model: base({ view: 'register' }) },
    { id: 'register-all', label: 'The register, archived too', model: base({ view: 'register', registerFilter: 'all', selectedActivities: [uid('8888', 1), uid('8888', 3)] }) },
    { id: 'register-edit', label: 'Edit an activity', model: base({ view: 'register', dialog: { kind: 'activity', activityId: REGISTER[2]!.id, draft: activityDraftOf(REGISTER[2]!), busy: false, problem: null, showErrors: false } }) },
    { id: 'register-new', label: 'New activity: what is missing', model: base({ view: 'register', dialog: { kind: 'activity', activityId: null, draft: { ...emptyActivity(), code: 'SPED MERCI', name: 'Spedizioni' }, busy: false, problem: null, showErrors: true } }) },
    { id: 'register-view', label: 'An activity, read-only', model: base({ view: 'register', dialog: { kind: 'activity', activityId: REGISTER[0]!.id, draft: activityDraftOf(REGISTER[0]!), busy: false, problem: null, showErrors: false } }, 'readOnly') },
    { id: 'archive', label: 'Archive an activity: confirm', model: base({ view: 'register', dialog: { kind: 'archive', activityId: REGISTER[1]!.id, busy: false, problem: null } }) },
    { id: 'register-empty', label: 'The register is empty', model: base({ view: 'register', register: { value: [], problem: null } }) },
    { id: 'done', label: 'After a save: one notice', model: base({ notice: { tone: 'success', words: { key: 'pv.done.published.WORKER_FLOOR', params: { label: '2026-11' } } } }) },
  ],
})

export { NOTICES, REGISTER, WORKER_DRAFT, WORKER_NOW, ACKS_NAMED }
