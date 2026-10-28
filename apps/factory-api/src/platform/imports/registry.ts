import type { Issue } from '@nexus/factory-domain/core/errors'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import { importerRegistry, type ExistingRecord, type Importer, type ImporterRegistry, type RecordValues, type RowValues } from '@nexus/factory-domain/imports/importer'
import type { CommandTools, CommandTx } from '../../core/command'
import { materialsImportAdapter } from '../../modules/product/materials/importer'

/**
 * The importers this process runs (plan A1 W0-22; feature PLT-176): each is an importer of factory-domain (its columns,
 * key and plan, pure) with its adapter here, the two things that touch records:
 *
 *   load(client, keys, scope)    the records the keys find, in the job's company (null: tenant-wide), with their current
 *                                values of the importer's columns (key columns included, in the JSON kinds the cells
 *                                parse to: decimals and dates as strings). Read only: the dry run runs it in a READ ONLY
 *                                transaction, so a dry run cannot write a business row even by mistake; the apply runs
 *                                it again inside each batch's transaction, to check every row against the record as it
 *                                is then.
 *   write(tools, row, scope)     writes ONE planned row inside the batch's command(): CREATE gets every given value,
 *                                UPDATE only the values that change (and the record's id); it records its audit row
 *                                (money in before/after marked with markMoney, or with markValues of the domain) and
 *                                its events through `tools`, and answers the record's id. A throw rolls the whole batch
 *                                back (the job stops as FAILED and can be applied again).
 *
 * `permission` is what writing those records needs (`parties.manage`), `viewPermission` what seeing them needs
 * (`parties.view`): imports.run and imports.apply also need `permission`, and imports.view also needs `viewPermission`,
 * each checked with can() against the job's company. imports.* alone never reaches a record.
 *
 * `authorize(actor, job, columns)` (optional) is what the importer asks of a person beyond that: the issues it answers
 * (empty: allowed) refuse the job. The engine calls it at the start (the person who starts it; the columns the mapping
 * names), in the dry run (that person again, with the roles they hold then; the columns the sheet maps: the job fails
 * with the issues) and at the apply (the person who applies; checked again there). It only adds refusals: the engine's
 * own checks (can(), the money grains of mapped columns) run first and always.
 *
 * A module adds its importer to IMPORTERS below (one line, like the worker's HANDLERS); tests set their own with
 * useImporters(). W0 brings the engine only: no business importer.
 */

export interface ImportScope {
  /** The job's company; null for tenant-wide master data. */
  readonly companyId: string | null
}

/** A planned row as the adapter writes it. */
export interface WriteRow {
  readonly action: 'CREATE' | 'UPDATE'
  /** The key columns' values. */
  readonly key: Readonly<Record<string, CellValue>>
  /** UPDATE: the record the dry run found (and the apply found again). */
  readonly recordId: string | null
  /** UPDATE: what the changed columns hold now. */
  readonly before: RecordValues
  /** CREATE: every given value; UPDATE: the new values of the changed columns. */
  readonly values: RowValues
}

export interface ImportAdapter {
  readonly importer: Importer
  readonly permission: Permission
  readonly viewPermission: Permission
  /** Refusals beyond the engine's checks (see above); empty: allowed. */
  readonly authorize?: (actor: Actor, job: ImportScope, columns: readonly string[]) => readonly Issue[]
  load(client: CommandTx, keys: readonly Readonly<Record<string, CellValue>>[], scope: ImportScope): Promise<readonly ExistingRecord[]>
  write(tools: CommandTools, row: WriteRow, scope: ImportScope): Promise<{ readonly recordId: string }>
}

/** Declares an importer's adapter (identity, for the types). */
export const defineImportAdapter = (adapter: ImportAdapter): ImportAdapter => Object.freeze({ ...adapter })

/** The process's importers. Each module that brings an importer adds its adapter here. */
export const IMPORTERS: readonly ImportAdapter[] = Object.freeze([materialsImportAdapter])

let configured: ImporterRegistry<ImportAdapter> | undefined
let fromList: ImporterRegistry<ImportAdapter> | undefined

/** Sets the importers (tests); undefined goes back to IMPORTERS. */
export function useImporters(adapters: readonly ImportAdapter[] | undefined): void {
  configured = adapters ? importerRegistry(adapters) : undefined
}

export function processImporters(): ImporterRegistry<ImportAdapter> {
  return configured ?? (fromList ??= importerRegistry(IMPORTERS))
}
