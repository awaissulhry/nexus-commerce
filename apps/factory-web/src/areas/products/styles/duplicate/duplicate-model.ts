import { COPY_PARTS, COPYABLE_PARTS, type CopyablePart, type CopyPart } from '@nexus/factory-domain/product/styles/copy'
import type { DuplicatedView, DuplicateInput, DuplicateOfferView, StyleRow } from '../api'
import type { StyleAbilities, Words } from '../model'

/**
 * Duplicate style (W2a, PRD-011; design products.styles pop:styles.duplicate, and "Start from: Copy of a style" in New
 * style), pure: what the dialog offers, holds and sends. The API decides what a copy can take (`GET …/duplicate`: each
 * part available or why not) and makes it (`POST …/duplicate`); its reasons and notes are English sentences for logs,
 * so this file says them in the app's words (`partWords`, `noteWords`) — a sentence it does not know gets a plain word
 * of ours, never the API's text.
 */

export { COPY_PARTS, COPYABLE_PARTS, type CopyablePart, type CopyPart }

export type Offer = DuplicateOfferView
export type OfferPart = Offer['parts'][number]
export type Duplicated = DuplicatedView

/** A read of the offer: its own little state (the dialog stays usable while it loads or fails). */
export type OfferState = { status: 'loading' } | { status: 'ready'; value: Offer } | { status: 'error'; problem: string }

export interface DuplicateDraft {
  code: string
  name: string
  /** '' keeps the source's season. */
  season: string
  parts: CopyablePart[]
  generateSkus: boolean
}

export interface SourcePick {
  query: string
  results: StyleRow[] | null
  problem: string | null
}

export interface DuplicateModel {
  /** The style copied; null while the person picks it (New style › Start from: Copy of a style). */
  source: { id: string; code: string; name: string } | null
  /** The style search of the picker (only while `source` is null). */
  pick: SourcePick | null
  offer: OfferState | null
  draft: DuplicateDraft
  busy: boolean
  /** A refused copy in our words (a message key). */
  problem: string | null
  /** The fields the API refused (their paths: `code`, `parts/1`). */
  refused: string[]
  /** The copy made: what it took and what it left out, with "Open the copy". */
  done: Duplicated | null
}

export const blankDraft = (): DuplicateDraft => ({ code: '', name: '', season: '', parts: [], generateSkus: false })

/** A code the copy may take (the API's STYLE_CODE): letters, digits, `.` `_` `-`, 1–24, no separator at either end. */
export const STYLE_CODE = /^[A-Z0-9](?:[A-Z0-9._-]{0,22}[A-Z0-9])?$/

/** The draft a fresh offer suggests: "<code>-COPY" and the source's name, every available part ticked. */
export function draftFor(offer: Offer, current: DuplicateDraft = blankDraft()): DuplicateDraft {
  const suggested = `${offer.source.code}-COPY`.slice(0, 24).replace(/[._-]+$/, '')
  return {
    ...current,
    code: current.code || suggested,
    name: current.name || offer.source.name,
    parts: offer.parts.filter((part) => part.available && isCopyable(part.part)).map((part) => part.part as CopyablePart),
  }
}

export const isCopyable = (part: CopyPart): part is CopyablePart => (COPYABLE_PARTS as readonly string[]).includes(part)

/** The parts in the dialog's order (the design's: BOM · measurements · routing · labels · pictures · options). */
export const PART_ORDER: readonly CopyPart[] = ['BOM', 'MEASUREMENTS', 'ROUTING', 'LABELS', 'PICTURES', 'OPTIONS']

export function orderedParts(offer: Offer): OfferPart[] {
  return PART_ORDER.flatMap((part) => offer.parts.filter((entry) => entry.part === part))
}

/** Ticking a part (only an available one moves). */
export function togglePart(draft: DuplicateDraft, offer: Offer, part: CopyPart): DuplicateDraft {
  const entry = offer.parts.find((item) => item.part === part)
  if (!entry?.available || !isCopyable(part)) return draft
  const parts = draft.parts.includes(part) ? draft.parts.filter((item) => item !== part) : [...draft.parts, part]
  return { ...draft, parts: COPYABLE_PARTS.filter((item) => parts.includes(item)) }
}

/**
 * What a part holds or why it cannot be picked, in our words. The API's reasons (styles/duplicate.ts partOffers) are
 * read by their shape: no revision yet, a revision without BOM lines / steps / label, the style's own label, a retired
 * label, a right the person lacks, not made to measure, and the W2b parts.
 */
