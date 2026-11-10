import {
  approveRefusal,
  CLAIM_CODE,
  CLAIM_KINDS,
  CLAIM_LIMITS,
  CLAIM_REFUSALS,
  CLAIM_SCOPES,
  CLAIM_STATES,
  earliestExpiry,
  USE_KINDS,
  wordingFindings,
  wordingOf,
  type ClaimKind,
  type ClaimScope,
  type ClaimState,
  type UseKind,
  type WordingFinding,
} from '@nexus/factory-domain/compliance/claims/rules'
import { issuePath, isApiError } from '../../../lib/api/errors'
import type { Choices, Claim, ClaimBody, ClaimRecord, CountsAnswer } from './api'

/**
 * Compliance › Sustainability › Sourcing & claims (SCR-215; B-W2b-264; design compliance.sourcing): the page's rules, pure. The
 * address ⇄ the page's state (a tile is a filter of the claims; every dialog lives in the address), the tiles, the claim's draft
 * with why its buttons are held and what it sends (factory-domain compliance/claims/rules decides what is well formed and runs
 * the wording checker: the screen and the API say the same), and the API's refusals in our words. No money.
 */

// ---- who may do what ------------------------------------------------------------------------------------------------------

export interface SourcingCan {
  readonly view: boolean
  readonly manage: boolean
  readonly approve: boolean
  /** Uploading an evidence file onto a claim (the generic files routes). */
  readonly upload: boolean
}

export const sourcingCan = (permissions: readonly string[]): SourcingCan => ({
  view: permissions.includes('compliance.certificates.view'),
  manage: permissions.includes('compliance.claims.manage'),
  approve: permissions.includes('compliance.claims.approve'),
  upload: permissions.includes('files.upload'),
})

// ---- the address ------------------------------------------------------------------------------------------------------------

/** The list's rows: current (drafts, approved, blocked), one state, or every claim. */
export const STATE_FILTERS = ['current', 'all', ...CLAIM_STATES] as const
export type StateFilter = (typeof STATE_FILTERS)[number]

/** The design's tiles that are built (LWG certificates expiring stays Later: never a tile that says nothing). */
export const TILES = ['approved', 'blocked', 'drafts'] as const
export type TileId = (typeof TILES)[number]
const TILE_STATE: Readonly<Record<TileId, ClaimState>> = { approved: 'APPROVED', blocked: 'BLOCKED', drafts: 'DRAFT' }
export const tileOfState = (state: StateFilter): TileId | null => (Object.entries(TILE_STATE).find(([, value]) => value === state)?.[0] as TileId | undefined) ?? null
export const stateOfTile = (tile: TileId): ClaimState => TILE_STATE[tile]

/** The claim window's tabs (design rec:Claim) and what it shows: the tabs, a draft's Edit, Approve, Withdraw, Add a use. */
export const CLAIM_TABS = ['wording', 'evidence', 'where', 'activity'] as const
export type ClaimTab = (typeof CLAIM_TABS)[number]
export type ClaimMode = 'view' | 'edit' | 'approve' | 'withdraw' | 'use'
const MODES: readonly ClaimMode[] = ['view', 'edit', 'approve', 'withdraw', 'use']

/**
 * `?state=current|all|DRAFT|APPROVED|BLOCKED|RETIRED&kind=<KIND>&scope=<SCOPE>&q=&open=<id>&tab=wording|evidence|where|activity
 * &do=edit|approve|withdraw|use&new=1&replaces=<id>` — the list's filters are the API's own (the export reads the same terms).
 */
export interface SourcingAddress {
  state: StateFilter
  kind: ClaimKind | null
  scope: ClaimScope | null
  q: string
  open: string | null
  tab: ClaimTab
  mode: ClaimMode
  add: boolean
  /** New claim as the replacement of this claim. */
  replaces: string | null
}

export const EMPTY_ADDRESS: SourcingAddress = { state: 'current', kind: null, scope: null, q: '', open: null, tab: 'wording', mode: 'view', add: false, replaces: null }

export function addressOf(params: { get(name: string): string | null }): SourcingAddress {
  const state = params.get('state')
  const kind = params.get('kind')
  const scope = params.get('scope')
  const tab = params.get('tab')
  const mode = params.get('do')
  return {
    state: state && (STATE_FILTERS as readonly string[]).includes(state) ? (state as StateFilter) : 'current',
    kind: kind && (CLAIM_KINDS as readonly string[]).includes(kind) ? (kind as ClaimKind) : null,
    scope: scope && (CLAIM_SCOPES as readonly string[]).includes(scope) ? (scope as ClaimScope) : null,
    q: params.get('q')?.trim().slice(0, 80) ?? '',
    open: params.get('open')?.trim() || null,
    tab: tab && (CLAIM_TABS as readonly string[]).includes(tab) ? (tab as ClaimTab) : 'wording',
    mode: mode && (MODES as readonly string[]).includes(mode) ? (mode as ClaimMode) : 'view',
    add: params.get('new') === '1',
    replaces: params.get('replaces')?.trim() || null,
  }
}

