import { DOCUMENT_LAYOUTS, optionalColumnsOf } from '@nexus/factory-domain/documents/layouts'
import { placeholderSyntaxOk, placeholdersIn } from '@nexus/factory-domain/templates/placeholders'
import { TEMPLATE_REFUSALS } from '@nexus/factory-domain/templates/refusals'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { problemKey } from '../../shared/model'
import type { ColumnKey, DocumentKind, DocumentTemplate, DocumentTemplateKind, TemplateStatus } from '../doc-templates/api'
import type { EmailTemplate } from '../mail-templates/api'

/**
 * The template editor's rules (B-W2b-432; design admin.documents pop:template-editor "Template: Quote (Italiano)", the
 * builder page, and the e-mail templates' "Edit with placeholders and a preview on a sample record"): the draft a person
 * types, what changed, the problems of the words in this web's words (the same rules as factory-domain's
 * documentTemplateProblems / emailTemplateProblems: a broken placeholder, a name the template does not offer, too long),
 * what each button waits for, and a refusal of the API said by its code. Pure: the containers read and write, the views draw.
 */

/** Every key here is a key of `admin-templates` (else of `admin`: the shared problems). */
export type WordKey = string
export interface Said {
  key: WordKey
  params?: Readonly<Record<string, string | number>>
}

// ── words of a template: the problems ────────────────────────────────────────────────────────────────────────────────

/** The problems of one text field, in order: too long first (the rest is not read), a broken placeholder, an unknown name. */
export function wordProblems(text: string, limit: number, offered: readonly string[]): Said[] {
  if (text.length > limit) return [{ key: 'tpl.problem.tooLong', params: { limit, over: text.length - limit } }]
  if (!placeholderSyntaxOk(text)) return [{ key: 'tpl.problem.syntax' }]
  return placeholdersIn(text)
    .filter((name) => !offered.includes(name))
    .map((name) => ({ key: 'tpl.problem.notOffered', params: { name: `{{${name}}}` } }))
}

/** `{{name}}`, as a placeholder is written. */
export const placeholderToken = (name: string) => `{{${name}}}`

/** The text with `token` put at the caret (`at` = the selection), and where the caret goes after it. */
export function insertAt(text: string, token: string, at: { start: number; end: number } | null): { text: string; caret: number } {
  const start = at ? Math.max(0, Math.min(at.start, text.length)) : text.length
  const end = at ? Math.max(start, Math.min(at.end, text.length)) : text.length
  return { text: text.slice(0, start) + token + text.slice(end), caret: start + token.length }
}

// ── the API's refusals ───────────────────────────────────────────────────────────────────────────────────────────────

/** A refused write in words: `refusal/<CODE>` (409) by its code, a stale version, no right, else the shared problem. */
export function refusalOf(error: unknown): Said {
  if (isApiError(error)) {
    const code = error.issues.map(issuePath).find((path) => path.startsWith('refusal/') || path.startsWith('refusal.'))?.slice('refusal/'.length)
    if (code && (TEMPLATE_REFUSALS as readonly string[]).includes(code)) return { key: `tpl.refusal.${code}` }
    if (error.kind === 'conflict') return { key: 'tpl.problem.stale' }
    if (error.kind === 'forbidden') return { key: 'tpl.problem.noRight' }
    if (error.kind === 'invalid') return { key: 'tpl.problem.invalid' }
  }
  return { key: problemKey(error) }
}

/** A 409 (a stale version, another version published meanwhile, a draft already open): the page reads again. */
export const refusalReloads = (error: unknown): boolean => isApiError(error) && error.kind === 'conflict'

// ── a document template's draft ──────────────────────────────────────────────────────────────────────────────────────

export interface DocumentDraft {
  header: string
  terms: string
  footer: string
  /** The optional columns shown, in the layout's order. */
  fieldsShown: readonly string[]
}

/**
 * The draft of a saved version: its words as written, and its optional columns WITHOUT a key the kind's layout lacks (the
 * API refuses one when writing or publishing; the editor drops it, says so, and offers the save).
 */
export const documentDraftOf = (template: Pick<DocumentTemplate, 'kind' | 'header' | 'terms' | 'footer' | 'fieldsShown'>): DocumentDraft => ({
  header: template.header ?? '',
  terms: template.terms ?? '',
  footer: template.footer ?? '',
  fieldsShown: template.fieldsShown.filter((key) => (optionalColumnsOf(template.kind) as string[]).includes(key)),
})

/** The keys a saved version lists that its kind's layout does not have as an optional column (dropped by the draft). */
export const droppedColumns = (template: Pick<DocumentTemplate, 'kind' | 'fieldsShown'>): string[] => template.fieldsShown.filter((key) => !(optionalColumnsOf(template.kind) as string[]).includes(key))

/** The columns of a kind's layout in its order, each mandatory (always printed) or optional (shown or left out). */
export function layoutColumns(kind: DocumentTemplateKind, info: Pick<DocumentKind, 'mandatoryColumns' | 'optionalColumns'> | null): Array<{ key: ColumnKey; mandatory: boolean }> {
  const order = DOCUMENT_LAYOUTS[kind].columns.map((column) => column.key)
  const mandatory = new Set<string>(info?.mandatoryColumns ?? [])
  const optional = new Set<string>(info?.optionalColumns ?? [])
  return order.filter((key) => mandatory.has(key) || optional.has(key)).map((key) => ({ key, mandatory: mandatory.has(key) }))
}