export function partWords(part: OfferPart, offer: Pick<Offer, 'source' | 'revision'>): Words {
  const revision = offer.revision?.revision ?? 0
  if (part.part === 'PICTURES' || part.part === 'OPTIONS') return { key: `duplicate.reason.${part.part}` }
  if (part.available) {
    if (part.part === 'BOM') return part.count === null ? { key: 'duplicate.holds.bomHidden' } : { key: 'duplicate.holds.bom', params: { count: part.count, revision } }
    if (part.part === 'ROUTING') return part.count === null ? { key: 'duplicate.holds.routingHidden' } : { key: 'duplicate.holds.routing', params: { count: part.count, revision } }
    if (part.part === 'LABELS') return { key: 'duplicate.holds.label', params: { revision } }
    return { key: 'duplicate.holds.measurements' }
  }
  const reason = part.reason ?? ''
  if (/needs /.test(reason)) return { key: `duplicate.reason.noRight.${part.part}` }
  if (part.part === 'MEASUREMENTS') return { key: 'duplicate.reason.notMtm', params: { code: offer.source.code } }
  if (offer.revision === null || /has no revision/.test(reason)) return { key: 'duplicate.reason.noRevision', params: { code: offer.source.code } }
  if (part.part === 'BOM') return { key: 'duplicate.reason.noLines', params: { revision } }
  if (part.part === 'ROUTING') return { key: 'duplicate.reason.noSteps', params: { revision } }
  const label = /^Label (\S+) r(\d+)/.exec(reason)
  if (/own label/.test(reason)) return { key: 'duplicate.reason.ownLabel', params: { label: label ? `${label[1]} r${label[2]}` : '—', code: offer.source.code } }
  if (/retired/.test(reason)) return { key: 'duplicate.reason.retiredLabel', params: { label: label ? `${label[1]} r${label[2]}` : '—' } }
  if (/no garment label/.test(reason)) return { key: 'duplicate.reason.noLabel', params: { revision } }
  return { key: 'duplicate.reason.other' }
}

/** A note of the copy (what it left out) in our words (styles/duplicate.ts duplicateStyle's notes, read by their shape). */
export function noteWords(note: string): Words {
  const sizes = /^Size\(s\) (.+) are archived in the scale/.exec(note)
  if (sizes) return { key: 'duplicate.note.sizes', params: { sizes: sizes[1]! } }
  const colourways = /^(\d+) archived colourway\(s\) are not copied/.exec(note)
  if (colourways) return { key: 'duplicate.note.colourways', params: { count: Number(colourways[1]) } }
  const colour = /^Colourway (\S+): its library colour/.exec(note)
  if (colour) return { key: 'duplicate.note.colour', params: { code: colour[1]! } }
  const lines = /^(\d+) BOM line\(s\) of archived colourways/.exec(note)
  if (lines) return { key: 'duplicate.note.lines', params: { count: Number(lines[1]) } }
  return { key: 'duplicate.note.other' }
}

/** Why Duplicate is held (a message key and params), or null when the copy may be asked for. */
export function duplicateHeld(model: Pick<DuplicateModel, 'source' | 'offer' | 'draft' | 'busy'>, can: Pick<StyleAbilities, 'manage'>): Words | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (!model.source) return { key: 'duplicate.held.source' }
  if (!model.offer || model.offer.status === 'loading') return { key: 'duplicate.held.reading' }
  if (model.offer.status === 'error') return { key: 'duplicate.held.offer' }
  const code = model.draft.code.trim().toUpperCase()
  if (!STYLE_CODE.test(code)) return { key: 'duplicate.held.code' }
  if (code === model.offer.value.source.code) return { key: 'duplicate.held.sameCode' }
  if (model.draft.name.trim() === '') return { key: 'duplicate.held.name' }
  if (model.busy) return { key: 'held.busy' }
  return null
}

/** The body of `POST …/duplicate`: what the person typed and ticked (the rest is the source's). */
export function duplicateBody(draft: DuplicateDraft, offer: Offer): DuplicateInput {
  const season = draft.season.trim()
  return {
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim(),
    ...(season ? { season } : {}),
    parts: COPYABLE_PARTS.filter((part) => draft.parts.includes(part) && offer.parts.some((entry) => entry.part === part && entry.available)),
    ...(offer.revision ? { fromRevisionId: offer.revision.id } : {}),
    ...(draft.generateSkus ? { generateSkus: true } : {}),
  }
}

/** A refused field the dialog points at: `code` (taken or malformed), `name`, `parts/<i>` (the API's `body/` taken off). */
export function refusedAt(refused: readonly string[], field: string): boolean {
  return refused.map((path) => path.replace(/^body[./]/, '')).some((path) => path === field || path.startsWith(`${field}/`) || path.startsWith(`${field}.`))
}

/** A refused copy in our words: a taken code, a part the offer holds now (read the offer again), or the usual problem. */
export function duplicateProblemKey(problem: { key: string; paths: readonly string[] }): string {
  if (problem.key === 'problem.write.codeTaken' || problem.key === 'problem.write.invalid') return problem.key
  if (refusedAt(problem.paths, 'parts')) return 'duplicate.problem.part'
  return problem.key
}
