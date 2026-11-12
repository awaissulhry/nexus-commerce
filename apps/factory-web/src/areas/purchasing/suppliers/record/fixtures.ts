import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, inShell, panels, PURCHASE_ORDERS, RECORD_CAN, recordModel, SUPPLIERS, withoutMoney } from '../../../parties/_shared/fixtures'
import { failed, loaded, loading, partyDraftOf, type PartyRecordModel } from '../../../parties/_shared/model'
import type { Party } from '../../../parties/_shared/api'
import { SupplierRecordView } from './view/SupplierRecordView'
import { ACTIVE_SOURCES, addDraft, CAN, changed, DesignSources, KANGAROO, MATERIAL, MATERIAL_OPTIONS, SOURCES, sourcesModel, withoutCost } from '../sources/demo/fixtures'
import { say, type ApprovedSourcesModel } from '../sources/model'
// B-W2b-334: the supplier in depth (made-up data in ../depth/demo.ts).
import { WithMessages } from '../../../../record-panels/i18n'
import type { SupplierDepth } from '../../../parties/_shared/view/PartyRecordView'
import { DEPTH_NAMESPACES } from '../depth/SupplierDepth'
import { ACTIVE_ACCOUNT, ALL_CAN, bankOf, CHANGES, CLAIMS, ME, profileOf, qualificationsOf, READ_CAN, RECEIPTS, REFUSED_ACCOUNT, REVEALED, TODAY, UPLOAD, vaultOf, WAITING_CALL, WAITING_CHECK } from '../depth/demo'
import { acceptDraftOf, draftOf, EMPTY_PROPOSAL, failedRead, LOADING, profileHeld, ready, statusHeld, type DepthCan } from '../depth/model'
import { BankTab, type BankTabModel } from '../depth/view/BankTab'
import { DocumentsTab, type DocumentsTabModel } from '../depth/view/DocumentsTab'
import { NowDepth, type NowDepthModel } from '../depth/view/NowDepth'
import { ProfileCard, type ProfileCardModel } from '../depth/view/ProfileCard'
import { QualityTab, type QualityTabModel } from '../depth/view/QualityTab'
import { ReceivesCard, type ReceivesCardModel } from '../depth/view/ReceivesCard'
import { StatusDialog, type StatusDialogModel } from '../depth/view/StatusDialog'
import { ImportButton } from '../list/view/ImportButton'

/**
 * SCR-057 Supplier record — made-up suppliers only. Each case is one state the Owner reviews: the Overview form (⌘S),
 * a change waiting with a problem (Save held with its reason), a prospect waiting for approval, EU tanneries with VIES,
 * blocked, read-only rights, no cost grain, contacts (who receives POs), orders, activity, dialogs, loading and errors.
 * B-W2a-69: Items & prices (`items-*`): the approved sources typed in place (saving, saved, refused), a primary that
 * demotes another, Add a source (search, picked, refused as a duplicate), archived, bulk Archive / Restore, empty,
 * loading, error, read-only, no cost grain, no purchasing.view, the keys.
 */

/** B-W2b-334: the depth slot's models of a case (each part drawn from its own view with made-up data). */
interface DepthCase {
  profile?: ProfileCardModel
  status?: StatusDialogModel | null
  now?: NowDepthModel
  receives?: ReceivesCardModel
  documents?: DocumentsTabModel
  quality?: QualityTabModel
  bank?: BankTabModel
  /** Items & prices: the Import price list button (its held reason). */
  importHeld?: string | null
}

/** A record case with the Items & prices tab's own model (the slot Purchasing draws). */
type SupplierCase = PartyRecordModel & { sources?: ApprovedSourcesModel; depth?: DepthCase }

const by = (code: string): Party => SUPPLIERS.find((item) => item.code === code)!
const record = (code: string, over: Partial<PartyRecordModel> = {}): SupplierCase => recordModel('suppliers', by(code), over)
const items = (sources: Partial<ApprovedSourcesModel> = {}, over: Partial<PartyRecordModel> = {}): SupplierCase => ({ ...record('CONCERIA-DEMO', { tab: 'items', ...over }), sources: sourcesModel(sources) })
const ROW = ACTIVE_SOURCES[0]!

