import { isApiError, issuePath } from '../../api/errors'
import type { ThreadFile } from './model'

/**
 * B-TH-231 — carry a file to another record (threads plan T9-F05; the API's POST /files/:fileId/use-on, B-TH-024, and its picker
 * GET /files/:fileId/use-on/targets): "Use on another record…" in a message's ⋯ and in the Files view (one file or the chosen
 * ones). The copy names its source (the Files view's "Copied from …" line); kind and category are kept; the office only, unless
 * the person shares it with the target's own customer (files.manage). The pure part; no React, no API.
 *
 * Brand wall (W25, W26; Owner rule 2026-11-16): the picker offers only records of the SAME customer as the file's record, or of
 * none (a file of no customer may go to any record); the API answers only those and refuses any other in words
 * (409 `refusal/OTHER_PARTY`), which this screen says without naming another customer.
 */

/** A record the API offers (GET /files/:fileId/use-on/targets). */
export interface UseOnTarget {
  readonly recordType: string
  readonly recordId: string
  readonly number: string | null
  readonly title: string
  readonly subtitle: string | null
  readonly area: string
  /** The target record's customer or supplier; null: none. */
  readonly partyId: string | null
}

/** Whose record it is, from the file's side: the same customer's, no customer's, or (for our own file) a customer's. */
export type UseOnRelation = 'same' | 'none' | 'customer'

export interface OfferedTarget extends UseOnTarget {
  readonly key: string
  readonly relation: UseOnRelation
}

export const targetKey = (target: Pick<UseOnTarget, 'recordType' | 'recordId'>): string => `${target.recordType}:${target.recordId}`

/**
 * What the picker lists: never the file's own record; for a file of a customer's record only that customer's records and records
 * of none (the API already answers only those: this is the screen's own check, so a stale or wrong answer never offers another
 * customer's record).
 */
export function offeredTargets(targets: readonly UseOnTarget[], from: { readonly recordType: string; readonly recordId: string; readonly partyId: string | null }): OfferedTarget[] {
  const seen = new Set<string>()
  const offered: OfferedTarget[] = []
  for (const target of targets) {
    const key = targetKey(target)
    if (seen.has(key) || (target.recordType === from.recordType && target.recordId === from.recordId)) continue
    if (from.partyId !== null && target.partyId !== null && target.partyId !== from.partyId) continue
    seen.add(key)
    offered.push({ ...target, key, relation: target.partyId === null ? 'none' : from.partyId !== null ? 'same' : 'customer' })
  }
  return offered
}

/** The words of a relation (keys of record-thread-files). */
export const relationKey = (relation: UseOnRelation): string => `useOn.relation.${relation}`

/** A target as one line: its number (else its title) and its title when both differ. */
export function targetLabel(target: Pick<UseOnTarget, 'number' | 'title'>): string {
  return target.number && target.number !== target.title ? `${target.number} · ${target.title}` : (target.number ?? target.title)
}

/** The files a carry may take: available ones the reader opens (a locked sheet or a held file never). */
export const carriable = <T extends Pick<ThreadFile, 'status'> & { readonly locked?: string | undefined }>(files: readonly T[]): T[] => files.filter((file) => file.status === 'AVAILABLE' && !file.locked)

/** The query is long enough to search (the API's own rule: three characters, spaces aside). */
export const queryReady = (query: string): boolean => query.replace(/\s/g, '').length >= 3

/**
 * Why a carry was refused, in this screen's words (keys of record-thread-files): another customer's record (never named), a
 * record or file not found (out of reach, as a wrong id), no right to add or to share files there, the file's own record, a
 * record whose files its own screen keeps, the network; anything else "could not copy".
 */
export function useOnRefusal(error: unknown): string {
  if (!isApiError(error)) return 'useOn.refused.network'
  const paths = error.issues.map(issuePath)
  if (paths.includes('refusal/OTHER_PARTY')) return 'useOn.refused.otherParty'
  if (paths.includes('body/recordId')) return 'useOn.refused.sameRecord'
  if (paths.includes('body/recordType')) return 'useOn.refused.owned'
  if (error.kind === 'not_found') return 'useOn.refused.notFound'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'useOn.refused.forbidden'
  if (error.kind === 'unavailable') return 'useOn.refused.network'
  if (error.kind === 'conflict') return 'useOn.refused.state'
  return 'useOn.refused.failed'
}

/** The outcome of carrying several files: how many went, and the names that did not (each with its reason key). */
export interface UseOnOutcome {
  readonly copied: number
  readonly failed: readonly { readonly name: string; readonly reason: string }[]
}

/** Where a copy came from, as the Files view says it ("Copied from Sales order · photo.jpg, version 2"); null: not a copy. */
export interface FileSource {
  readonly recordType: string
  readonly recordId: string
  readonly name: string
  readonly versionNo: number
}

/** The source line's words: the record's type and the file's name and version; a copy whose source the reader may not open says so. */
export function sourceLine(file: { readonly sourceFileId?: string | null; readonly source?: FileSource | null }): { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null {
  if (!file.sourceFileId) return null
  if (!file.source) return { key: 'useOn.source.hidden' }
  return file.source.name ? { key: 'useOn.source.line', params: { name: file.source.name, n: file.source.versionNo } } : { key: 'useOn.source.locked' }
}

/** What a refused file read says (B-TH-029: a file out of the reader's reach is "One file you cannot open"; keys of record-thread). */
export function openRefusal(error: unknown): 'notice.cannotOpen' | 'notice.openFailed' {
  return isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden') ? 'notice.cannotOpen' : 'notice.openFailed'
}
