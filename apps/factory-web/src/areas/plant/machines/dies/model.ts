import { DIE_REFUSALS, DIE_ROW_CONDITIONS, DIE_ROWS, normalDieCode, DIE_CODE, type DieRows } from '@nexus/factory-domain/plant/machines/dies'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { costMinorOf, minorText, type Tone } from '../../_shared/model'
import type { DieCondition, DieFields, Die, StyleChoice } from './api'

/**
 * The clicking-die register's pure rules (B-W2b-136; QHS-173; design plant.machines "Clicking dies"): what a person may
 * do, the section's own address terms (prefixed `d`, so they never clash with the machines page's), the saved rows ⇄ the
 * API's conditions, the New die draft and why Create waits, a refusal or a failure in the section's words
 * (`plant-dies` catalogue), the condition's tone, the CSV of the selected dies. Nothing here fetches.
 */

export { DIE_ROWS, type DieRows }

// ---- what a person may do -----------------------------------------------------------------------------------------------

export interface DieCan {
  readonly view: boolean
  readonly manage: boolean
  readonly cost: boolean
  readonly parties: boolean
}

export function dieCan(permissions: readonly string[]): DieCan {
  const held = new Set(permissions)
  return { view: held.has('plant.view'), manage: held.has('plant.machines.manage'), cost: held.has('money.cost'), parties: held.has('parties.view') }
}

// ---- the address ----------------------------------------------------------------------------------------------------------

export interface ParamsLike {
  get(name: string): string | null
  forEach?(callback: (value: string, key: string) => void): void
}

export interface DiesAddress {
  /** `dq`: the words searched. */
  q: string
  /** `drows`: the saved rows. */
  rows: DieRows
  /** `dnew=1`: the New die dialog. */
  isNew: boolean
}

export function diesAddressOf(params: ParamsLike | null): DiesAddress {
  const rows = params?.get('drows') ?? ''
  return { q: params?.get('dq') ?? '', rows: (DIE_ROWS as readonly string[]).includes(rows) ? (rows as DieRows) : 'inUse', isNew: params?.get('dnew') === '1' }
}

/** The page's address with the section's terms set (every other term kept as it was). */
export function withDiesAddress(current: string, next: DiesAddress): string {
  const query = new URLSearchParams(current.startsWith('?') ? current.slice(1) : current)
  for (const name of ['dq', 'drows', 'dnew']) query.delete(name)
  if (next.q.trim()) query.set('dq', next.q.trim())
  if (next.rows !== 'inUse') query.set('drows', next.rows)
  if (next.isNew) query.set('dnew', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** The API's filters of a saved row and a search, at the page's site (null: every site the person reaches). */
export function diesQuery(address: Pick<DiesAddress, 'q' | 'rows'>, siteId: string | null): { siteId: string | null; condition: DieCondition[]; q?: string } {
  return { siteId, condition: [...DIE_ROW_CONDITIONS[address.rows]], ...(address.q.trim() ? { q: address.q.trim() } : {}) }
}

/** Something narrows the list (an empty answer is then "nothing matches", not "no dies registered"). */
export const diesFiltered = (address: Pick<DiesAddress, 'q' | 'rows'>): boolean => address.rows !== 'inUse' || address.q.trim() !== ''

// ---- words ------------------------------------------------------------------------------------------------------------------

/** A message key of the `plant-dies` catalogue and its params. */
export interface DieWords {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export const CONDITION_TONE: Readonly<Record<DieCondition, Tone>> = { GOOD: 'success', WORN: 'warning', DAMAGED: 'danger', RETIRED: 'neutral' }

/** The fields whose 400 the section says in its own words. */
const FIELD_PROBLEMS = new Set(['code', 'piece', 'size', 'rackLocation', 'material', 'purchaseCost', 'supplierId', 'siteId'])

/** The die refusal an API error carries (409 `refusal/<CODE>`), or null. */
export function dieRefusalOf(error: unknown): (typeof DIE_REFUSALS)[number] | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!path.startsWith('refusal/')) continue
    const code = path.slice('refusal/'.length)
    if ((DIE_REFUSALS as readonly string[]).includes(code)) return code as (typeof DIE_REFUSALS)[number]
  }
  return null
}

/** The body field an API 400 names, or null. */
export function dieFieldOf(error: unknown): string | null {
  if (!isApiError(error) || error.kind !== 'invalid') return null
  for (const issue of error.issues) {
    const path = issuePath(issue).replace(/^body[./]/, '')
    if (path) return path.split(/[./]/)[0]!
  }
  return null
}

