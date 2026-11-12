import type { Issue } from '../../core/errors'
import { LANGUAGE_CODE } from '../markets/rules'
import { TEMPLATE_ID as DOC_TEMPLATE_ID } from '../declarations/template'
import { TEMPLATE_ID as LEAFLET_TEMPLATE_ID } from '../user-information/template'

/**
 * The PPE text approvals (B-W2b-288, follow-up FU2:01; GATE-PPE-TEXTS, the Owner's answer to W2b-4 question 2: a PPE
 * consultant checks the generated texts once, per template; factory-db PpeTextApproval of B-W2b-275), pure.
 *
 * Three templates generate PPE texts:
 *   DOC               the Declaration of Conformity of B-W2b-257 (Annex IX): its template `annex-ix.1`, written on every
 *                     generated DoC as `content.template`
 *   USER_INFORMATION  the user information of B-W2b-258 (Annex II 1.4): `annex-ii-1.4.1`, written as `sections.template`
 *   LABEL_WARNING     a label template's class warnings (B-W2b-253, EN 17092-5 and -6): the label template's code and revision
 *
 * An approval names its template (key + version: `<key>.<version>`), the company whose texts it approves (null: every company
 * of the tenant), the languages the consultant checked, the consultant as typed and the consultant's file. It is recorded in
 * force and withdrawn once with a reason; never changed otherwise, never deleted (the database's guards).
 *
 * The gate (the database's ComplianceDocument rule, said again here so the screens and the generators say the same): a
 * generated text leaves draft only while a LIVE approval of its template covers its language and its company — an approval
 * of every company covers every company; a document of every company needs an approval of every company. With none, it stays
 * a draft, as before (the Owner's default). A text issued while an approval was live stays issued when it is withdrawn later:
 * a withdrawal stops new issues only. No money, no person but the consultant as typed.
 */

export const PPE_TEXT_KINDS = ['DOC', 'USER_INFORMATION', 'LABEL_WARNING'] as const
export type PpeTextKind = (typeof PPE_TEXT_KINDS)[number]

export const PPE_TEXT_LIMITS = Object.freeze({
  /** The template key: 1 to 80 characters without spaces (the database's `factory_bom_options_code_ok`). */
  key: 80,
  version: 9999,
  languages: 20,
  checkedBy: 300,
  reasonMin: 3,
  reason: 2000,
})

/** A template as a generated text names it: `<key>.<version>` ("annex-ix.1"). */
export const templateIdOf = (key: string, version: number): string => `${key}.${version}`

/** "annex-ii-1.4.1" → { key: "annex-ii-1.4", version: 1 }; null when it names no version. */
export function templateOfId(id: string): { readonly key: string; readonly version: number } | null {
  const dot = id.lastIndexOf('.')
  if (dot <= 0) return null
  const tail = id.slice(dot + 1)
  if (!/^[1-9]\d{0,3}$/.test(tail)) return null
  return { key: id.slice(0, dot), version: Number(tail) }
}

/** The generators' own templates, as they write them on every generated text (the label warnings name a label template). */
export const GENERATOR_TEMPLATES: Readonly<Record<'DOC' | 'USER_INFORMATION', { readonly key: string; readonly version: number; readonly id: string }>> = Object.freeze({
  DOC: { ...templateOfId(DOC_TEMPLATE_ID)!, id: DOC_TEMPLATE_ID },
  USER_INFORMATION: { ...templateOfId(LEAFLET_TEMPLATE_ID)!, id: LEAFLET_TEMPLATE_ID },
})

/** What the gate reads of an approval. */
export interface ApprovalFacts {
  readonly companyId: string | null
  readonly templateKind: PpeTextKind
  readonly templateKey: string
  readonly templateVersion: number
  readonly languages: readonly string[]
  /** null: in force. */
  readonly withdrawnAt: string | null
}

export const isLive = (approval: Pick<ApprovalFacts, 'withdrawnAt'>): boolean => approval.withdrawnAt === null