/** The address with a change: opening another claim starts on its words; closing it clears its tab and mode. */
export function withAddress(address: SourcingAddress, change: Partial<SourcingAddress>): SourcingAddress {
  const next = { ...address, ...change }
  if ('open' in change && change.open !== address.open && !('mode' in change)) next.mode = 'view'
  if ('open' in change && change.open !== address.open && !('tab' in change)) next.tab = 'wording'
  if (next.open === null) {
    next.mode = 'view'
    next.tab = 'wording'
  }
  if (!next.add) next.replaces = null
  return next
}

export function addressText(address: SourcingAddress): string {
  const params = new URLSearchParams()
  if (address.state !== 'current') params.set('state', address.state)
  if (address.kind) params.set('kind', address.kind)
  if (address.scope) params.set('scope', address.scope)
  if (address.q) params.set('q', address.q)
  if (address.open) params.set('open', address.open)
  if (address.open && address.tab !== 'wording') params.set('tab', address.tab)
  if (address.open && address.mode !== 'view') params.set('do', address.mode)
  if (address.add) params.set('new', '1')
  if (address.add && address.replaces) params.set('replaces', address.replaces)
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Whether the list shows less than the default (an empty answer is then "nothing matches", not "no claims"). */
export const isFiltered = (address: SourcingAddress): boolean => address.state !== 'current' || address.kind !== null || address.scope !== null || address.q !== ''

// ---- the tiles ----------------------------------------------------------------------------------------------------------------

export interface Tile {
  readonly id: TileId
  readonly value: number | null
}

export const tilesOf = (counts: CountsAnswer | null): Tile[] => TILES.map((id) => ({ id, value: counts ? counts[id] : null }))

// ---- words of a claim --------------------------------------------------------------------------------------------------------

/** The languages the form offers first (the company's, then English); a claim may hold others. */
export const FORM_LANGUAGES = ['it', 'en'] as const

/** The words of a claim in the page's language, else Italian, else English, else the first one. */
export function wordsIn(wording: Readonly<Record<string, string>>, locale: string): string {
  return wording[locale] ?? wording.it ?? wording.en ?? Object.values(wording)[0] ?? ''
}

/** What a claim covers, in words: the style or material's code and name, else the company. */
export const scopeText = (claim: Pick<Claim, 'scope' | 'style' | 'material'>, company: string): string =>
  claim.style ? `${claim.style.code} · ${claim.style.name}` : claim.material ? `${claim.material.code} · ${claim.material.name}` : company

/** The record types an evidence file is named by (others say "a file"). */
export const EVIDENCE_RECORDS: readonly string[] = ['SustainabilityClaim', 'Certificate', 'Lot', 'Item', 'Party', 'Style', 'Company']
/** The file categories the page has words for (every FileCategory). */
export const FILE_CATEGORIES: readonly string[] = ['DDT_PHOTO', 'POD', 'CMR', 'CARRIER_INVOICE', 'CLAIM_PHOTO', 'MACHINE_CE', 'MANUAL', 'CHECK_REPORT', 'BEFORE_WORK', 'AFTER_WORK', 'OTHER', 'SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION', 'BODY_PHOTO', 'QUESTIONNAIRE', 'PROOF', 'SAMPLE_PHOTO']

/** The pill tone of a state. */
export const STATE_TONE: Readonly<Record<ClaimState, 'neutral' | 'success' | 'danger' | 'info'>> = { DRAFT: 'info', APPROVED: 'success', BLOCKED: 'danger', RETIRED: 'neutral' }

// ---- the claim's draft (New claim, Edit, a replacement) ------------------------------------------------------------------------

export interface ClaimDraft {
  code: string
  kind: ClaimKind | ''
  /** The words per language typed (it, en and any language the claim already had). */
  wording: Record<string, string>
  phraseKey: string
  scope: ClaimScope
  styleId: string | null
  itemId: string | null
  scopeNote: string
  /** Evidence files already stored (picked or uploaded). */
  evidenceFileIds: string[]
  /** Files chosen on this device, uploaded onto the claim when it is saved (names only here: the bytes stay in the container). */
  pending: { name: string; type: string; size: number }[]
  validUntil: string
  note: string
  supersedesId: string | null
}

export const EMPTY_DRAFT: ClaimDraft = { code: '', kind: '', wording: { it: '', en: '' }, phraseKey: '', scope: 'COMPANY', styleId: null, itemId: null, scopeNote: '', evidenceFileIds: [], pending: [], validUntil: '', note: '', supersedesId: null }

/** The draft of an existing draft claim (Edit). */
export function draftOf(claim: Claim): ClaimDraft {
  return {
    code: claim.code,
    kind: claim.kind,
    wording: { it: '', en: '', ...claim.wording },
    phraseKey: claim.phraseKey ?? '',
    scope: claim.scope,
    styleId: claim.style?.id ?? null,
    itemId: claim.material?.id ?? null,
    scopeNote: claim.scopeNote ?? '',
    evidenceFileIds: claim.evidence.filter((file) => file.status !== 'DELETED' && file.status !== 'MISSING').map((file) => file.id),
    pending: [],
    validUntil: claim.validUntil ?? '',
    note: claim.note ?? '',
    supersedesId: null,
  }
}

/** A replacement of an approved, blocked or retired claim: its words and scope to start from, a new code, no evidence yet. */
export function replacementOf(claim: Claim, code: string): ClaimDraft {
  return { ...draftOf(claim), code, evidenceFileIds: [], validUntil: '', supersedesId: claim.id }
}

/** What the draft sends. */
export function bodyOf(draft: ClaimDraft): ClaimBody {
  return {
    kind: draft.kind as ClaimKind,
    wording: wordingOf(draft.wording),
    phraseKey: draft.phraseKey.trim() || null,
    scope: draft.scope,
    styleId: draft.scope === 'STYLE' ? draft.styleId : null,
    itemId: draft.scope === 'MATERIAL' ? draft.itemId : null,
    scopeNote: draft.scopeNote.trim() || null,
    evidenceFileIds: [...draft.evidenceFileIds],
    validUntil: draft.validUntil.trim() || null,
    note: draft.note.trim() || null,
  }
}

/** The checker's findings per language as typed (the same rules the API refuses with). */
export function findingsOf(draft: Pick<ClaimDraft, 'kind' | 'wording'>): Record<string, WordingFinding[]> {
  const out: Record<string, WordingFinding[]> = {}
  if (!draft.kind) return out
  for (const [language, text] of Object.entries(draft.wording)) {
    const found = wordingFindings(language, text, draft.kind)
    if (found.length > 0) out[language] = found
  }
  return out
}

export interface DraftProblem {
  readonly field: string
  /** A message key of the page (namespace compliance-sourcing). */
  readonly key: string
}

/** Why Save is held, in order (the first one is said on the button). */
export function draftProblems(draft: ClaimDraft, isNew: boolean): DraftProblem[] {
  const problems: DraftProblem[] = []
  if (isNew && !CLAIM_CODE.test(draft.code.trim())) problems.push({ field: 'code', key: 'held.code' })
  if (!draft.kind) problems.push({ field: 'kind', key: 'held.kind' })
  const words = wordingOf(draft.wording)
  if (Object.keys(words).length === 0) problems.push({ field: 'wording', key: 'held.wording' })
  if (Object.values(words).some((text) => text.length > CLAIM_LIMITS.wording || /[\r\n]/.test(text))) problems.push({ field: 'wording', key: 'held.wordingLine' })
  if (Object.values(findingsOf(draft)).some((found) => found.some((finding) => finding.severity === 'refuse'))) problems.push({ field: 'wording', key: 'held.wordingRefused' })
  if (draft.scope === 'STYLE' && !draft.styleId) problems.push({ field: 'styleId', key: 'held.style' })
  if (draft.scope === 'MATERIAL' && !draft.itemId) problems.push({ field: 'itemId', key: 'held.material' })
  if (draft.validUntil.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(draft.validUntil.trim())) problems.push({ field: 'validUntil', key: 'held.validUntil' })
  if (draft.evidenceFileIds.length + draft.pending.length > CLAIM_LIMITS.evidence) problems.push({ field: 'evidenceFileIds', key: 'held.evidenceMany' })
  return problems
}

/** Whether an Edit changed anything. */
export function draftChanged(claim: Claim, draft: ClaimDraft): boolean {
  const before = bodyOf(draftOf(claim))
  const after = bodyOf(draft)
  return JSON.stringify(before) !== JSON.stringify(after) || draft.pending.length > 0
}

/** The earliest expiry among the chosen evidence files (the form offers it as the claim's last valid day). */
export const suggestedValidUntil = (draft: Pick<ClaimDraft, 'evidenceFileIds'>, choices: Choices | null): string | null =>
  choices ? earliestExpiry(choices.files.filter((file) => draft.evidenceFileIds.includes(file.id))) : null

// ---- approve, withdraw, a use -------------------------------------------------------------------------------------------------

/** Why Approve is held (a message key), from the claim as read: the same rule the API and the database hold. */
export function approveHeld(claim: Claim, today: string, can: SourcingCan, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!can.approve || !claim.canApprove) return 'held.approve'
  if (claim.status !== 'DRAFT') return 'held.notDraft'
  const refusal = approveRefusal(
    { status: claim.status, validUntil: claim.validUntil, evidenceFileIds: claim.evidence.map((file) => file.id) },
    claim.evidence.map((file) => ({ id: file.id, status: file.status, expiresOn: file.expiresOn })),
    today,
  )
  return refusal ? `refusal.${refusal.code}` : null
}

