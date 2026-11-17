import { isProjectLinkType, LINK_GROUPS, PROJECT_LIMITS, PROJECT_LINK_TYPES, type ProjectLinkType } from '@nexus/factory-domain/projects/rules'
import { recordAddress } from '../../../../../lib/records/record-links'
import { isApiError } from '../../../../../lib/api/errors'
import { statusKey as searchStatusKey, statusTone } from '../../../../search/model'
import type { LinkedRecord, ProjectLinks, ProjectView, ShortProject } from '../../api'
import { NO_MANAGE, OFFLINE, refusalCode, refusalPhrase, writeProblem, type Notice, type Phrase, type Tone } from '../../model'

/**
 * B-TH-251 (threads plan TH-5; design PROJ.linked-F01…F05, F07, F09, F10; walls W01, W09, W12, W27, W38), pure: the project's linked
 * records grouped by kind in the domain's order, each a real link or "you cannot open it", status in words only (never an
 * amount); who may link and unlink and why not; the Link dialog's candidates (the office search, kept to the project's company and
 * the kinds a project links); a refused link said from its code in words that name NEITHER company (W12, W38); "In project …" for
 * a record's thread head. Words: `products-projects-linked` (this part), `products-projects` (shared: groups, refusals, problems),
 * `search` (a record's status words).
 */

export const LINKED_NS = 'products-projects-linked'
/** The catalogues the Linked block brings beside the shared ones: its own and the search's status words. */
export const LINKED_ALSO = [LINKED_NS, 'search'] as const

/** The groups in the page's order (factory-domain LINK_GROUPS: Styles, Samples, Quotes, Orders, Requests, Shipments, Changes, Purchase orders, Certificates, Measurement profiles). */
export const GROUP_ORDER: readonly string[] = [...new Set(Object.values(LINK_GROUPS))]

/** A group shows this many rows before "Show all N" (100 links stay readable: grouped and folded). */
export const FOLD_AT = 5

/** A record type's words in this catalogue (`type.Style`); a type a project does not link is "Record". */
export const typeKey = (type: string): string => (isProjectLinkType(type) ? `type.${type}` : 'type.other')

export interface LinkedRow {
  readonly linkId: string
  readonly recordType: string
  /** The record's number; null: the reader may not open it (no link, its kind and "you cannot open it"). */
  readonly label: string | null
  /** Its own page (a real link: ⌘-click opens a new tab), or null when it may not be opened. */
  readonly href: string | null
  /** `search` catalogue key of its status (`status.SENT`), or null: no words, nothing shown (never the raw code). */
  readonly statusKey: string | null
  readonly statusTone: Tone
  readonly note: string | null
  readonly linkedAt: string
  readonly linkedBy: string | null
}

export interface LinkedGroup {
  /** STYLES · SAMPLES · … (the shared catalogue's `group.<GROUP>`). */
  readonly group: string
  readonly rows: readonly LinkedRow[]
}

/** Each linked record as the block shows it. `built` = the pages that exist (OFFICE_PAGES); `prefix` = `/w/<company>`. */
export function rowOf(record: LinkedRecord, prefix: string, built: ReadonlySet<string>): LinkedRow {
  const open = record.mayOpen && record.label !== null
  return {
    linkId: record.linkId,
    recordType: record.recordType,
    label: open ? record.label : null,
    href: open ? `${prefix}${recordAddress({ type: record.recordType, id: record.recordId, label: record.label ?? undefined }, built)}` : null,
    // A record the reader may not open shows no status either: only its kind.
    statusKey: open ? searchStatusKey(record.status) : null,
    statusTone: open ? statusTone(record.status) : 'neutral',
    note: open ? record.note : null,
    linkedAt: record.linkedAt,
    linkedBy: record.linkedBy?.name ?? null,
  }
}

/** The records grouped by kind in GROUP_ORDER (a group the API names that the domain does not know comes last, as "Other records"); empty groups left out. */
export function groupsOf(records: readonly LinkedRecord[], prefix: string, built: ReadonlySet<string>): LinkedGroup[] {
  const byGroup = new Map<string, LinkedRow[]>()
  for (const record of records) {
    const group = GROUP_ORDER.includes(record.group) ? record.group : 'other'
    byGroup.set(group, [...(byGroup.get(group) ?? []), rowOf(record, prefix, built)])
  }
  return [...GROUP_ORDER, 'other'].flatMap((group) => {
    const rows = byGroup.get(group)
    return rows && rows.length > 0 ? [{ group, rows }] : []
  })
}

