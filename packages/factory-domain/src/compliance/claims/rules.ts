import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * Sourcing & claims (B-W2b-264; PRD-380; design compliance.sourcing, SCR-215), pure. The sustainability claims register on
 * B-W2b-222's tables (recall.prisma SustainabilityClaim, ClaimUse): every environmental claim the company makes, with its
 * words per language, what it covers (the company, one style or one material, and in words which part), the files that
 * prove it, until when that evidence holds, and its approval before use; where each claim is used (labels, styles,
 * catalogues, web shop texts). Dir. (EU) 2024/825 (from 27 September 2026): a claim needs its evidence; generic claims
 * ("eco-friendly") and claims of neutrality through offsetting are not allowed.
 *
 *   DRAFT      written, not usable yet: the words, the scope and the evidence may still change
 *   APPROVED   approved by a person with a fresh code, with at least one evidence file and evidence that still holds;
 *              never changes again but its withdrawal (a changed claim is a new one that replaces it)
 *   BLOCKED    a reading, not a status: APPROVED, but its evidence no longer holds (the claim's last valid day passed, an
 *              evidence file expired or is gone). It flags itself and every place it is still used.
 *   RETIRED    WITHDRAWN: with when and why; its uses end with it
 *
 * The wording checker (`wordingFindings`) refuses generic and offsetting claims with the reason and offers wording that
 * says what is better (design pop:sc-new; PRD-361's example "Leather from a tannery rated by LWG" instead of "LWG certified
 * jacket"). The screen and the API run the same rules. No person, no money.
 */

export const CLAIM_KINDS = ['RECYCLED_CONTENT', 'ORGANIC_CONTENT', 'BIO_BASED', 'RESPONSIBLE_SOURCING', 'SUBSTANCE_FREE', 'DURABILITY', 'REPAIRABILITY', 'CARBON', 'SOCIAL', 'CERTIFICATION_LABEL', 'OTHER'] as const
export type ClaimKind = (typeof CLAIM_KINDS)[number]

export const CLAIM_SCOPES = ['COMPANY', 'STYLE', 'MATERIAL'] as const
export type ClaimScope = (typeof CLAIM_SCOPES)[number]

export const CLAIM_STATUSES = ['DRAFT', 'APPROVED', 'WITHDRAWN'] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

/** What a person reads: the status, with APPROVED split by whether its evidence still holds. */
export const CLAIM_STATES = ['DRAFT', 'APPROVED', 'BLOCKED', 'RETIRED'] as const
export type ClaimState = (typeof CLAIM_STATES)[number]

export const USE_KINDS = ['LABEL', 'STYLE', 'CATALOGUE', 'WEB_SHOP', 'OTHER'] as const
export type UseKind = (typeof USE_KINDS)[number]

/** The record a use names: a label template for LABEL, a style for the others (its texts, its catalogue page, its web shop page). */
export const useRecordTypeOf = (kind: UseKind): 'LabelTemplate' | 'Style' => (kind === 'LABEL' ? 'LabelTemplate' : 'Style')

/** Why an approved claim no longer holds. */
export const BLOCK_CAUSES = ['VALID_UNTIL', 'FILE_EXPIRED', 'FILE_GONE'] as const
export type BlockCause = (typeof BLOCK_CAUSES)[number]

export const CLAIM_LIMITS = {
  code: 60,
  wording: 1000,
  scopeNote: 1000,
  note: 2000,
  reason: 500,
  evidence: 50,
  label: 200,
  phraseKey: 100,
  languages: 12,
  list: 500,
  choices: 200,
} as const

/** The database's code rule: a letter or digit, then letters, digits, ".", "_" or "-" (up to 60). */
export const CLAIM_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/
/** A language tag (BCP 47) as the database takes it: "it", "en", "de-CH". */
export const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const PHRASE_KEY = /^[^\s\p{Cc}]{1,100}$/u
const CONTROL = /[\u0000-\u001f\u007f]/
const CONTROL_IN_TEXT = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** The law the page cites (LawRef). */
export const CLAIMS_LAW = 'Dir. (EU) 2024/825'
export const GENERIC_LAW = 'Dir. (EU) 2024/825, Annex I 4a'
export const OFFSET_LAW = 'Dir. (EU) 2024/825, Annex I 4c'
export const LABEL_LAW = 'Dir. (EU) 2024/825, Annex I 2a'

/** The ValidityBar's thresholds, in days before the last valid day (design part ValidityBar: 180 / 90 / 30). */
export const VALIDITY_THRESHOLDS = [180, 90, 30] as const

/** The prefix of the codes the register suggests ("CL-0004"). */
export const CODE_PREFIX = 'CL-'

// ---- days ------------------------------------------------------------------------------------------------------------------

const dayNumber = (day: BusinessDate): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000

/** The day `days` after `day`. */
export function addDays(day: BusinessDate, days: number): BusinessDate {
  return new Date((dayNumber(day) + days) * 86_400_000).toISOString().slice(0, 10)
}

/** Whole days from `today` to `day` (negative: past). */
export const daysUntil = (day: BusinessDate, today: BusinessDate): number => Math.round(dayNumber(day) - dayNumber(today))

/** Where a validity stands: no end, fine, inside a threshold (the smallest reached), or past. */
export interface Validity {
  readonly state: 'NONE' | 'OK' | 'SOON' | 'EXPIRED'
  readonly daysLeft: number | null
  /** The smallest threshold reached (180, 90, 30), when SOON. */
  readonly threshold: number | null
}

export function validityOf(until: BusinessDate | null, today: BusinessDate): Validity {
  if (until === null) return { state: 'NONE', daysLeft: null, threshold: null }
  const daysLeft = daysUntil(until, today)
  if (daysLeft < 0) return { state: 'EXPIRED', daysLeft, threshold: null }
  const reached = [...VALIDITY_THRESHOLDS].sort((a, b) => a - b).find((threshold) => daysLeft <= threshold) ?? null
  return { state: reached === null ? 'OK' : 'SOON', daysLeft, threshold: reached }
}

// ---- what a claim's evidence says ----------------------------------------------------------------------------------------

/** An evidence file as a claim reads it: its state and the day it stops being valid (StoredFile.expiresOn). */
export interface EvidenceFact {
  readonly id: string
  readonly status: 'PENDING_UPLOAD' | 'AVAILABLE' | 'QUARANTINED' | 'DELETED' | 'MISSING'
  readonly expiresOn: BusinessDate | null
}

export interface BlockReason {
  readonly cause: BlockCause
  /** The evidence file at fault (FILE_EXPIRED, FILE_GONE). */
  readonly fileId: string | null
  /** The last valid day that passed (VALID_UNTIL, FILE_EXPIRED). */
  readonly day: BusinessDate | null
}

/** Why the evidence of a claim no longer holds today (empty: it holds). Read for an APPROVED claim. */
export function blockReasons(claim: { readonly validUntil: BusinessDate | null; readonly evidenceFileIds: readonly string[] }, files: readonly EvidenceFact[], today: BusinessDate): BlockReason[] {
  const reasons: BlockReason[] = []
  if (claim.validUntil !== null && claim.validUntil < today) reasons.push({ cause: 'VALID_UNTIL', fileId: null, day: claim.validUntil })
  for (const id of claim.evidenceFileIds) {
    const file = files.find((entry) => entry.id === id)
    if (!file || file.status !== 'AVAILABLE') reasons.push({ cause: 'FILE_GONE', fileId: id, day: null })
    else if (file.expiresOn !== null && file.expiresOn < today) reasons.push({ cause: 'FILE_EXPIRED', fileId: id, day: file.expiresOn })
  }
  return reasons
}

/** What a person reads of a claim today. */
export function claimStateOf(claim: { readonly status: ClaimStatus; readonly validUntil: BusinessDate | null; readonly evidenceFileIds: readonly string[] }, files: readonly EvidenceFact[], today: BusinessDate): ClaimState {
  if (claim.status === 'DRAFT') return 'DRAFT'
  if (claim.status === 'WITHDRAWN') return 'RETIRED'
  return blockReasons(claim, files, today).length > 0 ? 'BLOCKED' : 'APPROVED'
}

/**
 * The first day a claim stopped holding (the day after the earliest last valid day that passed), or `gone` when a file is
 * no longer there: the expiry job's key, so it says so once per cause.
 */
export function blockedSince(reasons: readonly BlockReason[]): string | null {
  if (reasons.length === 0) return null
  const days = reasons.filter((reason) => reason.day !== null).map((reason) => addDays(reason.day!, 1)).sort()
  return days[0] ?? 'gone'
}

/** The earliest last valid day among the evidence files (the form offers it as the claim's own). */
export function earliestExpiry(files: readonly { readonly expiresOn: BusinessDate | null }[]): BusinessDate | null {
  const days = files.map((file) => file.expiresOn).filter((day): day is BusinessDate => day !== null).sort()
  return days[0] ?? null
}

// ---- the wording checker ---------------------------------------------------------------------------------------------------

export const FINDING_CODES = ['GENERIC', 'OFFSETTING', 'CERTIFIED_PRODUCT', 'NO_SHARE'] as const
export type FindingCode = (typeof FINDING_CODES)[number]

/** One thing the checker found in the words of one language: refused (the claim cannot be saved so) or advice. */
export interface WordingFinding {
  readonly code: FindingCode
  readonly severity: 'refuse' | 'advise'
  /** The words it matched, as typed. */
  readonly words: string
  readonly law: string
  /** Wording that says the same within the law, in this language (null: none to offer). */
  readonly suggestion: string | null
}

interface Pattern {
  readonly code: FindingCode
  readonly re: RegExp
}

// Generic environmental claims (Annex I 4a): words that say "good for the environment" without saying what is better.
const GENERIC_EN = /\b(eco[- ]?friendly|environment(?:ally)?[- ]friendly|planet[- ]friendly|nature[- ]friendly|earth[- ]friendly|climate[- ]friendly|good for the (?:planet|environment)|green|eco|sustainable|sustainably made|conscious|kind to the planet)\b/i
const GENERIC_IT = /(eco[- ]?friendly|ecologic[oaie]|eco[- ]?compatibil[ei]|eco[- ]?sostenibil[ei]|rispettos[oaie] dell'ambiente|amic[oaie] dell'ambiente|amic[oaie] del pianeta|buon[oaie]? per il pianeta|\bgreen\b|\bverd[ei]\b|\bsostenibil[ei]\b|\bconsapevol[ei]\b)/i
// Neutral or reduced impact through offsetting (Annex I 4c).
const OFFSET_EN = /\b(climate[- ]neutral|carbon[- ]neutral|co2[- ]neutral|co₂[- ]neutral|net[- ]zero|climate[- ]positive|carbon[- ]positive|zero[- ]emissions?|carbon[- ]offset|offset)\b/i
const OFFSET_IT = /(neutral[ei] per il clima|a impatto zero|impatto climatico zero|carbon[- ]neutral|co2[- ]neutral[ei]|co₂[- ]neutral[ei]|a emissioni zero|emissioni compensate|compensat[oaie])/i
// A product said to be certified by a scheme that rates the maker (LWG rates tanneries, not jackets).
const CERTIFIED_EN = /\b(lwg[- ]certified|certified (?:by )?lwg|leather working group certified)\b/i
const CERTIFIED_IT = /(certificat[oaie] lwg|lwg certificat[oaie])/i

const PATTERNS: Readonly<Record<'en' | 'it', readonly Pattern[]>> = {
  en: [
    { code: 'OFFSETTING', re: OFFSET_EN },
    { code: 'CERTIFIED_PRODUCT', re: CERTIFIED_EN },
    { code: 'GENERIC', re: GENERIC_EN },
  ],
  it: [
    { code: 'OFFSETTING', re: OFFSET_IT },
    { code: 'CERTIFIED_PRODUCT', re: CERTIFIED_IT },
    { code: 'GENERIC', re: GENERIC_IT },
  ],
}

/** Wording that says what is better, per kind and language (the checker offers it in place of a refused claim). */
export const SUGGESTIONS: Readonly<Record<ClaimKind, Readonly<Record<'en' | 'it', string>>>> = {
  RECYCLED_CONTENT: { en: 'Lining made with 50 % recycled polyester', it: 'Fodera in poliestere riciclato al 50 %' },
  ORGANIC_CONTENT: { en: 'Made with 100 % organic cotton lining', it: 'Fodera in cotone biologico al 100 %' },
  BIO_BASED: { en: 'Outer shell made with 30 % bio-based polyamide', it: 'Tessuto esterno in poliammide al 30 % di origine biologica' },
  RESPONSIBLE_SOURCING: { en: 'Leather from a tannery rated by LWG', it: 'Pelle da una conceria valutata LWG' },
  SUBSTANCE_FREE: { en: 'Made without PFAS', it: 'Realizzato senza PFAS' },
  DURABILITY: { en: 'Seams tested for 5 years of use', it: 'Cuciture testate per 5 anni di uso' },
  REPAIRABILITY: { en: 'Spare protectors and zips available for 5 years', it: 'Protezioni e cerniere di ricambio disponibili per 5 anni' },
  CARBON: { en: 'Made with 40 % less energy than our 2024 jacket, measured at our plant', it: 'Prodotta con il 40 % di energia in meno della giacca 2024, misurata nel nostro stabilimento' },
  SOCIAL: { en: 'Sewn in our own factory in Italy', it: 'Cucita nel nostro stabilimento in Italia' },
  CERTIFICATION_LABEL: { en: 'Leather from a tannery rated by LWG', it: 'Pelle da una conceria valutata LWG' },
  OTHER: { en: 'Say what is better and by how much', it: 'Dite che cosa è migliore e di quanto' },
}

/** The language family the checker knows ("it-CH" → "it"); others are not checked (null). */
const familyOf = (language: string): 'en' | 'it' | null => {
  const base = language.toLowerCase().split('-')[0]
  return base === 'en' || base === 'it' ? base : null
}

/** Content claims (recycled, organic, bio-based) say how much: a share in percent. */
const SHARE = /\d\s?%|\bper ?cento\b|\bpercent\b/i
const CONTENT_KINDS: readonly ClaimKind[] = ['RECYCLED_CONTENT', 'ORGANIC_CONTENT', 'BIO_BASED']

/**
 * The checker for the words of one language: generic claims and offsetting claims are refused, a product "certified" by a
 * scheme that rates its maker is refused with the wording that is allowed, a content claim without its share is advised.
 * The words are matched as typed, case and accents kept in the finding.
 */
export function wordingFindings(language: string, text: string, kind: ClaimKind): WordingFinding[] {
  const family = familyOf(language)
  const findings: WordingFinding[] = []
  const words = text.trim()
  if (!family || words === '') return findings
  for (const pattern of PATTERNS[family]) {
    const match = pattern.re.exec(words)
    if (!match) continue
    const law = pattern.code === 'OFFSETTING' ? OFFSET_LAW : pattern.code === 'CERTIFIED_PRODUCT' ? LABEL_LAW : GENERIC_LAW
    const suggestion = pattern.code === 'CERTIFIED_PRODUCT' ? SUGGESTIONS.RESPONSIBLE_SOURCING[family] : SUGGESTIONS[kind][family]
    findings.push({ code: pattern.code, severity: 'refuse', words: match[0], law, suggestion })
  }
  if (CONTENT_KINDS.includes(kind) && !SHARE.test(words)) findings.push({ code: 'NO_SHARE', severity: 'advise', words, law: CLAIMS_LAW, suggestion: SUGGESTIONS[kind][family] })
  return findings
}

/** Every language's findings ({ it: [...], en: [...] }), only the languages with one. */
export function wordingCheck(wording: Readonly<Record<string, string>>, kind: ClaimKind): Record<string, WordingFinding[]> {
  const out: Record<string, WordingFinding[]> = {}
  for (const [language, text] of Object.entries(wording)) {
    const found = wordingFindings(language, text, kind)
    if (found.length > 0) out[language] = found
  }
  return out
}

/** Whether any language holds a refused finding. */
export const wordingRefused = (wording: Readonly<Record<string, string>>, kind: ClaimKind): boolean =>
  Object.values(wordingCheck(wording, kind)).some((found) => found.some((finding) => finding.severity === 'refuse'))

// ---- a claim as typed ------------------------------------------------------------------------------------------------------

export interface ClaimInput {
  readonly code: string
  readonly kind: ClaimKind
  readonly wording: Readonly<Record<string, string>>
  readonly phraseKey: string | null
  readonly scope: ClaimScope
  readonly styleId: string | null
  readonly itemId: string | null
  readonly scopeNote: string | null
  readonly evidenceFileIds: readonly string[]
  readonly validUntil: BusinessDate | null
  readonly note: string | null
}

const oneLine = (text: string, longest: number): boolean => text.trim() !== '' && text.length <= longest && !CONTROL.test(text)
const lines = (text: string | null, longest: number): boolean => text === null || (text.trim() !== '' && text.length <= longest && !CONTROL_IN_TEXT.test(text))

/** What is wrong with a claim as typed (paths without `body/`), the database's rules in words, and the checker's refusals. */
export function claimProblems(input: ClaimInput): Issue[] {
  const problems: Issue[] = []
  if (!CLAIM_CODE.test(input.code)) problems.push({ path: 'code', message: 'A code is a letter or digit, then letters, digits, ".", "_" or "-" (up to 60).' })
  if (!(CLAIM_KINDS as readonly string[]).includes(input.kind)) problems.push({ path: 'kind', message: 'Choose what kind of claim it is.' })
  const languages = Object.keys(input.wording)
  if (languages.length === 0) problems.push({ path: 'wording', message: 'Write the claim in at least one language.' })
  if (languages.length > CLAIM_LIMITS.languages) problems.push({ path: 'wording', message: `At most ${CLAIM_LIMITS.languages} languages.` })
  for (const language of languages) {
    const text = input.wording[language] ?? ''
    if (!LANGUAGE_TAG.test(language)) problems.push({ path: `wording.${language}`, message: 'A language is a tag like "it", "en" or "de-CH".' })
    else if (!oneLine(text, CLAIM_LIMITS.wording)) problems.push({ path: `wording.${language}`, message: `The claim is one line of 1 to ${CLAIM_LIMITS.wording} characters.` })
    else {
      const refused = wordingFindings(language, text, input.kind).find((finding) => finding.severity === 'refuse')
      if (refused) problems.push({ path: `wording.${language}`, message: refusalWords(refused) })
    }
  }
  if (input.phraseKey !== null && !PHRASE_KEY.test(input.phraseKey)) problems.push({ path: 'phraseKey', message: 'A phrase is named by its key (no spaces, up to 100).' })
  if (input.scope === 'STYLE' && !input.styleId) problems.push({ path: 'styleId', message: 'Choose the style the claim covers.' })
  if (input.scope === 'MATERIAL' && !input.itemId) problems.push({ path: 'itemId', message: 'Choose the material the claim covers.' })
  if (input.scope !== 'STYLE' && input.styleId) problems.push({ path: 'styleId', message: 'Only a claim about one style names a style.' })
  if (input.scope !== 'MATERIAL' && input.itemId) problems.push({ path: 'itemId', message: 'Only a claim about one material names a material.' })
  if (!lines(input.scopeNote, CLAIM_LIMITS.scopeNote)) problems.push({ path: 'scopeNote', message: `Which part it covers, in up to ${CLAIM_LIMITS.scopeNote} characters.` })
  if (!lines(input.note, CLAIM_LIMITS.note)) problems.push({ path: 'note', message: `A note of up to ${CLAIM_LIMITS.note} characters.` })
  if (new Set(input.evidenceFileIds).size !== input.evidenceFileIds.length) problems.push({ path: 'evidenceFileIds', message: 'Each evidence file once.' })
  if (input.evidenceFileIds.length > CLAIM_LIMITS.evidence) problems.push({ path: 'evidenceFileIds', message: `At most ${CLAIM_LIMITS.evidence} evidence files.` })
  if (input.validUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil)) problems.push({ path: 'validUntil', message: 'A day (YYYY-MM-DD).' })
  return problems
}

