import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../quality/_shared/hooks'
import {
  ANIMAL,
  BRANDS,
  BUILT_IN,
  CARE,
  CHANGE_ASSESSED,
  CHANGE_CLOSED,
  CHANGE_OPEN,
  CHANGES,
  COMPANY,
  CR6,
  CR6_MATERIALS,
  DOC_LANGUAGE,
  EN_3,
  EN_4,
  ENTRIES,
  entryRecord,
  gateMatrix,
  inRulesShell,
  LABEL_LANGUAGE,
  LANGUAGES,
  ME,
  MARKETS,
  marketsAnswer,
  NOW,
  OPERATORS,
  operatorsAnswer,
  PARTIES,
  phraseRecord,
  phrasesAnswer,
  PREFIX,
  REQUIREMENTS,
  RULES_ROLES_DEMO,
  STYLES,
  TEXTILE_IT,
  TODAY,
  USER_INFO,
  WARNING_A,
  type RulesRoleDemo,
} from './_demo/fixtures'
import { EMPTY_ADDRESS, EMPTY_CHANGE, EMPTY_ENTRY, EMPTY_MARKET, EMPTY_PHRASE, EMPTY_REQUIREMENT, emptyOperator, gateDraftOf, markKey, ruleDraftsOf, rulesCan, type GateDraft, type SettingsAddress } from './model'
import { IDLE, type Cr6State, type GatesState, type MarketsState, type OperatorsState, type PhrasesState, type RegsState, type RulesMarketsModel } from './view-model'
import { RulesMarketsView } from './view/RulesMarketsView'
// B-W2b-288 (FU2:01): the Templates tab's cases.
import { templatesCases } from './ppe-texts/fixtures'

/**
 * SCR-262 — Compliance › Settings › Rules & markets (B-W2b-265; design compliance.settings: rm-tabs, rm-cr6, rm-gates, rm-regs,
 * rm-markets, rm-phrases, rm-operators, pop rm-loosen). Made-up data only (./_demo). Roles from factory-domain's templates: the
 * owner changes the Cr VI rule; the quality inspector keeps gates, the register, markets, operators and phrases and approves
 * translations; the production manager and read-only look; sales has no compliance read. The labels and notes are English (the
 * design index only); the screen's words come from the catalogues.
 */

interface RulesCase {
  role: RulesRoleDemo
  model: RulesMarketsModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }

const cr6 = (over: Partial<Cr6State> = {}): Cr6State => ({ settings: ready(CR6), materials: ready(CR6_MATERIALS), draft: null, loosen: null, writing: IDLE, ...over })
const gates = (over: Partial<GatesState> = {}, mayManage = true): GatesState => ({ matrix: ready(gateMatrix(mayManage)), drafts: {}, selected: [], loosen: null, override: null, add: null, writing: IDLE, ...over })
const regs = (over: Partial<RegsState> = {}, mayManage = true): RegsState => ({ entries: ready({ entries: ENTRIES, asOf: NOW, mayManage }), changes: ready(CHANGES), marks: {}, selected: [], add: null, entry: null, change: null, ...over })
const markets = (over: Partial<MarketsState> = {}, mayManage = true): MarketsState => ({ markets: ready(marketsAnswer(mayManage)), languages: ready(LANGUAGES), marks: {}, selected: [], add: null, open: null, off: null, ...over })
const phrases = (over: Partial<PhrasesState> = {}, mayManage = true, mayApprove = true): PhrasesState => ({ phrases: ready(phrasesAnswer(mayManage, mayApprove)), selected: [], add: null, open: null, ...over })
const pickers = { styleQ: '', styles: ready(STYLES), brands: ready(BRANDS), partyQ: '', parties: ready(PARTIES) }
const operators = (over: Partial<OperatorsState> = {}, mayManage = true): OperatorsState => ({ operators: ready(operatorsAnswer(mayManage)), markets: MARKETS.map((row) => row.code), marks: {}, selected: [], add: null, open: null, ...over })

