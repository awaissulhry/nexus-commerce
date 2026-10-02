/**
 * MCP full control 08 S6 — create, change and deactivate a stock location (the stock page and Claude's
 * set-stock-location). Moved as it was out of routes/stock.routes.ts (`POST /stock/locations`, `PATCH` and `DELETE
 * /stock/locations/:id`; stock-change.vitest.test.ts holds the routes' answers). A refusal is a LocationWriteError
 * carrying the status and the sentence the route answers with.
 */
import type { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { isProtectedStockLocation } from '../default-stock-location.js'

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

/** Change a location's mutable fields. The code is immutable once set. */
export async function updateStockLocation(id: string, input: UpdateLocationInput) {
  const { name, servesMarketplaces, isActive, address } = input
  const loc = await prisma.stockLocation.findUnique({ where: { id } })
  if (!loc) throw new LocationWriteError(404, 'Location not found')

  if (isActive === false && (await isProtectedStockLocation(loc))) {
    throw new LocationWriteError(409, 'Choose another default warehouse before deactivating this location.')
  }

  return prisma.stockLocation.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(servesMarketplaces !== undefined ? { servesMarketplaces } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(address !== undefined ? { address: (address ?? undefined) as Prisma.InputJsonValue | undefined } : {}),
    },
  })
}

/** Soft-delete: isActive = false. A built-in location (the default warehouse, IT-MAIN, the FBA mirror) is refused. */
export async function deactivateStockLocation(id: string): Promise<void> {
  const loc = await prisma.stockLocation.findUnique({ where: { id } })
  if (!loc) throw new LocationWriteError(404, 'Location not found')
  if (await isProtectedStockLocation(loc)) {
    throw new LocationWriteError(409, `Built-in location ${loc.code} cannot be deactivated here`)
  }
  await prisma.stockLocation.update({ where: { id }, data: { isActive: false } })
}
