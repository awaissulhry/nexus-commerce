/**
 * A person's own product sheet layout — one per sheet, following them into every business profile (2026-10-01).
 *
 * The Owner: "always remember what layouts I saved … whenever I reorder something … the view [is] always saved, and
 * whenever I reload or change profiles, I should see the same layout … I do not want any inconsistency." The sheet's
 * "Current layout" (My layout, the view picked last, widths, sort, row height) used to live in the business-owned
 * `SavedView` table, so each business profile had its own; it lives here now, in the GLOBAL `UserSheetLayout` table.
 * Named views ("Save as view…") stay in `SavedView`: they belong to a business and can be shared with its team.
 *
 * The record keeps the `SavedView` working-layout shape on the wire (`id`, `name: 'Current layout'`, `updatedAt`,
 * `filters`) and the same rules: the same payload validation, and a write must name the `updatedAt` it read, so two
 * tabs cannot silently overwrite each other (409; the sheet re-reads and writes again — the last change wins).
 *
 * Every query names the signed-in user (`savedViewOwner`): no row of another person is ever read or written.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { SavedViewError, validateSavedViewPayload } from '../saved-views/persistence.service.js'

const WORKING_NAME = 'Current layout'
/** `product-edit:layout:master` or `product-edit:layout:<CHANNEL>` — one per sheet; never a per-market legacy surface. */
const SURFACE = /^product-edit:layout:(master|[A-Z][A-Z0-9_]{1,30})$/

export interface UserSheetLayoutRecord {
  id: string
  name: typeof WORKING_NAME
  surface: string
  updatedAt: string
  filters: unknown
}

function surfaceOf(value: unknown): string {
  if (typeof value !== 'string' || !SURFACE.test(value)) throw new SavedViewError('A sheet layout needs a product sheet layout surface')
  return value
}

function expectation(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new SavedViewError('Invalid expectedUpdatedAt')
  return new Date(value)
}

const stale = () => new SavedViewError('Your layout changed in another tab. It was read again; save again to keep this change.', 409)

/** Monotonic milliseconds make a returned timestamp usable as the next conditional-write token. */
const nextTimestamp = (previous: Date) => new Date(Math.max(Date.now(), previous.getTime() + 1))

function toRecord(row: { id: string; surface: string; payload: unknown; updatedAt: Date }): UserSheetLayoutRecord {
  return { id: row.id, name: WORKING_NAME, surface: row.surface, updatedAt: row.updatedAt.toISOString(), filters: row.payload }
}

/** The signed-in user's layout for one sheet, as a one-item list (the `SavedView` list shape), or an empty list. */
export async function readUserSheetLayout(userId: string, surface: unknown): Promise<UserSheetLayoutRecord[]> {
  const row = await prisma.userSheetLayout.findUnique({ where: { userId_surface: { userId, surface: surfaceOf(surface) } } })
  return row ? [toRecord(row)] : []
}

export interface UserSheetLayoutWrite {
  surface?: unknown
  filters?: unknown
  expectedUpdatedAt?: unknown
}

/**
 * Create the layout (no `expectedUpdatedAt`) or replace it (the `updatedAt` last read). A write that names an older
 * `updatedAt`, or creates over an existing record, is refused with 409.
 */
export async function writeUserSheetLayout(userId: string, input: UserSheetLayoutWrite): Promise<UserSheetLayoutRecord> {
  if (!input || typeof input !== 'object') throw new SavedViewError('Invalid sheet layout')
  const surface = surfaceOf(input.surface)
  validateSavedViewPayload(surface, input.filters)
  const expected = expectation(input.expectedUpdatedAt)
  const payload = input.filters as Prisma.InputJsonValue
  const current = await prisma.userSheetLayout.findUnique({ where: { userId_surface: { userId, surface } } })
  if (!current) {
    if (expected) throw stale()
    try {
      return toRecord(await prisma.userSheetLayout.create({ data: { userId, surface, payload } }))
    } catch (error) {
      // Two tabs creating the first record at once: the second one is told to read and write again.
      if ((error as { code?: string }).code === 'P2002') throw stale()
      throw error
    }
  }
  if (!expected || expected.getTime() !== current.updatedAt.getTime()) throw stale()
  const changed = await prisma.userSheetLayout.updateMany({
    where: { id: current.id, userId, updatedAt: expected },
    data: { payload, updatedAt: nextTimestamp(current.updatedAt) },
  })
  if (changed.count !== 1) throw stale()
  return toRecord(await prisma.userSheetLayout.findUniqueOrThrow({ where: { id: current.id } }))
}
