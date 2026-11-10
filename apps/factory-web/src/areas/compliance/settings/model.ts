import { CHANGE_KINDS, IMPACTS, REGULATION_KINDS, REGULATION_STATUSES, type RegulationKind, type RegulationStatus, type StandardChangeImpact, type StandardChangeKind } from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { LANGUAGE_CODE, MARK_CODE, MARKET_CODE, MARKET_CODE_MAX } from '@nexus/factory-domain/compliance/markets/rules'
import { OPERATOR_ROLES, type OperatorRole } from '@nexus/factory-domain/compliance/operators/rules'
import { PHRASE_KINDS, type PhraseKind } from '@nexus/factory-domain/compliance/phrases/rules'
import { CHECK_KEY, COMPLIANCE_GATES, LOOSENINGS, looseningOf, OVERRIDE_DAYS_MAX, PRODUCT_TYPES, REQUIREMENT_KINDS, type ComplianceGate, type Editable, type Loosening, type ProductType, type RequirementKind } from '@nexus/factory-domain/compliance/requirements/rules'
import { PPE_CATEGORIES, type PpeCategory } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { isLoosening, type EvidenceRule } from '@nexus/factory-domain/quality/lab/rules'
import { issuePath, isApiError } from '../../../lib/api/errors'
import type { GateRow, Market, Operator, OperatorBody, Phrase, Requirement, RequirementBody } from './api'

/**
 * Compliance › Settings › Rules & markets (SCR-262; B-W2b-265), pure: the page's address (`?tab=` and each tab's filters and
 * dialogs), who may do what, the six tabs' drafts and their checks before the API is asked, the loosenings said before a
 * looser gate is applied (the same codes as factory-domain's `looseningOf`), the requirement rows a person may add from the
 * Gates tab (the label, artwork, reconciliation and claim checks the later steps plugged into the one gate, each OFF until a
 * person switches it on), and the problems in words. One save model per tab (design rm-tabs): Chromium VI and Gates save with
 * the EditModeBar (a looser rule asks the confirm in words, then a fresh code); Regulations, Markets and Operators autosave
 * per cell at the row's version; Phrases propose and approve (a second person).
 */

// ---- the address ---------------------------------------------------------------------------------------------------------

export const SETTINGS_TABS = ['cr6', 'gates', 'regulations', 'markets', 'phrases', 'operators'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]
export const CR6_SCOPES = ['company', 'all'] as const
export type Cr6Scope = (typeof CR6_SCOPES)[number]

export interface SettingsAddress {
  readonly tab: SettingsTab | null
  /** Chromium VI: this company's rule or every company's. */
  readonly scope: Cr6Scope
  /** The tab's "Add …" dialog. */
  readonly add: boolean
  /** The tab's record window: an entry id, a market code, a phrase key, an operator id, a requirement code. */
  readonly open: string | null
  /** Regulations: a change of the watch. */
  readonly change: string | null
  readonly q: string
  /** Regulations: RegulationKind; Phrases: PhraseKind. */
  readonly kind: string | null
  /** Regulations: RegulationStatus. */
  readonly status: RegulationStatus | null
  /** Operators. */
  readonly role: OperatorRole | null
  readonly market: string | null
  /** Regulations: the watch shows the open changes (default) or every change. */
  readonly watch: 'open' | 'all'
}

export const EMPTY_ADDRESS: SettingsAddress = Object.freeze({ tab: null, scope: 'company', add: false, open: null, change: null, q: '', kind: null, status: null, role: null, market: null, watch: 'open' })

const oneOf = <T extends string>(list: readonly T[], value: string | null | undefined): T | null => ((list as readonly string[]).includes(value ?? '') ? (value as T) : null)
const KINDS: readonly string[] = [...REGULATION_KINDS, ...PHRASE_KINDS]

export function addressOf(params: { get(name: string): string | null } | null | undefined): SettingsAddress {
  const get = (name: string) => params?.get(name) ?? null
  const tab = oneOf(SETTINGS_TABS, get('tab'))
  const kind = get('kind')
  const market = get('market')
  return {
    tab,
    scope: oneOf(CR6_SCOPES, get('scope')) ?? 'company',
    add: get('add') === '1',
    open: get('open') || null,
    change: get('change') || null,
    q: (get('q') ?? '').slice(0, 100),
    kind: kind && KINDS.includes(kind) ? kind : null,
    status: oneOf(REGULATION_STATUSES, get('status')),
    role: oneOf(OPERATOR_ROLES, get('role')),
    market: market && MARKET_CODE.test(market) && market.length <= MARKET_CODE_MAX ? market : null,
    watch: get('watch') === 'all' ? 'all' : 'open',
  }
}