export const withdrawHeld = (reason: string, busy: boolean): string | null => (busy ? 'held.busy' : reason.trim() === '' ? 'held.reason' : reason.trim().length > CLAIM_LIMITS.reason ? 'held.reasonLong' : null)

export interface UseDraft {
  kind: UseKind
  recordId: string | null
  label: string
  note: string
}

export const EMPTY_USE: UseDraft = { kind: 'LABEL', recordId: null, label: '', note: '' }

/** Why Add use is held (a message key). */
export function useHeld(claim: Claim, draft: UseDraft, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (claim.state === 'BLOCKED') return 'refusal.NOT_HOLDING'
  if (claim.state !== 'APPROVED') return 'refusal.NOT_APPROVED'
  if (!draft.recordId) return draft.kind === 'LABEL' ? 'held.useLabel' : 'held.useStyle'
  if ((draft.kind === 'CATALOGUE' || draft.kind === 'OTHER') && draft.label.trim() === '') return 'held.useName'
  return null
}

/** The live uses of a record read (the window's Where used, newest first), and the ended ones. */
export const liveUses = (record: ClaimRecord) => record.uses.filter((use) => use.endedAt === null)
export const endedUses = (record: ClaimRecord) => record.uses.filter((use) => use.endedAt !== null)

export { CLAIM_KINDS, CLAIM_SCOPES, USE_KINDS }