/** A refused finding in one sentence (the API's English; the screens say their own words by code). */
export function refusalWords(finding: WordingFinding): string {
  const offer = finding.suggestion ? ` Say what is better instead, for example: "${finding.suggestion}".` : ''
  if (finding.code === 'OFFSETTING') return `"${finding.words}": a claim of neutral or reduced impact through offsetting is not allowed (${finding.law}).${offer}`
  if (finding.code === 'CERTIFIED_PRODUCT') return `"${finding.words}": LWG rates the tannery, not the garment (${finding.law}).${offer}`
  return `"${finding.words}" is a generic environmental claim, not allowed without proof of excellent performance (${finding.law}).${offer}`
}

// ---- what a command may do ---------------------------------------------------------------------------------------------------

export const CLAIM_REFUSALS = [
  'NOT_DRAFT',
  'NOT_APPROVED',
  'ALREADY_WITHDRAWN',
  'NO_EVIDENCE',
  'EVIDENCE_NOT_AVAILABLE',
  'EVIDENCE_EXPIRED',
  'EVIDENCE_OTHER_COMPANY',
  'VALID_UNTIL_PAST',
  'CODE_TAKEN',
  'STYLE_OTHER_COMPANY',
  'MATERIAL_NOT_ALLOWED',
  'PHRASE_UNKNOWN',
  'REPLACES_OTHER',
  'ALREADY_REPLACED',
  'NOT_HOLDING',
  'USE_TAKEN',
  'USE_RECORD',
  'USE_ENDED',
  'WORDING_REFUSED',
] as const
export type ClaimRefusal = (typeof CLAIM_REFUSALS)[number]