export function addressText(address: SettingsAddress): string {
  const query = new URLSearchParams()
  if (address.tab) query.set('tab', address.tab)
  if (address.scope !== 'company') query.set('scope', address.scope)
  if (address.add) query.set('add', '1')
  if (address.open) query.set('open', address.open)
  if (address.change) query.set('change', address.change)
  if (address.q) query.set('q', address.q)
  if (address.kind) query.set('kind', address.kind)
  if (address.status) query.set('status', address.status)
  if (address.role) query.set('role', address.role)
  if (address.market) query.set('market', address.market)
  if (address.watch !== 'open') query.set('watch', address.watch)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** A change of address: another tab starts with its own filters and no dialog. */
export function withAddress(address: SettingsAddress, change: Partial<SettingsAddress>): SettingsAddress {
  if (change.tab !== undefined && change.tab !== address.tab) return { ...EMPTY_ADDRESS, scope: address.scope, ...change }
  return { ...address, ...change }
}

// ---- who may do what -----------------------------------------------------------------------------------------------------

export interface RulesCan {
  /** compliance.certificates.view: the register, markets, phrases, operators and the gates. */
  readonly view: boolean
  /** quality.lots.view: the Cr VI rule (as the tests page). */
  readonly crViView: boolean
  /** quality.settings.manage: change the Cr VI rule (the owner by template). */
  readonly crViManage: boolean
  readonly rulesManage: boolean
  readonly phrasesManage: boolean
  readonly phrasesApprove: boolean
  readonly requirementsManage: boolean
  readonly materialsView: boolean
  readonly stylesView: boolean
  readonly partiesView: boolean
}

export function rulesCan(permissions: readonly string[]): RulesCan {
  const has = (permission: string) => permissions.includes(permission)
  return {
    view: has('compliance.certificates.view'),
    crViView: has('quality.lots.view'),
    crViManage: has('quality.settings.manage'),
    rulesManage: has('compliance.rules.manage'),
    phrasesManage: has('compliance.phrases.manage'),
    phrasesApprove: has('compliance.phrases.approve'),
    requirementsManage: has('compliance.requirements.manage'),
    materialsView: has('product.materials.view'),
    stylesView: has('product.styles.view'),
    partiesView: has('parties.view'),
  }
}

/** The tabs a person may open (Chromium VI needs the lots' read, the rest the compliance read). */
export function tabsFor(can: RulesCan): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => (tab === 'cr6' ? can.crViView : can.view))
}

/** The tab shown: the address's when the person may open it, else the first they may. */
export function tabOf(address: SettingsAddress, can: RulesCan): SettingsTab | null {
  const tabs = tabsFor(can)
  return address.tab && tabs.includes(address.tab) ? address.tab : (tabs[0] ?? null)
}

// ---- reads, problems and marks -------------------------------------------------------------------------------------------

/** One read of one part: loading, its answer, or the problem in words (never drawn as empty). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }
export const valueOf = <T>(read: Read<T> | null | undefined): T | null => (read && read.status === 'ready' ? read.value : null)

/** A write's problem: the message key and the field it names. */
export interface Problem {
  readonly key: string
  readonly field: string | null
}

/** The fields a problem may name (each has its words, `field.<name>`); another field is said as "Check the fields". */
export const PROBLEM_FIELDS = [
  'code', 'edition', 'title', 'kind', 'status', 'ojReference', 'ojDate', 'link', 'note', 'supersededById', 'reason', 'transitionEndsOn', 'whatChanged', 'sourceReference', 'newStandardId',
  'impact', 'assessment', 'reviewCertificateIds', 'version', 'name', 'nameI18n', 'labelLanguages', 'docLanguages', 'userInfoLanguages', 'markings', 'nationalRules', 'importerNeeded',
  'gpsrContactNeeded', 'seq', 'offReason', 'on', 'marketCode', 'companyId', 'checkKey', 'operatorRole', 'productTypes', 'productTypeProfileId', 'ppeCategories', 'blocks', 'lockedBlocks',
  'overrideRoleKeys', 'overrideMaxDays', 'legalReference', 'regulationId', 'explanationI18n', 'appliesFrom', 'appliesUntil', 'switchedOn', 'role', 'styleId', 'brandPartyId', 'partyId',
  'printedName', 'printedAddress', 'contact', 'validFrom', 'validTo', 'key', 'sourceLanguage', 'sourceText', 'language', 'text', 'crViEvidenceRule',
] as const

/** The refusal codes the rules' API names (`refusal/<CODE>`); each has its words, `refusal.<CODE>`. */
export const REFUSAL_CODES = [
  'ALREADY', 'ALREADY_ON', 'ALREADY_OFF', 'LOCKED', 'REASON_NEEDED', 'DATABASE', 'CLOSED', 'TASK_NAMED', 'NOT_ASSESSED', 'NOT_OPEN', 'NO_REVIEW_FOR_NONE', 'NOT_NAMED',
  'NOT_DRAFT', 'DRAFT_WAITING', 'NOTHING_NEW', 'SOURCE_LANGUAGE_TRANSLATED', 'ARCHIVED', 'LANGUAGE', 'SOURCE_LANGUAGE', 'WORDS', 'STALE', 'OWN_PROPOSAL',
] as const

/** What a write was: a bare 409 means "there is one already" for a new row, "it overlaps" for an operator, "something names it" for a delete. */
export type WriteKind = 'edit' | 'create' | 'overlap' | 'delete'

/** The fields the law's padlocks refuse (requirements: lockedProblems). */
const LOCK_FIELDS: readonly string[] = ['blocks', 'lockedBlocks', 'switchedOn', 'status', 'kind', 'scope', 'appliesFrom']

/** A write's problem in our words (the API's English is never shown): a known refusal, the field, or what a 409 means here. */
export function problemOf(error: unknown, kind: WriteKind = 'edit'): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null }
  let field: string | null = null
  let refusal: string | null = null
  let version = false
  for (const issue of error.issues) {
    const path = issuePath(issue).replace(/\./g, '/')
    if (path.startsWith('refusal/') && !refusal) refusal = path.slice(8)
    else if (path === 'version' || path === 'body/version') version = true
    else if (path.startsWith('body/') && !field) field = path.slice(5).split('/')[0] || null
  }
  if (refusal && (REFUSAL_CODES as readonly string[]).includes(refusal)) return { key: `refusal.${refusal}`, field: null }
  if (field && !(PROBLEM_FIELDS as readonly string[]).includes(field)) field = null
  switch (error.kind) {
    case 'invalid':
      return { key: field ? 'problem.field' : 'problem.invalid', field }
    case 'signed_out':
      return { key: 'problem.signedOut', field: null }
    case 'forbidden':
      return { key: 'problem.forbidden', field: null }
    case 'not_found':
      return { key: 'problem.notFound', field: null }
    case 'conflict':
      if (version) return { key: 'problem.conflict', field: null }
      if (field) return { key: LOCK_FIELDS.includes(field) ? 'problem.locked' : 'problem.field', field }
      return { key: kind === 'create' ? 'problem.taken' : kind === 'overlap' ? 'problem.overlap' : kind === 'delete' ? 'held.entryNamed' : 'problem.conflict', field: null }
    case 'rate_limited':
      return { key: 'problem.rateLimited', field: null }
    case 'unavailable':
      return { key: 'problem.unavailable', field: null }
    default:
      return { key: 'problem.internal', field: null }
  }
}