/** The shared catalogue's key of a group's name. */
export const groupKey = (group: string): string => (GROUP_ORDER.includes(group) ? `group.${group}` : 'group.other')

/** The rows a group shows: all when opened or short, else the first FOLD_AT. */
export const shownRows = (group: LinkedGroup, opened: boolean): readonly LinkedRow[] => (opened || group.rows.length <= FOLD_AT ? group.rows : group.rows.slice(0, FOLD_AT))

// ---- who may link and unlink ------------------------------------------------------------------------------------------------

/** Link and unlink: projects.manage over THIS project (the API's `may.manage`), an open project, the network. */
export function linkHeld(project: Pick<ProjectView, 'status' | 'may'>, offline: boolean): Phrase | null {
  if (!project.may.manage) return NO_MANAGE
  if (project.status === 'CLOSED') return { key: 'held.closed' }
  if (offline) return OFFLINE
  return null
}

/** What may join, said under the heading: records of the project's outside company or of none; an office-only project: of none. */
export function scopePhrase(project: Pick<ProjectView, 'party'>): Phrase {
  return project.party ? { key: 'block.scopeParty', params: { party: project.party.name } } : { key: 'block.scopeOffice' }
}

// ---- the Link dialog ------------------------------------------------------------------------------------------------------

/** The kinds a project links (the dialog's kind filter), in the domain's order. */
export const LINK_KINDS: readonly ProjectLinkType[] = PROJECT_LINK_TYPES

export interface LinkCandidate {
  readonly recordType: string
  readonly recordId: string
  /** Its number (else its name). */
  readonly label: string
  /** The line beside it (its name when it has a number). */
  readonly title: string | null
  readonly statusKey: string | null
  /** In this project already (shown, not offered). */
  readonly linked: boolean
}

/** A search result as far as the dialog needs it (factory-domain search/contracts SearchResult). */
export interface SearchHit {
  readonly recordType: string
  readonly recordId: string
  readonly number: string | null
  readonly title: string
  readonly status: string | null
  readonly companyId: string | null
}

/**
 * The search's results the dialog offers: only the kinds a project links, only records of the project's company or of every
 * company (the API's LINK_COMPANY; a result does not say its outside company, so the outside company is the API's check, refused
 * in words); one row per record; a record linked already is shown as such.
 */
