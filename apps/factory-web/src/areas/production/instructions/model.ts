import { STEP_CODE } from '@nexus/factory-domain/production/checklists/rules'
import { INSTRUCTION_ICONS, INSTRUCTION_LIMITS, MEDIA_TYPES, wordsIn, type MediaKind } from '@nexus/factory-domain/production/instructions/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Acknowledgements, AckPerson, FileFacts, InstructionList, InstructionRecord, InstructionRow, SaveBody, StepView, VersionAnswer, VersionView } from './api'

/**
 * Production › Floor control › Work instructions (SCR-141, design production.instructions; B-W2b-234 on B-W2b-214's API):
 * the pure rules of the list, the record, the editor's draft, the held reasons and the words of the API's codes. Nothing
 * here fetches or draws. Every held reason and refusal is a key of the `production-instructions` catalogue with its
 * parameters: the API's English is never shown. No money, and never a figure per worker (Owner answers W1, F2, H3): the
 * acknowledgements are counts per site; names only inside the record, only for HR (production.instructions.people).
 */

export const NS = 'production-instructions'
export const NAMESPACES = [NS, 'lists'] as const

/** A phrase of the catalogue: its key and parameters. */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface Notice extends Phrase {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
}

// ---- rights ---------------------------------------------------------------------------------------------------------------

export interface InstructionsCan {
  /** production.instructions.view: the list, the record, the sheet, counts of who saw. */
  readonly view: boolean
  /** production.instructions.manage: new, drafts, photos and videos, discard, archive and restore, the typed lines. */
  readonly manage: boolean
  /** production.instructions.approve: approve another person's draft (it goes to the floor). */
  readonly approve: boolean
  /** production.instructions.people: who saw it by name (HR), a paper acknowledgement. */
  readonly people: boolean
  /** product.routing.view: New instruction picks a library operation. */
  readonly pickOperation: boolean
  /** product.styles.view: New instruction may pick one style revision. */
  readonly pickStyle: boolean
  /** files.read: the photos and videos are shown (else their names only). */
  readonly seeMedia: boolean
}

export function instructionsCan(permissions: readonly string[]): InstructionsCan {
  const held = new Set(permissions)
  return {
    view: held.has('production.instructions.view'),
    manage: held.has('production.instructions.manage'),
    approve: held.has('production.instructions.approve'),
    people: held.has('production.instructions.people'),
    pickOperation: held.has('product.routing.view'),
    pickStyle: held.has('product.styles.view'),
    seeMedia: held.has('files.read'),
  }
}

// ---- the list -------------------------------------------------------------------------------------------------------------

/** The saved views (the tiles): in force, a draft waiting, a floor language missing, never published, archived. */
export const LIST_VIEWS = ['active', 'drafts', 'missing', 'unpublished', 'archived'] as const
export type ListView = (typeof LIST_VIEWS)[number]
export const TILES: readonly ListView[] = ['drafts', 'missing', 'unpublished', 'archived']

export interface ListAddress {
  readonly view: ListView
  readonly q: string
  /** `?new=1`: New instruction open. */
  readonly creating: boolean
  /** `?typed=1`: Bring in typed steps open. */
  readonly typed: boolean
}

interface Params {
  get(name: string): string | null
}

export function listAddressOf(params: Params | null | undefined): ListAddress {
  const view = params?.get('view') ?? ''
  return {
    view: (LIST_VIEWS as readonly string[]).includes(view) ? (view as ListView) : 'active',
    q: params?.get('q') ?? '',
    creating: params?.get('new') === '1',
    typed: params?.get('typed') === '1',
  }
}