/** A read that failed, in words. */
export function readProblemOf(error: unknown): string {
  const problem = problemOf(error)
  return ['problem.forbidden', 'problem.signedOut', 'problem.notFound'].includes(problem.key) ? problem.key : 'problem.read'
}

/** A cell's save mark (autosave per cell): saving, unknown, saved (fades), refused with its reason in words. */
export interface Mark {
  readonly state: 'saving' | 'unknown' | 'saved' | 'refused'
  readonly problem?: string
}
export const markKey = (id: string, field: string): string => `${id}:${field}`

// ---- lists typed in a cell -----------------------------------------------------------------------------------------------

/** "de, FR it" → ['de', 'fr', 'it'] (each once, in order). */
export function codesOf(text: string, upper = false): string[] {
  const parts = text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => (upper ? part.toUpperCase() : part.toLowerCase()))
  return [...new Set(parts)]
}

/** A language list as typed: null when fine, else the message key. */
export const languagesProblem = (codes: readonly string[]): string | null => (codes.length > 20 || codes.some((code) => !LANGUAGE_CODE.test(code)) ? 'held.languages' : null)
export const marksProblem = (codes: readonly string[]): string | null => (codes.length > 20 || codes.some((code) => !MARK_CODE.test(code)) ? 'held.markings' : null)

// ---- Chromium VI (rm-cr6) ------------------------------------------------------------------------------------------------

/** Whether a new Cr VI rule accepts more evidence than the one in force (it then asks the reason and a fresh code). */
export const crViLoosens = (from: EvidenceRule, to: EvidenceRule): boolean => isLoosening(from, to)

/** Apply's hold on the Cr VI card, or null. */
export function crViHeld(input: { readonly mayManage: boolean; readonly changed: boolean; readonly busy: boolean }): string | null {
  if (!input.mayManage) return 'held.crViManage'
  if (!input.changed) return 'held.nothingChanged'
  if (input.busy) return 'held.busy'
  return null
}

/** The legal limit (mg/kg) a material's own lower limit is compared with. */
export const LEGAL_CR_VI_LIMIT_MG_KG = 3

/** A material sets a brand's lower limit when its own is below the law's. */
export const isLowerLimit = (limit: string | null): boolean => limit !== null && Number.isFinite(Number(limit)) && Number(limit) < LEGAL_CR_VI_LIMIT_MG_KG

// ---- Gates (rm-gates) ----------------------------------------------------------------------------------------------------

export { COMPLIANCE_GATES, LOOSENINGS, PRODUCT_TYPES, PPE_CATEGORIES, REQUIREMENT_KINDS }

/** The office role templates that may be named to override a gate (a custom role keeps its key). */
export const OVERRIDE_ROLES = ['owner', 'quality_inspector', 'production_manager', 'admin', 'planner', 'sales', 'buyer', 'warehouse', 'finance', 'floor_supervisor'] as const

/** What the person may change on one gate row, before Apply. */
export interface GateDraft {
  readonly blocks: readonly ComplianceGate[]
  readonly overrideRoleKeys: readonly string[]
  readonly overrideMaxDays: number
  readonly switchedOn: boolean
}

export const gateDraftOf = (row: GateRow): GateDraft => ({ blocks: [...row.requirement.blocks], overrideRoleKeys: [...row.overrideRoleKeys], overrideMaxDays: row.overrideMaxDays, switchedOn: row.requirement.switchedOn })

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value) => b.includes(value))

/** The draft's change for the row: which parts moved (empty: unchanged). */
export function gateChangeOf(row: GateRow, draft: GateDraft | undefined): { blocks: boolean; roles: boolean; days: boolean; switched: boolean } {
  const base = gateDraftOf(row)
  const now = draft ?? base
  return { blocks: !sameSet(base.blocks, now.blocks), roles: !sameSet(base.overrideRoleKeys, now.overrideRoleKeys), days: base.overrideMaxDays !== now.overrideMaxDays, switched: base.switchedOn !== now.switchedOn }
}

export const gateChanged = (row: GateRow, draft: GateDraft | undefined): boolean => Object.values(gateChangeOf(row, draft)).some(Boolean)

/** How many rows the person changed (the EditModeBar's count). */
export const gateChanges = (rows: readonly GateRow[], drafts: Readonly<Record<string, GateDraft>>): number => rows.filter((row) => gateChanged(row, drafts[row.requirement.code])).length

const editableOf = (requirement: Requirement, draft?: GateDraft): Editable => ({
  kind: requirement.kind,
  checkKey: requirement.checkKey,
  operatorRole: requirement.operatorRole,
  productTypes: requirement.productTypes,
  productTypeProfileId: requirement.productTypeProfileId,
  ppeCategories: requirement.ppeCategories,
  marketCode: requirement.marketCode,
  blocks: draft ? [...draft.blocks] : requirement.blocks,
  lockedBlocks: requirement.lockedBlocks,
  overrideRoleKeys: draft ? [...draft.overrideRoleKeys] : requirement.overrideRoleKeys,
  overrideMaxDays: draft ? draft.overrideMaxDays : requirement.overrideMaxDays,
  appliesFrom: requirement.appliesFrom,
  appliesUntil: requirement.appliesUntil,
  switchedOn: draft ? draft.switchedOn : requirement.switchedOn,
  status: requirement.status,
})

/** One looser change, with what the screen says ("It no longer blocks the label print."). */
export interface LooseLine {
  readonly code: Loosening
  readonly params: Readonly<Record<string, string | number>>
}

