import type { CommandCaller, CommandTx } from '../../../core/command'
import { toleranceOfLot, type Tolerance } from '../../inventory/hides/facts'
import { leatherToleranceFor, type ToleranceSetting } from '../../inventory/hides/tolerance'

/**
 * The area tolerance of the incoming area check (B-W2b-219; SCM-249, QHS-025; FC4:03): a lot's purchase order line's, else
 * the company's leather area tolerance (PurchasingSettings: the company's row, every company's, 2 %). The office's bench
 * reads it in its own transaction (inventory/hides/facts toleranceOfLot). The floor's bench has no grant on
 * PurchasingSettings (B-W2b-204): it reads the setting first through the tenant's system scope (`incomingToleranceSetting`,
 * outside its transaction) and hands it to toleranceOfLot as its third argument; without it a floor read answers 2 %.
 */

/** The setting for the lot's company, read for any request (a floor request through the tenant's system scope). */
export async function incomingToleranceSetting(caller: CommandCaller, lot: { readonly companyId: string }): Promise<ToleranceSetting> {
  return leatherToleranceFor(caller, lot.companyId)
}

/** The lot's tolerance for this request: the PO line's, else the setting read for its company (any audience). */
export async function incomingToleranceOfLot(caller: CommandCaller, db: Pick<CommandTx, 'lot' | 'purchasingSettings' | '$queryRaw'>, lot: { readonly id: string; readonly companyId: string }): Promise<Tolerance> {
  return toleranceOfLot(db, lot.id, await incomingToleranceSetting(caller, lot))
}
