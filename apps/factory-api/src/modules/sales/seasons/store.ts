import type { FactoryClient } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { closedSeasonWords } from '@nexus/factory-domain/sales/seasons/rules'
import type { CommandTx } from '../../../core/command'

/**
 * Seasons per company (B-W2b-303; SAL-277): the reads the order and quote paths share. A quote version and an order name an
 * OPEN season of their own company (B-W2b-279's guard refuses a closed one or another company's in words): these say it
 * first, in words, as a 409 or a 400.
 */

export type Reader = FactoryClient | CommandTx

export const SEASON_COLUMNS = { id: true, companyId: true, code: true, name: true, startsOn: true, endsOn: true, orderBookClosesOn: true, status: true, closedAt: true, closedById: true, note: true, version: true, createdAt: true, createdById: true } as const

/** The season's id when it is still OPEN, else null (a copy that carries a season: revise, duplicate, an acceptance's order). */
export async function openSeasonOrNull(db: Reader, seasonId: string | null | undefined): Promise<string | null> {
  if (!seasonId) return null
  const season = await db.season.findUnique({ where: { id: seasonId }, select: { status: true } })
  return season?.status === 'OPEN' ? seasonId : null
}

/**
 * The season named by id for a record of `companyId`: 400 when it is not one of the company's (path `at`), 409 when it is
 * CLOSED. null passes (no season).
 */
export async function assertOpenSeason(db: Reader, seasonId: string | null | undefined, companyId: string, at = 'body/seasonId'): Promise<{ id: string; code: string } | null> {
  if (seasonId === null || seasonId === undefined) return null
  const season = isUuid(seasonId) ? await db.season.findUnique({ where: { id: seasonId }, select: { id: true, companyId: true, code: true, status: true } }) : null
  if (!season || season.companyId !== companyId) throw new ValidationError('Not a season of this company.', [{ path: at, message: 'Expected a season of the company.' }])
  if (season.status !== 'OPEN') throw new DomainError('conflict', closedSeasonWords(season.code), [{ path: at, message: closedSeasonWords(season.code) }])
  return { id: season.id, code: season.code }
}

/** The season of the company with this code (any case), for the sheet import; null when there is none. */
export async function seasonByCode(db: Reader, companyId: string, code: string): Promise<{ id: string; code: string; status: string } | null> {
  return db.season.findFirst({ where: { companyId, code: { equals: code.trim(), mode: 'insensitive' } }, select: { id: true, code: true, status: true } })
}

/** A season the caller may read, or 404. */
export async function seasonOr404(db: Reader, seasonId: string) {
  const row = isUuid(seasonId) ? await db.season.findUnique({ where: { id: seasonId }, select: SEASON_COLUMNS }) : null
  if (!row) throw new NotFoundError('Season not found.')
  return row
}

/** The season a copy keeps (B-W2b-303; quotes/duplicate.ts): its quote version's or order's while it is OPEN; none otherwise. */
export async function seasonOfCopySource(db: Reader, from: { readonly versionId: string } | { readonly orderId: string } | object): Promise<string | null> {
  if ('versionId' in from) return openSeasonOrNull(db, (await db.quoteVersion.findUnique({ where: { id: from.versionId }, select: { seasonId: true } }))?.seasonId)
  if ('orderId' in from) return openSeasonOrNull(db, (await db.salesOrder.findUnique({ where: { id: from.orderId }, select: { seasonId: true } }))?.seasonId)
  return null
}
