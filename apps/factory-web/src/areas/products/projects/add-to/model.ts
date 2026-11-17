import { PROJECT_LIMITS, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import type { LinkManyAnswer, ProjectRow } from '../api'
import { NO_MANAGE, OFFLINE, refusalPhrase, type Phrase } from '../model'

/**
 * B-TH-251 (design X-PRD-STY-LIST.grid, X-PRD-SMP-LIST.grid; walls W12, W27, W38), pure: "Add to project" from the Styles and the
 * Samples & prototypes lists — who may (projects.manage), at most PROJECT_LIMITS.bulk rows in one go, the open projects to pick, the
 * ONE body of POST /projects/:id/links/bulk, and the answer in words: how many linked, each skipped row with its number and its reason
 * from its code (a row of another outside company: "belongs to another outside company", naming neither company). Words: the
 * `products-projects-linked` catalogue (`addTo.*`), the shared one for the rest.
 */

export type AddToKind = 'Style' | 'SampleRound'

/** A selected row: its id and the number the list shows (a style's code, a round's number). */
export interface AddToRecord {
  readonly id: string
  readonly number: string
}

/** An open project to pick. */
export interface ProjectChoice {
  readonly id: string
  readonly number: string
  readonly name: string
  /** Its outside company's name; null: office only. */
  readonly party: string | null
  readonly status: ProjectStatus
}

export interface AddToSkipped {
  readonly number: string
  readonly reason: Phrase
}

export interface AddToResult {
  readonly linked: number
  readonly skipped: readonly AddToSkipped[]
  readonly project: { readonly number: string; readonly name: string; readonly href: string }
}

export type AddToProjects = { readonly status: 'loading' } | { readonly status: 'ready'; readonly items: readonly ProjectChoice[] } | { readonly status: 'error'; readonly problem: string }

/** The Add to project dialog. */
export interface AddToProjectModel {
  readonly kind: AddToKind
  readonly records: readonly AddToRecord[]
  readonly q: string
  readonly projects: AddToProjects
  /** The project picked (its id). */
  readonly picked: string | null
  readonly note: string
  readonly busy: boolean
  /** A refused call in words (the whole call: a closed project, no right, the network). */
  readonly problem: Phrase | null
  /** Sent: the answer in words (the dialog then offers Open the project and Done). */
  readonly result: AddToResult | null
  readonly offline: boolean
}

export interface AddToProjectActions {
  onQuery?: (q: string) => void
  onPick?: (projectId: string) => void
  onNote?: (note: string) => void
  onSubmit?: () => void
  onRetry?: () => void
  onClose?: () => void
}

/** The most rows one "Add to project" takes (the API's bulk limit). */
export const ADD_TO_LIMIT = PROJECT_LIMITS.bulk

/** Why the list's "Add to project" is held, or null: no projects.manage, too many rows, offline. */
export function addToHeld(input: { readonly manage: boolean; readonly count: number; readonly offline: boolean }): Phrase | null {
  if (!input.manage) return NO_MANAGE
  if (input.count > ADD_TO_LIMIT) return { key: 'addTo.held.tooMany', params: { count: ADD_TO_LIMIT } }
  if (input.offline) return OFFLINE
  return null
}

/** The open projects to pick (ACTIVE and ON_HOLD read apart, merged once each; a closed one never offered), nearest number first. */
export function choicesOf(rows: readonly ProjectRow[]): ProjectChoice[] {
  const seen = new Set<string>()
  const out: ProjectChoice[] = []
  for (const row of rows) {
    if (row.status === 'CLOSED' || seen.has(row.id)) continue
    seen.add(row.id)
    out.push({ id: row.id, number: row.number, name: row.name, party: row.party?.name ?? null, status: row.status })
  }
  return out
}

/** The note on every record linked: one line, at most PROJECT_LIMITS.linkNote characters; empty is fine. */
export function addToNoteProblem(note: string): Phrase | null {
  if (note.length > PROJECT_LIMITS.linkNote) return { key: 'link.noteTooLong' }
  if (/[\u0000-\u001f\u007f]/.test(note)) return { key: 'link.noteOneLine' }
  return null
}

/** Why Add is held in the dialog, or null. */
export function submitHeld(model: Pick<AddToProjectModel, 'picked' | 'note' | 'offline' | 'records'>): Phrase | null {
  if (model.offline) return OFFLINE
  if (model.records.length > ADD_TO_LIMIT) return { key: 'addTo.held.tooMany', params: { count: ADD_TO_LIMIT } }
  if (!model.picked) return { key: 'addTo.held.pick' }
  return addToNoteProblem(model.note)
}

/** The ONE body of POST /projects/:id/links/bulk: the kind, each id once (at most the limit), the note when typed. */
export function bulkBody(kind: AddToKind, records: readonly AddToRecord[], note: string): { recordType: AddToKind; recordIds: string[]; note?: string } {
  const recordIds = [...new Set(records.map((record) => record.id))].slice(0, ADD_TO_LIMIT)
  const trimmed = note.trim()
  return { recordType: kind, recordIds, ...(trimmed ? { note: trimmed } : {}) }
}

/** A skipped row's reason from its code: another outside company and "linked already" in short words, MISSING as not found, any other rule in the shared words. */
export function skipReason(code: string): Phrase {
  if (code === 'LINK_PARTY' || code === 'ALREADY_LINKED' || code === 'MISSING') return { key: `addTo.skip.${code}` }
  return refusalPhrase(code)
}

/** The answer in words: how many linked, each skipped row by its number (the list's) and why. */
export function resultOf(answer: Pick<LinkManyAnswer, 'linked' | 'skipped'>, records: readonly AddToRecord[], project: AddToResult['project']): AddToResult {
  const numberOf = new Map(records.map((record) => [record.id, record.number]))
  return { linked: answer.linked, skipped: answer.skipped.map((entry) => ({ number: numberOf.get(entry.recordId) ?? '—', reason: skipReason(entry.code) })), project }
}

/** What a list's view gets for "Add to project": the right (projects.manage), the network, the dialog when open. */
export interface AddToListPart {
  readonly manage: boolean
  readonly offline: boolean
  readonly dialog: AddToProjectModel | null
}