function depthNodes(depth: DepthCase | undefined): SupplierDepth | undefined {
  if (!depth) return undefined
  return {
    overview: depth.profile ? createElement('div', { className: 'fw-spd-stack' }, createElement(ProfileCard, { model: depth.profile }), depth.status ? createElement(StatusDialog, { model: depth.status }) : null) : null,
    now: depth.now ? createElement(NowDepth, { model: depth.now }) : null,
    contacts: depth.receives ? createElement(ReceivesCard, { model: depth.receives }) : null,
    documents: depth.documents ? createElement(DocumentsTab, { model: depth.documents }) : null,
    quality: depth.quality ? createElement(QualityTab, { model: depth.quality }) : null,
    bank: depth.bank ? createElement(BankTab, { model: depth.bank }) : null,
  }
}

function SupplierDesign({ model }: { model: SupplierCase }) {
  const party = model.party
  const { sources, depth, ...record } = model
  const importAction = depth && depth.importHeld !== undefined ? createElement(ImportButton, { label: 'Import price list', held: depth.importHeld }) : undefined
  return inShell(
    `/purchasing/suppliers/${party?.id ?? 'x'}`,
    createElement(
      WithMessages,
      { namespaces: DEPTH_NAMESPACES },
      createElement(SupplierRecordView, { model: record, panels: party ? panels(party) : null, items: createElement(DesignSources, { model: sources ?? sourcesModel(), importAction }), depth: depthNodes(depth) }),
    ),
  )
}

// ---- B-W2b-334: the supplier in depth ----

const DEPTH_RECORD_CAN = { ...RECORD_CAN, depth: true, bank: true }
const CONCERIA = by('CONCERIA-DEMO')
const TERZISTA = by('TERZISTA-DEMO')
const PROFILE = profileOf(CONCERIA)
const recordPath = `/w/DEMO/purchasing/suppliers/${CONCERIA.id}`

const profileModel = (over: Partial<ProfileCardModel> = {}, can: DepthCan = ALL_CAN, profile = PROFILE): ProfileCardModel => ({
  read: ready(profile),
  draft: null,
  held: profileHeld(can, CONCERIA.status),
  statusHeld: statusHeld(can, profile),
  saving: false,
  failed: null,
  refused: [],
  tried: false,
  today: TODAY,
  ...over,
})
const nowModel = (over: Partial<NowDepthModel> = {}, profile = PROFILE): NowDepthModel => ({ profile: ready(profile), vault: ready(vaultOf(CONCERIA)), today: TODAY, documentsHref: `${recordPath}?tab=documents`, ...over })
const overview = (depth: Partial<DepthCase> = {}, over: Partial<PartyRecordModel> = {}, profile = PROFILE): SupplierCase => ({
  ...record('CONCERIA-DEMO', { can: DEPTH_RECORD_CAN, ...over }),
  depth: { profile: profileModel({}, ALL_CAN, profile), now: nowModel({}, profile), ...depth },
})
const receivesModel = (over: Partial<ReceivesCardModel> = {}, profile = PROFILE): ReceivesCardModel => ({ read: ready(profile), can: ALL_CAN, cells: {}, notice: null, ...over })
const documentsModel = (over: Partial<DocumentsTabModel> = {}): DocumentsTabModel => ({
  vault: ready(vaultOf(CONCERIA)),
  changes: ready(CHANGES),
  qualifications: ready(qualificationsOf(CONCERIA, false)),
  can: ALL_CAN,
  today: TODAY,
  questionnaireHref: `${recordPath}?tab=questionnaire`,
  notice: null,
  dialog: null,
  companies: [{ id: '0190f0e2-0101-7000-8000-000000000001', name: 'Officina Demo' }],
  ...over,
})
const documents = (over: Partial<DocumentsTabModel> = {}, code = 'CONCERIA-DEMO'): SupplierCase => ({ ...record(code, { tab: 'documents', can: DEPTH_RECORD_CAN }), depth: { documents: documentsModel(over) } })
const quality = (over: Partial<QualityTabModel> = {}): SupplierCase => ({ ...record('CONCERIA-DEMO', { tab: 'quality', can: DEPTH_RECORD_CAN }), depth: { quality: { receipts: ready(RECEIPTS), claims: ready(CLAIMS), prefix: '/w/DEMO', ...over } } })
const CLOSED_STEP_UP = { open: false, busy: false, sentence: 'stepUp.sentence.default', problem: null }
const bankModel = (over: Partial<BankTabModel> = {}): BankTabModel => ({ read: ready(bankOf(CONCERIA, [ACTIVE_ACCOUNT, WAITING_CALL, REFUSED_ACCOUNT])), can: ALL_CAN, me: ME, notice: null, dialog: null, stepUp: CLOSED_STEP_UP, ...over })
const bank = (over: Partial<BankTabModel> = {}, recordOver: Partial<PartyRecordModel> = {}): SupplierCase => ({ ...record('CONCERIA-DEMO', { tab: 'bank', can: DEPTH_RECORD_CAN, ...recordOver }), depth: { bank: bankModel(over) } })
const idle = { busy: false, failed: null, tried: false }
const TYPED_IBAN = 'IT11 X000 0000 0000 0000 0315 001'