/** The words of a failed call: a refusal by its code, a named field, else the kind of failure. */
export function dieProblemOf(error: unknown): DieWords {
  const refusal = dieRefusalOf(error)
  if (refusal) return { key: `refusal.${refusal}` }
  if (!isApiError(error)) return { key: 'problem.unavailable' }
  if (error.kind === 'invalid') {
    const field = dieFieldOf(error)
    if (field && FIELD_PROBLEMS.has(field)) return { key: `problem.field.${field}` }
  }
  switch (error.kind) {
    case 'signed_out':
      return { key: 'problem.signedOut' }
    case 'forbidden':
      return { key: 'problem.forbidden' }
    case 'not_found':
      return { key: 'problem.notFound' }
    case 'conflict':
      return { key: 'problem.conflict' }
    case 'invalid':
      return { key: 'problem.invalid' }
    case 'rate_limited':
      return { key: 'problem.rateLimited' }
    case 'unavailable':
      return { key: 'problem.unavailable' }
    default:
      return { key: 'problem.internal' }
  }
}

// ---- New die ----------------------------------------------------------------------------------------------------------------

export interface DieDraft {
  siteId: string | null
  code: string
  style: StyleChoice | null
  /** '' = every size. */
  size: string
  piece: string
  patternPieceId: string | null
  rackLocation: string
  material: string
  supplier: { id: string; code: string; legalName: string } | null
  /** As typed ("185,00"). */
  cost: string
  note: string
}

export const blankDieDraft = (siteId: string | null): DieDraft => ({ siteId, code: '', style: null, size: '', piece: '', patternPieceId: null, rackLocation: '', material: '', supplier: null, cost: '', note: '' })

/** Why New die may not be created yet (a message key of `plant-dies`), or null. */
export function dieDraftHeld(draft: DieDraft, can: DieCan): string | null {
  if (!can.manage) return 'held.noManage'
  if (!draft.siteId) return 'held.siteNeeded'
  const code = normalDieCode(draft.code)
  if (!code || code.length > 40 || !DIE_CODE.test(code)) return 'held.codeNeeded'
  if (!draft.style) return 'held.styleNeeded'
  if (draft.piece.trim() === '') return 'held.pieceNeeded'
  if (can.cost && draft.cost.trim() !== '' && costMinorOf(draft.cost) === undefined) return 'held.costBad'
  return null
}

/** The body of POST /plant/dies from a draft Create allows (the cost only with the grain). */
export function createBodyOf(draft: DieDraft, can: DieCan): DieFields & { siteId: string; code: string; styleId: string; piece: string } {
  const cost = costMinorOf(draft.cost)
  const text = (value: string) => (value.trim() === '' ? undefined : value.trim())
  return {
    siteId: draft.siteId!,
    code: normalDieCode(draft.code),
    styleId: draft.style!.id,
    piece: draft.piece.trim(),
    ...(draft.size ? { size: draft.size } : {}),
    ...(draft.patternPieceId ? { patternPieceId: draft.patternPieceId } : {}),
    ...(text(draft.rackLocation) ? { rackLocation: text(draft.rackLocation)! } : {}),
    ...(text(draft.material) ? { material: text(draft.material)! } : {}),
    ...(draft.supplier ? { supplierId: draft.supplier.id } : {}),
    ...(can.cost && typeof cost === 'number' ? { purchaseCost: cost } : {}),
    ...(text(draft.note) ? { note: text(draft.note)! } : {}),
  }
}

/** A rack typed inline: the change to send, or undefined when nothing changed (blank clears it). */
export function rackChange(die: Pick<Die, 'rackLocation'>, typed: string): string | null | undefined {
  const next = typed.trim() === '' ? null : typed.trim()
  return next === (die.rackLocation ?? null) ? undefined : next
}

/** Why a die's row may not be picked for Retire N (a message key), or null. */
export const retireHeldOf = (die: Pick<Die, 'condition'>): string | null => (die.condition === 'RETIRED' ? 'held.alreadyRetired' : null)

// ---- export -----------------------------------------------------------------------------------------------------------------

export const CSV_COLUMNS = ['code', 'site', 'style', 'size', 'piece', 'patternPiece', 'rack', 'material', 'supplier', 'condition'] as const

/** The CSV rows of the dies picked (the cost only with the grain): the words from the caller. */
export function csvRows(dies: readonly Die[], words: { everySize: string; condition: (condition: DieCondition) => string }, cost: boolean): (string | number)[][] {
  return dies.map((die) => [
    die.code,
    die.siteCode,
    die.style.code,
    die.size ?? words.everySize,
    die.piece,
    die.patternPiece?.name ?? '',
    die.rackLocation ?? '',
    die.material ?? '',
    die.supplier?.code ?? '',
    words.condition(die.condition),
    ...(cost ? [minorText(die.purchaseCost)] : []),
  ])
}