export function listQueryText(address: ListAddress): string {
  const search = new URLSearchParams()
  if (address.view !== 'active') search.set('view', address.view)
  if (address.q.trim()) search.set('q', address.q.trim())
  if (address.creating) search.set('new', '1')
  if (address.typed) search.set('typed', '1')
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const isFiltered = (address: ListAddress): boolean => address.view !== 'active' || address.q.trim() !== ''

/** The API's status a view reads (the other views are read from the ACTIVE list). */
export const statusOfView = (view: ListView): 'ACTIVE' | 'ARCHIVED' => (view === 'archived' ? 'ARCHIVED' : 'ACTIVE')

/** The rows of a view (the API sends the ACTIVE or ARCHIVED list whole, at most 500). */
export function rowsOfView(rows: readonly InstructionRow[], view: ListView): InstructionRow[] {
  switch (view) {
    case 'drafts':
      return rows.filter((row) => row.draft !== null)
    case 'missing':
      return rows.filter((row) => (row.current?.missingLanguages.length ?? 0) > 0)
    case 'unpublished':
      return rows.filter((row) => row.current === null)
    default:
      return [...rows]
  }
}

/** The tiles' numbers: what the ACTIVE list holds, and the archived count the API sends with it. */
export function tileCounts(list: InstructionList | null): Record<ListView, number | null> {
  if (!list) return { active: null, drafts: null, missing: null, unpublished: null, archived: null }
  const active = list.instructions.filter((row) => row.status === 'ACTIVE')
  return {
    active: list.counts.active,
    drafts: list.counts.drafts,
    missing: rowsOfView(active, 'missing').length,
    unpublished: rowsOfView(active, 'unpublished').length,
    archived: list.counts.archived,
  }
}

/** The list's "seen" cell: of the version in force, how many saw it (a count of people, never names). */
export function seenPhrase(row: Pick<InstructionRow, 'current'>): Phrase {
  if (!row.current) return { key: 'list.seen.none' }
  return { key: 'list.seen.count', params: { count: row.current.seen } }
}

/** Export N: one CSV row per instruction, in the page's words. */
export function listCsv(rows: readonly InstructionRow[], words: { header: readonly string[]; everyStyle: string; status: (status: string) => string; none: string }): string {
  const cell = (value: string | number) => {
    const text = String(value)
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = rows.map((row) =>
    [
      row.number,
      row.operation.code,
      row.operation.name,
      row.style ? `${row.style.code} rev ${row.style.revision}` : words.everyStyle,
      row.current ? `v${row.current.number}` : words.none,
      row.draft ? `v${row.draft.number}` : '',
      row.current?.languages.join(' ') ?? '',
      row.current?.missingLanguages.join(' ') ?? '',
      row.current?.steps ?? 0,
      row.current?.media ?? 0,
      row.current?.seen ?? 0,
      row.usedIn,
      words.status(row.status),
      row.updatedAt.slice(0, 10),
    ]
      .map(cell)
      .join(','),
  )
  return [words.header.map(cell).join(','), ...lines].join('\n')
}

// ---- the record's address ------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['steps', 'media', 'versions', 'acks'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export interface RecordAddress {
  readonly tab: RecordTab
  /** The version shown on Steps and Media (else the draft, else the one in force). */
  readonly version: string | null
  /** Versions: the two compared (`compare` = the earlier one). */
  readonly compare: string | null
  /** `?approve=1`: Approve version N open. */
  readonly approve: boolean
}

export function recordAddressOf(params: Params | null | undefined): RecordAddress {
  const tab = params?.get('tab') ?? ''
  return {
    tab: (RECORD_TABS as readonly string[]).includes(tab) ? (tab as RecordTab) : 'steps',
    version: params?.get('version') || null,
    compare: params?.get('compare') || null,
    approve: params?.get('approve') === '1',
  }
}

export function recordQuery(address: RecordAddress): string {
  const search = new URLSearchParams()
  if (address.tab !== 'steps') search.set('tab', address.tab)
  if (address.version) search.set('version', address.version)
  if (address.compare) search.set('compare', address.compare)
  if (address.approve) search.set('approve', '1')
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** The version Steps and Media show: the one asked, else the draft, else the one in force, else the newest. */
export function shownVersionId(record: InstructionRecord, asked: string | null): string | null {
  if (asked && record.versions.some((version) => version.id === asked)) return asked
  return record.draftVersionId ?? record.currentVersionId ?? [...record.versions].sort((a, b) => b.number - a.number)[0]?.id ?? null
}

export const draftOfRecord = (record: InstructionRecord): VersionView | null => record.versions.find((version) => version.id === record.draftVersionId) ?? null
export const currentOfRecord = (record: InstructionRecord): VersionView | null => record.versions.find((version) => version.id === record.currentVersionId) ?? null
export const nextNumber = (record: InstructionRecord): number => Math.max(0, ...record.versions.map((version) => version.number)) + 1

/** The two versions Versions compares by default: the draft (or the one in force) against the one before it. */
export function defaultPair(record: InstructionRecord): { beforeId: string | null; afterId: string | null } {
  const sorted = [...record.versions].filter((version) => version.status !== 'DISCARDED').sort((a, b) => b.number - a.number)
  const afterId = record.draftVersionId ?? record.currentVersionId ?? sorted[0]?.id ?? null
  const afterNumber = record.versions.find((version) => version.id === afterId)?.number ?? 0
  const beforeId = sorted.find((version) => version.number < afterNumber)?.id ?? null
  return { beforeId, afterId }
}

// ---- the editor's draft ----------------------------------------------------------------------------------------------------------

export interface MediaDraft {
  /** Stable for the list (a file is on a step once). */
  readonly key: string
  readonly fileId: string
  readonly kind: MediaKind
  readonly caption: Readonly<Record<string, string>>
  /** The file's facts (null for a file the API no longer lists). */
  readonly file: FileFacts | null
}

export interface StepDraft {
  readonly key: string
  readonly code: string
  readonly text: Readonly<Record<string, string>>
  readonly critical: boolean
  readonly safety: Readonly<Record<string, string>>
  readonly icon: string | null
  readonly requiredTick: boolean
  readonly media: readonly MediaDraft[]
}

export interface VersionDraft {
  readonly steps: readonly StepDraft[]
  readonly changeNote: string
  readonly acknowledgementRequired: boolean
}

export function stepDraftOf(step: StepView): StepDraft {
  return {
    key: step.id,
    code: step.code,
    text: { ...step.text },
    critical: step.critical,
    safety: { ...(step.safety ?? {}) },
    icon: step.icon,
    requiredTick: step.requiredTick,
    media: step.media.map((medium) => ({ key: medium.fileId, fileId: medium.fileId, kind: medium.kind, caption: { ...(medium.caption ?? {}) }, file: medium.file })),
  }
}

export function draftOf(answer: VersionAnswer): VersionDraft {
  return { steps: [...answer.steps].sort((a, b) => a.sortOrder - b.sortOrder).map(stepDraftOf), changeNote: answer.version.changeNote ?? '', acknowledgementRequired: answer.version.acknowledgementRequired }
}

/** Words without blank languages, each trimmed; null for none. */
export function cleanWords(words: Readonly<Record<string, string>>): Record<string, string> | null {
  const entries = Object.entries(words)
    .map(([language, text]) => [language, text.trim()] as const)
    .filter(([, text]) => text !== '')
  return entries.length === 0 ? null : Object.fromEntries(entries)
}

/** The save's body: the whole document, the steps in their order with their photos and videos. */
export function saveBodyOf(version: Pick<VersionView, 'version'>, draft: VersionDraft): SaveBody {
  return {
    version: version.version,
    changeNote: draft.changeNote.trim() || null,
    acknowledgementRequired: draft.acknowledgementRequired,
    steps: draft.steps.map((step) => ({
      code: step.code.trim(),
      text: cleanWords(step.text) ?? {},
      critical: step.critical,
      safety: cleanWords(step.safety),
      icon: step.icon,
      requiredTick: step.requiredTick,
      media: step.media.map((medium) => ({ fileId: medium.fileId, kind: medium.kind, caption: cleanWords(medium.caption) })),
    })),
  }
}

const stepText = (body: SaveBody['steps'][number]): string => JSON.stringify(body)

/** How many changes the draft holds against the saved version: each step that differs (or moved), the note, the ask. */
export function changesOf(saved: VersionAnswer, draft: VersionDraft): number {
  const before = saveBodyOf(saved.version, draftOf(saved))
  const after = saveBodyOf(saved.version, draft)
  let count = 0
  const longest = Math.max(before.steps.length, after.steps.length)
  for (let index = 0; index < longest; index++) {
    const a = before.steps[index]
    const b = after.steps[index]
    if (!a || !b || stepText(a) !== stepText(b)) count++
  }
  if (before.changeNote !== after.changeNote) count++
  if (before.acknowledgementRequired !== after.acknowledgementRequired) count++
  return count
}

/** A new step at the end: a code not used yet (`STEP_4`), words in the language being written. */
export function newStep(steps: readonly StepDraft[], seed: number): StepDraft {
  const used = new Set(steps.map((step) => step.code))
  let n = steps.length + 1
  while (used.has(`STEP_${n}`)) n++
  return { key: `new-${seed}-${n}`, code: `STEP_${n}`, text: {}, critical: false, safety: {}, icon: null, requiredTick: false, media: [] }
}

export interface Problem extends Phrase {
  /** Where (`steps/2/code`, `steps/0/text`, `changeNote`): the API's own paths. */
  readonly path: string
}

/** The draft's problems at their places, as the API would refuse them (factory-domain stepsProblems), in the page's words. */
export function problemsOf(draft: VersionDraft): Problem[] {
  const problems: Problem[] = []
  if (draft.steps.length > INSTRUCTION_LIMITS.steps) problems.push({ path: 'steps', key: 'problem.steps.tooMany', params: { max: INSTRUCTION_LIMITS.steps } })
  const codes = new Set<string>()
  draft.steps.forEach((step, index) => {
    const at = `steps/${index}`
    const code = step.code.trim()
    if (!STEP_CODE.test(code)) problems.push({ path: `${at}/code`, key: 'problem.code.format', params: { n: index + 1 } })
    else if (codes.has(code)) problems.push({ path: `${at}/code`, key: 'problem.code.twice', params: { n: index + 1, code } })
    codes.add(code)
    const text = cleanWords(step.text)
    if (!text) problems.push({ path: `${at}/text`, key: 'problem.text.missing', params: { n: index + 1 } })
    for (const [language, words] of Object.entries(text ?? {})) if (words.length > INSTRUCTION_LIMITS.words) problems.push({ path: `${at}/text/${language}`, key: 'problem.text.tooLong', params: { n: index + 1, max: INSTRUCTION_LIMITS.words, language: language.toUpperCase() } })
    for (const [language, words] of Object.entries(cleanWords(step.safety) ?? {})) if (words.length > INSTRUCTION_LIMITS.safety) problems.push({ path: `${at}/safety/${language}`, key: 'problem.safety.tooLong', params: { n: index + 1, max: INSTRUCTION_LIMITS.safety, language: language.toUpperCase() } })
    const languages = new Set([...Object.keys(cleanWords(step.text) ?? {}), ...Object.keys(cleanWords(step.safety) ?? {})])
    if (languages.size > INSTRUCTION_LIMITS.languages) problems.push({ path: `${at}/text`, key: 'problem.languages.tooMany', params: { n: index + 1, max: INSTRUCTION_LIMITS.languages } })
    if (step.media.length > INSTRUCTION_LIMITS.mediaPerStep) problems.push({ path: `${at}/media`, key: 'problem.media.tooMany', params: { n: index + 1, max: INSTRUCTION_LIMITS.mediaPerStep } })
    step.media.forEach((medium, place) => {
      for (const [language, words] of Object.entries(cleanWords(medium.caption) ?? {})) if (words.length > INSTRUCTION_LIMITS.caption) problems.push({ path: `${at}/media/${place}/caption/${language}`, key: 'problem.caption.tooLong', params: { n: index + 1, max: INSTRUCTION_LIMITS.caption } })
    })
  })
  if (draft.changeNote.length > INSTRUCTION_LIMITS.changeNote) problems.push({ path: 'changeNote', key: 'problem.changeNote.tooLong', params: { max: INSTRUCTION_LIMITS.changeNote } })
  return problems
}

export const problemsAt = (problems: readonly Problem[], prefix: string): Problem[] => problems.filter((problem) => problem.path === prefix || problem.path.startsWith(`${prefix}/`))

/** The languages the editor offers: the floor's (every site's floor languages, Italian and English first), then the ones written. */
export function languagesOf(draft: VersionDraft | null, floorLanguages: readonly string[]): string[] {
  const written = new Set((draft?.steps ?? []).flatMap((step) => [...Object.keys(cleanWords(step.text) ?? {}), ...Object.keys(cleanWords(step.safety) ?? {})]))
  const order = ['it', 'en', ...floorLanguages, ...[...written].sort()]
  return [...new Set(order)]
}

/** The floor languages a step lacks (design: "missing language marked per step"). */
export const missingIn = (step: Pick<StepDraft, 'text'>, floorLanguages: readonly string[]): string[] => floorLanguages.filter((language) => !(step.text[language] ?? '').trim())

/** The languages a person may add to an instruction (ISO 639-1 codes the floor speaks most; `zh-Hans` as the database writes it). */
export const ADDABLE_LANGUAGES = ['it', 'en', 'ro', 'sq', 'ar', 'zh-Hans', 'hi', 'pa', 'bn', 'ur', 'uk', 'es', 'fr', 'de', 'pl', 'pt', 'tl', 'wo'] as const

/** A language's name in the page's language (Intl.DisplayNames; the code itself when the browser has no name). */
export function languageName(code: string, pageLocale: string): string {
  try {
    const names = new Intl.DisplayNames([pageLocale], { type: 'language' })
    const name = names.of(code)
    return name ? name.charAt(0).toLocaleUpperCase(pageLocale) + name.slice(1) : code
  } catch {
    return code
  }
}

export const ICON_KEYS: readonly string[] = INSTRUCTION_ICONS

// ---- photos and videos ----------------------------------------------------------------------------------------------------------

export const MEDIA_ACCEPT = [...MEDIA_TYPES.PHOTO, ...MEDIA_TYPES.VIDEO].join(',')
/** The files platform's PHOTO limit (a video is a PHOTO file with a video type: platform/files UploadPath.clip). */
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024

/** The kind of a picked file, or the problem's key. */
export function mediaKindOf(file: { type: string; size: number }): { kind: MediaKind } | { problem: string } {
  const type = file.type.toLowerCase()
  if (file.size === 0) return { problem: 'media.problem.empty' }
  if (file.size > MEDIA_MAX_BYTES) return { problem: 'media.problem.tooBig' }
  if ((MEDIA_TYPES.PHOTO as readonly string[]).includes(type)) return { kind: 'PHOTO' }
  if ((MEDIA_TYPES.VIDEO as readonly string[]).includes(type)) return { kind: 'VIDEO' }
  return { problem: 'media.problem.type' }
}

/** Photos or videos of the draft not uploaded yet (still uploading, held for the scan): the approval waits for them. */
export const mediaNotReady = (draft: VersionDraft): number => draft.steps.reduce((sum, step) => sum + step.media.filter((medium) => medium.file !== null && medium.file.status !== 'AVAILABLE').length, 0)

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return [...items]
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

// ---- held reasons -------------------------------------------------------------------------------------------------------------------

export interface Facts {
  readonly can: InstructionsCan
  readonly me: string
  readonly offline: boolean
}

/** Why the version shown cannot be changed here, or null (a draft, the right, an active instruction, online). */
export function editHeld(record: InstructionRecord, shown: VersionView | null, facts: Facts): Phrase | null {
  if (!facts.can.manage) return { key: 'held.noManage' }
  if (record.instruction.status !== 'ACTIVE') return { key: 'held.archived', params: { number: record.instruction.number } }
  if (!shown) return { key: 'held.noVersion' }
  if (shown.status !== 'DRAFT') return { key: `held.readOnly.${shown.status}`, params: { number: shown.number } }
  if (facts.offline) return { key: 'held.offline' }
  return null
}

/** Why this person cannot approve the draft now: the API's order (factory-domain publishRefusal), then this page's. */
export function approveHeld(record: InstructionRecord, draft: VersionView | null, content: VersionDraft | null, facts: Facts & { readonly unsaved: number }): Phrase | null {
  if (!facts.can.approve) return { key: 'held.noApprove' }
  if (!draft || draft.status !== 'DRAFT') return { key: 'held.noDraft' }
  if (draft.author.id === facts.me) return { key: 'held.ownDraft', params: { number: draft.number } }
  if (record.instruction.status !== 'ACTIVE') return { key: 'held.archived', params: { number: record.instruction.number } }
  if (facts.unsaved > 0) return { key: 'held.unsaved', params: { count: facts.unsaved } }
  const steps = content ? content.steps.length : draft.steps
  if (steps === 0) return { key: 'held.noSteps', params: { number: draft.number } }
  const note = content ? content.changeNote : (draft.changeNote ?? '')
  if (draft.number > 1 && !note.trim()) return { key: 'held.noNote', params: { number: draft.number } }
  const notReady = content ? mediaNotReady(content) : 0
  if (notReady > 0) return { key: 'held.mediaNotReady', params: { count: notReady } }
  if (facts.offline) return { key: 'held.offline' }
  return null
}

/** Why a new version cannot be started now, or null. */
export function newVersionHeld(record: InstructionRecord, facts: Facts): Phrase | null {
  if (!facts.can.manage) return { key: 'held.noManage' }
  if (record.instruction.status !== 'ACTIVE') return { key: 'held.archived', params: { number: record.instruction.number } }
  const draft = draftOfRecord(record)
  if (draft) return { key: 'held.draftExists', params: { number: draft.number } }
  if (facts.offline) return { key: 'held.offline' }
  return null
}

export function discardHeld(record: InstructionRecord, facts: Facts): Phrase | null {
  if (!facts.can.manage) return { key: 'held.noManage' }
  if (!draftOfRecord(record)) return { key: 'held.noDraft' }
  if (facts.offline) return { key: 'held.offline' }
  return null
}

export function statusHeld(facts: Facts): Phrase | null {
  if (!facts.can.manage) return { key: 'held.noManage' }
  if (facts.offline) return { key: 'held.offline' }
  return null
}

/** Why a paper acknowledgement cannot be recorded now (HR's right, a version in force, someone named). */
export function paperHeld(acks: Acknowledgements | null, facts: Facts): Phrase | null {
  if (!facts.can.people) return { key: 'held.noPeople' }
  if (!acks?.current) return { key: 'held.notPublished' }
  if (!acks.people || acks.people.rows.every((row) => !row.worker)) return { key: 'held.nobodyNamed' }
  if (facts.offline) return { key: 'held.offline' }
  return null
}

/** The band's one next step for this person: approve the draft, start the next version, or none. */
export function bandPrimary(record: InstructionRecord, facts: Facts): 'approve' | 'newVersion' | null {
  const draft = draftOfRecord(record)
  if (draft && facts.can.approve) return 'approve'
  if (!draft && facts.can.manage && record.instruction.status === 'ACTIVE') return 'newVersion'
  return null
}

// ---- the API's answers in words -----------------------------------------------------------------------------------------------------

/** Refusal codes the API answers (409 `refusal/<CODE>`) that this page says in its own words. */
export const KNOWN_REFUSALS = [
  'ACTIVE_EXISTS',
  'ALREADY_ACTIVE',
  'ALREADY_ARCHIVED',
  'ARCHIVED',
  'DRAFT_EXISTS',
  'NOT_DRAFT',
  'OWN_DRAFT',
  'NO_STEPS',
  'CHANGE_NOTE_MISSING',
  'MEDIA_NOT_READY',
  'NOT_PUBLISHED',
  'SEEN_ALREADY',
  'DATABASE_REFUSED',
  'ALREADY_EXISTS',
] as const

export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
  }
  return null
}

