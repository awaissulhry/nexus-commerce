import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { ColourRow, ListColoursQuery } from '@nexus/factory-domain/product/styles/contracts'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, STYLE_SCOPE } from './store'

/**
 * The colour library as a colourway picks its main colour (SCR-041 "Colourways": the swatch). Read only: the library
 * itself is kept on its own page later (W2b "Colours & artwork"); a colourway names an ACTIVE colour of its style's
 * company or of every company (store.ts colourProblems). Scoped like the styles: the caller's companies and the
 * tenant-wide colours.
 */
export async function listColours(caller: CommandCaller, query: ListColoursQuery): Promise<{ colours: ColourRow[] }> {
  const context = contextOf(caller)
  const search = query.q?.trim()
  const filters: Prisma.ColourWhereInput[] = [
    scopeWhere(actorOf(context), PRODUCT_STYLES_VIEW, STYLE_SCOPE) as Prisma.ColourWhereInput,
    query.status === 'ALL' ? {} : { status: query.status },
    search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } : {},
    query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
  ]
  const rows = await caller.withClient((client) =>
    client.colour.findMany({
      where: { AND: filters },
      select: { id: true, companyId: true, code: true, name: true, hex: true, status: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: query.limit,
    }),
  )
  return { colours: rows.map((row) => ({ id: row.id, companyId: row.companyId, code: row.code, name: row.name, hex: row.hex, status: row.status })) }
}
