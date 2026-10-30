import type { DroppedLine, PartyRow } from '../api'

/**
 * Duplicate a quote (design sales.quotes row verb "Duplicate (W2a)"; SAL-155 on B-W2a-30's API): a NEW draft quote with
 * its own number, copied from a version of this one, for the same customer (its terms, addresses and contact) or another
 * customer of the company (that customer's own defaults). What the copy left out is said, in words, before the new quote
 * opens.
 */

export interface DuplicateSource {
  id: string
  number: string
  partyId: string
  partyName: string
  revision: number
  /** The versions to copy from (newest first); empty: the current one only. */
  versions: ReadonlyArray<{ id: string; revision: number; status: string }>
}

export interface DuplicateDone {
  quoteId: string
  number: string
  lines: number
  dropped: DroppedLine[]
  warnings: string[]
}

export interface DuplicateModel {
  source: DuplicateSource
  /** For the same customer, or another one picked below. */
  target: 'same' | 'other'
  /** '' = the current version. */
  versionId: string
  query: string
  results: PartyRow[] | null
  searchProblem: string | null
  party: PartyRow | null
  busy: boolean
  problem: string | null
  done: DuplicateDone | null
}

export interface DuplicateActions {
  onDuplicateField?: (patch: Partial<Pick<DuplicateModel, 'target' | 'versionId'>>) => void
  onDuplicateSearch?: (query: string) => void
  onDuplicatePick?: (party: PartyRow | null) => void
  onDuplicate?: () => void
  onDuplicateClose?: () => void
  onDuplicateOpen?: (quoteId: string) => void
}

export function duplicateOf(source: DuplicateSource): DuplicateModel {
  return { source, target: 'same', versionId: '', query: '', results: null, searchProblem: null, party: null, busy: false, problem: null, done: null }
}

/** Why Duplicate is held (a `sales` key), or null. */
export function duplicateHeld(model: DuplicateModel, canManage: boolean): string | null {
  if (!canManage) return 'held.noManage'
  if (model.target === 'other' && !model.party) return 'dup.held.customer'
  if (model.target === 'other' && model.party && model.party.status !== 'ACTIVE') return 'dup.held.inactive'
  if (model.busy) return 'held.busy'
  return null
}

/** The body the API takes: only what differs from "the current version for the same customer". */
export function duplicateBody(model: DuplicateModel): { versionId?: string; partyId?: string } {
  return {
    ...(model.versionId ? { versionId: model.versionId } : {}),
    ...(model.target === 'other' && model.party && model.party.id !== model.source.partyId ? { partyId: model.party.id } : {}),
  }
}