export function candidatesOf(hits: readonly SearchHit[], project: Pick<ProjectView, 'companyId'>, links: Pick<ProjectLinks, 'records'>): LinkCandidate[] {
  const linked = new Set(links.records.map((record) => `${record.recordType}:${record.recordId}`))
  const seen = new Set<string>()
  const out: LinkCandidate[] = []
  for (const hit of hits) {
    if (!isProjectLinkType(hit.recordType)) continue
    if (hit.companyId !== null && hit.companyId !== project.companyId) continue
    const key = `${hit.recordType}:${hit.recordId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ recordType: hit.recordType, recordId: hit.recordId, label: hit.number ?? hit.title, title: hit.number ? hit.title : null, statusKey: searchStatusKey(hit.status), linked: linked.has(key) })
  }
  return out
}

/** The note (why it is linked): one line, at most PROJECT_LIMITS.linkNote characters; empty is fine. */
export function noteProblem(note: string): Phrase | null {
  if (note.length > PROJECT_LIMITS.linkNote) return { key: 'link.noteTooLong' }
  if (/[\u0000-\u001f\u007f]/.test(note)) return { key: 'link.noteOneLine' }
  return null
}

/** The body of POST …/links (the note left out when blank). */
export function linkBody(picked: { recordType: string; recordId: string }, note: string): { recordType: string; recordId: string; note?: string | null } {
  const trimmed = note.trim()
  return { recordType: picked.recordType, recordId: picked.recordId, ...(trimmed ? { note: trimmed } : {}) }
}

/** A refused link: a headline that names the record only (its number) and, when the API's rule says why, the rule in words. */
export interface LinkProblem {
  readonly title: Phrase
  readonly body: Phrase | null
}

/**
 * A refused link in words from its code (W12, W27, W38): a record of another outside company → "SO-… belongs to another outside
 * company: it cannot join this project." + the rule, naming NEITHER company (the label is the number the office typed; the
 * project's outside company is never named here either). A record not found (or not the reader's to open) → said so.
 */
export function linkProblemOf(error: unknown, label: string): LinkProblem {
  const code = refusalCode(error)
  if (code === 'LINK_PARTY') return { title: { key: 'refused.party', params: { label } }, body: refusalPhrase(code) }
  if (code === 'ALREADY_LINKED') return { title: { key: 'refused.already', params: { label } }, body: null }
  if (code) return { title: { key: 'refused.label', params: { label } }, body: refusalPhrase(code) }
  if (isApiError(error) && error.kind === 'not_found') return { title: { key: 'refused.notFound', params: { label } }, body: null }
  return { title: writeProblem(error), body: null }
}

/** Whether a link attempt may be sent again with the same key (the answer was lost), else a new attempt takes a new key. */
export const keepsKey = (error: unknown): boolean => isApiError(error) && (error.kind === 'unavailable' || error.kind === 'internal')

export const linkedNotice = (label: string): Notice => ({ key: 'notice.linked', params: { label }, tone: 'success' })
export const unlinkedNotice = (label: string): Notice => ({ key: 'notice.unlinked', params: { label }, tone: 'success' })

// ---- "In project …" on a record's thread head (PROJ.linked-F05) ---------------------------------------------------------------

/** Whether a record may be in a project at all (the thread head reads its projects only then). */
export const takesProjects = (recordType: string): boolean => isProjectLinkType(recordType)

/** A live change that may move a record's "In project": a link or unlink of THIS record. */
export function inProjectChangeFor(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, record: { readonly type: string; readonly id: string }): boolean {
  if (change.type !== 'project.linked' && change.type !== 'project.unlinked') return false
  return change.fields.recordType === record.type && change.fields.recordId === record.id
}

/** The head's chip: each project with its page (open projects first, then by number); never one the API left out. */
export function inProjectOf(projects: readonly ShortProject[], prefix: string): { readonly id: string; readonly label: string; readonly number: string; readonly href: string }[] {
  const open = projects.filter((project) => project.status !== 'CLOSED')
  const closed = projects.filter((project) => project.status === 'CLOSED')
  return [...open, ...closed].map((project) => ({ id: project.id, label: project.name, number: project.number, href: `${prefix}/products/projects/${encodeURIComponent(project.id)}` }))
}

// ---- the views' models ------------------------------------------------------------------------------------------------------

export type LinkResults =
  | { readonly status: 'idle' }
  | { readonly status: 'tooShort' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly LinkCandidate[] }
  | { readonly status: 'error'; readonly problem: string }

/** The Link dialog (PROJ.linked-F02, F03). */
export interface LinkDialogModel {
  /** "PRJ-26-012 · FW27 airbag line". */
  readonly project: string
  /** What may join (records of its outside company or of none). */
  readonly scope: Phrase
  readonly q: string
  /** One kind, or every kind a project links. */
  readonly kind: ProjectLinkType | null
  readonly results: LinkResults
  readonly picked: { readonly recordType: string; readonly recordId: string; readonly label: string } | null
  readonly note: string
  readonly busy: boolean
  /** A refused link in words (never naming another company). */
  readonly problem: LinkProblem | null
  readonly offline: boolean
}

export interface LinkDialogActions {
  onQuery?: (q: string) => void
  onKind?: (kind: ProjectLinkType | null) => void
  onPick?: (candidate: LinkCandidate) => void
  onNote?: (note: string) => void
  onSubmit?: () => void
  onRetry?: () => void
  onClose?: () => void
}

/** The Linked block of the project page's side column (PROJ.linked-F01, F04, F05, F09, F10). */
export interface LinkedBlockModel {
  readonly count: number
  readonly groups: readonly LinkedGroup[]
  readonly scope: Phrase
  /** Link and unlink held with why (no right, a closed project, offline), or null. */
  readonly held: Phrase | null
  /** projects.manage over this project: Link and Unlink are offered at all (held with why when they cannot be used now). */
  readonly manage: boolean
  /** The link being unlinked (its row says so). */
  readonly busy: string | null
  readonly notice: Notice | null
  readonly link: LinkDialogModel | null
  /** "Unlink …?" open for this row. */
  readonly unlinking: { readonly linkId: string; readonly recordType: string; readonly label: string | null } | null
  /** Design cases: the groups opened past the fold. */
  readonly opened?: readonly string[]
}

export interface LinkedBlockActions {
  onLink?: () => void
  onUnlink?: (row: LinkedRow) => void
  onConfirmUnlink?: () => void
  onCancelUnlink?: () => void
  onDismissNotice?: () => void
  link?: LinkDialogActions
}