// ---- the API's answers in our words --------------------------------------------------------------------------------------------

export interface Problem {
  readonly key: string
  readonly field: string | null
  readonly unknown?: boolean
}

const REFUSALS = new Set<string>(CLAIM_REFUSALS)

export function problemOf(error: unknown): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null, unknown: true }
  let refusal: string | null = null
  let field: string | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) {
      const code = path.slice('refusal/'.length)
      if (REFUSALS.has(code) || code === 'DATABASE') refusal = code
    } else if (/^body[./]/.test(path) && !field) {
      field = path.replace(/^body[./]/, '').split(/[./]/)[0] || null
    }
  }
  if (refusal) return { key: `refusal.${refusal}`, field }
  switch (error.kind) {
    case 'invalid':
      return { key: field === 'wording' ? 'held.wordingRefused' : field ? `held.${field}` : 'problem.invalid', field }
    case 'signed_out':
      return { key: 'problem.signedOut', field: null }
    case 'forbidden':
      return { key: 'problem.forbidden', field: null }
    case 'not_found':
      return { key: 'problem.notFound', field: null }
    case 'conflict':
      return { key: 'problem.conflict', field: null }
    case 'rate_limited':
      return { key: 'problem.rateLimited', field: null }
    case 'unavailable':
      return error.code === 'network' ? { key: 'problem.noAnswer', field: null, unknown: true } : { key: 'problem.unavailable', field: null }
    default:
      return { key: 'problem.internal', field: null }
  }
}

/** A read that failed, in words (a section says it and offers Try again; never drawn as empty). */
export const readProblemOf = (error: unknown): string => {
  const problem = problemOf(error)
  return problem.key === 'problem.forbidden' || problem.key === 'problem.signedOut' || problem.key === 'problem.notFound' ? problem.key : 'problem.read'
}

/** The problem's words at a field, when it names that field. */
export const atField = (problem: Problem | null, ...fields: readonly string[]): string | null => (problem && problem.field && fields.includes(problem.field) ? problem.key : null)

// ---- live ---------------------------------------------------------------------------------------------------------------------

/** claim.changed, claim.use_changed and claim.evidence_expired (design "live: claim.evidence_expired → Status column and tile"). */
export const isClaimsChange = (change: { readonly type: string }): boolean => change.type === 'claim.changed' || change.type === 'claim.use_changed' || change.type === 'claim.evidence_expired'