/** One generated text the gate is asked about. */
export interface TextAsk {
  readonly kind: PpeTextKind
  /** The template the text names (`content.template`, `sections.template`; a label: its code and revision); null: none. */
  readonly templateId: string | null
  /** The company of the text; null: a text of every company. */
  readonly companyId: string | null
}

/** The approval's company covers the text's: an approval of every company covers every text, a company's only its own. */
export const coversCompany = (approvalCompanyId: string | null, textCompanyId: string | null): boolean => approvalCompanyId === null || approvalCompanyId === textCompanyId

const sameTemplate = (approval: ApprovalFacts, ask: TextAsk): boolean => ask.templateId !== null && approval.templateKind === ask.kind && templateIdOf(approval.templateKey, approval.templateVersion) === ask.templateId

/** The live approval that lets one text in one language leave draft (the database's own rule), or null. */
export function approvalCovering<Approval extends ApprovalFacts>(approvals: readonly Approval[], ask: TextAsk & { readonly language: string }): Approval | null {
  return approvals.find((approval) => isLive(approval) && sameTemplate(approval, ask) && coversCompany(approval.companyId, ask.companyId) && approval.languages.includes(ask.language)) ?? null
}

/** Every language live approvals of the template cover for the text's company, in code order. */
export function languagesApproved(approvals: readonly ApprovalFacts[], ask: TextAsk): string[] {
  const out = new Set<string>()
  for (const approval of approvals) if (isLive(approval) && sameTemplate(approval, ask) && coversCompany(approval.companyId, ask.companyId)) approval.languages.forEach((language) => out.add(language))
  return [...out].sort()
}

export const PPE_GATE_STATES = ['APPROVED', 'WAITING'] as const
export type PpeGateState = (typeof PPE_GATE_STATES)[number]

export interface PpeGate<Approval> {
  /** APPROVED: a live approval covers the text (it may be issued); WAITING: it stays a draft. */
  readonly state: PpeGateState
  readonly approval: Approval | null
  /** The languages live approvals of this template cover for this company. */
  readonly languages: string[]
  /** An approval of this template and company was withdrawn and none in force covers the language. */
  readonly withdrawn: boolean
}

/** Where one generated text stands at GATE-PPE-TEXTS. */
export function ppeGateOf<Approval extends ApprovalFacts>(approvals: readonly Approval[], ask: TextAsk & { readonly language: string }): PpeGate<Approval> {
  const approval = approvalCovering(approvals, ask)
  const withdrawn = approval === null && approvals.some((entry) => !isLive(entry) && sameTemplate(entry, ask) && coversCompany(entry.companyId, ask.companyId) && entry.languages.includes(ask.language))
  return { state: approval ? 'APPROVED' : 'WAITING', approval, languages: languagesApproved(approvals, ask), withdrawn }
}

/** The languages of a label not yet covered by a live approval of its class warnings (none: the label's texts are approved). */
export const languagesWaiting = (approved: readonly string[], asked: readonly string[]): string[] => asked.filter((language) => !approved.includes(language))

// ---- recording and withdrawing --------------------------------------------------------------------------------------------

export interface ApprovalDraft {
  readonly templateKind?: string | null | undefined
  readonly templateKey?: string | null | undefined
  readonly templateVersion?: number | null | undefined
  readonly languages?: readonly string[] | null | undefined
  readonly checkedBy?: string | null | undefined
}

/** "IT, en ,it" → ['it', 'en'] (trimmed, lower case, each once, in the order given). */
export const normaliseLanguages = (languages: readonly string[]): string[] => [...new Set(languages.map((language) => language.trim().toLowerCase()).filter((language) => language !== ''))]

/** The consultant as typed, on one line (trimmed). */
export const normaliseCheckedBy = (text: string): string => text.trim()

