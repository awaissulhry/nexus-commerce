import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { ColourLibraryRow } from '@nexus/factory-domain/product/colours/contracts'
import type { ColourLocale, ColourSystem } from '@nexus/factory-domain/product/colours/rules'
import { isPictureType } from '@nexus/factory-domain/product/images/rules'
import { PRODUCT_MATERIALS_VIEW } from '@nexus/factory-domain/product/materials/permissions'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, STYLE_SCOPE } from '../styles/store'

/**
 * The colour library, the shared parts (B-W2b-247; PRD-041): the row and its view, what names a colour (counted over what
 * the reader may see; `inUse` over the tenant), its photo (the newest picture file of the colour), and the database's
 * Colour_system_check said in words when a write reaches it anyway.
 */

type Reader = FactoryClient | CommandTx

/** Library colours: a company's or every company's (companyId null), as styles and size scales. */
export const COLOUR_SCOPE = STYLE_SCOPE
const MATERIAL_SCOPE = { company: { field: 'companyId', nullable: true } } as const
/** Branding sets: their company and their brand. */
export const SET_SCOPE = { company: 'companyId', party: 'partyId' } as const

export const COLOUR_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  system: true,
  reference: true,
  family: true,
  hex: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.ColourSelect
export type ColourRowData = Prisma.ColourGetPayload<{ select: typeof COLOUR_COLUMNS }>

/** Colour.nameI18n as kept: { it?, en? } (other keys of an older row are left out). */
export function namesOf(value: Prisma.JsonValue | null): Partial<Record<ColourLocale, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.it === 'string' && record.it.trim() ? { it: record.it } : {}),
    ...(typeof record.en === 'string' && record.en.trim() ? { en: record.en } : {}),
  }
}

export interface ColourUseFacts {
  readonly materialColours: number | null
  readonly colourways: number | null
  readonly brandingSets: number | null
  readonly inUse: boolean
}

const countBy = (rows: readonly { colourId: string | null; _count: { _all: number } }[]): Map<string, number> =>
  new Map(rows.flatMap((row) => (row.colourId ? [[row.colourId, row._count._all] as const] : [])))

/** The ids among `ids` named by an ACTIVE branding set (`scoped`: of the sets the actor may see), with how many sets. */
async function setUse(db: Reader, ids: readonly string[], scope: Prisma.BrandingSetWhereInput | null): Promise<Map<string, number>> {
  const sets = await db.brandingSet.findMany({ where: { AND: [{ status: 'ACTIVE', brandColourIds: { hasSome: [...ids] } }, scope ?? {}] }, select: { brandColourIds: true } })
  const wanted = new Set(ids)
  const counts = new Map<string, number>()
  for (const set of sets) for (const colourId of set.brandColourIds) if (wanted.has(colourId)) counts.set(colourId, (counts.get(colourId) ?? 0) + 1)
  return counts
}

/**
 * What names each colour: ACTIVE material colours (only with product.materials.view, over the materials the actor sees;
 * null otherwise), ACTIVE colourways of the styles the actor sees, ACTIVE branding sets the actor sees; and `inUse`, anything
 * the session can read in the tenant (an archive candidate is a colour nothing names).
 */
