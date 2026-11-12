import type { Issue } from '../../core/errors'
import { STEP_CODE, stepsOfInstructions, type ChecklistStep } from '../checklists/rules'

/**
 * Work instructions (B-W2b-214; PRD-117, MES-110, MES-119; design production.instructions SCR-141, floor.instructions
 * SCR-174, floor.operation "New instruction (MES-110 opens it first)"). Pure rules; apps/factory-api
 * modules/production/instructions applies them. The schema is B-W2b-205's (instructions.prisma); its guards
 * (…_routings_instructions_w2b_guards) are the last word, and every one a route here can meet is said here first, in words.
 *
 * An instruction belongs to a library operation of a company, for every style or for one style revision. Its content is
 * its versions: a DRAFT is written (steps with words per language, a critical point, a safety note, an icon and the tick
 * the tablet asks, with photos and short videos), a second person approves it (never its author) and it is PUBLISHED, the
 * one before it SUPERSEDED in the same command; a published version never changes. The floor finds the instruction of the
 * operation in hand: the work order's own revision's first, else the operation's for every style.
 *
 * Its steps are the operation's checklist (B-W2b-47): a step whose tick is required holds Finish until it is ticked (the
 * tick and hold rules of production/checklists stay as they are). Until an instruction of the operation is published, the
 * `[ ] CODE words` lines typed in the routing step stay the steps; they are brought into a first version once (a DRAFT,
 * which a second person publishes).
 *
 * Acknowledgements (MES-119) are a training record (D.Lgs. 81/2008 art. 37): a worker saw this version, in this language,
 * on this tablet, at this time. Per person only to HR and the person, never a count, a ranking or a filter per worker
 * (Owner answers F2, H3, W1). A version that asks for it opens before Start (MES-110) until the worker taps Seen, once.
 */

export const VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED'] as const
export type VersionStatus = (typeof VERSION_STATUSES)[number]

/** What the floor may read: a published version and one it replaced (an old printed page, a queued Seen). */
export const FLOOR_STATUSES: readonly VersionStatus[] = Object.freeze(['PUBLISHED', 'SUPERSEDED'])

