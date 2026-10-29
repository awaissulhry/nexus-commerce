import { allocateScanIds, type ScanIdTools } from '../../../platform/numbering/scan-ids'

/**
 * Garment serial numbers (MES-076, Q31 (b)): the tenant's GARMENT_SERIAL scan ids (`SN-<tag>-<ref>-<check>`), from its
 * ONE tenant-wide counter (platform/numbering scan-ids, the floor numbering step): unique in the tenant, never reused,
 * also when voided; a command that rolls back takes none. The final operation's print takes them online, inside its
 * command, after its own locks (the counter's lock is taken last). A label printed OFFLINE from a tablet's own block
 * (not in W1: the print is online) would be recorded with `useScanIds(tools, 'GARMENT_SERIAL', [{ code, record: { type:
 * 'GarmentSerial', id } }])` in the command that inserts the serial.
 */
export async function takeSerials(tools: ScanIdTools, count: number): Promise<readonly string[]> {
  return (await allocateScanIds(tools, 'GARMENT_SERIAL', count)).codes
}