/** A failed read in words (a failed read is never drawn as an empty list). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  switch (error.kind) {
    case 'forbidden':
      return 'problem.forbidden'
    case 'not_found':
      return 'problem.notFound'
    case 'signed_out':
      return 'problem.signedOut'
    case 'contract':
      return 'problem.contract'
    case 'rate_limited':
      return 'problem.rateLimited'
    default:
      return 'problem.unavailable'
  }
}

export interface WriteProblem extends Phrase {
  /** The API's places of a 400 (`body/steps/1/code` → `steps/1/code`). */
  readonly paths: readonly string[]
  /** Someone changed it first: read it again. */
  readonly stale: boolean
}

/** A refused write in words: a rule's refusal by its code, a stale version, a refused field, the kind. */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.unavailable', paths: [], stale: false }
  const code = refusalCode(error)
  if (code) return { key: (KNOWN_REFUSALS as readonly string[]).includes(code) ? `refusal.${code}` : 'refusal.other', paths: [], stale: false }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[/.]/, '').replace(/\./g, '/')).filter(Boolean)
  if (error.kind === 'conflict') return { key: 'problem.stale', paths: [], stale: true }
  if (error.kind === 'invalid') return { key: 'problem.invalid', paths, stale: false }
  if (error.kind === 'forbidden') return { key: 'problem.writeForbidden', paths: [], stale: false }
  if (error.kind === 'not_found') return { key: 'problem.notFound', paths: [], stale: false }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited', paths: [], stale: false }
  return { key: 'problem.unavailable', paths: [], stale: false }
}

