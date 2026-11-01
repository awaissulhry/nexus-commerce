import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { BulkFieldSpec, BulkRefusal, BulkValue } from '@nexus/factory-domain/views/bulk/rules'
import { LIST_KEY } from '@nexus/factory-domain/views/state'
import type { CommandCaller } from '../../../core/command'

/**
 * The lists that can be edited in bulk and cell by cell (B-W2b-13; PLT-182, PLT-166; design shell.lists pop:bulk-edit,
 * sec:grid "inline edit … autosaved per cell with CellSaveMark and a version check"): one bulk target per list, in
 * `targets/` (one file per list, listed in targets/index.ts), named by the list's page id (`production.work-orders`)
 * as the web's list frame names it — the same key as its export source. A target says:
 *
 *   permission  the list's own WRITE permission (asked over the screen's company before any row is read; each row's
 *               own command asks it again over the row's company and site)
 *   fields      by the frame's column id: the field's kind and limits (factory-domain views/bulk/rules BulkFieldSpec),
 *               its value on a row, and why a row's state keeps it (a closed work order keeps its due date)
 *   load        the rows the person asks for, as the module's own scope shows them (one read; a row they may not see is
 *               simply not answered: the preview says "missing")
 *   write       one row's change THROUGH the record's own command (its audit row, its version check, its events), with
 *               the version the person reviewed; answers the row after
 *
 * A list without a target answers 404 on both bulk routes; the web frame offers no Edit N and no inline edit for it.
 * Tests set their own targets with useBulkTargets([...]).
 */

export interface BulkTargetField<Row> extends BulkFieldSpec {
  /** The field's value on a row (a day as YYYY-MM-DD, a whole number, a text, a choice's code), or null. */
  read(row: Row): BulkValue
  /** Why this row's state keeps the field (`{ code: 'held', status }`), or null. */
  held?(row: Row): BulkRefusal | null
}

export interface BulkTarget<Row> {
  readonly listKey: string
  readonly permission: Permission
  readonly fields: Readonly<Record<string, BulkTargetField<Row>>>
  load(caller: CommandCaller, ids: readonly string[]): Promise<readonly Row[]>
  idOf(row: Row): string
  labelOf(row: Row): string
  versionOf(row: Row): number
  /** The row's state code (`CLOSED`), named by a refusal the record's own command gives. */
  statusOf?(row: Row): string | null
  /** Why the person may not change this row at all (another site's: `{ code: 'forbidden' }`), or null. */
  rowHeld?(caller: CommandCaller, row: Row): BulkRefusal | null
  write(caller: CommandCaller, row: Row, changes: Readonly<Record<string, BulkValue>>, version: number, idempotencyKey: string | undefined): Promise<Row>
  /** B-W2b-51: at most this many rows at once, when each row's read is heavy (a release check); default BULK_LIMITS.rows. */
  readonly maxRows?: number
}

/**
 * B-W2b-51: a target's write that the record's own command refused, with the refusal in the target's codes (a release
 * the check holds: `{ code: 'held', reasons: ['CERTIFICATE'] }`); the engine answers it as it is.
 */
export class BulkRowRefused extends Error {
  override name = 'BulkRowRefused'
  constructor(readonly refusal: BulkRefusal) {
    super(`Refused: ${refusal.code}.`)
  }
}

/** A target with its row type erased, as the registry and the routes hold it. */
export type AnyBulkTarget = BulkTarget<unknown>

export class BulkTargetError extends Error {
  override name = 'BulkTargetError'
}

/** Declares a list's bulk edit. A bad list key, no field or a field id the frame could not name throws at import. */
export function defineBulkTarget<Row>(target: BulkTarget<Row>): AnyBulkTarget {
  if (!LIST_KEY.test(target.listKey)) throw new BulkTargetError(`${target.listKey}: not a list key (a page id with dots)`)
  const keys = Object.keys(target.fields)
  if (keys.length === 0) throw new BulkTargetError(`${target.listKey}: a bulk edit needs a field`)
  for (const key of keys) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(key)) throw new BulkTargetError(`${target.listKey}: "${key}" is not a column id`)
    const field = target.fields[key]!
    if (field.kind === 'choice' && (field.choices ?? []).length === 0) throw new BulkTargetError(`${target.listKey}: "${key}" is a choice without choices`)
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw new BulkTargetError(`${target.listKey}: "${key}" has its lowest value above its highest`)
  }
  return Object.freeze({ ...target }) as unknown as AnyBulkTarget
}