/** What the draft makes looser (the codes are factory-domain's `looseningOf`; the params name the gate, role or days). */
export function gateLoosenings(row: GateRow, draft: GateDraft | undefined): LooseLine[] {
  if (!draft) return []
  const before = editableOf(row.requirement)
  const after = editableOf(row.requirement, draft)
  const codes = looseningOf(before, after).map((entry) => entry.code)
  const lines: LooseLine[] = []
  for (const gate of before.blocks.filter((gate) => !after.blocks.includes(gate))) lines.push({ code: 'BLOCK_REMOVED', params: { gate } })
  for (const role of after.overrideRoleKeys.filter((role) => !before.overrideRoleKeys.includes(role))) lines.push({ code: 'OVERRIDE_ROLE_ADDED', params: { role } })
  if (codes.includes('OVERRIDE_LONGER')) lines.push({ code: 'OVERRIDE_LONGER', params: { days: after.overrideMaxDays, was: before.overrideMaxDays } })
  if (codes.includes('SWITCHED_OFF')) lines.push({ code: 'SWITCHED_OFF', params: {} })
  return lines
}

/** Every changed row's loosenings (the "Confirm a looser rule" dialog's lines), in the matrix's order. */
export function looseningsOf(rows: readonly GateRow[], drafts: Readonly<Record<string, GateDraft>>): { code: string; name: string; lines: LooseLine[] }[] {
  return rows.map((row) => ({ code: row.requirement.code, name: row.requirement.name, lines: gateLoosenings(row, drafts[row.requirement.code]) })).filter((entry) => entry.lines.length > 0)
}

/** Why one cell of the matrix may not change (null: it may). */
export function cellHeld(row: GateRow, gate: ComplianceGate, offline = false): string | null {
  if (row.requirement.lockedBlocks.includes(gate)) return 'held.locked'
  if (row.requirement.builtIn) return 'held.builtIn'
  if (!row.mayLoosen) return 'held.requirementsManage'
  if (offline) return 'held.offline'
  return null
}

/** Why a row's switch may not move (a requirement the law locks at a gate stays on). */
export function switchHeld(row: GateRow, offline = false): string | null {
  if (row.requirement.lockedBlocks.length > 0) return 'held.lockedOn'
  if (row.requirement.builtIn) return 'held.builtIn'
  if (!row.mayLoosen) return 'held.requirementsManage'
  if (offline) return 'held.offline'
  return null
}

/** Apply's hold on the matrix, or null. */
export function gatesApplyHeld(input: { readonly changes: number; readonly busy: boolean; readonly offline: boolean }): string | null {
  if (input.changes === 0) return 'held.nothingChanged'
  if (input.busy) return 'held.busy'
  if (input.offline) return 'held.offline'
  return null
}

/** A row switched off in the draft needs the words why (the Owner question it waits for). */
export const switchesOff = (rows: readonly GateRow[], drafts: Readonly<Record<string, GateDraft>>): string[] =>
  rows.filter((row) => row.requirement.switchedOn && drafts[row.requirement.code]?.switchedOn === false).map((row) => row.requirement.code)

export const REASON_MIN = 3
export const REASON_MAX = 500
export const reasonHeld = (reason: string): string | null => (reason.trim().length < REASON_MIN ? 'held.reason' : reason.trim().length > REASON_MAX ? 'held.reasonLong' : null)

// ---- requirement rows to add (the plugged checks of B-W2b-253, -259 and -264) ---------------------------------------------

export interface Suggestion {
  readonly code: string
  readonly kind: RequirementKind
  readonly checkKey: string
  readonly name: Readonly<Record<'it' | 'en', string>>
  readonly explanation: Readonly<Record<'it' | 'en', string>>
  readonly legalReference: string
  readonly blocks: readonly ComplianceGate[]
  readonly ppeCategories: readonly PpeCategory[]
  readonly productTypes: readonly ProductType[]
  readonly seq: number
}

/**
 * The requirement rows the label checks (B-W2b-253), the artwork and label reconciliation checks (B-W2b-259) and the claims'
 * evidence check (B-W2b-264) wait for: each check is plugged into the one gate by name and does nothing until a row names it.
 * Added from here they are OFF with the reason the person gives (the lead's rule; the Owner's Q5 = A keeps claim rules off);
 * switching one on is the person's next, separate step.
 */
