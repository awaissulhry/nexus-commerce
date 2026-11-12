import type { Issue } from '@nexus/factory-domain/core/errors'
import { grantsFor, type Actor } from '@nexus/factory-domain/core/permissions'
import type { RowValues } from '@nexus/factory-domain/imports/importer'
import { STATUS_COLUMNS, supplierOfRow, type ImportedSupplier } from '@nexus/factory-domain/purchasing/suppliers-depth/importer'
import { PURCHASING_SUPPLIERS_STATUS } from '@nexus/factory-domain/purchasing/suppliers-depth/permissions'
import { PROFILE_FIELDS, type SupplierStatus } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
import { profileOf, readSupplierRow, SUPPLIER_COLUMNS } from './store'
import { setStatusInCommand } from './status'

/**
 * The supplier columns of the customers and suppliers import (B-W2b-311; SCM-289; factory-domain
 * purchasing/suppliers-depth/importer): the parts of modules/parties importer.ts's adapter that read and write a supplier's
 * kinds, status, default lead time and origin. factory-domain `supplierOfRow` decides them in the dry run; this
 *
 *   loads       each party's supplier side (`suppliersOf`),
 *   authorizes  the Supplier status and Status reason columns: purchasing.suppliers.status over the job's company (every
 *               company for a job of every company), at the start, in the dry run and at the apply,
 *   gives       a new supplier's first status from its row (`firstStatusOfRow`, passed to the parties' insertParty, so the
 *               status is set once, when the party is made),
 *   writes      one planned row's supplier side inside the batch's command, after the party itself
 *               (`writeSupplierInCommand`): the profile columns (audited as the supplier record's own change, party.updated
 *               with the fields) and a status move (purchasing.suppliers.status's audit row and supplier.status_changed; by
 *               the system: the batch runs in the worker's context, and the job names who applied it).
 */

/** Stops the batch: the supplier side changed since the dry run in a way the row no longer fits. */
class SupplierRowRefused extends ApiError {
  constructor(code: string, detail: string) {
    super('conflict', `The import row for ${code} no longer fits the supplier: ${detail}. Run the dry run again.`)
  }
}

/** The parties' supplier sides as the import sees them, by party id. */
export async function suppliersOf(client: CommandTx, partyIds: readonly string[]): Promise<Map<string, ImportedSupplier>> {
  if (partyIds.length === 0) return new Map()
  const rows = await client.party.findMany({ where: { id: { in: [...partyIds] } }, select: SUPPLIER_COLUMNS })
  return new Map(rows.map((row) => [row.id, { ...profileOf(row), supplierStatus: row.supplierStatus as SupplierStatus | null, supplierStatusReason: row.supplierStatusReason }]))
}

/** Refusals of a job that maps a status column the person may not set. */
export function authorizeSupplier(actor: Actor, job: { readonly companyId: string | null }, columns: readonly string[]): Issue[] {
  if (!columns.some((column) => STATUS_COLUMNS.includes(column as never))) return []
  const reaches = grantsFor(actor, PURCHASING_SUPPLIERS_STATUS).some((grant) => grant.companies === 'all' || (job.companyId !== null && grant.companies.includes(job.companyId)))
  return reaches ? [] : [{ path: 'columns/supplierStatus', message: 'Setting where suppliers stand needs purchasing.suppliers.status: leave the Supplier status and Status reason columns out.' }]
}

/** A new party's first supplier status from its row (undefined: the row names none, the parties' own rule applies). */
export function firstStatusOfRow(values: RowValues, roles: readonly string[]): { readonly status: SupplierStatus; readonly reason: string | null } | undefined {
  const outcome = supplierOfRow(values, roles, null)
  if (!outcome?.ok || !outcome.plan.status) return undefined
  return { status: outcome.plan.status.to, reason: outcome.plan.status.reason }
}

/** One planned row's supplier side, inside the batch's command (see the module comment). `created`: the party was just made. */
export async function writeSupplierInCommand(tools: CommandTools, partyId: string, values: RowValues, created: boolean): Promise<void> {
  const row = await readSupplierRow(tools.tx, partyId)
  if (!row) return
  const current = { ...profileOf(row), supplierStatus: row.supplierStatus as SupplierStatus | null, supplierStatusReason: row.supplierStatusReason }
  const outcome = supplierOfRow(values, row.roles, current)
  if (outcome === null) return
  if (!outcome.ok) throw new SupplierRowRefused(row.code, outcome.issues.map((issue) => `${issue.column ?? 'row'}: ${issue.message}`).join(' '))
  const { plan } = outcome
  if (plan.profileChanged.length > 0) {
    const next = plan.profile
    await tools.tx.party.update({
      where: { id: partyId },
      data: { supplierKinds: [...next.kinds], leadTimeDays: next.leadTimeDays, originCountry: next.originCountry, originRegion: next.originRegion, originNote: next.originNote, hideOriginCountries: [...next.hideOriginCountries], tannages: [...next.tannages] },
      select: { id: true },
    })
    const fields = PROFILE_FIELDS.filter((field) => plan.profileChanged.includes(field))
    const before = profileOf(row)
    tools.audit({ action: 'purchasing.suppliers.profile', recordType: 'Party', recordId: partyId, companyId: row.companyId, before: Object.fromEntries(fields.map((field) => [field, before[field]])), after: Object.fromEntries(fields.map((field) => [field, next[field]])) })
    tools.emit({ type: 'party.updated', subject: partyId, companyId: row.companyId, payload: { partyId, code: row.code, fields: fields.map((field) => (field === 'kinds' ? 'supplierKinds' : field)) } })
  }
  // A new party's status was set when it was made (firstStatusOfRow); a known one moves here.
  if (plan.status && !created) await setStatusInCommand(tools, row, plan.status.to, plan.status.reason, null)
  // command() bumps only the record it guards (the import job): a known party's version moves here, as its other columns'.
  if (!created && (plan.profileChanged.length > 0 || plan.status)) await tools.tx.party.update({ where: { id: partyId }, data: { version: { increment: 1 } }, select: { id: true } })
}
