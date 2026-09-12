import type { Prisma } from '@prisma/client'
import prisma from '../db.js'

/** The business chooses its default warehouse; geography is not a global constant. */
export async function defaultStockLocation(db: Pick<Prisma.TransactionClient, 'stockLocation'> = prisma) {
  const defaults = await db.stockLocation.findMany({ where: { isActive: true, type: 'WAREHOUSE', warehouse: { isActive: true, isDefault: true } }, select: { id: true, code: true }, take: 2 })
  if (defaults.length > 1) throw new Error('Choose one default warehouse for this business.')
  if (defaults.length === 1) return defaults[0]
  // Existing businesses may predate the default flag. A sole location is unambiguous.
  const locations = await db.stockLocation.findMany({ where: { isActive: true, type: 'WAREHOUSE' }, select: { id: true, code: true }, take: 2 })
  return locations.length === 1 ? locations[0] : null
}