export async function useOf(db: Reader, actor: Actor, ids: readonly string[]): Promise<Map<string, ColourUseFacts>> {
  if (ids.length === 0) return new Map()
  const colourIds = [...ids]
  const seesMaterials = holds(actor, PRODUCT_MATERIALS_VIEW)
  const [ways, waysAll, items, itemsAll, sets, setsAll] = await Promise.all([
    db.colourway.groupBy({ by: ['colourId'], where: { colourId: { in: colourIds }, status: 'ACTIVE', style: scopeWhere(actor, PRODUCT_STYLES_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput }, _count: { _all: true } }),
    db.colourway.groupBy({ by: ['colourId'], where: { colourId: { in: colourIds }, status: 'ACTIVE' }, _count: { _all: true } }),
    seesMaterials
      ? db.itemColour.groupBy({ by: ['colourId'], where: { colourId: { in: colourIds }, status: 'ACTIVE', item: scopeWhere(actor, PRODUCT_MATERIALS_VIEW, MATERIAL_SCOPE) as Prisma.ItemWhereInput }, _count: { _all: true } })
      : Promise.resolve([]),
    db.itemColour.groupBy({ by: ['colourId'], where: { colourId: { in: colourIds }, status: 'ACTIVE' }, _count: { _all: true } }),
    setUse(db, colourIds, scopeWhere(actor, PRODUCT_STYLES_VIEW, SET_SCOPE) as Prisma.BrandingSetWhereInput),
    setUse(db, colourIds, null),
  ])
  const [wayCount, wayAll, itemCount, itemAll] = [countBy(ways), countBy(waysAll), countBy(items), countBy(itemsAll)]
  return new Map(
    colourIds.map((id) => [
      id,
      {
        materialColours: seesMaterials ? (itemCount.get(id) ?? 0) : null,
        colourways: wayCount.get(id) ?? 0,
        brandingSets: sets.get(id) ?? 0,
        inUse: (wayAll.get(id) ?? 0) + (itemAll.get(id) ?? 0) + (setsAll.get(id) ?? 0) > 0,
      },
    ]),
  )
}

/** Colour ids an ACTIVE branding set names (every set the session reads): the "Unused" view leaves them out. */
export async function brandColourIds(db: Reader): Promise<string[]> {
  const sets = await db.brandingSet.findMany({ where: { status: 'ACTIVE' }, select: { brandColourIds: true } })
  return [...new Set(sets.flatMap((set) => set.brandColourIds))]
}

/** The "Unused" filter: no ACTIVE material colour, colourway or branding set names it. */
export const unusedWhere = (namedBySets: readonly string[]): Prisma.ColourWhereInput => ({
  AND: [{ itemColours: { none: { status: 'ACTIVE' } } }, { colourways: { none: { status: 'ACTIVE' } } }, namedBySets.length > 0 ? { id: { notIn: [...namedBySets] } } : {}],
})

/** Each colour's photo: its newest AVAILABLE picture file (StoredFile recordType "Colour", kind PHOTO). */
export async function photosOf(db: Reader, ids: readonly string[]): Promise<Map<string, { fileId: string; name: string; url: string }>> {
  if (ids.length === 0) return new Map()
  const files = await db.storedFile.findMany({
    where: { recordType: 'Colour', recordId: { in: [...ids] }, kind: 'PHOTO', status: 'AVAILABLE' },
    select: { id: true, recordId: true, originalName: true, contentType: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const photos = new Map<string, { fileId: string; name: string; url: string }>()
  for (const file of files) {
    if (photos.has(file.recordId) || !isPictureType(file.contentType)) continue
    photos.set(file.recordId, { fileId: file.id, name: file.originalName, url: `/product/colours/pictures/${file.id}` })
  }
  return photos
}

export function rowViewOf(row: ColourRowData, use: ColourUseFacts | undefined, photo: { fileId: string; name: string; url: string } | undefined): ColourLibraryRow {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    names: namesOf(row.nameI18n),
    system: (row.system as ColourSystem | null) ?? null,
    reference: row.reference,
    family: row.family,
    hex: row.hex,
    photo: photo ?? null,
    use: use ?? { materialColours: null, colourways: 0, brandingSets: 0, inUse: false },
    status: row.status,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** Rows as the list and the writes answer them: with their use and photo. */
export async function viewsOf(db: Reader, actor: Actor, rows: readonly ColourRowData[]): Promise<ColourLibraryRow[]> {
  const ids = rows.map((row) => row.id)
  const [use, photos] = await Promise.all([useOf(db, actor, ids), photosOf(db, ids)])
  return rows.map((row) => rowViewOf(row, use.get(row.id), photos.get(row.id)))
}

/** A colour the caller may see (product.styles.view over its company); else not found. */
export async function readColour(caller: CommandCaller, colourId: string): Promise<ColourRowData> {
  if (!isUuid(colourId)) throw new NotFoundError('Colour not found.')
  const row = await caller.withClient((client) => client.colour.findUnique({ where: { id: colourId }, select: COLOUR_COLUMNS }))
  if (!row || !can(actorOf(contextOf(caller)), PRODUCT_STYLES_VIEW, { companyId: row.companyId })) throw new NotFoundError('Colour not found.')
  return row
}

/** A unique violation (the tenant's code). */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002'
}

/**
 * The database's colour and branding set refusals (Colour_system_check, BrandingSet_check, the one-active-set index: 'product:
 * …' check violations, 23505) in words when a write reached them without the command's own check: a 409, never a 500.
 */
export async function libraryGuarded<T>(work: () => Promise<T>, taken?: () => string): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (taken && isUniqueViolation(error)) throw new ConflictError(taken())
    const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('product: ')) {
      const words = cause.originalMessage.slice('product: '.length)
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
    }
    if (cause?.originalCode === '23505' && typeof cause.originalMessage === 'string' && cause.originalMessage.includes('BrandingSet_one_active_per_brand')) {
      throw new ConflictError('The brand has a branding set in use in this company already: archive it first, or start the new set with "replace".')
    }
    throw error
  }
}