export const SUGGESTIONS: readonly Suggestion[] = Object.freeze([
  {
    code: 'LABEL-CE-MARKING',
    kind: 'LABEL',
    checkKey: 'label.ceMarking',
    name: { it: 'La marcatura CE è sull\'etichetta', en: 'The CE marking is on the label' },
    explanation: { it: 'La marcatura CE è visibile, leggibile e indelebile; in categoria III è seguita dal numero dell\'organismo notificato.', en: 'The CE marking is visible, legible and indelible; on category III it is followed by the notified body\'s number.' },
    legalReference: 'Reg. (EU) 2016/425 art. 17',
    blocks: ['LABEL_PRINT'],
    ppeCategories: ['CATEGORY_II', 'CATEGORY_III'],
    productTypes: [],
    seq: 40,
  },
  {
    code: 'LABEL-CLASS-WARNINGS',
    kind: 'LABEL',
    checkKey: 'label.classWarnings',
    name: { it: 'Le avvertenze di classe sono sull\'etichetta', en: 'The class warnings are on the label' },
    explanation: { it: 'Un capo di classe B o C, o con protezioni estraibili, lo dice a parole accanto al pittogramma.', en: 'A class B or C garment, or one with removable protectors, says so in words beside the pictogram.' },
    legalReference: 'EN 17092-1:2020; Reg. (EU) 2016/425 Annex II 1.4',
    blocks: ['LABEL_PRINT'],
    ppeCategories: [],
    productTypes: [],
    seq: 41,
  },
  {
    code: 'LABEL-GLOVE-MARKING',
    kind: 'LABEL',
    checkKey: 'label.gloveMarking',
    name: { it: 'Il guanto porta pittogramma e livello EN 13594', en: 'The glove carries the EN 13594 pictogram and level' },
    explanation: { it: 'Un guanto da moto porta il pittogramma della norma e il livello 1 o 2, con KP se le nocche sono protette.', en: 'A rider\'s glove carries the standard\'s pictogram and its level 1 or 2, with KP when the knuckles are protected.' },
    legalReference: 'EN 13594:2015',
    blocks: ['LABEL_PRINT'],
    ppeCategories: [],
    productTypes: ['GLOVES'],
    seq: 42,
  },
  {
    code: 'LABEL-QR-CODE',
    kind: 'LABEL',
    checkKey: 'label.qrCode',
    name: { it: 'Il QR porta alla dichiarazione pubblica', en: 'The QR leads to the public declaration' },
    explanation: { it: 'La dichiarazione UE accompagna il DPI, oppure le istruzioni danno l\'indirizzo dove leggerla: il QR porta lì.', en: 'The EU declaration goes with the PPE, or the instructions give the address where it can be read: the QR leads there.' },
    legalReference: 'Reg. (EU) 2016/425 art. 15, Annex II 1.4',
    blocks: ['LABEL_PRINT'],
    ppeCategories: [],
    productTypes: [],
    seq: 43,
  },
  {
    code: 'LABEL-ARTWORK',
    kind: 'LABEL',
    checkKey: 'label.artwork',
    name: { it: 'Si stampa solo una grafica approvata', en: 'Only approved artwork prints' },
    explanation: { it: 'La revisione dell\'etichetta ha una bozza approvata da una seconda persona prima della stampa.', en: 'The label revision has a proof approved by a second person before it prints.' },
    legalReference: 'Reg. (EU) 2016/425 art. 8(5)-(6), Annex II 2.12',
    blocks: ['LABEL_PRINT'],
    ppeCategories: [],
    productTypes: [],
    seq: 44,
  },
  {
    code: 'LABEL-RECONCILIATION',
    kind: 'LABEL',
    checkKey: 'label.reconciliation',
    name: { it: 'Le etichette dell\'ordine tornano', en: 'The work order\'s labels balance' },
    explanation: { it: 'Etichette stampate = applicate + scartate + rese per ogni taglia, prima del rilascio finale.', en: 'Labels printed = applied + spoiled + returned per size, before the final release.' },
    legalReference: 'Reg. (EU) 2016/425 art. 8(2), Annex VII (production control)',
    blocks: ['FINAL_RELEASE'],
    ppeCategories: [],
    productTypes: [],
    seq: 45,
  },
  {
    code: 'CLAIM-EVIDENCE',
    kind: 'CLAIM_EVIDENCE',
    checkKey: 'claims.evidence',
    name: { it: 'Ogni dichiarazione ambientale stampata ha prove valide', en: 'Every environmental claim printed has valid evidence' },
    explanation: { it: 'Una dichiarazione ambientale si usa solo con prove in corso di validità.', en: 'An environmental claim is used only with evidence that still holds.' },
    legalReference: 'Dir. (EU) 2024/825',
    blocks: ['LABEL_PRINT'],
    ppeCategories: [],
    productTypes: [],
    seq: 50,
  },
] satisfies Suggestion[])

/** The suggestions whose check no requirement names yet (archived ones count: restore them instead). */
export function missingSuggestions(requirements: readonly Pick<Requirement, 'checkKey' | 'code'>[]): Suggestion[] {
  return SUGGESTIONS.filter((entry) => !requirements.some((row) => row.checkKey === entry.checkKey || row.code === entry.code))
}

/** A suggestion as the row the API keeps: OFF, with the person's reason. */
export function suggestionBody(entry: Suggestion, reason: string, locale: 'it' | 'en'): RequirementBody {
  return {
    code: entry.code,
    kind: entry.kind,
    name: entry.name[locale],
    nameI18n: { it: entry.name.it, en: entry.name.en },
    checkKey: entry.checkKey,
    operatorRole: null,
    productTypes: entry.productTypes,
    ppeCategories: entry.ppeCategories,
    marketCode: null,
    blocks: entry.blocks,
    overrideRoleKeys: [],
    overrideMaxDays: 7,
    legalReference: entry.legalReference,
    explanationI18n: { it: entry.explanation.it, en: entry.explanation.en },
    seq: entry.seq,
    switchedOn: false,
    offReason: reason.trim(),
  }
}

/** A requirement of the person's own (the Add requirement dialog's second way). */
export interface RequirementDraft {
  readonly code: string
  readonly nameIt: string
  readonly nameEn: string
  readonly kind: RequirementKind | null
  readonly checkKey: string
  readonly operatorRole: OperatorRole | null
  readonly marketCode: string | null
  readonly ppeCategories: readonly PpeCategory[]
  readonly productTypes: readonly ProductType[]
  readonly blocks: readonly ComplianceGate[]
  readonly legalReference: string
  readonly overrideRoleKeys: readonly string[]
  readonly overrideMaxDays: number
  readonly switchedOn: boolean
  readonly offReason: string
}

export const EMPTY_REQUIREMENT: RequirementDraft = Object.freeze({
  code: '',
  nameIt: '',
  nameEn: '',
  kind: null,
  checkKey: '',
  operatorRole: null,
  marketCode: null,
  ppeCategories: [],
  productTypes: [],
  blocks: [],
  legalReference: '',
  overrideRoleKeys: [],
  overrideMaxDays: 3,
  switchedOn: false,
  offReason: '',
})