// ---- comparing two versions ----------------------------------------------------------------------------------------------------------

export interface CompareSide {
  readonly text: string | null
  readonly safety: string | null
  readonly critical: boolean
  readonly icon: string | null
  readonly requiredTick: boolean
  readonly media: number
  readonly languages: readonly string[]
}

export interface CompareLine {
  readonly code: string
  readonly before: CompareSide | null
  readonly after: CompareSide | null
}

const sideOf = (step: StepView, language: string): CompareSide => ({
  text: wordsIn(step.text, language)?.text ?? null,
  safety: wordsIn(step.safety, language)?.text ?? null,
  critical: step.critical,
  icon: step.icon,
  requiredTick: step.requiredTick,
  media: step.media.length,
  languages: Object.keys(step.text).sort(),
})

/** The steps of two versions matched by code, in the newer version's order, then the removed ones. */
export function compareLines(before: VersionAnswer, after: VersionAnswer, language: string): CompareLine[] {
  const old = new Map(before.steps.map((step) => [step.code, step]))
  const lines: CompareLine[] = [...after.steps].sort((a, b) => a.sortOrder - b.sortOrder).map((step) => ({ code: step.code, before: old.has(step.code) ? sideOf(old.get(step.code)!, language) : null, after: sideOf(step, language) }))
  const kept = new Set(after.steps.map((step) => step.code))
  for (const step of [...before.steps].sort((a, b) => a.sortOrder - b.sortOrder)) if (!kept.has(step.code)) lines.push({ code: step.code, before: sideOf(step, language), after: null })
  return lines
}