export interface Refusal {
  readonly code: ClaimRefusal
  readonly message: string
  readonly field?: string
}

/**
 * Why a draft cannot be approved today (null: it can): at least one evidence file, every one available and not expired,
 * and its last valid day today or later (Dir. (EU) 2024/825: a claim needs its evidence).
 */
export function approveRefusal(claim: { readonly status: ClaimStatus; readonly validUntil: BusinessDate | null; readonly evidenceFileIds: readonly string[] }, files: readonly EvidenceFact[], today: BusinessDate): Refusal | null {
  if (claim.status !== 'DRAFT') return { code: 'NOT_DRAFT', message: 'Only a draft claim is approved; an approved claim never changes (a changed claim is a new one that replaces it).' }
  if (claim.evidenceFileIds.length === 0) return { code: 'NO_EVIDENCE', message: 'A claim is approved with its evidence: add at least one file that proves it.', field: 'evidenceFileIds' }
  const reasons = blockReasons(claim, files, today)
  const gone = reasons.find((reason) => reason.cause === 'FILE_GONE')
  if (gone) return { code: 'EVIDENCE_NOT_AVAILABLE', message: 'Every evidence file must be uploaded and available before the claim is approved.', field: 'evidenceFileIds' }
  const expired = reasons.find((reason) => reason.cause === 'FILE_EXPIRED')
  if (expired) return { code: 'EVIDENCE_EXPIRED', message: `An evidence file expired on ${expired.day}: add a valid one first.`, field: 'evidenceFileIds' }
  if (reasons.some((reason) => reason.cause === 'VALID_UNTIL')) return { code: 'VALID_UNTIL_PAST', message: `The evidence held until ${claim.validUntil}: a claim is not approved after its evidence expired.`, field: 'validUntil' }
  return null
}

/** Why a use cannot be added (null: it can): the claim is APPROVED and its evidence holds today. */
export function useRefusal(state: ClaimState): Refusal | null {
  if (state === 'APPROVED') return null
  if (state === 'BLOCKED') return { code: 'NOT_HOLDING', message: 'The evidence of this claim no longer holds: it may not be used anywhere new until a replacement is approved.' }
  return { code: 'NOT_APPROVED', message: 'A claim is used only once it is approved.' }
}

/** The next free code of the register ("CL-0004"), after the highest CL- number in use. */
export function nextCode(codes: readonly string[]): string {
  const numbers = codes.map((code) => /^CL-(\d+)$/i.exec(code)?.[1]).filter((value): value is string => value !== undefined).map(Number)
  const next = (numbers.length > 0 ? Math.max(...numbers) : 0) + 1
  return `${CODE_PREFIX}${String(next).padStart(4, '0')}`
}

/** A wording as stored: the languages typed, trimmed; blank ones dropped. */
export function wordingOf(input: Readonly<Record<string, string | null | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [language, text] of Object.entries(input)) {
    const words = (text ?? '').trim()
    if (words !== '') out[language.trim()] = words
  }
  return out
}