/**
 * Every problem of a new approval, in words (paths `body/<field>`): the kind; the template — the generator's own for a DoC or
 * the user information (`annex-ix` 1, `annex-ii-1.4` 1), a label template's code and revision for the class warnings (that the
 * label exists is the caller's read) —; the languages ISO 639, each once, 1 to 20; the consultant 1 to 300 characters on one
 * line. The database holds the same rules (and that the file is an AVAILABLE file of the company).
 */
export function recordProblems(draft: ApprovalDraft): Issue[] {
  const problems: Issue[] = []
  const kind = draft.templateKind ?? null
  if (!kind || !(PPE_TEXT_KINDS as readonly string[]).includes(kind)) problems.push({ path: 'body/templateKind', message: 'Which texts: the declaration of conformity, the user information or a label’s class warnings.' })
  const key = (draft.templateKey ?? '').trim()
  const version = draft.templateVersion ?? null
  if (key === '' || key.length > PPE_TEXT_LIMITS.key || /[\s\p{Cc}]/u.test(key)) problems.push({ path: 'body/templateKey', message: `The template: 1 to ${PPE_TEXT_LIMITS.key} characters without spaces.` })
  if (version === null || !Number.isInteger(version) || version < 1 || version > PPE_TEXT_LIMITS.version) problems.push({ path: 'body/templateVersion', message: `The template’s version: a whole number from 1 to ${PPE_TEXT_LIMITS.version}.` })
  if (kind === 'DOC' || kind === 'USER_INFORMATION') {
    const own = GENERATOR_TEMPLATES[kind]
    if (key !== '' && version !== null && templateIdOf(key, version) !== own.id) problems.push({ path: 'body/templateKey', message: `The ${kind === 'DOC' ? 'declaration' : 'user information'} generator writes template ${own.key} version ${own.version}: that is the one a consultant checks.` })
  }
  const languages = draft.languages ?? []
  const normal = normaliseLanguages(languages)
  if (normal.length === 0 || normal.length > PPE_TEXT_LIMITS.languages) problems.push({ path: 'body/languages', message: `The languages the consultant checked: 1 to ${PPE_TEXT_LIMITS.languages}.` })
  else if (normal.length !== languages.length) problems.push({ path: 'body/languages', message: 'Each language once.' })
  normal.forEach((language, index) => {
    if (!LANGUAGE_CODE.test(language)) problems.push({ path: `body/languages/${index}`, message: `"${language}" is not a language code (ISO 639: "it", "en", "de").` })
  })
  const checkedBy = normaliseCheckedBy(draft.checkedBy ?? '')
  if (checkedBy === '' || checkedBy.length > PPE_TEXT_LIMITS.checkedBy || /[\r\n\p{Cc}]/u.test(checkedBy)) problems.push({ path: 'body/checkedBy', message: `Who checked the texts (the consultant’s name and firm): 1 to ${PPE_TEXT_LIMITS.checkedBy} characters on one line.` })
  return problems
}

/** A label template's class warnings are approved by its company's approval, or by one of every company for a tenant-wide label. */
export const labelFitsApproval = (labelCompanyId: string | null, approvalCompanyId: string | null): boolean => labelCompanyId === null || labelCompanyId === approvalCompanyId

/** Why a withdrawal is refused, in words (paths `body/reason`), or none. */
export function withdrawProblems(reason: string | null | undefined): Issue[] {
  const words = (reason ?? '').trim()
  if (words.length < PPE_TEXT_LIMITS.reasonMin || words.length > PPE_TEXT_LIMITS.reason) return [{ path: 'body/reason', message: `Say why it is withdrawn: ${PPE_TEXT_LIMITS.reasonMin} to ${PPE_TEXT_LIMITS.reason} characters.` }]
  return []
}

/** The template as people read it ("Declaration of conformity annex-ix · version 1", "Label SEED-LBL-JKT-02 · revision 1"). */
export function templateWords(kind: PpeTextKind, key: string, version: number): string {
  if (kind === 'LABEL_WARNING') return `the class warnings of label ${key} revision ${version}`
  return `${kind === 'DOC' ? 'the declaration of conformity' : 'the user information'} template ${key} version ${version}`
}