// ---- the floor preview ----------------------------------------------------------------------------------------------------------------

export interface PreviewStep {
  readonly code: string
  readonly words: string
  /** The language the words are in when it is not the one asked (the tablet marks it). */
  readonly shownIn: string | null
  readonly critical: boolean
  readonly safety: string | null
  readonly icon: string | null
  readonly requiredTick: boolean
  readonly media: ReadonlyArray<{ readonly fileId: string; readonly kind: MediaKind; readonly caption: string | null }>
}

/** A version's steps as the tablet shows them in one language (factory-domain wordsIn: asked → it → en → the first). */
export function previewSteps(answer: VersionAnswer, language: string): PreviewStep[] {
  return [...answer.steps]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((step) => {
      const words = wordsIn(step.text, language)
      return {
        code: step.code,
        words: words?.text ?? step.code,
        shownIn: words && words.language !== language ? words.language : null,
        critical: step.critical,
        safety: wordsIn(step.safety, language)?.text ?? null,
        icon: step.icon,
        requiredTick: step.requiredTick,
        media: step.media.map((medium) => ({ fileId: medium.fileId, kind: medium.kind, caption: wordsIn(medium.caption, language)?.text ?? null })),
      }
    })
}

/** The languages a version is written in (every step's), Italian and English first. */
export function versionLanguages(answer: VersionAnswer | null, floorLanguages: readonly string[]): string[] {
  const written = new Set((answer?.steps ?? []).flatMap((step) => Object.keys(step.text)))
  return [...new Set(['it', 'en', ...floorLanguages, ...[...written].sort()])].filter((language) => written.has(language) || language === 'it' || language === 'en')
}

