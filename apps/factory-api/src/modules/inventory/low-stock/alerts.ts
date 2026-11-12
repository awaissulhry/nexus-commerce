import type { Finding, RulePlace } from '@nexus/factory-domain/alerts/rules'
import { UNITS } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import { inForceOf, rowsOf } from '../posting/store'
import { readLowStock } from './store'

/**
 * The LOW_STOCK alert rule's finder (B-W2b-314; SCM-281 "Low-stock alerts are daily running"; factory-domain alerts/kinds
 * LOW_STOCK; platform/alerts/evaluators FINDERS): in the tenant's system scope, every active site of the rule's place whose
 * company keeps the low-stock alerts on (the warehouse rules; on by default), each material below its planning minimum
 * there — one alert per material, colour (where the site keeps its own minimum) and site: record Item, sub-key
 * `<site>|<colour or ->`, label "LEA-BLK at A1" (with the colour's code where there is one). The facts name the numbers
 * the alert says (no money, no person). `only`: the items of a recheck (none: the kind rechecks with every pass).
 */
export async function lowStockFindings(tx: CommandTx, rule: RulePlace, _now: Date, only?: readonly string[]): Promise<Finding[]> {
  const sites = await tx.site.findMany({
    where: { status: 'ACTIVE', ...(rule.companyId ? { companyId: rule.companyId } : {}), ...(rule.siteId ? { id: rule.siteId } : {}) },
    orderBy: [{ id: 'asc' }],
    select: { id: true, code: true, companyId: true, tenantId: true },
  })
  const on = new Map<string, boolean>()
  for (const companyId of [...new Set(sites.map((site) => site.companyId))]) {
    const tenantId = sites.find((site) => site.companyId === companyId)!.tenantId
    on.set(companyId, inForceOf(companyId, await rowsOf(tx, tenantId, companyId)).lowStockAlerts.value)
  }
  const watched = sites.filter((site) => on.get(site.companyId) === true)
  const rows = (await readLowStock(tx, { siteIds: watched.map((site) => site.id), ...(only ? { itemIds: only } : {}) })).filter((row) => row.below)
  if (rows.length === 0) return []
  const items = new Map((await tx.item.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.itemId))] } }, select: { id: true, code: true } })).map((item) => [item.id, item.code]))
  const colourIds = [...new Set(rows.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
  const colours = new Map((colourIds.length ? await tx.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true } }) : []).map((colour) => [colour.id, colour.code]))
  const siteCode = new Map(watched.map((site) => [site.id, site.code]))
  const plain = (value: string) => new Dec(value).toFixed()
  return rows.map((row) => {
    const colour = row.itemColourId ? colours.get(row.itemColourId) : undefined
    return {
      recordType: 'Item',
      recordId: row.itemId,
      subKey: `${row.siteId}|${row.itemColourId ?? '-'}`,
      label: `${items.get(row.itemId) ?? row.itemId}${colour ? ` ${colour}` : ''} at ${siteCode.get(row.siteId) ?? row.siteId}`,
      scope: { companyId: row.companyId, siteId: row.siteId, partyId: null },
      facts: { position: plain(row.position), minimum: plain(row.minimum), unit: UNITS[row.uom].symbol, basis: row.basis, itemColourId: row.itemColourId, itemPlanningId: row.itemPlanningId },
    }
  })
}
