import { PROJECT_LIMITS, isOneLine, isParagraph } from '@nexus/factory-domain/projects/rules'
import type { StartFromRequestBody } from '../../products/projects/api'
import type { InquiryView } from './api'

/**
 * B-TH-252 (threads plan TH-5; PROJ-G20, PROJ.new-F07; design O-SAL-INQ-LIST.pane-actions "Start a project", in ⋯ — never a sixth
 * main action): a project started from an Incoming request, when a request is the start of development work (a new collection, a
 * style family, a programme) rather than one order. POST /sales/inquiries/:id/project (B-TH-071): the project's outside company is
 * the REQUEST's customer — the dialog never offers another one (W38); the request is linked to it; the files picked are carried to
 * it. Pure: who may, the draft, its problems and the body. Words: `sales-incoming-pane` `project.*`.
 */

export interface StartProjectDraft {
  /** Empty: the API names it after the request's subject. */
  readonly name: string
  /** YYYY-MM-DD, required. */
  readonly targetDate: string
  readonly goal: string
  /** The request's files (and its mail's) to carry to the project. */
  readonly fileIds: readonly string[]
}

export interface StartProjectFile {
  readonly id: string
  readonly name: string
  readonly sizeBytes: number
}

export interface StartProjectModel {
  readonly number: string
  /** The request's customer: the project's outside company, set once. */
  readonly customer: string
  readonly draft: StartProjectDraft
  readonly files: readonly StartProjectFile[]
  readonly busy: boolean
  /** A refusal or a problem, as a key of `sales-incoming-pane` (`project.refusal.*`, `project.problem.*`) with its parameters. */
  readonly notice: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
  readonly offline: boolean
}

export interface StartProjectActions {
  onDraft?: (patch: Partial<StartProjectDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Why "Start a project…" is held on this request (a key of `sales-incoming-pane`), or null: it needs projects.manage; a request
 * from a prospect has no customer yet (a project's outside company never changes later: match it first — the API's
 * NO_PARTY_REQUEST, said before the click).
 */
export function startProjectHeld(view: Pick<InquiryView, 'party'>, rights: { readonly manage: boolean; readonly read: boolean }): string | null {
  if (!rights.read) return 'project.held.read'
  if (!rights.manage) return 'project.held.right'
  if (!view.party) return 'project.held.prospect'
  return null
}

/** The draft a request starts with: its subject as the name (editable), no date yet, every file of the request ticked. */
export function startDraftOf(view: Pick<InquiryView, 'summary' | 'number' | 'files' | 'mailFiles'>): StartProjectDraft {
  const name = (view.summary || view.number).replace(/\s+/g, ' ').trim().slice(0, PROJECT_LIMITS.name)
  return { name, targetDate: '', goal: '', fileIds: carriableFiles(view).map((file) => file.id) }
}

/** The request's files (and its mail's) the dialog offers to carry: available ones only. */
export function carriableFiles(view: Pick<InquiryView, 'files' | 'mailFiles'>): StartProjectFile[] {
  const seen = new Set<string>()
  return [...view.files, ...view.mailFiles].filter((file) => file.status === 'AVAILABLE' && !seen.has(file.id) && seen.add(file.id)).map((file) => ({ id: file.id, name: file.originalName, sizeBytes: file.sizeBytes }))
}

/** What keeps Start from being sent, each a key of `sales-incoming-pane`: a target date, a one-line name, a goal within its length. */
export function startProblems(draft: StartProjectDraft, today: string): string[] {
  const problems: string[] = []
  if (draft.name.trim() !== '' && !isOneLine(draft.name.trim(), PROJECT_LIMITS.name)) problems.push('project.problem.name')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.targetDate)) problems.push('project.problem.target')
  else if (draft.targetDate < today) problems.push('project.problem.targetPast')
  if (draft.goal.trim() !== '' && !isParagraph(draft.goal.trim(), PROJECT_LIMITS.goal)) problems.push('project.problem.goal')
  return problems
}

/** The body: the customer is never sent (the API takes the request's); the lead is the maker unless the project page changes it. */
export function startBodyOf(draft: StartProjectDraft): StartFromRequestBody {
  const name = draft.name.trim()
  const goal = draft.goal.trim()
  return { ...(name ? { name } : {}), targetDate: draft.targetDate, ...(goal ? { goal } : {}), ...(draft.fileIds.length > 0 ? { fileIds: [...draft.fileIds] } : {}) }
}

/** A refusal's code (`refusal/<CODE>` of factory-domain projects/rules) said in the pane's words. */
export function startRefusalKey(code: string | null): string | null {
  if (code === 'NO_PARTY_REQUEST' || code === 'PARTY_BLOCKED' || code === 'SEASON' || code === 'LEAD') return `project.refusal.${code}`
  return null
}