// ---- acknowledgements --------------------------------------------------------------------------------------------------------------------

/** "12 of 14" per site of the version in force; the share for the bar (null when nobody holds the skill there). */
export function siteShare(row: { readonly seen: number; readonly of: number }): number | null {
  return row.of > 0 ? Math.min(100, Math.round((row.seen / row.of) * 100)) : null
}

/** HR's rows in a stable order: by site, those still to see the version in force first, then by name; hidden names last. */
export function peopleRows(acks: Acknowledgements | null): AckPerson[] {
  const rows = acks?.people?.rows ?? []
  return [...rows].sort((a, b) => a.site.code.localeCompare(b.site.code) || Number(a.seenCurrent) - Number(b.seenCurrent) || Number(a.workerHidden) - Number(b.workerHidden) || (a.worker?.name ?? '').localeCompare(b.worker?.name ?? ''))
}

/** The PDF sheet's languages (the shared document renderer's: Italian and English). */
export const SHEET_LANGUAGES = ['it', 'en'] as const
export type SheetLanguage = (typeof SHEET_LANGUAGES)[number]

export const sheetLanguageOf = (asked: string | null | undefined, pageLocale: string): SheetLanguage => (asked === 'it' || asked === 'en' ? asked : pageLocale === 'en' ? 'en' : 'it')