function base(role: RulesRoleDemo, address: Partial<SettingsAddress>, over: Partial<RulesMarketsModel> = {}): RulesCase {
  const can = rulesCan(RULES_ROLES_DEMO[role])
  const manage = can.requirementsManage
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      me: ME,
      companyId: COMPANY.id,
      companyName: COMPANY.name,
      address: { ...EMPTY_ADDRESS, ...address },
      today: TODAY,
      readAt: NOW,
      live: 'live',
      notice: null,
      stepUp: STEP_UP_CLOSED,
      cr6: cr6(),
      gates: gates({}, manage),
      regs: regs({}, can.rulesManage),
      markets: markets({}, can.rulesManage),
      phrases: phrases({}, can.phrasesManage, can.phrasesApprove),
      operators: operators({}, can.rulesManage),
      ...over,
    },
  }
}

const drafted = (code: string, change: Partial<GateDraft>): Record<string, GateDraft> => {
  const row = gateMatrix().rows.find((entry) => entry.requirement.code === code)!
  return { [code]: { ...gateDraftOf(row), ...change } }
}
const gatesTab = { tab: 'gates' as const }
const regsTab = { tab: 'regulations' as const }
const marketsTab = { tab: 'markets' as const }
const phrasesTab = { tab: 'phrases' as const }
const operatorsTab = { tab: 'operators' as const }