const ON_HOLD = profileOf(CONCERIA, { standing: { status: 'ON_HOLD', source: 'SUPPLIER', supplierStatus: 'ON_HOLD', reason: 'Due lotti fuori specifica: in attesa di azione correttiva.', changedAt: '2026-11-05T10:00:00.000Z', changedBy: 'Bruno Prova' }, newOrderProblem: 'on hold' })
const NOBODY = profileOf(by('TESSITURA-ESEMPIO'), { kinds: ['TEXTILE_MILL'], origin: { country: 'IT', region: 'Piemonte', note: null, hideCountries: [], tannages: [] } })
const TANNERY_DRAFT = { ...draftOf(PROFILE), kinds: ['TANNERY', 'TRIMS'] as const, leadTimeDays: '25', hideCountries: 'IT, FR, ES' }
const NOT_TANNERY = { ...draftOf(PROFILE), kinds: ['TEXTILE_MILL'] as const }

const W2B_334: ReadonlyArray<{ id: string; label: string; model: SupplierCase; note?: string }> = [
  { id: 'w2b-334-overview', label: 'W2b Overview: kinds, status, origin and closures; Now with the next document', model: overview(), note: 'One EditModeBar for kinds, lead time and origin; the closures as a month on the DS CalendarGrid; "Ordered today it arrives on …".' },
  { id: 'w2b-334-overview-editing', label: 'W2b Overview: kinds and the raw hides typed, not saved', model: overview({ profile: profileModel({ draft: { ...TANNERY_DRAFT, kinds: [...TANNERY_DRAFT.kinds] } }) }) },
  { id: 'w2b-334-overview-not-tannery', label: 'W2b Overview: no longer a tannery (its hides and tannages cleared)', model: overview({ profile: profileModel({ draft: { ...NOT_TANNERY, kinds: [...NOT_TANNERY.kinds] } }) }) },
  { id: 'w2b-334-overview-refused', label: 'W2b Overview: the save refused at a field', model: overview({ profile: profileModel({ draft: { ...draftOf(PROFILE), leadTimeDays: '400', originCountry: 'ITA' }, tried: true, failed: 'problem.invalid', refused: ['leadTimeDays'] }) }) },
  { id: 'w2b-334-overview-on-hold', label: 'W2b Overview: on hold, with why (no new PO)', model: overview({}, {}, ON_HOLD) },
  { id: 'w2b-334-overview-read-only', label: 'W2b Overview: a planner reads it (no parties.manage, no status right)', model: overview({ profile: profileModel({}, READ_CAN) }, { can: { ...DEPTH_RECORD_CAN, manage: false, block: false, vies: false } }) },
  { id: 'w2b-334-overview-loading', label: 'W2b Overview: loading', model: overview({ profile: profileModel({ read: LOADING }), now: nowModel({ profile: LOADING, vault: LOADING }) }) },
  { id: 'w2b-334-overview-error', label: "W2b Overview: couldn't load", model: overview({ profile: profileModel({ read: failedRead('problem.offline') }), now: nowModel({ profile: failedRead('problem.offline'), vault: failedRead('problem.offline') }) }) },
  { id: 'w2b-334-status', label: 'W2b Change status: on hold, with what it reaches', model: overview({ status: { profile: PROFILE, to: 'ON_HOLD', reason: 'Due lotti fuori specifica.', reach: ready({ status: 'ON_HOLD', draftsHeld: 2, openUnchanged: 1 }), busy: false, failed: null, tried: false } }) },
  { id: 'w2b-334-status-reason', label: 'W2b Change status: blocked without a reason (held)', model: overview({ status: { profile: PROFILE, to: 'BLOCKED', reason: '', reach: ready({ status: 'BLOCKED', draftsHeld: 0, openUnchanged: 3 }), busy: false, failed: null, tried: true } }) },
  { id: 'w2b-334-contacts', label: 'W2b Contacts: what each one receives (a box per cell, saved as ticked)', model: { ...record('CONCERIA-DEMO', { tab: 'contacts', can: DEPTH_RECORD_CAN }), depth: { receives: receivesModel({ cells: { [`${PROFILE.contacts[0]!.id}:REMITTANCE`]: { state: 'saving' }, [`${PROFILE.contacts[1]!.id}:DOCUMENT`]: { state: 'saved' }, [`${PROFILE.contacts[2]!.id}:CLAIM`]: { state: 'refused', words: { key: 'receives.invalid' } } } }) } } },
  { id: 'w2b-334-contacts-nobody', label: 'W2b Contacts: nobody receives POs (a contact with no e-mail)', model: { ...record('TESSITURA-ESEMPIO', { tab: 'contacts', can: DEPTH_RECORD_CAN }), depth: { receives: receivesModel({}, NOBODY) } } },
  { id: 'w2b-334-contacts-read-only', label: 'W2b Contacts: read only (no parties.manage)', model: { ...record('CONCERIA-DEMO', { tab: 'contacts', can: { ...DEPTH_RECORD_CAN, manage: false } }), depth: { receives: receivesModel({ can: READ_CAN }) } } },
  { id: 'w2b-334-items-import', label: 'W2b Items & prices: Import price list', model: { ...items(), can: DEPTH_RECORD_CAN, depth: { importHeld: null } } },
  { id: 'w2b-334-items-import-held', label: 'W2b Items & prices: Import price list held (no import right)', model: { ...items(), can: DEPTH_RECORD_CAN, depth: { importHeld: 'Importing needs the rights to run imports and upload files.' } } },
  { id: 'w2b-334-documents', label: 'W2b Documents & qualification: asks, the gate, documents, the office review', model: documents(), note: 'A leather PO is held at Send (expired chromium VI report); a REACH declaration waits for our check; a company data change waits.' },
  { id: 'w2b-334-documents-empty', label: 'W2b Documents: nothing yet (no kinds set)', model: documents({ vault: ready(vaultOf(CONCERIA, { supplier: { id: CONCERIA.id, code: CONCERIA.code, name: 'Conceria Demo', kinds: [], roles: ['SUPPLIER'] }, asked: [], materials: [], documents: [], nextExpiry: null, review: { uploads: [], changes: [] } })), changes: ready([]) }) },
  { id: 'w2b-334-documents-read-only', label: 'W2b Documents: a planner reads it (accept, refuse, ask held with why)', model: documents({ can: READ_CAN, changes: null }) },
  { id: 'w2b-334-documents-accept', label: 'W2b Documents: accept an upload (kind, last valid day, replaces)', model: documents({ dialog: { kind: 'accept', upload: UPLOAD, draft: acceptDraftOf(UPLOAD), replaceable: vaultOf(CONCERIA).documents.map((doc) => ({ fileId: doc.fileId, name: doc.name })), ...idle } }) },
  { id: 'w2b-334-documents-refuse', label: 'W2b Documents: refuse an upload without a reason (held)', model: documents({ dialog: { kind: 'refuse', upload: UPLOAD, reason: '', busy: false, failed: null, tried: true } }) },
  { id: 'w2b-334-documents-change', label: 'W2b Documents: approve a company data change', model: documents({ dialog: { kind: 'approveChange', request: CHANGES[0]!, ...idle } }) },
  { id: 'w2b-334-documents-request', label: 'W2b Documents: request documents (a due day)', model: documents({ dialog: { kind: 'request', due: '2026-11-30', ...idle } }) },
  { id: 'w2b-334-documents-accepted', label: 'W2b Documents: accepted', model: documents({ notice: { tone: 'success', words: { key: 'review.accepted' } } }) },
  { id: 'w2b-334-documents-workshop', label: 'W2b Documents: a workshop qualified for sewing, finishing waiting', model: documents({ vault: ready(vaultOf(TERZISTA, { supplier: { id: TERZISTA.id, code: TERZISTA.code, name: 'Lab. Terzista Demo', kinds: ['SUBCONTRACTOR'], roles: ['SUBCONTRACTOR'] }, asked: [{ category: 'SUPPLIER_CERTIFICATE', required: true, codes: ['DURC'], laws: ['D.Lgs. 276/2003 art. 29'], state: 'EXPIRING', fileId: null, expiresOn: '2026-12-20', waiting: false }], materials: [], review: { uploads: [], changes: [] } })), qualifications: ready(qualificationsOf(TERZISTA, true)), changes: ready([]) }, 'TERZISTA-DEMO') },
  { id: 'w2b-334-documents-decide', label: 'W2b Documents: decide a qualification (on conditions)', model: documents({ qualifications: ready(qualificationsOf(TERZISTA, true)), dialog: { kind: 'qualification', form: { kind: 'decide', id: '0190f0e2-4545-7000-8000-000000000002', decision: 'CONDITIONAL', conditions: 'Campione approvato prima di ogni stagione.', refuseReason: '', validFrom: TODAY, validUntil: '2027-11-11' }, workshop: true, companyId: '0190f0e2-0101-7000-8000-000000000001', ...idle } }, 'TERZISTA-DEMO') },
  { id: 'w2b-334-documents-ask', label: 'W2b Documents: ask a qualification (kinds of material)', model: documents({ dialog: { kind: 'qualification', form: { kind: 'ask', workCentreKinds: [], materialKinds: ['LEATHER'], validFrom: '', validUntil: '' }, workshop: false, companyId: '0190f0e2-0101-7000-8000-000000000001', ...idle } }) },
  { id: 'w2b-334-documents-loading', label: 'W2b Documents: loading', model: documents({ vault: LOADING, changes: LOADING, qualifications: LOADING }) },
  { id: 'w2b-334-documents-error', label: "W2b Documents: couldn't load", model: documents({ vault: failedRead('problem.offline'), changes: failedRead('problem.offline'), qualifications: failedRead('problem.offline') }) },
  { id: 'w2b-334-quality', label: 'W2b Quality & rating: receipts and claims', model: quality() },
  { id: 'w2b-334-quality-empty', label: 'W2b Quality & rating: nothing yet', model: quality({ receipts: ready([]), claims: ready([]) }) },
  { id: 'w2b-334-quality-no-rights', label: 'W2b Quality & rating: without the stock and purchasing rights', model: quality({ receipts: null, claims: null }) },
  { id: 'w2b-334-quality-loading', label: 'W2b Quality & rating: loading', model: quality({ receipts: LOADING, claims: LOADING }) },
  { id: 'w2b-334-quality-error', label: "W2b Quality & rating: couldn't load", model: quality({ receipts: failedRead('problem.offline'), claims: failedRead('problem.unavailable') }) },
  { id: 'w2b-334-bank', label: 'W2b Bank details: the account in use and a change from the portal waiting for its call-back', model: bank(), note: 'Masked (last four); Reveal and Retire need finance; the change waits for a call-back on a number we had before it.' },
  { id: 'w2b-334-bank-check', label: 'W2b Bank details: called back, waiting for the second check', model: bank({ read: ready(bankOf(CONCERIA, [ACTIVE_ACCOUNT, WAITING_CHECK])) }) },
  { id: 'w2b-334-bank-own', label: 'W2b Bank details: my own change (the call-back and the check are held)', model: bank({ read: ready(bankOf(CONCERIA, [ACTIVE_ACCOUNT, { ...WAITING_CALL, proposedBy: { id: ME, name: 'Franca Esempio' }, source: 'OFFICE', may: { ...WAITING_CALL.may, callBack: false } }])) }) },
  { id: 'w2b-334-bank-empty', label: 'W2b Bank details: no account (payments held)', model: bank({ read: ready(bankOf(CONCERIA, [])) }) },
  { id: 'w2b-334-bank-propose', label: 'W2b Bank details: Change IBAN, a mistyped IBAN said as typed', model: bank({ dialog: { kind: 'propose', draft: { ...EMPTY_PROPOSAL, iban: 'IT11 X000 0000 0000 0000 0315 002', holder: 'Conceria Demo S.p.A.' }, review: false, busy: false, failed: null, tried: true } }) },
  { id: 'w2b-334-bank-review', label: 'W2b Bank details: Change IBAN, the review old → new (masked)', model: bank({ read: ready(bankOf(CONCERIA, [ACTIVE_ACCOUNT])), dialog: { kind: 'propose', draft: { ...EMPTY_PROPOSAL, iban: TYPED_IBAN, holder: 'Conceria Demo S.p.A.', bankName: 'Banca Prova' }, review: true, ...idle } }) },
  { id: 'w2b-334-bank-step-up', label: 'W2b Bank details: a fresh code before the proposal', model: bank({ stepUp: { open: true, busy: false, sentence: 'bank.stepUp.propose', problem: null } }) },
  { id: 'w2b-334-bank-call-back', label: 'W2b Bank details: record the call-back (numbers on file, one left out)', model: bank({ dialog: { kind: 'callBack', account: WAITING_CALL, pick: WAITING_CALL.callBackCandidates!.usable[0]!.id, phone: '+39 000 000 0003', ...idle } }) },
  { id: 'w2b-334-bank-verify', label: 'W2b Bank details: the second check', model: bank({ read: ready(bankOf(CONCERIA, [ACTIVE_ACCOUNT, WAITING_CHECK])), dialog: { kind: 'verify', account: WAITING_CHECK, ...idle } }) },
  { id: 'w2b-334-bank-refuse', label: 'W2b Bank details: refuse the change (why)', model: bank({ dialog: { kind: 'refuse', account: WAITING_CALL, reason: 'Il fornitore non ha confermato al telefono.', ...idle } }) },
  { id: 'w2b-334-bank-reveal', label: 'W2b Bank details: the whole IBAN once, recorded', model: bank({ dialog: { kind: 'reveal', account: ACTIVE_ACCOUNT, grouped: REVEALED, ...idle } }) },
  { id: 'w2b-334-bank-buyer', label: 'W2b Bank details: a buyer without finance rights (tab not offered)', model: overview({}, { can: { ...DEPTH_RECORD_CAN, bank: false }, tab: 'bank' }), note: 'The design: hidden for roles without finance permissions — the record opens on Overview.' },
  { id: 'w2b-334-bank-read-only', label: 'W2b Bank details: read only (finance reader: no propose, call-back or check)', model: bank({ can: { ...ALL_CAN, bankPropose: false, bankCallBack: false, bankVerify: false, bankReveal: false } }) },
  { id: 'w2b-334-bank-loading', label: 'W2b Bank details: loading', model: bank({ read: LOADING }) },
  { id: 'w2b-334-bank-error', label: "W2b Bank details: couldn't load", model: bank({ read: failedRead('problem.offline') }) },
]