/** The window pages' addresses (a new tab). */
export const previewHref = (prefix: string, instructionId: string, versionId: string | null, language?: string | null): string =>
  `${prefix}/production/instructions/${encodeURIComponent(instructionId)}/preview${versionId || language ? `?${new URLSearchParams({ ...(versionId ? { version: versionId } : {}), ...(language ? { language } : {}) }).toString()}` : ''}`
export const sheetHref = (prefix: string, instructionId: string, versionId: string | null, language?: string | null): string =>
  `${prefix}/production/instructions/${encodeURIComponent(instructionId)}/sheet${versionId || language ? `?${new URLSearchParams({ ...(versionId ? { version: versionId } : {}), ...(language ? { language } : {}) }).toString()}` : ''}`

// ---- page helpers ---------------------------------------------------------------------------------------------------------------------

/** A key that belongs to the page: not while typing, not inside a dialog or a menu, no modifier. */
export function isPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return true
  if (target.isContentEditable) return false
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')
}

/** The ids still loaded after a re-read (a selection never points at a row that is gone). */
export function keepLoaded(selected: readonly string[], loaded: readonly { id: string }[] | null): string[] {
  if (!loaded) return []
  const ids = new Set(loaded.map((row) => row.id))
  return selected.filter((id) => ids.has(id))
}

