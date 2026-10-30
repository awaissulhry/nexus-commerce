import { stationWords, type MachineStatus } from '@nexus/factory-domain/plant/rules'
import type { CommandTx } from '../../core/command'
import { locksOf } from './store'

/**
 * What a locked or do-not-use machine means for its station (B-W2a-35; Owner answer H1: "A machine marked unsafe must block
 * its station's scans or say so in words"). Read in the caller's scope (office or the station's floor: the floor reads its
 * site's machines and requests).
 *
 *   stationWordsAt(tx, stationId, alsoMachineId?)   the station's banner: the machines marked do-not-use there, in words,
 *                                                   and `blocked` when none of its machines is usable. The floor's machine
 *                                                   screens answer it with every read and every report.
 *   stationBlock(tx, stationId)                     the hook for the floor's work modules: null, or the refusal's words
 *                                                   when the station is blocked. ONE line in a module's command, after its
 *                                                   own locks. Wired (B-W2a-35b) where a station works a machine:
 *                                                     - modules/production/scans/scans.ts reportInCommand, after
 *                                                       refuseIfHeld: refused as refusal/MACHINE_UNSAFE (factory-domain
 *                                                       production/scans/rules SCAN_REFUSALS), not final: a queued scan
 *                                                       passes once a technician signs the machine safe;
 *                                                     - modules/production/cutting/cut.ts cutInCommand, before anything is
 *                                                       issued or cut: refusal/MACHINE_UNSAFE (production/cutting/rules
 *                                                       CUT_REFUSALS).
 *                                                   Not wired where no machine works: an undo or correction of a scan or a
 *                                                   cut (it puts a record right), bundles and their tickets (paper at the
 *                                                   table), pick and issue (the stores move stock to the work order).
 */

type Reader = Pick<CommandTx, 'machine' | 'maintenanceRequest'>

export async function stationWordsAt(tx: Reader, stationId: string | null, alsoMachineId?: string): Promise<{ blocked: boolean; message: string | null; fix: string | null }> {
  const machines = await tx.machine.findMany({
    where: stationId ? { OR: [{ stationId }, ...(alsoMachineId ? [{ id: alsoMachineId }] : [])] } : alsoMachineId ? { id: alsoMachineId } : { id: { in: [] } },
    orderBy: [{ assetNumber: 'asc' }],
    select: { id: true, assetNumber: true, status: true, stationId: true },
  })
  const locks = await locksOf(tx, machines.map((machine) => machine.id))
  const words = stationWords(machines.map((machine) => ({ assetNumber: machine.assetNumber, status: machine.status as MachineStatus, locked: locks.has(machine.id) })))
  // A machine named that stands elsewhere says its words, but blocks no station.
  const atStation = stationId ? machines.filter((machine) => machine.stationId === stationId) : []
  const blocked = atStation.length > 0 && stationWords(atStation.map((machine) => ({ assetNumber: machine.assetNumber, status: machine.status as MachineStatus, locked: locks.has(machine.id) }))).blocked
  return { blocked, message: words.message, fix: words.fix }
}

/** The floor work hook: the station's words when none of its machines may be used (every one do-not-use), else null. */
export async function stationBlock(tx: Reader, stationId: string | null): Promise<{ message: string; fix: string } | null> {
  if (!stationId) return null
  const words = await stationWordsAt(tx, stationId)
  return words.blocked && words.message ? { message: words.message, fix: words.fix ?? '' } : null
}