export const MEDIA_KINDS = ['PHOTO', 'VIDEO'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

/** A photo is a picture; a video a short clip shown muted and looping (stored as a PHOTO file with a video type: no video kind of file yet). */
export const MEDIA_TYPES: Readonly<Record<MediaKind, readonly string[]>> = Object.freeze({
  PHOTO: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
  VIDEO: Object.freeze(['video/mp4', 'video/webm', 'video/quicktime']),
})

/**
 * The steps panel's icons (design floor.operation StepsPanel, floor.instructions FloorMediaSteps): the keys a step may name,
 * lower case with hyphens (the database's pattern); the tablet draws each with its own picture, the plain mark for none.
 */
export const INSTRUCTION_ICONS = Object.freeze([
  'needle',
  'thread',
  'scissors',
  'ruler',
  'check',
  'eye',
  'hand',
  'shield',
  'alert',
  'flame',
  'iron',
  'glue',
  'zip',
  'button',
  'label',
  'layers',
  'tape',
  'stamp',
  'package',
] as const)
export type InstructionIcon = (typeof INSTRUCTION_ICONS)[number]

/** A language key of words (the database's: `it`, `en`, `ro`, `zh-Hans`). */
export const WORDS_LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
/** The language an acknowledgement records (ISO 639-1, the database's). */
export const ACK_LANGUAGE = /^[a-z]{2}$/

export const INSTRUCTION_LIMITS = Object.freeze({
  steps: 60,
  words: 600,
  safety: 400,
  caption: 200,
  mediaPerStep: 6,
  languages: 12,
  changeNote: 1000,
  reason: 500,
})

/** The languages an office reads the steps in when the person's own is missing. */
export const FALLBACK_LANGUAGES: readonly string[] = Object.freeze(['it', 'en'])

export type Words = Readonly<Record<string, string>>

export interface MediaDraft {
  readonly fileId: string
  readonly kind: MediaKind
  readonly caption?: Words | null | undefined
}

/** A step as the office writes it (the whole version is saved at once: a version is a document). */
export interface StepDraft {
  readonly code: string
  readonly text: Words
  readonly critical?: boolean | undefined
  readonly safety?: Words | null | undefined
  readonly icon?: string | null | undefined
  /** Finish waits for a tick of it (B-W2b-47's `[ ]`); false: the tick is optional (`[o]`). */
  readonly requiredTick?: boolean | undefined
  readonly media?: readonly MediaDraft[] | undefined
}

/** Words per language: at least one language when required, no blank one, known keys, each within its length. */
export function wordsProblems(words: Words | null | undefined, at: string, limit: number, required: boolean): Issue[] {
  if (words === null || words === undefined) return required ? [{ path: at, message: 'Write the words in at least one language.' }] : []
  const entries = Object.entries(words)
  const problems: Issue[] = []
  if (required && entries.length === 0) problems.push({ path: at, message: 'Write the words in at least one language.' })
  if (entries.length > INSTRUCTION_LIMITS.languages) problems.push({ path: at, message: `At most ${INSTRUCTION_LIMITS.languages} languages.` })
  for (const [language, text] of entries) {
    if (!WORDS_LANGUAGE.test(language)) problems.push({ path: `${at}/${language}`, message: 'A language is an ISO 639 code in lower case (it, en, ro).' })
    else if (typeof text !== 'string' || text.trim() === '') problems.push({ path: `${at}/${language}`, message: 'Words are never blank: take the language out instead.' })
    else if (text.length > limit) problems.push({ path: `${at}/${language}`, message: `At most ${limit} characters.` })
  }
  return problems
}

/** Words with every text trimmed (the stored form). */
export const trimmedWords = (words: Words): Record<string, string> => Object.fromEntries(Object.entries(words).map(([language, text]) => [language, text.trim()]))

/** The problems of a version's steps, each at its place (`steps/2/code`, `steps/0/text/it` …). */
export function stepsProblems(steps: readonly StepDraft[]): Issue[] {
  const problems: Issue[] = []
  if (steps.length > INSTRUCTION_LIMITS.steps) problems.push({ path: 'steps', message: `At most ${INSTRUCTION_LIMITS.steps} steps.` })
  const seen = new Set<string>()
  steps.forEach((step, index) => {
    const at = `steps/${index}`
    if (!STEP_CODE.test(step.code)) problems.push({ path: `${at}/code`, message: 'A step code is 1 to 40 capitals, digits, underscores or hyphens (SEAM_ALLOWANCE): the tablet ticks it by that code.' })
    else if (seen.has(step.code)) problems.push({ path: `${at}/code`, message: `${step.code} is the code of an earlier step: each step has its own.` })
    seen.add(step.code)
    problems.push(...wordsProblems(step.text, `${at}/text`, INSTRUCTION_LIMITS.words, true))
    problems.push(...wordsProblems(step.safety, `${at}/safety`, INSTRUCTION_LIMITS.safety, false))
    if (step.icon !== undefined && step.icon !== null && !(INSTRUCTION_ICONS as readonly string[]).includes(step.icon)) problems.push({ path: `${at}/icon`, message: `An icon is one of ${INSTRUCTION_ICONS.join(', ')}.` })
    const media = step.media ?? []
    if (media.length > INSTRUCTION_LIMITS.mediaPerStep) problems.push({ path: `${at}/media`, message: `At most ${INSTRUCTION_LIMITS.mediaPerStep} photos or videos per step.` })
    const files = new Set<string>()
    media.forEach((medium, place) => {
      if (files.has(medium.fileId)) problems.push({ path: `${at}/media/${place}/fileId`, message: 'The same file is on this step already.' })
      files.add(medium.fileId)
      problems.push(...wordsProblems(medium.caption, `${at}/media/${place}/caption`, INSTRUCTION_LIMITS.caption, false))
    })
  })
  return problems
}

/** The kind of medium a file's type allows, or a problem in words (the database says the same: a PHOTO is image/*, a VIDEO video/*). */
export function mediaTypeProblem(kind: MediaKind, contentType: string): string | null {
  if (MEDIA_TYPES[kind].includes(contentType.toLowerCase())) return null
  return kind === 'PHOTO' ? `A photo is a picture (${MEDIA_TYPES.PHOTO.join(', ')}).` : `A video is a short clip (${MEDIA_TYPES.VIDEO.join(', ')}).`
}

/**
 * The words in one language: the one asked, else the first of the fallbacks the words have, else the first language they
 * have; null for no words. `language` says which was taken (the tablet marks a step not in the worker's language).
 */
export function wordsIn(words: Words | null | undefined, wanted: string | null | undefined, fallbacks: readonly string[] = FALLBACK_LANGUAGES): { readonly text: string; readonly language: string } | null {
  if (!words) return null
  for (const language of [wanted, ...fallbacks]) {
    if (language && typeof words[language] === 'string' && words[language]!.trim() !== '') return { text: words[language]!, language }
  }
  const first = Object.entries(words).find(([, text]) => typeof text === 'string' && text.trim() !== '')
  return first ? { text: first[1], language: first[0] } : null
}

/** Every language a version's steps are written in, sorted. */
export function languagesOf(steps: readonly { readonly text: Words }[]): string[] {
  return [...new Set(steps.flatMap((step) => Object.keys(step.text)))].sort()
}

/** The languages a step lacks of those the floor reads (design: "missing language marked per step"). */
export const missingLanguages = (text: Words, wanted: readonly string[]): string[] => wanted.filter((language) => !(typeof text[language] === 'string' && text[language]!.trim() !== ''))

// ---- the steps as the tablet ticks them ------------------------------------------------------------------------------------

/** A checklist step (B-W2b-47) with what an instruction adds: its icon and whether it is a critical point. */
export interface MarkedStep extends ChecklistStep {
  readonly icon: string | null
  readonly critical: boolean
}

export interface InstructionStepRow {
  readonly code: string
  readonly sortOrder: number
  readonly textI18n: unknown
  readonly critical: boolean
  readonly icon: string | null
  readonly requiredTick: boolean
}

/** A JSON value as words (anything else is no words). */
export function asWords(value: unknown): Words {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
}

/** A published version's steps as the checklist: in their order, a code once (the first), words in the language asked. */
export function checklistOfSteps(rows: readonly InstructionStepRow[], language?: string | null): MarkedStep[] {
  const steps = new Map<string, MarkedStep>()
  for (const row of [...rows].sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) {
    if (steps.has(row.code)) continue
    steps.set(row.code, { code: row.code, words: wordsIn(asWords(row.textI18n), language)?.text ?? row.code, required: row.requiredTick, icon: row.icon, critical: row.critical })
  }
  return [...steps.values()]
}

/** The typed lines of a routing step as the checklist (until an instruction of the operation is published). */
export const checklistOfLines = (instructions: string | null): MarkedStep[] => stepsOfInstructions(instructions).map((step) => ({ ...step, icon: null, critical: false }))

/**
 * Which instruction applies to an operation of a work order: of the work order's company and the library operation, ACTIVE,
 * the one for the work order's own style revision first, else the one for every style (B-W2b-205's lookup). The database
 * keeps at most one ACTIVE of each kind.
 */
export function instructionFor<Row extends { readonly styleRevisionId: string | null; readonly status: string }>(candidates: readonly Row[], revisionId: string | null): Row | null {
  const active = candidates.filter((row) => row.status === 'ACTIVE')
  return (revisionId ? active.find((row) => row.styleRevisionId === revisionId) : undefined) ?? active.find((row) => row.styleRevisionId === null) ?? null
}

// ---- the typed lines brought into a first version ----------------------------------------------------------------------------

/**
 * The `[ ] CODE words` / `[o] CODE words` lines of a routing step as the steps of a first version: the same codes (a tick
 * already made names them), the words in the language the office typed them in, a `[ ]` line's tick required. Other lines
 * stay the routing's plain instructions.
 */
export function stepsFromTypedLines(instructions: string | null, language: string): StepDraft[] {
  return stepsOfInstructions(instructions).map((step) => ({ code: step.code, text: { [language]: step.words }, critical: false, safety: null, icon: null, requiredTick: step.required, media: [] }))
}

// ---- publishing (approval by a second person) ------------------------------------------------------------------------------

export interface Refusal {
  readonly code: string
  readonly message: string
}

export interface PublishFacts {
  readonly number: number
  readonly status: VersionStatus
  readonly authorId: string
  /** Everyone who saved a change to the draft (its audit rows; the author may be among them). */
  readonly editorIds: readonly string[]
  readonly approverId: string
  readonly instructionNumber: string
  readonly instructionActive: boolean
  readonly changeNote: string | null
  readonly steps: number
  /** Media whose file is not AVAILABLE (still uploading, held for its scan, deleted). */
  readonly mediaNotReady: number
}

/** Why this person cannot publish this version now, in the words the database's guard would use, or null. */
export function publishRefusal(facts: PublishFacts): Refusal | null {
  const v = `Version ${facts.number} of ${facts.instructionNumber}`
  if (facts.status !== 'DRAFT') return { code: 'NOT_DRAFT', message: facts.status === 'DISCARDED' ? `${v} was discarded: a discarded draft is never published.` : `${v} is ${facts.status.toLowerCase()} already: a published version never changes.` }
  if (facts.authorId === facts.approverId) return { code: 'OWN_DRAFT', message: `${v} is your own draft: another person approves it (four eyes).` }
  // Nobody approves their own work, the Owner included (Owner W2b-5 Q3): a person who changed the draft is never its approver.
  if (facts.editorIds.includes(facts.approverId)) return { code: 'EDITED_DRAFT', message: `You changed version ${facts.number} of ${facts.instructionNumber}: a person who neither wrote nor changed it approves it (four eyes).` }
  if (!facts.instructionActive) return { code: 'ARCHIVED', message: `${facts.instructionNumber} is archived: restore it before publishing a version.` }
  if (facts.steps === 0) return { code: 'NO_STEPS', message: `${v} has no step: write at least one before it goes to the floor.` }
  if (facts.number > 1 && !(facts.changeNote ?? '').trim()) return { code: 'CHANGE_NOTE_MISSING', message: `${v} needs a change note: say what changed from the version before, for the people who saw it.` }
  if (facts.mediaNotReady > 0) return { code: 'MEDIA_NOT_READY', message: `${v} has ${facts.mediaNotReady === 1 ? 'a photo or video' : `${facts.mediaNotReady} photos or videos`} not uploaded yet: finish the upload or take ${facts.mediaNotReady === 1 ? 'it' : 'them'} off.` }
  return null
}

/** A draft that is not a draft any more: its content never changes. */
export function notDraftRefusal(number: number, status: VersionStatus): Refusal {
  return status === 'DISCARDED'
    ? { code: 'NOT_DRAFT', message: `Version ${number} was discarded: it never changes. Draft a new version.` }
    : { code: 'NOT_DRAFT', message: `Version ${number} is ${status.toLowerCase()}: a published version never changes. Draft a new version to change it.` }
}

// ---- Seen (MES-119) and the version that opens before Start (MES-110) ------------------------------------------------------

export const ACK_DUE = ['FIRST', 'CHANGED'] as const
export type AckDue = (typeof ACK_DUE)[number]

/**
 * Whether the worker is asked to look at the version in force and tap Seen: never once they saw it; a version that asks
 * for it when they saw an earlier one (CHANGED) or none (FIRST); a version that does not ask (a wording fix) only the first
 * time they meet the instruction at all.
 */
export function acknowledgementDue(input: { readonly required: boolean; readonly seenThis: boolean; readonly seenEarlier: boolean }): AckDue | null {
  if (input.seenThis) return null
  if (input.seenEarlier) return input.required ? 'CHANGED' : null
  return 'FIRST'
}

/** Seen of a version that is not the floor's (a draft, a discarded one): the database's guard in words. */
export const notPublishedRefusal = (number: number): Refusal => ({ code: 'NOT_PUBLISHED', message: `Version ${number} is not published: only a version shown on the floor is seen.` })
