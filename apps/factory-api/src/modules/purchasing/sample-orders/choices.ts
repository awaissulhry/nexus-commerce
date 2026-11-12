import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { convertibleUnits, type Uom } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_PARTY_ROLES } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import { OPEN_ROUND_STAGES } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import type { SampleKind, SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf, unitsOf } from '../store'

/**
 * GET /purchasing/sample-orders/choices?companyId= (purchasing.manage over the company; design pop "New sample order"): what the
 * dialog offers — the company's active sites the caller may order for (the only one is the default), the suppliers it may order
 * from (a SUPPLIER or SUBCONTRACTOR, never blocked or archived; its prospects are drafted, as W1's), the styles a sample order
 * may be for (of the company or tenant-wide, not archived or discontinued) each with its open sample rounds of the company, and
 * the materials (never a finished garment) with their units and active colours. Each list is cut at its limit (`complete`).
 */

const LIMIT = { suppliers: 500, styles: 500, materials: 1000 } as const

export async function sampleChoices(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!can(actor, PURCHASING_MANAGE, { companyId: query.companyId })) throw new ForbiddenError('Drafting a sample order needs the right to manage purchase orders of this company.')
  const partyScope = scopeWhere(actor, PURCHASING_MANAGE, { company: { field: 'companyId', nullable: true }, party: 'id' }) as Prisma.PartyWhereInput
  return caller.withClient(async (client) => {
    const sites = (await client.site.findMany({ where: { companyId: query.companyId, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, code: true, name: true } })).filter((site) =>
      can(actor, PURCHASING_MANAGE, { companyId: query.companyId, siteId: site.id }),
    )
    const suppliers = await client.party.findMany({
      where: { AND: [partyScope, { OR: [{ companyId: null }, { companyId: query.companyId }] }, { roles: { hasSome: [...PURCHASE_PARTY_ROLES] } }, { status: { notIn: ['BLOCKED', 'ARCHIVED'] } }] },
      orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
      take: LIMIT.suppliers + 1,
      select: { id: true, code: true, legalName: true, currency: true, language: true },
    })
    const styles = await client.style.findMany({
      where: { OR: [{ companyId: null }, { companyId: query.companyId }], status: { not: 'ARCHIVED' }, lifecycle: { not: 'DISCONTINUED' } },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: LIMIT.styles + 1,
      select: { id: true, code: true, name: true, lifecycle: true },
    })
    const shownStyles = styles.slice(0, LIMIT.styles)
    const rounds =
      shownStyles.length === 0
        ? []
        : await client.sampleRound.findMany({
            where: { companyId: query.companyId, styleId: { in: shownStyles.map((style) => style.id) }, stage: { in: [...OPEN_ROUND_STAGES] } },
            orderBy: [{ styleId: 'asc' }, { kind: 'asc' }, { roundNo: 'asc' }, { id: 'asc' }],
            select: { id: true, styleId: true, number: true, kind: true, roundNo: true, stage: true },
          })
    const materials = await client.item.findMany({
      where: { OR: [{ companyId: null }, { companyId: query.companyId }], kind: { in: [...ITEM_KINDS] }, status: 'ACTIVE' },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: LIMIT.materials + 1,
      select: { id: true, code: true, name: true, kind: true, baseUom: true, purchaseUom: true, purchaseFactor: true, consumptionUom: true, consumptionFactor: true },
    })
    const shownMaterials = materials.slice(0, LIMIT.materials)
    const colours =
      shownMaterials.length === 0
        ? []
        : await client.itemColour.findMany({ where: { itemId: { in: shownMaterials.map((item) => item.id) }, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, itemId: true, code: true, name: true } })
    return {
      sites,
      defaultSiteId: sites.length === 1 ? sites[0]!.id : null,
      suppliers: suppliers.slice(0, LIMIT.suppliers).map((party) => ({ id: party.id, code: party.code, name: party.legalName, currency: party.currency, language: party.language })),
      styles: shownStyles.map((style) => ({
        id: style.id,
        code: style.code,
        name: style.name,
        lifecycle: style.lifecycle,
        rounds: rounds.filter((round) => round.styleId === style.id).map((round) => ({ id: round.id, number: round.number, kind: round.kind as SampleKind, roundNo: round.roundNo, stage: round.stage as SampleStage })),
      })),
      materials: shownMaterials.map((item) => ({
        id: item.id,
        code: item.code,
        name: item.name,
        kind: item.kind,
        baseUom: item.baseUom as Uom,
        purchaseUom: item.purchaseUom as Uom,
        units: convertibleUnits(unitsOf(item)),
        colours: colours.filter((colour) => colour.itemId === item.id).map((colour) => ({ id: colour.id, code: colour.code, name: colour.name })),
      })),
      complete: suppliers.length <= LIMIT.suppliers && styles.length <= LIMIT.styles && materials.length <= LIMIT.materials,
    }
  })
}
