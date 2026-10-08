/**
 * MCP full control 08 S6 — create, change and deactivate a stock location (the stock page and Claude's
 * set-stock-location). Moved as it was out of routes/stock.routes.ts (`POST /stock/locations`, `PATCH` and `DELETE
 * /stock/locations/:id`; stock-change.vitest.test.ts holds the routes' answers). A refusal is a LocationWriteError
 * carrying the status and the sentence the route answers with.
 *
 * Step 2 "Sells from": a switched-off warehouse feeds no listing (`loadSyncLedgers`). So a location that still holds
 * units is never switched off — its markets would lose that stock and keep showing a number nothing re-sends — and
 * every switch on or off re-works the quantities of the products stocked there (in the background, as a routes change).
 */
import type { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { isProtectedStockLocation } from '../default-stock-location.js'
import { logger } from '../../utils/logger.js'

export class LocationWriteError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = 'LocationWriteError'
  }
}

/** The code a location is created with: upper case, letters, digits and hyphens, 1–30 characters. */
export const LOCATION_CODE = /^[A-Z0-9][A-Z0-9-]{0,29}$/

export interface CreateLocationInput {
  name?: string
  code?: string
  type?: string
  servesMarketplaces?: string[]
  isActive?: boolean
  address?: { street?: string; city?: string; country?: string }
}

export async function createStockLocation(input: CreateLocationInput) {
  const { name, code, type, servesMarketplaces, isActive = true, address } = input
  if (!name?.trim()) throw new LocationWriteError(400, 'name is required')
  if (!code?.trim()) throw new LocationWriteError(400, 'code is required')
  if (!['WAREHOUSE', 'AMAZON_FBA'].includes(type as string)) {
    throw new LocationWriteError(400, 'type must be WAREHOUSE or AMAZON_FBA')
  }
  const normalised = code.toUpperCase().trim()
  if (!LOCATION_CODE.test(normalised)) {
    throw new LocationWriteError(400, 'code must be uppercase alphanumeric with hyphens, 1–30 chars')
  }
  const existing = await prisma.stockLocation.findUnique({ where: { workspace_code: workspaceKey({ code: normalised }) } })
  if (existing) throw new LocationWriteError(409, `Location code ${normalised} already exists`)

  return prisma.stockLocation.create({
    data: {
      name: name.trim(),
      code: normalised,
      type: type as string,
      servesMarketplaces: servesMarketplaces as string[],
      isActive,
      address: address ?? undefined,
    },
  })
}

export interface UpdateLocationInput {
  name?: string
  servesMarketplaces?: string[]
  isActive?: boolean
  address?: { street?: string; city?: string; country?: string } | null
}

/** The sentence a location that still holds units is refused with (Claude's set-stock-location says the same). */
export const stillHoldsUnits = (code: string, units: number) =>
  `${code} still holds ${units} units: move or count them out first. A location is switched off only at 0.`

/** Refuse switching off a location that still holds units (on hand or held for an order). */
async function refuseIfHoldingUnits(loc: { id: string; code: string }): Promise<void> {
  const onHand = (await prisma.stockLevel.aggregate({ where: { locationId: loc.id }, _sum: { quantity: true, reserved: true } }))._sum
  if ((onHand?.quantity ?? 0) > 0 || (onHand?.reserved ?? 0) > 0) throw new LocationWriteError(409, stillHoldsUnits(loc.code, onHand?.quantity ?? 0))
}

/**
 * A location was switched on or off: the products stocked there may show another number (a switched-off warehouse
 * feeds no listing). Re-worked in the background, one product at a time — the routes change does the same.
 */
function recascadeStockedAt(locationId: string, actor: string): void {
  void (async () => {
    const stocked = await prisma.stockLevel.findMany({ where: { locationId }, select: { productId: true }, distinct: ['productId'] })
    if (stocked.length === 0) return
    const { recascadeAfterSyncControlChange } = await import('../stock-movement.service.js')
    const result = await recascadeAfterSyncControlChange(stocked.map((row) => row.productId), actor)
    logger.info('[stock-location] recascade after switching a location on or off complete', { ...result, locationId, actor })
  })().catch((error) => logger.warn('[stock-location] recascade after switching a location on or off failed', {
    locationId, error: error instanceof Error ? error.message : String(error),
  }))
}

/** Change a location's mutable fields. The code is immutable once set. */
export async function updateStockLocation(id: string, input: UpdateLocationInput, actor = 'stock-location') {
  const { name, servesMarketplaces, isActive, address } = input
  const loc = await prisma.stockLocation.findUnique({ where: { id } })
  if (!loc) throw new LocationWriteError(404, 'Location not found')

  if (isActive === false && (await isProtectedStockLocation(loc))) {
    throw new LocationWriteError(409, 'Choose another default warehouse before deactivating this location.')
  }
  const switching = isActive !== undefined && isActive !== loc.isActive
  if (switching && isActive === false) await refuseIfHoldingUnits(loc)

  const updated = await prisma.stockLocation.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(servesMarketplaces !== undefined ? { servesMarketplaces } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(address !== undefined ? { address: (address ?? undefined) as Prisma.InputJsonValue | undefined } : {}),
    },
  })
  if (switching) recascadeStockedAt(id, actor)
  return updated
}

/**
 * Soft-delete: isActive = false. A built-in location (the default warehouse, IT-MAIN, the FBA mirror) is refused, and
 * so is a location that still holds units.
 */
export async function deactivateStockLocation(id: string, actor = 'stock-location'): Promise<void> {
  const loc = await prisma.stockLocation.findUnique({ where: { id } })
  if (!loc) throw new LocationWriteError(404, 'Location not found')
  if (await isProtectedStockLocation(loc)) {
    throw new LocationWriteError(409, `Built-in location ${loc.code} cannot be deactivated here`)
  }
  if (loc.isActive === false) return
  await refuseIfHoldingUnits(loc)
  await prisma.stockLocation.update({ where: { id }, data: { isActive: false } })
  recascadeStockedAt(id, actor)
}