/** Why Archive N / Restore N is held for the rows picked, or null. */
export function bulkStatusHeld(rows: readonly InstructionRow[], to: 'ARCHIVED' | 'ACTIVE', can: InstructionsCan, offline = false): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (rows.length === 0) return { key: 'held.pickRows' }
  if (to === 'ARCHIVED' && rows.every((row) => row.status === 'ARCHIVED')) return { key: 'held.allArchived' }
  if (to === 'ACTIVE' && rows.every((row) => row.status === 'ACTIVE')) return { key: 'held.allActive' }
  if (offline) return { key: 'held.offline' }
  return null
}

/** New instruction's draft: the operation, for every style or one style revision, blank or a copy of a version in force. */
export interface NewDraft {
  readonly operationId: string
  readonly scope: 'every' | 'revision'
  readonly styleId: string
  readonly revisionId: string
  readonly copyFrom: string
}

export const EMPTY_NEW: NewDraft = { operationId: '', scope: 'every', styleId: '', revisionId: '', copyFrom: '' }

/** Why New instruction cannot be made yet, or null. */
export function createHeld(draft: NewDraft, can: InstructionsCan, busy: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (!can.pickOperation) return { key: 'held.noOperations' }
  if (!draft.operationId) return { key: 'held.pickOperation' }
  if (draft.scope === 'revision' && !draft.revisionId) return { key: 'held.pickRevision' }
  if (busy) return { key: 'held.busy' }
  return null
}

// ---- reads ------------------------------------------------------------------------------------------------------------------------------

/** A read as the view draws it: loading, its value, or the problem's key (never drawn as empty). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

export const reading = <T>(): Read<T> => ({ status: 'loading' })
export const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
export const failed = <T>(problem: string): Read<T> => ({ status: 'error', problem })
export const valueOf = <T>(read: Read<T> | null | undefined): T | null => (read && read.status === 'ready' ? read.value : null)

/** A photo or video being uploaded to a step (or one whose upload failed, with the reason). */
export interface Upload {
  readonly key: string
  readonly stepKey: string
  readonly name: string
  readonly state: 'uploading' | 'failed'
  readonly problem: string | null
}

/** "What changed" of a draft against the version in force (the API's comparison of step codes), for the approval. */
export function changeSummary(answer: VersionAnswer | null): { readonly from: number | null; readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] } {
  const compared = answer?.comparedWith ?? null
  return { from: compared?.number ?? null, added: compared?.added ?? [], removed: compared?.removed ?? [], changed: compared?.changed ?? [] }
}

/** The sheet's failure in words: the company's legal data missing for the paper (art. 2250 c.c.) is said as such. */
export function sheetProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'invalid' && error.issues.some((issue) => issuePath(issue).replace(/\./g, '/').startsWith('company'))) return 'problem.sheetCompany'
  return readProblem(error)
}