/** The first thing missing before Add (null: ready). */
export function requirementHeld(draft: RequirementDraft): string | null {
  if (!/^[^\s\p{Cc}]{1,60}$/u.test(draft.code.trim())) return 'held.code'
  if (draft.nameIt.trim() === '' && draft.nameEn.trim() === '') return 'held.name'
  if (!draft.kind) return 'held.kind'
  if (draft.checkKey.trim() !== '' && !CHECK_KEY.test(draft.checkKey.trim())) return 'held.checkKey'
  if (draft.kind === 'OPERATOR_ROLE' && !draft.operatorRole) return 'held.operatorRole'
  if (draft.legalReference.trim() === '') return 'held.legalReference'
  if (draft.overrideMaxDays < 1 || draft.overrideMaxDays > OVERRIDE_DAYS_MAX) return 'held.overrideMaxDays'
  if (!draft.switchedOn) return reasonHeld(draft.offReason)
  return null
}

export function requirementBodyOf(draft: RequirementDraft, locale: 'it' | 'en'): RequirementBody {
  const nameI18n: Record<string, string> = {}
  if (draft.nameIt.trim()) nameI18n.it = draft.nameIt.trim()
  if (draft.nameEn.trim()) nameI18n.en = draft.nameEn.trim()
  return {
    code: draft.code.trim(),
    kind: draft.kind ?? 'TEST',
    name: (locale === 'it' ? draft.nameIt || draft.nameEn : draft.nameEn || draft.nameIt).trim(),
    nameI18n,
    checkKey: draft.checkKey.trim() || null,
    operatorRole: draft.kind === 'OPERATOR_ROLE' ? draft.operatorRole : null,
    productTypes: draft.productTypes,
    ppeCategories: draft.ppeCategories,
    marketCode: draft.marketCode,
    blocks: draft.blocks,
    overrideRoleKeys: draft.overrideRoleKeys,
    overrideMaxDays: draft.overrideMaxDays,
    legalReference: draft.legalReference.trim(),
    explanationI18n: null,
    seq: 100,
    switchedOn: draft.switchedOn,
    offReason: draft.switchedOn ? null : draft.offReason.trim(),
  }
}

/** The check keys a person may name for a kind (the built-in ones and those the later steps plugged in). */
export const CHECKS_BY_KIND: Readonly<Record<RequirementKind, readonly string[]>> = Object.freeze({
  CERTIFICATE: ['certificate.coverage', 'certificate.gloveLevels'],
  DOC_LANGUAGE: ['doc.languages'],
  USER_INFO_LANGUAGE: ['userInfo.languages'],
  LABEL: ['label.languages', 'label.ceMarking', 'label.classWarnings', 'label.gloveMarking', 'label.qrCode', 'label.artwork', 'label.reconciliation', 'gpsr.contact'],
  TEST: [],
  OPERATOR_ROLE: ['operator.role'],
  DECLARATION: ['gpsr.contact'],
  CLAIM_EVIDENCE: ['claims.evidence'],
})

/** A requirement's name in the page's language. */
export const nameIn = (requirement: Pick<Requirement, 'name' | 'nameI18n'>, locale: string): string => requirement.nameI18n[locale] ?? requirement.name

/** What the row covers, as codes the screen words (categories, types, market). */
export function scopeOf(requirement: Pick<Requirement, 'ppeCategories' | 'productTypes' | 'marketCode' | 'companyId'>): { categories: readonly PpeCategory[]; types: readonly ProductType[]; market: string | null; company: boolean } {
  return { categories: requirement.ppeCategories, types: requirement.productTypes, market: requirement.marketCode, company: requirement.companyId !== null }
}

// ---- Regulations & standards (rm-regs) -----------------------------------------------------------------------------------

export { CHANGE_KINDS, IMPACTS, REGULATION_KINDS, REGULATION_STATUSES }

/** The register's cells autosaved one by one (the API's PATCH fields). */
export const ENTRY_CELLS = ['title', 'ojReference', 'link'] as const
export type EntryCell = (typeof ENTRY_CELLS)[number]

export function entryCellProblem(field: EntryCell, value: string): string | null {
  const text = value.trim()
  if (field === 'title') return text === '' || text.length > 300 ? 'held.title' : null
  if (field === 'ojReference') return text.length > 200 ? 'held.ojReference' : null
  return text !== '' && !/^https:\/\/\S+$/.test(text) ? 'held.link' : null
}

export interface EntryDraft {
  readonly code: string
  readonly edition: string
  readonly title: string
  readonly kind: RegulationKind | null
  readonly ojReference: string
  readonly ojDate: string | null
  readonly link: string
  readonly status: RegulationStatus
}

export const EMPTY_ENTRY: EntryDraft = Object.freeze({ code: '', edition: '', title: '', kind: null, ojReference: '', ojDate: null, link: '', status: 'IN_FORCE' })

export function entryHeld(draft: EntryDraft): string | null {
  if (draft.code.trim() === '' || draft.code.length > 100) return 'held.code'
  if (draft.edition.length > 40) return 'held.edition'
  if (draft.title.trim() === '') return 'held.title'
  if (!draft.kind) return 'held.kind'
  if (draft.link.trim() !== '' && !/^https:\/\/\S+$/.test(draft.link.trim())) return 'held.link'
  return null
}

/** A move of an entry to SUPERSEDED or WITHDRAWN (it raises a change naming the certificates that cite it). */
export interface StatusMove {
  readonly status: RegulationStatus
  readonly supersededById: string | null
  readonly reason: string
  readonly transitionEndsOn: string | null
}

export function moveHeld(move: StatusMove, current: RegulationStatus): string | null {
  if (move.status === current) return 'held.sameStatus'
  if (move.status !== 'IN_FORCE' && move.reason.trim().length < 3) return 'held.whatChanged'
  return null
}

export interface ChangeDraft {
  readonly kind: StandardChangeKind
  readonly whatChanged: string
  readonly sourceReference: string
  readonly transitionEndsOn: string | null
  readonly newStandardId: string | null
}