/** The optional columns shown after one is ticked or unticked, kept in the layout's order. */
export function toggleColumn(kind: DocumentTemplateKind, shown: readonly string[], key: string, on: boolean): string[] {
  const set = new Set(shown)
  if (on) set.add(key)
  else set.delete(key)
  return DOCUMENT_LAYOUTS[kind].columns.map((column) => column.key as string).filter((column) => set.has(column))
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index])

/** What differs from the saved version (the words as sent: '' is "none"; the columns as saved, a dropped key counted). */
export function documentChanges(template: Pick<DocumentTemplate, 'kind' | 'header' | 'terms' | 'footer' | 'fieldsShown'>, draft: DocumentDraft): Array<keyof DocumentDraft> {
  const saved = { header: template.header ?? '', terms: template.terms ?? '', footer: template.footer ?? '' }
  return (['header', 'terms', 'footer', 'fieldsShown'] as const).filter((field) => (field === 'fieldsShown' ? !sameList(template.fieldsShown, draft.fieldsShown) : saved[field] !== draft[field]))
}

/** The body of the save: the changed fields only, an empty text as null (the company's own footer, no words). */
export function documentSaveBody(template: Pick<DocumentTemplate, 'kind' | 'header' | 'terms' | 'footer' | 'fieldsShown'>, draft: DocumentDraft) {
  const body: { header?: string | null; terms?: string | null; footer?: string | null; fieldsShown?: string[] } = {}
  for (const field of documentChanges(template, draft)) {
    if (field === 'fieldsShown') body.fieldsShown = [...draft.fieldsShown]
    else body[field] = draft[field].trim() === '' ? null : draft[field]
  }
  return body
}

/** The problems of a document draft by field (none: an empty object). */
export function documentProblems(kind: Pick<DocumentKind, 'placeholders' | 'limits'> | null, draft: DocumentDraft): Partial<Record<'header' | 'terms' | 'footer', Said[]>> {
  if (!kind) return {}
  const out: Partial<Record<'header' | 'terms' | 'footer', Said[]>> = {}
  for (const field of ['header', 'terms', 'footer'] as const) {
    const problems = wordProblems(draft[field], kind.limits[field], kind.placeholders)
    if (problems.length > 0) out[field] = problems
  }
  return out
}

// ── an e-mail template's draft ───────────────────────────────────────────────────────────────────────────────────────

export interface MailDraft {
  subject: string
  body: string
}

export const MAIL_LIMITS = Object.freeze({ subject: 200, body: 20000 })

export const mailDraftOf = (template: Pick<EmailTemplate, 'subject' | 'body'>): MailDraft => ({ subject: template.subject, body: template.body })

export function mailChanges(template: Pick<EmailTemplate, 'subject' | 'body'>, draft: MailDraft): Array<keyof MailDraft> {
  return (['subject', 'body'] as const).filter((field) => template[field] !== draft[field])
}

export function mailProblems(placeholders: readonly string[] | null, draft: MailDraft): Partial<Record<keyof MailDraft, Said[]>> {
  if (!placeholders) return {}
  const out: Partial<Record<keyof MailDraft, Said[]>> = {}
  const subject = draft.subject.trim() === '' ? [{ key: 'tpl.problem.subjectEmpty' }] : draft.subject.includes('\n') ? [{ key: 'tpl.problem.oneLine' }] : wordProblems(draft.subject, MAIL_LIMITS.subject, placeholders)
  const body = draft.body.trim() === '' ? [{ key: 'tpl.problem.bodyEmpty' }] : wordProblems(draft.body, MAIL_LIMITS.body, placeholders)
  if (subject.length > 0) out.subject = subject
  if (body.length > 0) out.body = body
  return out
}

// ── what each button waits for ───────────────────────────────────────────────────────────────────────────────────────

export interface EditorState {
  status: TemplateStatus
  mayManage: boolean
  busy: boolean
  /** Fields changed and not saved. */
  changed: number
  /** Problems in the words. */
  problems: number
}

/** Why "Save draft" (⌘S) waits; null when it may. */
export function saveHeld(state: EditorState): WordKey | null {
  if (!state.mayManage) return 'tpl.held.noRight'
  if (state.status !== 'DRAFT') return 'tpl.held.published'
  if (state.busy) return 'tpl.held.busy'
  if (state.changed === 0) return 'tpl.held.nothingChanged'
  if (state.problems > 0) return 'tpl.held.problems'
  return null
}

/** Why "Publish template" waits; null when it may (a draft, saved, with no problem). */
export function publishHeld(state: EditorState): WordKey | null {
  if (!state.mayManage) return 'tpl.held.noRight'
  if (state.status !== 'DRAFT') return state.status === 'ACTIVE' ? 'tpl.held.inUse' : 'tpl.held.retired'
  if (state.busy) return 'tpl.held.busy'
  if (state.problems > 0) return 'tpl.held.problems'
  if (state.changed > 0) return 'tpl.held.saveFirst'
  return null
}

/** Why "New version" (a draft from this one) waits; null when it may. */
export function newVersionHeld(state: Pick<EditorState, 'mayManage' | 'busy'>, draftOpen: { revision: number } | null): WordKey | null {
  if (!state.mayManage) return 'tpl.held.noRight'
  if (state.busy) return 'tpl.held.busy'
  if (draftOpen) return 'tpl.held.draftOpen'
  return null
}

/** A version's status as a Pill tone. */
export const STATUS_TONE: Readonly<Record<TemplateStatus, 'info' | 'success' | 'neutral'>> = { DRAFT: 'info', ACTIVE: 'success', RETIRED: 'neutral' }
