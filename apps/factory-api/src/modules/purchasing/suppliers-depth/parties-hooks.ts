import { DomainError } from '@nexus/factory-domain/core/errors'
import { supplierRoleProblem, type SupplierStatus } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { readSupplierRow } from './store'
import { setStatusInCommand } from './status'

/**
 * Where the parties module's own commands meet a supplier's depth (B-W2b-311), one call each from modules/parties
 * (parties.ts updateParty and moveParty, importer.ts updateRow), inside their commands:
 *
 *   assertSupplierRoleKept   B-W2b-287's gap: a party with supplier kinds or a supplier status keeps a supplier,
 *                            subcontractor or carrier role (the database does not refuse the removal), a 409 in words
 *   approveOnActivation      W1's Activate of a prospect approves it as a supplier too (PROSPECT → APPROVED, by the system:
 *                            the activation's audit row names who), so the two statuses never disagree after it
 */

export async function assertSupplierRoleKept(tx: CommandTx, partyId: string, name: string, before: readonly string[], after: readonly string[]): Promise<void> {
  const held = await tx.party.findUnique({ where: { id: partyId }, select: { supplierKinds: true, supplierStatus: true } })
  if (!held) return
  const problem = supplierRoleProblem(name, before, after, { kinds: held.supplierKinds, supplierStatus: held.supplierStatus as SupplierStatus | null })
  if (problem) throw new DomainError('conflict', problem, [{ path: 'body/roles', message: problem }])
}

export async function approveOnActivation(tools: CommandTools, partyId: string): Promise<void> {
  const row = await readSupplierRow(tools.tx, partyId)
  if (row?.supplierStatus !== 'PROSPECT') return
  await setStatusInCommand(tools, row, 'APPROVED', null, null)
}