export const EMPTY_CHANGE: ChangeDraft = Object.freeze({ kind: 'REVISION', whatChanged: '', sourceReference: '', transitionEndsOn: null, newStandardId: null })
export const changeHeld = (draft: ChangeDraft): string | null => (draft.whatChanged.trim().length < 3 ? 'held.whatChanged' : null)

export interface AssessDraft {
  readonly impact: StandardChangeImpact | null
  readonly assessment: string
  readonly reviewCertificateIds: readonly string[]
}

export const EMPTY_ASSESS: AssessDraft = Object.freeze({ impact: null, assessment: '', reviewCertificateIds: [] })

/** The assessment's hold (impact NONE names no review; REVIEW or RETEST names at least one certificate). */
export function assessHeld(draft: AssessDraft): string | null {
  if (!draft.impact) return 'held.impact'
  if (draft.assessment.trim().length < 3) return 'held.assessment'
  if (draft.impact === 'NONE' && draft.reviewCertificateIds.length > 0) return 'held.noReviewForNone'
  if (draft.impact !== 'NONE' && draft.reviewCertificateIds.length === 0) return 'held.reviewCertificates'
  return null
}

/** The transition's tone (a badge): ending within 30 days is a warning, ended is danger. */
export const TRANSITION_TONE = { NONE: 'neutral', RUNNING: 'info', ENDS_SOON: 'warning', ENDED: 'danger' } as const
export const ENTRY_TONE = { IN_FORCE: 'success', SUPERSEDED: 'warning', WITHDRAWN: 'danger' } as const
export const CHANGE_TONE = { OPEN: 'warning', ASSESSED: 'info', CLOSED: 'neutral' } as const

// ---- Markets (rm-markets) ------------------------------------------------------------------------------------------------

export const MARKET_LISTS = ['labelLanguages', 'docLanguages', 'userInfoLanguages', 'markings'] as const
export type MarketList = (typeof MARKET_LISTS)[number]

/** A list cell as typed: its codes, or the problem key. */
export function marketListOf(field: MarketList, text: string): { codes: string[]; problem: string | null } {
  const codes = codesOf(text, field === 'markings')
  return { codes, problem: field === 'markings' ? marksProblem(codes) : languagesProblem(codes) }
}

export interface MarketDraft {
  readonly code: string
  readonly name: string
  readonly labelLanguages: string
  readonly docLanguages: string
  readonly userInfoLanguages: string
  readonly markings: string
  readonly importerNeeded: boolean
  readonly gpsrContactNeeded: boolean
  readonly switchedOn: boolean
  readonly offReason: string
}

export const EMPTY_MARKET: MarketDraft = Object.freeze({ code: '', name: '', labelLanguages: '', docLanguages: '', userInfoLanguages: '', markings: 'CE', importerNeeded: false, gpsrContactNeeded: false, switchedOn: true, offReason: '' })

export function marketHeld(draft: MarketDraft): string | null {
  const code = draft.code.trim().toUpperCase()
  if (!MARKET_CODE.test(code) || code.length > MARKET_CODE_MAX) return 'held.marketCode'
  if (draft.name.trim() === '') return 'held.name'
  for (const field of ['labelLanguages', 'docLanguages', 'userInfoLanguages'] as const) if (languagesProblem(codesOf(draft[field]))) return 'held.languages'
  if (marksProblem(codesOf(draft.markings, true))) return 'held.markings'
  if (!draft.switchedOn) return reasonHeld(draft.offReason)
  return null
}

export const marketBodyOf = (draft: MarketDraft) => ({
  code: draft.code.trim().toUpperCase(),
  name: draft.name.trim(),
  labelLanguages: codesOf(draft.labelLanguages),
  docLanguages: codesOf(draft.docLanguages),
  userInfoLanguages: codesOf(draft.userInfoLanguages),
  markings: codesOf(draft.markings, true),
  importerNeeded: draft.importerNeeded,
  gpsrContactNeeded: draft.gpsrContactNeeded,
  switchedOn: draft.switchedOn,
  offReason: draft.switchedOn ? null : draft.offReason.trim(),
})

/** A national rule as the market dialog edits it: its words in Italian and English. */
export interface RuleDraft {
  readonly key: string
  readonly it: string
  readonly en: string
  readonly law: string
  readonly href: string
}

export const ruleDraftsOf = (market: Pick<Market, 'nationalRules'>): RuleDraft[] => market.nationalRules.map((rule) => ({ key: rule.key, it: rule.words.it ?? '', en: rule.words.en ?? '', law: rule.law ?? '', href: rule.href ?? '' }))

export function rulesHeld(rules: readonly RuleDraft[]): string | null {
  const keys = rules.map((rule) => rule.key.trim())
  if (keys.some((key) => !/^[^\s\p{Cc}]{1,60}$/u.test(key)) || new Set(keys).size !== keys.length) return 'held.ruleKey'
  if (rules.some((rule) => rule.it.trim() === '' && rule.en.trim() === '')) return 'held.ruleWords'
  if (rules.some((rule) => rule.href.trim() !== '' && !/^https:\/\/\S+$/.test(rule.href.trim()))) return 'held.link'
  return null
}

export const rulesBodyOf = (rules: readonly RuleDraft[]) =>
  rules.map((rule) => {
    const words: Record<string, string> = {}
    if (rule.it.trim()) words.it = rule.it.trim()
    if (rule.en.trim()) words.en = rule.en.trim()
    return { key: rule.key.trim(), words, ...(rule.law.trim() ? { law: rule.law.trim() } : {}), ...(rule.href.trim() ? { href: rule.href.trim() } : {}) }
  })

/** A market's words in the page's language. */
export const marketName = (market: Pick<Market, 'name' | 'nameI18n'>, locale: string): string => market.nameI18n[locale] ?? market.name

// ---- Phrases & translations (rm-phrases) ---------------------------------------------------------------------------------

export { PHRASE_KINDS }

