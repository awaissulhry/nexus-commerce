import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { ColourCountsView, ColourLibraryQuery, ColourLibraryView } from '@nexus/factory-domain/product/colours/contracts'
import { COLOUR_SYSTEMS, normaliseFamily, type ColourSystem } from '@nexus/factory-domain/product/colours/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { afterCursor, decodeCursor, encodeCursor } from '../styles/cursor'
import { contextOf } from '../styles/store'
import { brandColourIds, COLOUR_COLUMNS, COLOUR_SCOPE, SET_SCOPE, unusedWhere, viewsOf } from './store'

/**
 * Products › Colours & artwork, the reads (B-W2b-247; PRD-041; design products.colours sec:colours.grid, sec:colours.tiles,
 * sec:colours.notices). Every colour the person may see (product.styles.view over its company; a colour of every company
 * reaches everyone), pages of 50 by code, with what names it and its photo. A filter the API cannot apply is named in
 * `ignored`, never refused. The tiles count their own list; the facts say what the page lacks.
 *
 *   GET /product/colours/library?view=active|unused|archived|all&q=&system=&family=&companyId=&cursor=&limit=
 *   GET /product/colours/counts[?companyId]
 *
 * W1's GET /product/colours (the colourway picker, modules/product/styles/colours.ts) stays as it is.
 */

/** The colours the caller may see, of `companyId` and every company when given. */
function scopedWhere(caller: CommandCaller, companyId: string | undefined): Prisma.ColourWhereInput[] {
  const actor = actorOf(contextOf(caller))
  return [scopeWhere(actor, PRODUCT_STYLES_VIEW, COLOUR_SCOPE) as Prisma.ColourWhereInput, companyId ? { OR: [{ companyId }, { companyId: null }] } : {}]
}

/** GET /product/colours/library */
export async function listLibrary(caller: CommandCaller, query: ColourLibraryQuery): Promise<ColourLibraryView> {
  const actor = actorOf(contextOf(caller))
  const cursor = decodeCursor(query.cursor)
  const scope = scopedWhere(caller, query.companyId)
  return caller.withClient(async (client) => {
    const familyRows = await client.colour.groupBy({ by: ['family'], where: { AND: [...scope, { family: { not: null } }] }, orderBy: { family: 'asc' } })
    const families = familyRows.flatMap((row) => (row.family ? [row.family] : []))
    const ignored: string[] = []
    const filters: Prisma.ColourWhereInput[] = [...scope]
    if (query.view === 'active') filters.push({ status: 'ACTIVE' })
    if (query.view === 'archived') filters.push({ status: 'ARCHIVED' })
    if (query.view === 'unused') filters.push({ status: 'ACTIVE' }, unusedWhere(await brandColourIds(client)))
    if (query.system) {
      const system = query.system.toUpperCase()
      if ((COLOUR_SYSTEMS as readonly string[]).includes(system)) filters.push({ system: system as ColourSystem })
      else ignored.push(`system=${query.system}`)
    }
    if (query.family) {
      const family = normaliseFamily(query.family)
      if (family && families.includes(family)) filters.push({ family })
      else ignored.push(`family=${query.family}`)
    }
    const q = query.q?.trim()
    if (q) {
      const hex = q.replace(/^#/, '')
      filters.push({
        OR: [
          { code: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
          { reference: { contains: q, mode: 'insensitive' } },
          { family: { contains: q.toLowerCase() } },
          ...(/^[0-9a-f]{3,6}$/i.test(hex) ? [{ hex: { contains: hex.toUpperCase() } }] : []),
        ],
      })
    }
    const [rows, count] = await Promise.all([
      client.colour.findMany({ where: { AND: [...filters, afterCursor(cursor)] }, select: COLOUR_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1 }),
      client.colour.count({ where: { AND: filters } }),
    ])
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      colours: await viewsOf(client, actor, page),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ code: last.code, id: last.id }) : null,
      count,
      ignored,
      families,
    }
  })
}

/** The most brands named in the "brands without a set" notice (the count says all). */
const NAMED_BRANDS = 10

/** GET /product/colours/counts */
export async function libraryCounts(caller: CommandCaller, query: { readonly companyId?: string | undefined }): Promise<ColourCountsView> {
  const actor = actorOf(contextOf(caller))
  const scope = scopedWhere(caller, query.companyId)
  const setScope = scopeWhere(actor, PRODUCT_STYLES_VIEW, SET_SCOPE) as Prisma.BrandingSetWhereInput
  return caller.withClient(async (client) => {
    const named = await brandColourIds(client)
    const [unused, sets, noHex, styles, activeSets] = await Promise.all([
      client.colour.count({ where: { AND: [...scope, { status: 'ACTIVE' }, unusedWhere(named)] } }),
      client.brandingSet.count({ where: { AND: [setScope, { status: 'ACTIVE' }, query.companyId ? { companyId: query.companyId } : {}] } }),
      client.colour.count({ where: { AND: [...scope, { status: 'ACTIVE', hex: null }] } }),
      // Private-label styles under the brand's own name (B-W2b-206: brandPartyId set, not sold under our name) the person sees.
      client.style.groupBy({
        by: ['companyId', 'brandPartyId'],
        where: { AND: [scopeWhere(actor, PRODUCT_STYLES_VIEW, COLOUR_SCOPE) as Prisma.StyleWhereInput, { brandPartyId: { not: null }, soldUnderOurName: false, status: { not: 'ARCHIVED' } }, query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {}] },
        _count: { _all: true },
      }),
      client.brandingSet.findMany({ where: { status: 'ACTIVE' }, select: { companyId: true, partyId: true } }),
    ])
    const covered = new Set(activeSets.map((set) => `${set.companyId}|${set.partyId}`))
    const brandsWithSet = new Set(activeSets.map((set) => set.partyId))
    // A company's style reads its company's set; a style of every company reads the brand's set of any company.
    const missing = styles.filter((row) => row.brandPartyId && (row.companyId ? !covered.has(`${row.companyId}|${row.brandPartyId}`) : !brandsWithSet.has(row.brandPartyId)))
    const partyIds = [...new Set(missing.map((row) => row.brandPartyId!))]
    const parties = partyIds.length === 0 ? [] : await client.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true } })
    const partyOf = new Map(parties.map((party) => [party.id, party]))
    const brands = missing
      .flatMap((row) => {
        const party = partyOf.get(row.brandPartyId!)
        return party ? [{ partyId: party.id, code: party.code, name: party.tradeName ?? party.legalName, companyId: row.companyId, styles: row._count._all }] : []
      })
      .sort((a, b) => b.styles - a.styles || a.code.localeCompare(b.code))
    return { tiles: { unused, brandingSets: sets }, brandsWithoutSet: { count: missing.length, brands: brands.slice(0, NAMED_BRANDS) }, noHex }
  })
}