function RulesDesign({ model }: { model: RulesCase }) {
  return inRulesShell(createElement(RulesMarketsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<RulesCase>({
  screen: 'SCR-262',
  title: 'Rules & markets (Compliance › Settings)',
  view: RulesDesign,
  cases: [
    // ---- Chromium VI (rm-cr6) ----
    {
      id: 'normal',
      label: 'Quality inspector: Chromium VI — the rule in force, the locked legal limit, the materials',
      model: base('quality', { tab: 'cr6' }),
      note: 'Link tabs Chromium VI · Gates · Regulations & standards · Markets · Phrases & translations · Operators. The rule is the owner’s (quality.settings.manage): the radio cards are held with why.',
    },
    { id: 'cr6-owner', label: 'Owner: Chromium VI, every company’s scope', model: base('owner', { tab: 'cr6', scope: 'all' }, { cr6: cr6({ settings: ready({ ...CR6, companyId: null, source: 'TENANT' }) }) }) },
    { id: 'cr6-draft', label: 'Owner: a looser rule chosen — the warning and the EditModeBar “Apply the looser rule…”', model: base('owner', { tab: 'cr6' }, { cr6: cr6({ draft: 'SUPPLIER_REPORT_ACCEPTED' }) }) },
    { id: 'cr6-loosen', label: 'Confirm a looser rule (rm-loosen): from now on … and why', model: base('owner', { tab: 'cr6' }, { cr6: cr6({ draft: 'SUPPLIER_REPORT_ACCEPTED', loosen: { reason: 'Il fornitore certificato copre ora tutti gli articoli' } }) }) },
    { id: 'cr6-step-up', label: 'The looser rule asks a fresh code', model: base('owner', { tab: 'cr6' }, { cr6: cr6({ draft: 'SUPPLIER_REPORT_ACCEPTED', loosen: { reason: 'Il fornitore certificato copre ora tutti gli articoli' }, writing: { busy: true, problem: null } }), stepUp: { open: true, busy: false, sentence: 'stepUp.loosen', problem: null } }) },
    { id: 'cr6-loading', label: 'Chromium VI loading', model: base('owner', { tab: 'cr6' }, { cr6: cr6({ settings: loading, materials: loading }), readAt: null }) },
    { id: 'cr6-error', label: 'Chromium VI failed: said with Try again', model: base('owner', { tab: 'cr6' }, { cr6: cr6({ settings: failed, materials: failed }) }) },
    // ---- Gates (rm-gates) ----
    { id: 'gates', label: 'Gates: requirement × place, padlocks with their law, who may waive and how long, on/off', model: base('quality', gatesTab), note: 'CERT-COVERAGE is locked at label print, final release and shipment (W1’s two gates); release is the company’s choice.' },
    { id: 'gates-changed', label: 'Gates: cells changed — the EditModeBar counts them', model: base('quality', gatesTab, { gates: gates({ drafts: { ...drafted('DOC-LANGUAGE', { blocks: ['SHIPMENT', 'LABEL_PRINT'] }), ...drafted('LABEL-LANGUAGE', { blocks: [] }) } }) }) },
    {
      id: 'gates-loosen',
      label: 'Confirm a looser rule: each loosening in words, the reason for switching off',
      model: base('quality', gatesTab, { gates: gates({ drafts: { ...drafted('LABEL-LANGUAGE', { blocks: [], overrideMaxDays: 5 }), ...drafted('DOC-LANGUAGE', { switchedOn: false, overrideRoleKeys: ['owner', 'quality_inspector'] }) }, loosen: { reason: '' } }) }),
      note: 'Apply held “Say why …” until the reason is typed; Apply then asks a fresh code.',
    },
    { id: 'gates-step-up', label: 'Gates: the looser rule asks a fresh code', model: base('quality', gatesTab, { gates: gates({ drafts: drafted('LABEL-LANGUAGE', { blocks: [] }), loosen: { reason: '' }, writing: { busy: true, problem: null } }), stepUp: { open: true, busy: false, sentence: 'stepUp.loosen', problem: null } }) },
    { id: 'gates-refused', label: 'Gates: the law’s padlock refused, in words', model: base('quality', gatesTab, { gates: gates({ writing: { busy: false, problem: { key: 'problem.locked', field: 'blocks' } } }), notice: { tone: 'warning', key: 'notice.gatesPartly', params: { done: 1, refused: 1, codes: 'USER-INFO-LANGUAGE' } } }) },
    { id: 'gates-override', label: 'Who may grant a waiver of LABEL-LANGUAGE, and for how long', model: base('quality', gatesTab, { gates: gates({ override: { code: LABEL_LANGUAGE.code, roles: ['quality_inspector'], days: 3 } }) }) },
    { id: 'gates-selected', label: 'Two rows chosen: Switch on 2 / Switch off 2', model: base('quality', gatesTab, { gates: gates({ selected: [DOC_LANGUAGE.code, TEXTILE_IT.code] }) }) },
    {
      id: 'gates-add',
      label: 'Add requirement: the checks waiting for a row (label, artwork, reconciliation, claims), each added OFF',
      model: base('quality', { ...gatesTab, add: true }, { gates: gates({ add: { way: 'suggested', requirements: ready(REQUIREMENTS), markets: ready(MARKETS.map((row) => row.code)), picked: ['LABEL-CE-MARKING', 'LABEL-ARTWORK'], reason: '', draft: EMPTY_REQUIREMENT, writing: IDLE } }) }),
      note: 'Add held “Say why …” until the reason (the Owner question it waits for) is typed.',
    },
    {
      id: 'gates-add-own',
      label: 'Add requirement: one of your own (a German user information rule)',
      model: base('quality', { ...gatesTab, add: true }, { gates: gates({ add: { way: 'own', requirements: ready(REQUIREMENTS), markets: ready(MARKETS.map((row) => row.code)), picked: [], reason: '', draft: { ...EMPTY_REQUIREMENT, code: 'USER-INFO-DE', nameIt: 'Istruzioni in tedesco per la Germania', nameEn: 'User information in German for Germany', kind: 'USER_INFO_LANGUAGE', marketCode: 'DE', blocks: ['SHIPMENT'], legalReference: 'Reg. (EU) 2016/425 art. 8(7)', switchedOn: true }, writing: IDLE } }) }),
    },
    { id: 'gates-built-in', label: 'Gates: W1’s certificate rule still built in (no row yet): Write it as a row', model: base('quality', gatesTab, { gates: gates({ matrix: ready(gateMatrix(true, [BUILT_IN, DOC_LANGUAGE, USER_INFO])) }) }) },
    { id: 'gates-read-only', label: 'Production manager: the matrix read only, every change held with why', model: base('production', gatesTab) },
    { id: 'gates-loading', label: 'Gates loading', model: base('quality', gatesTab, { gates: gates({ matrix: loading }), readAt: null }) },
    { id: 'gates-error', label: 'Gates failed: said with Try again', model: base('quality', gatesTab, { gates: gates({ matrix: failed }) }) },
    { id: 'gates-empty', label: 'Gates: no requirement', model: base('quality', gatesTab, { gates: gates({ matrix: ready(gateMatrix(true, [])) }) }) },
    // ---- Regulations & standards (rm-regs) ----
    { id: 'regulations', label: 'Regulations & standards: the register (autosave per cell) and the change watch', model: base('quality', regsTab), note: 'EN 17092-3:2020 superseded by the 2026 edition: a change to assess with its transition ending soon.' },
    { id: 'regulations-marks', label: 'Cells saving, saved and refused (a link that is not https)', model: base('quality', regsTab, { regs: regs({ marks: { [markKey(EN_4.id, 'title')]: { state: 'saving' }, [markKey(EN_3.id, 'link')]: { state: 'refused', problem: 'held.link' }, [markKey(ENTRIES[0]!.id, 'ojReference')]: { state: 'unknown' } } }) }) },
    { id: 'regulations-entry', label: 'An entry’s window: the certificates citing it and its change', model: base('quality', { ...regsTab, open: EN_3.id }, { regs: regs({ entry: { id: EN_3.id, read: ready(entryRecord(EN_3)), mode: 'view', move: { status: 'SUPERSEDED', supersededById: null, reason: '', transitionEndsOn: null }, change: EMPTY_CHANGE, writing: IDLE, saved: null } }) }) },
    { id: 'regulations-move', label: 'Mark superseded: the change it raises names the certificates', model: base('quality', { ...regsTab, open: EN_4.id }, { regs: regs({ entry: { id: EN_4.id, read: ready(entryRecord(EN_4)), mode: 'move', move: { status: 'SUPERSEDED', supersededById: null, reason: '', transitionEndsOn: null }, change: EMPTY_CHANGE, writing: IDLE, saved: null } }) }) },
    { id: 'regulations-record', label: 'Record a change you noticed', model: base('quality', { ...regsTab, open: EN_4.id }, { regs: regs({ entry: { id: EN_4.id, read: ready(entryRecord(EN_4)), mode: 'change', move: { status: 'SUPERSEDED', supersededById: null, reason: '', transitionEndsOn: null }, change: { ...EMPTY_CHANGE, kind: 'AMENDMENT', whatChanged: 'Emendamento A1 annunciato' }, writing: IDLE, saved: null } }) }) },
    { id: 'regulations-change', label: 'A change to assess: impact, the certificates for the notified body', model: base('quality', { ...regsTab, change: CHANGE_OPEN.id }, { regs: regs({ change: { id: CHANGE_OPEN.id, read: ready(CHANGE_OPEN), assess: { impact: 'RETEST', assessment: '', reviewCertificateIds: [CHANGE_OPEN.certificates[0]!.id] }, writing: IDLE, saved: null } }) }) },
    { id: 'regulations-assessed', label: 'An assessed change: the review opened, the impact task, Close', model: base('quality', { ...regsTab, change: CHANGE_ASSESSED.id }, { regs: regs({ change: { id: CHANGE_ASSESSED.id, read: ready(CHANGE_ASSESSED), assess: { impact: null, assessment: '', reviewCertificateIds: [] }, writing: IDLE, saved: { tone: 'success', key: 'saved.assessedReviews' } } }) }) },
    { id: 'regulations-closed', label: 'A closed change (read only)', model: base('quality', { ...regsTab, change: CHANGE_CLOSED.id, watch: 'all' }, { regs: regs({ changes: ready([...CHANGES, CHANGE_CLOSED]), change: { id: CHANGE_CLOSED.id, read: ready(CHANGE_CLOSED), assess: { impact: null, assessment: '', reviewCertificateIds: [] }, writing: IDLE, saved: null } }) }) },
    { id: 'regulations-new', label: 'New entry: Add held until code, title and kind', model: base('quality', { ...regsTab, add: true }, { regs: regs({ add: { draft: { ...EMPTY_ENTRY, code: 'EN 17092-2' }, writing: IDLE } }) }) },
    { id: 'regulations-new-refused', label: 'New entry refused: that edition is there already', model: base('quality', { ...regsTab, add: true }, { regs: regs({ add: { draft: { ...EMPTY_ENTRY, code: 'EN 17092-4', edition: '2020', title: 'Duplicate', kind: 'HARMONISED_STANDARD' }, writing: { busy: false, problem: { key: 'problem.taken', field: null } } } }) }) },
    { id: 'regulations-closing', label: 'Two assessed changes chosen: Close 2', model: base('quality', regsTab, { regs: regs({ changes: ready([CHANGE_OPEN, CHANGE_ASSESSED]), selected: [CHANGE_ASSESSED.id] }) }) },
    { id: 'regulations-filtered-empty', label: 'Filters match nothing: Clear filters', model: base('quality', { ...regsTab, q: 'ISO 13688', kind: 'GUIDANCE' }, { regs: regs({ entries: ready({ entries: [], asOf: NOW, mayManage: true }) }) }) },
    { id: 'regulations-empty', label: 'An empty register and watch', model: base('quality', regsTab, { regs: regs({ entries: ready({ entries: [], asOf: NOW, mayManage: true }), changes: ready([]) }) }) },
    { id: 'regulations-read-only', label: 'Read-only role: no cell edits, New entry held with why', model: base('readOnly', regsTab) },
    { id: 'regulations-error', label: 'The register failed; the watch still shows', model: base('quality', regsTab, { regs: regs({ entries: failed }) }) },
    // ---- Markets (rm-markets) ----
    { id: 'markets', label: 'Markets: the LanguageMatrix with phrase coverage, then the markets (autosave per cell)', model: base('quality', marketsTab), note: 'UK and CH are off with the Owner’s question; FR carries a made-up national extra.' },
    { id: 'markets-new', label: 'New market (off needs why)', model: base('quality', { ...marketsTab, add: true }, { markets: markets({ add: { draft: { ...EMPTY_MARKET, code: 'NL', name: 'Paesi Bassi', labelLanguages: 'nl', docLanguages: 'nl', userInfoLanguages: 'nl', switchedOn: false }, writing: IDLE } }) }) },
    { id: 'markets-off', label: 'Switching a market off asks why', model: base('quality', marketsTab, { markets: markets({ off: { code: 'ES', reason: '', writing: IDLE } }) }) },
    { id: 'markets-window', label: 'A market’s window: national extras and note', model: base('quality', { ...marketsTab, open: 'FR' }, { markets: markets({ open: { code: 'FR', rules: ruleDraftsOf(MARKETS[2]!), note: '', writing: IDLE } }) }) },
    { id: 'markets-selected', label: 'Two markets chosen: Switch on 1 (the one that is off)', model: base('quality', marketsTab, { markets: markets({ selected: ['IT', 'UK'], marks: { [markKey('DE', 'labelLanguages')]: { state: 'refused', problem: 'held.languages' } } }) }) },
    { id: 'markets-loading', label: 'Markets loading', model: base('quality', marketsTab, { markets: markets({ markets: loading, languages: loading }), readAt: null }) },
    { id: 'markets-error', label: 'Markets failed', model: base('quality', marketsTab, { markets: markets({ markets: failed, languages: failed }) }) },
    // ---- Phrases & translations (rm-phrases) ----
    { id: 'phrases', label: 'Phrases & translations: one column per language, state per cell', model: base('quality', phrasesTab) },
    {
      id: 'phrases-window',
      label: 'A phrase’s window: propose, approve as a second person (SignOffPanel)',
      model: base('quality', { ...phrasesTab, open: WARNING_A.key }, { phrases: phrases({ open: { key: WARNING_A.key, read: ready(phraseRecord(WARNING_A)), language: 'es', text: 'Prenda de clase A', source: null, writing: IDLE, saved: null } }) }),
    },
    { id: 'phrases-own-words', label: 'Your own proposal: Approve held — a second person approves', model: base('quality', { ...phrasesTab, open: ANIMAL.key }, { phrases: phrases({ open: { key: ANIMAL.key, read: ready(phraseRecord(ANIMAL)), language: null, text: '', source: null, writing: IDLE, saved: null } }) }) },
    { id: 'phrases-source', label: 'New source words: approved translations go out of date', model: base('quality', { ...phrasesTab, open: CARE.key }, { phrases: phrases({ open: { key: CARE.key, read: ready(phraseRecord(CARE)), language: null, text: '', source: 'Non lavare. Pulire con un panno umido e asciugare all’aria.', writing: IDLE, saved: null } }) }) },
    { id: 'phrases-new', label: 'New phrase', model: base('quality', { ...phrasesTab, add: true }, { phrases: phrases({ add: { draft: { ...EMPTY_PHRASE, key: 'warning.class-b', kind: 'WARNING' }, writing: IDLE } }) }) },
    { id: 'phrases-empty', label: 'An empty library', model: base('quality', phrasesTab, { phrases: phrases({ phrases: ready(phrasesAnswer(true, true, [])) }) }) },
    { id: 'phrases-read-only', label: 'Production manager: proposes, never approves', model: base('production', { ...phrasesTab, open: WARNING_A.key }, { phrases: phrases({ open: { key: WARNING_A.key, read: ready(phraseRecord(WARNING_A)), language: null, text: '', source: null, writing: IDLE, saved: null } }, true, false) }) },
    // ---- Operators (rm-operators) ----
    { id: 'operators', label: 'Operators: maker, brand, distributor and importer rows with the printed words', model: base('quality', operatorsTab) },
    { id: 'operators-new', label: 'New operator: an importer for the UK', model: base('quality', { ...operatorsTab, add: true }, { operators: operators({ add: { draft: { ...emptyOperator(TODAY), role: 'IMPORTER', scope: 'TENANT', marketCode: 'UK' }, pickers, writing: IDLE } }) }) },
    {
      id: 'operators-overlap',
      label: 'New operator refused: an overlapping row (in words)',
      model: base('quality', { ...operatorsTab, add: true }, { operators: operators({ add: { draft: { ...emptyOperator(TODAY), role: 'DISTRIBUTOR', scope: 'STYLE', styleId: STYLES[0]!.id, marketCode: 'CH', partyId: PARTIES[0]!.id, printedName: 'Distribuzione Demo SA', printedAddress: 'Strada Demo 5' }, pickers, writing: { busy: false, problem: { key: 'problem.overlap', field: null } } } }) }),
    },
    { id: 'operators-window', label: 'An operator row’s window', model: base('quality', { ...operatorsTab, open: OPERATORS[1]!.id }, { operators: operators({ open: { id: OPERATORS[1]!.id, draft: { partyId: OPERATORS[1]!.party!.id, printedName: OPERATORS[1]!.printedName, printedAddress: OPERATORS[1]!.printedAddress, contact: OPERATORS[1]!.contact ?? '', validFrom: OPERATORS[1]!.validFrom, validTo: '2026-12-31', note: '' }, pickers: { ...pickers, parties: ready(BRANDS) }, writing: IDLE } }) }) },
    { id: 'operators-selected', label: 'Rows chosen: End 1 today', model: base('quality', operatorsTab, { operators: operators({ selected: [OPERATORS[0]!.id, OPERATORS[3]!.id] }) }) },
    { id: 'operators-empty', label: 'No operator rows', model: base('quality', operatorsTab, { operators: operators({ operators: ready(operatorsAnswer(true, [])) }) }) },
    // ---- the page ----
    { id: 'no-permission', label: 'Sales: no compliance read', model: base('sales', {}) },
    { id: 'read-only', label: 'Read-only role: Gates (no Chromium VI tab without the lots read)', model: base('readOnly', {}) },
    { id: 'offline', label: 'Offline: changes wait, every write held with why', model: base('quality', gatesTab, { live: 'offline' }) },
    { id: 'notice', label: 'After a write: the notice', model: base('quality', gatesTab, { notice: { tone: 'success', key: 'notice.suggestedAdded', params: { count: 2 } } }) },
    { id: 'keys', label: 'Keyboard shortcuts (?)', model: base('quality', gatesTab, { keysOpen: true }) },
    // B-W2b-288 (FU2:01): Templates — the PPE consultant's yes per template (GATE-PPE-TEXTS).
    ...templatesCases(base),
  ],
})