export interface PhraseDraft {
  readonly key: string
  readonly kind: PhraseKind | null
  readonly sourceLanguage: string
  readonly sourceText: string
  readonly note: string
}

export const EMPTY_PHRASE: PhraseDraft = Object.freeze({ key: '', kind: null, sourceLanguage: 'it', sourceText: '', note: '' })

export function phraseHeld(draft: PhraseDraft): string | null {
  if (!/^[^\s\p{Cc}]{1,100}$/u.test(draft.key.trim())) return 'held.phraseKey'
  if (!draft.kind) return 'held.kind'
  if (!LANGUAGE_CODE.test(draft.sourceLanguage)) return 'held.sourceLanguage'
  if (draft.sourceText.trim() === '') return 'held.sourceText'
  return null
}

/** Why the person may not approve a cell's draft (null: they may). Never one's own words (four eyes). */
export function approveHeld(input: { readonly mayApprove: boolean; readonly draftBy: string | null; readonly me: string; readonly busy: boolean }): string | null {
  if (!input.mayApprove) return 'held.phrasesApprove'
  if (input.draftBy !== null && input.draftBy === input.me) return 'held.ownWords'
  if (input.busy) return 'held.busy'
  return null
}

/** The cell's state tone (never colour alone: the word is beside it). */
export const CELL_TONE = { SOURCE: 'neutral', APPROVED: 'success', PROPOSED: 'info', STALE: 'warning', MISSING: 'danger' } as const

/** Per phrase, how many of its language cells print (approved or the source) — the row's coverage. */
export function readyCount(phrase: Pick<Phrase, 'cells'>): { ready: number; total: number } {
  const total = phrase.cells.length
  return { ready: phrase.cells.filter((cell) => cell.state === 'APPROVED' || cell.state === 'SOURCE').length, total }
}

// ---- Operators (rm-operators) --------------------------------------------------------------------------------------------

export { OPERATOR_ROLES }

export const OPERATOR_CELLS = ['printedName', 'printedAddress', 'contact'] as const
export type OperatorCell = (typeof OPERATOR_CELLS)[number]

export function operatorCellProblem(field: OperatorCell, value: string): string | null {
  const text = value.trim()
  if (field === 'printedName') return text === '' || text.length > 200 ? 'held.printedName' : null
  if (field === 'printedAddress') return text === '' || text.length > 500 ? 'held.printedAddress' : null
  return text.length > 200 ? 'held.contact' : null
}

export const OPERATOR_SCOPES = ['STYLE', 'BRAND', 'COMPANY', 'TENANT'] as const
export type OperatorScope = (typeof OPERATOR_SCOPES)[number]

export interface OperatorDraft {
  readonly role: OperatorRole | null
  readonly scope: OperatorScope
  readonly styleId: string | null
  readonly brandPartyId: string | null
  readonly marketCode: string | null
  /** null: our company (the manufacturer only). */
  readonly partyId: string | null
  readonly printedName: string
  readonly printedAddress: string
  readonly contact: string
  readonly validFrom: string
  readonly validTo: string | null
  readonly note: string
}

export const emptyOperator = (today: string): OperatorDraft => ({ role: null, scope: 'COMPANY', styleId: null, brandPartyId: null, marketCode: null, partyId: null, printedName: '', printedAddress: '', contact: '', validFrom: today, validTo: null, note: '' })

export function operatorHeld(draft: OperatorDraft): string | null {
  if (!draft.role) return 'held.role'
  if (draft.scope === 'STYLE' && !draft.styleId) return 'held.styleId'
  if (draft.scope === 'BRAND' && !draft.brandPartyId) return 'held.brandPartyId'
  if (draft.role !== 'MANUFACTURER' && !draft.partyId) return 'held.partyId'
  if (draft.printedName.trim() === '') return 'held.printedName'
  if (draft.printedAddress.trim() === '') return 'held.printedAddress'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.validFrom)) return 'held.validFrom'
  if (draft.validTo !== null && draft.validTo < draft.validFrom) return 'held.validTo'
  return null
}

export function operatorBodyOf(draft: OperatorDraft, companyId: string | null): OperatorBody {
  return {
    role: draft.role ?? 'MANUFACTURER',
    styleId: draft.scope === 'STYLE' ? draft.styleId : null,
    brandPartyId: draft.scope === 'BRAND' ? draft.brandPartyId : null,
    companyId: draft.scope === 'COMPANY' || draft.scope === 'BRAND' ? companyId : null,
    marketCode: draft.marketCode,
    partyId: draft.partyId,
    printedName: draft.printedName.trim(),
    printedAddress: draft.printedAddress.trim(),
    contact: draft.contact.trim() || null,
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    note: draft.note.trim() || null,
  }
}

/** What an operator row applies to, as the screen words it. */
export const operatorTarget = (row: Pick<Operator, 'level' | 'style' | 'brand'>): { level: Operator['level']; label: string | null } => ({ level: row.level, label: row.style ? `${row.style.code} · ${row.style.name}` : row.brand ? `${row.brand.code} · ${row.brand.name}` : null })

// ---- live --------------------------------------------------------------------------------------------------------------

/** Which tabs a live event reads again (a hint: the screen reads, never takes data from the message). */
export function liveTabsOf(type: string): SettingsTab[] {
  if (type === 'quality.settings_changed') return ['cr6']
  if (type === 'compliance_gates.requirement_changed') return ['gates']
  if (type === 'compliance_rules.standard_changed' || type === 'compliance_rules.change_raised' || type === 'compliance_rules.change_moved') return ['regulations']
  if (type === 'compliance_rules.market_changed') return ['markets', 'phrases', 'operators', 'gates']
  if (type === 'compliance_rules.phrase_changed' || type === 'compliance_rules.translation_changed') return ['phrases', 'markets']
  if (type === 'compliance_rules.operator_changed') return ['operators']
  return []
}