export const designScreen = defineDesignScreen<SupplierCase>({
  screen: 'SCR-057',
  title: 'Supplier record',
  view: SupplierDesign,
  cases: [
    { id: 'overview', label: 'Overview: the supplier, its tax identity and addresses', model: record('CONCERIA-DEMO'), note: 'Change a field and the bar appears (⌘S saves, Discard puts it back).' },
    {
      id: 'overview-editing',
      label: 'Overview: unsaved changes with a problem',
      model: record('CONCERIA-DEMO', { draft: { ...partyDraftOf(by('CONCERIA-DEMO')), legalName: '', paymentTerms: 'RiBa 90 gg f.m.' } }),
      note: 'Save is held until the legal name is back.',
    },
    { id: 'overview-saved', label: 'Overview: saved', model: record('CONCERIA-DEMO', { notice: { key: 'done.saved', tone: 'success' } }) },
    { id: 'prospect', label: 'A prospect: approve it before POs', model: record('PROTEZIONI-PROVA', { purchaseOrders: loaded([]) }) },
    { id: 'eu-valid', label: 'EU tannery: VIES valid', model: record('DE-LEDER', { purchaseOrders: loaded([]) }) },
    { id: 'eu-unchecked', label: 'EU tannery: never checked', model: record('PT-EXEMPLO', { purchaseOrders: loaded([]) }) },
    { id: 'subcontractor', label: 'A subcontractor (a person’s workshop)', model: record('TERZISTA-DEMO', { purchaseOrders: loaded([]) }) },
    { id: 'both-sides', label: 'Also a customer: one party record', model: record('PELLETTERIA-DOPPIA', { purchaseOrders: loaded([]) }) },
    { id: 'blocked', label: 'Blocked, with its reason', model: record('FORN-BLOCCATO') },
    { id: 'read-only', label: 'Read-only rights: fields as text', model: record('CONCERIA-DEMO', { can: { ...RECORD_CAN, manage: false, block: false, vies: false } }) },
    {
      id: 'no-cost',
      label: 'A role without the cost grain',
      model: record('CONCERIA-DEMO', { can: { ...RECORD_CAN, cost: false }, purchaseOrders: loaded(withoutMoney(PURCHASE_ORDERS)) }),
      note: 'No values drawn, not even as —.',
    },
    { id: 'contacts', label: 'Contacts: who receives POs', model: record('CONCERIA-DEMO', { tab: 'contacts' }), note: 'The Receives POs box saves at once.' },
    { id: 'contacts-nobody', label: 'Contacts: nobody receives POs yet', model: record('TESSITURA-ESEMPIO', { tab: 'contacts' }) },
    { id: 'contacts-empty', label: 'Contacts: none yet', model: record('PROTEZIONI-PROVA', { tab: 'contacts' }) },
    { id: 'contact-new', label: 'Add a contact', model: record('CONCERIA-DEMO', { tab: 'contacts', dialog: { kind: 'contact' } }) },
    { id: 'items', label: 'Items & prices: approved sources', model: items(), note: 'Type in a cell and leave it: one field saved with the row\u2019s version. A colour\u2019s own primary, every colour of every company, an unusable unit.' },
    { id: 'items-saving', label: 'Items & prices: a price saving', model: items({ cells: { [`${ROW.id}:unitPrice`]: { state: 'saving' } } }) },
    { id: 'items-saved', label: 'Items & prices: the minimum saved', model: items({ cells: { [`${ROW.id}:minOrderQty`]: { state: 'saved' } } }) },
    {
      id: 'items-refused',
      label: 'Items & prices: cells refused',
      model: items({ cells: { [`${ROW.id}:leadTimeDays`]: { state: 'refused', words: say('cell.badDays', { max: 366 }) }, [`${ACTIVE_SOURCES[2]!.id}:unitPrice`]: { state: 'refused', words: say('cell.changed') } }, notice: { tone: 'warning', words: changed } }),
      note: 'A typed value the rules refuse says why in the cell; a 409 reads the row again and says so.',
    },
    { id: 'items-demoted', label: 'Items & prices: a new primary demotes another', model: items({ notice: { tone: 'info', words: say('notice.demoted', { supplier: 'Conceria Esempio Due', material: MATERIAL.leather.code }) } }) },
    { id: 'items-add', label: 'Add a source: find the material', model: items({ dialog: addDraft({ materialQuery: 'demo', materials: MATERIAL_OPTIONS }) }) },
    { id: 'items-add-picked', label: 'Add a source: material picked, as primary', model: items({ dialog: addDraft({ material: KANGAROO, itemColourId: KANGAROO.colours[0]!.id, purchaseUom: 'HIDE', unitPrice: '98,50', minOrderQty: '10', leadTimeDays: '18', preference: 'PRIMARY', supplierArticleCode: 'CD-CNG10' }) }) },
    { id: 'items-add-duplicate', label: 'Add a source: refused, a duplicate', model: items({ dialog: addDraft({ material: KANGAROO, unitPrice: '98.5', problem: say('add.refused.duplicate') }) }) },
    { id: 'items-add-every', label: 'Add a source: every company, refused by the role', model: items({ dialog: addDraft({ material: KANGAROO, scope: 'every', problem: say('add.refused.everyCompany') }) }) },
    { id: 'items-archived', label: 'Items & prices: archived sources', model: items({ view: 'archived', read: { status: 'ready', rows: SOURCES.filter((row) => row.status === 'ARCHIVED'), more: false } }), note: 'An archived row reads as text: restore it to change it.' },
    { id: 'items-all', label: 'Items & prices: all, a pick across states', model: items({ view: 'all', read: { status: 'ready', rows: SOURCES, more: false }, selected: [SOURCES[1]!.id, SOURCES[4]!.id] }), note: 'Archive 1 and Restore 1: each verb reaches the rows of its state.' },
    { id: 'items-archive', label: 'Archive 2 sources', model: items({ selected: [ACTIVE_SOURCES[1]!.id, ACTIVE_SOURCES[3]!.id], dialog: { kind: 'archive', ids: [ACTIVE_SOURCES[1]!.id, ACTIVE_SOURCES[3]!.id], reason: 'Not bought from them any more.', busy: false } }) },
    {
      id: 'items-bulk-done',
      label: 'Archive: one done, one refused',
      model: items({ bulk: { verb: 'archive', done: 1, refused: [{ label: `${MATERIAL.lining.code} · NERO`, words: say('cell.changed') }] } }),
    },
    { id: 'items-empty', label: 'Items & prices: none yet', model: items({ read: { status: 'ready', rows: [], more: false } }) },
    { id: 'items-loading', label: 'Items & prices: loading', model: items({ read: { status: 'loading' } }) },
    { id: 'items-error', label: "Items & prices: couldn't load", model: items({ read: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'items-read-only', label: 'Items & prices: read only (no purchasing.sources.manage)', model: items({ can: { ...CAN, manage: false } }), note: 'Cells as text with the reason; Add held with it.' },
    { id: 'items-no-cost', label: 'Items & prices: no cost grain', model: items({ can: { ...CAN, cost: false }, read: { status: 'ready', rows: withoutCost(ACTIVE_SOURCES), more: false } }), note: 'No price column, not even as —; no last purchase price.' },
    { id: 'items-no-access', label: 'Items & prices: no purchasing.view', model: items({ can: { ...CAN, view: false } }, { can: { ...RECORD_CAN, purchaseOrders: false } }) },
    { id: 'items-keys', label: 'Items & prices: keyboard shortcuts', model: items({ dialog: { kind: 'keys' } }) },
    { id: 'orders', label: 'Orders', model: record('CONCERIA-DEMO', { tab: 'orders' }) },
    {
      id: 'orders-no-cost',
      label: 'Orders without the cost grain',
      model: record('CONCERIA-DEMO', { tab: 'orders', can: { ...RECORD_CAN, cost: false }, purchaseOrders: loaded(withoutMoney(PURCHASE_ORDERS)) }),
    },
    { id: 'orders-empty', label: 'Orders: none yet', model: record('PROTEZIONI-PROVA', { tab: 'orders', purchaseOrders: loaded([]) }) },
    { id: 'orders-error', label: "Orders: couldn't load", model: record('CONCERIA-DEMO', { tab: 'orders', purchaseOrders: failed('problem.unavailable') }) },
    { id: 'activity', label: 'Activity', model: record('CONCERIA-DEMO', { tab: 'activity' }) },
    { id: 'dock', label: 'Thread beside Overview (≥ 1280 px, ⌘J)', model: record('CONCERIA-DEMO', { dockOpen: true }) },
    { id: 'address-new', label: 'Add a pick-up address', model: record('CONCERIA-DEMO', { dialog: { kind: 'address' } }) },
    { id: 'identity-new', label: 'New tax identity from a date', model: record('CONCERIA-DEMO', { dialog: { kind: 'identity', mode: 'new' } }) },
    { id: 'block', label: 'Block supplier', model: record('CONCERIA-DEMO', { dialog: { kind: 'block' } }) },
    { id: 'changed', label: 'Changed by someone else while editing', model: record('CONCERIA-DEMO', { changedAt: at(29, 9, 40) }) },
    { id: 'loading', label: 'Loading', model: record('CONCERIA-DEMO', { party: null, asOf: null, live: 'connecting', purchaseOrders: loading() }) },
    { id: 'not-found', label: 'Not found', model: record('CONCERIA-DEMO', { party: null, problem: 'problem.notFound' }) },
    { id: 'no-access', label: 'No permission', model: record('CONCERIA-DEMO', { can: { ...RECORD_CAN, view: false } }) },
    { id: 'shortcuts', label: 'Keyboard shortcuts (?)', model: record('CONCERIA-DEMO', { dialog: { kind: 'shortcuts' } }) },
    ...W2B_334,
  ],
})
