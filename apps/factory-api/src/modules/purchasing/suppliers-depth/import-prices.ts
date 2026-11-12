import type { Issue } from '@nexus/factory-domain/core/errors'
import { grantsFor } from '@nexus/factory-domain/core/permissions'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { ExistingRecord, RowIssue } from '@nexus/factory-domain/imports/importer'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { isPurchaseParty } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { PURCHASING_SOURCES_MANAGE } from '@nexus/factory-domain/purchasing/sources/permissions'
import { sourceProblems, type SourceFields, type SourcePreference } from '@nexus/factory-domain/purchasing/sources/sources'
import { colourOfKey, PRICE_VALUE_COLUMNS, priceRecordValues, supplierPricesImporter, type PriceValueColumn } from '@nexus/factory-domain/purchasing/suppliers-depth/importer'
import type { CommandTools, CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { CheckRow, ImportAdapter, ImportScope } from '../../../platform/imports/registry'
import { decimal, ITEM_COLUMNS, unitsOf, type ItemRow } from '../store'
import { mayKeep, SOURCE_COLUMNS } from '../supplier-items/store'
import { changeSourceInCommand, insertSourceInCommand, type SourceInput } from '../supplier-items/supplier-items'

/**
 * A supplier's price list from a sheet (B-W2b-311; SCM-289 → PLT-176; design purchasing.suppliers › Items & prices
 * "Import price list (W2b, ImportFlow)"): the adapter of factory-domain's `supplierPricesImporter`. One approved source per
 * row (B-W2a-10's SupplierItem), keyed by the supplier's code, our material's code and its colour's code (* for every
 * colour), in the job's company (none: a source for every company). Running and applying it needs
 * purchasing.sources.manage, seeing its plans purchasing.view (the engine checks both against the job's company); the
 * Unit price column the cost grain (the engine refuses it otherwise).
 *
 *   load    the ACTIVE source each key finds (supplier, material and colour by their codes, in the job's company)
 *   check   what a row names: the supplier (a supplier or subcontractor, not archived, of the job's company or every
 *           company; a source for every company needs a supplier of every company), the person may keep its sources, the
 *           material (active, of the job's company or every company), the colour (an active colour of the material), and
 *           the source's own rules (the unit the material converts, the price, minimum, steps, lead time) with the fields
 *           it would hold
 *   write   ONE row inside the batch's command through the approved sources' own commands (supplier-items.ts
 *           insertSourceInCommand / changeSourceInCommand: the material's lock, one source per supplier and scope, one
 *           PRIMARY per scope — a PRIMARY row makes the other one a BACKUP), audited as purchasing.sources.import
 */

const ACTION = 'purchasing.sources.import'

class PriceRowRefused extends ApiError {
  constructor(key: string, detail: string) {
    super('conflict', `The price list row for ${key} no longer fits: ${detail}. Run the dry run again.`)
  }
}

const PARTY = { id: true, code: true, companyId: true, roles: true, status: true, currency: true, legalName: true, tradeName: true } as const
const COLOUR = { id: true, itemId: true, code: true, status: true, supplierColourCode: true } as const

interface Named {
  readonly parties: Map<string, { id: string; code: string; companyId: string | null; roles: string[]; status: string; currency: string; legalName: string; tradeName: string | null }>
  readonly items: Map<string, ItemRow>
  readonly colours: Map<string, { id: string; itemId: string; code: string; status: string; supplierColourCode: string | null }>
}

/** The suppliers, materials and colours the keys name, by code (colours by item id + code). */
async function namedBy(client: CommandTx, keys: readonly Readonly<Record<string, CellValue>>[]): Promise<Named> {
  const suppliers = [...new Set(keys.map((key) => String(key.supplier)))]
  const materials = [...new Set(keys.map((key) => String(key.material)))]
  const parties = await client.party.findMany({ where: { code: { in: suppliers } }, select: PARTY })
  const items = await client.item.findMany({ where: { code: { in: materials } }, select: ITEM_COLUMNS })
  const colourCodes = [...new Set(keys.map((key) => colourOfKey(key.colour)).filter((code): code is string => code !== null))]
  const colours = colourCodes.length === 0 || items.length === 0 ? [] : await client.itemColour.findMany({ where: { itemId: { in: items.map((item) => item.id) }, code: { in: colourCodes } }, select: COLOUR })
  return {
    parties: new Map(parties.map((party) => [party.code, { ...party, roles: [...party.roles] }])),
    items: new Map(items.map((item) => [item.code, item])),
    colours: new Map(colours.map((colour) => [`${colour.itemId}|${colour.code}`, colour])),
  }
}

const sourceKey = (companyId: string | null, partyId: string, itemId: string, itemColourId: string | null) => `${companyId ?? '*'}|${partyId}|${itemId}|${itemColourId ?? '*'}`

/** The fields a row's values set (blank cells left out). */
function inputOf(values: Readonly<Record<string, CellValue>>): SourceInput {
  const out: Record<string, unknown> = {}
  for (const column of PRICE_VALUE_COLUMNS) {
    const value = values[column]
    if (value === undefined) continue
    out[column] = column === 'leadTimeDays' ? Number(value) : String(value)
  }
  return out as SourceInput
}

const COLUMN_OF: Readonly<Record<string, PriceValueColumn>> = Object.fromEntries(PRICE_VALUE_COLUMNS.map((column) => [column, column]))

export const supplierPricesImportAdapter = Object.freeze({
  importer: supplierPricesImporter,
  permission: PURCHASING_SOURCES_MANAGE,
  viewPermission: PURCHASING_VIEW,

  authorize(actor, job) {
    if (job.companyId !== null) return []
    return grantsFor(actor, PURCHASING_SOURCES_MANAGE).some((grant) => grant.companies === 'all')
      ? []
      : [{ path: 'companyId', message: 'A price list for every company is kept only by a role over every company: import it for one company instead.' } satisfies Issue]
  },

  async check(client, rows: readonly CheckRow[], scope: ImportScope, actor) {
    const named = await namedBy(client, rows.map((row) => row.key))
    const existing = await client.supplierItem.findMany({
      where: { status: 'ACTIVE', companyId: scope.companyId, partyId: { in: [...named.parties.values()].map((party) => party.id) }, itemId: { in: [...named.items.values()].map((item) => item.id) } },
      select: SOURCE_COLUMNS,
    })
    const sources = new Map(existing.map((row) => [sourceKey(row.companyId, row.partyId, row.itemId, row.itemColourId), row]))
    return rows.map((row): RowIssue[] => {
      const party = named.parties.get(String(row.key.supplier))
      if (!party) return [{ column: 'supplier', message: `No supplier has the code ${String(row.key.supplier)}.` }]
      const name = party.tradeName ?? party.legalName
      if (!isPurchaseParty(party.roles as never)) return [{ column: 'supplier', message: `${name} is not a supplier: give it the supplier role first.` }]
      if (party.status === 'ARCHIVED') return [{ column: 'supplier', message: `${name} is archived: it is no approved source any more.` }]
      if (party.companyId !== null && party.companyId !== scope.companyId) {
        return [{ column: 'supplier', message: scope.companyId === null ? `${name} supplies one company only: import its prices for that company.` : `${name} is another company's supplier.` }]
      }
      if (!mayKeep(actor, { companyId: scope.companyId, partyId: party.id })) return [{ column: 'supplier', message: `Keeping ${name}'s prices needs purchasing.sources.manage over it and the import's company.` }]
      const item = named.items.get(String(row.key.material))
      if (!item) return [{ column: 'material', message: `No material has the code ${String(row.key.material)}.` }]
      if (item.companyId !== null && item.companyId !== scope.companyId) {
        return [{ column: 'material', message: scope.companyId === null ? `${item.code} is one company's material: import its prices for that company.` : `${item.code} is another company's material.` }]
      }
      if (item.status !== 'ACTIVE') return [{ column: 'material', message: `${item.code} is archived: it is not bought any more.` }]
      const colourCode = colourOfKey(row.key.colour)
      const colour = colourCode === null ? null : named.colours.get(`${item.id}|${colourCode}`)
      if (colourCode !== null && !colour) return [{ column: 'colour', message: `${item.code} has no colour ${colourCode} (write * for every colour).` }]
      if (colour && colour.status !== 'ACTIVE') return [{ column: 'colour', message: `${item.code} ${colour.code} is archived: choose an active colour.` }]
      const current = sources.get(sourceKey(scope.companyId, party.id, item.id, colour?.id ?? null))
      const input = inputOf(row.values)
      const fields: SourceFields = {
        purchaseUom: (input.purchaseUom ?? current?.purchaseUom ?? item.purchaseUom) as Uom,
        unitPrice: input.unitPrice !== undefined ? (input.unitPrice ?? null) : decimal(current?.unitPrice ?? null),
        currency: input.currency ?? current?.currency ?? party.currency,
        minOrderQty: input.minOrderQty !== undefined ? (input.minOrderQty ?? null) : decimal(current?.minOrderQty ?? null),
        orderMultiple: input.orderMultiple !== undefined ? (input.orderMultiple ?? null) : decimal(current?.orderMultiple ?? null),
        leadTimeDays: input.leadTimeDays !== undefined ? (input.leadTimeDays ?? null) : (current?.leadTimeDays ?? null),
        supplierArticleCode: input.supplierArticleCode ?? current?.supplierArticleCode ?? null,
        supplierColourCode: input.supplierColourCode ?? current?.supplierColourCode ?? null,
        description: input.description ?? current?.description ?? null,
        note: input.note ?? current?.note ?? null,
      }
      return sourceProblems(fields, { units: unitsOf(item) }).map((issue) => ({ column: COLUMN_OF[issue.path.split('/')[0] ?? ''] ?? 'purchaseUom', message: issue.message }))
    })
  },

  async load(client, keys, scope): Promise<readonly ExistingRecord[]> {
    const named = await namedBy(client, keys)
    const partyIds = [...named.parties.values()].map((party) => party.id)
    const itemIds = [...named.items.values()].map((item) => item.id)
    if (partyIds.length === 0 || itemIds.length === 0) return []
    const rows = await client.supplierItem.findMany({ where: { status: 'ACTIVE', companyId: scope.companyId, partyId: { in: partyIds }, itemId: { in: itemIds } }, select: SOURCE_COLUMNS, orderBy: { id: 'asc' } })
    const partyCode = new Map([...named.parties.values()].map((party) => [party.id, party.code]))
    const itemCode = new Map([...named.items.values()].map((item) => [item.id, item.code]))
    const colourIds = rows.flatMap((row) => (row.itemColourId ? [row.itemColourId] : []))
    const colours = new Map((colourIds.length === 0 ? [] : await client.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true } })).map((colour) => [colour.id, colour.code]))
    return rows.map((row) => ({
      id: row.id,
      values: priceRecordValues(
        { supplier: partyCode.get(row.partyId)!, material: itemCode.get(row.itemId)!, colour: row.itemColourId ? (colours.get(row.itemColourId) ?? null) : null },
        {
          supplierArticleCode: row.supplierArticleCode,
          supplierColourCode: row.supplierColourCode,
          description: row.description,
          purchaseUom: row.purchaseUom,
          unitPrice: decimal(row.unitPrice),
          currency: row.currency,
          minOrderQty: decimal(row.minOrderQty),
          orderMultiple: decimal(row.orderMultiple),
          leadTimeDays: row.leadTimeDays,
          preference: row.preference,
          note: row.note,
        },
      ),
    }))
  },

  async write(tools: CommandTools, row, scope) {
    const tenantId = 'tenantId' in tools.context && tools.context.tenantId ? tools.context.tenantId : null
    if (!tenantId) throw new ApiError('internal_error', 'A price list is imported in a tenant’s context.')
    const key = `${String(row.key.supplier)} ${String(row.key.material)} ${String(row.key.colour)}`
    const input = inputOf(row.values)
    if (row.action === 'UPDATE') {
      await changeSourceInCommand(tools, { tenantId, action: ACTION }, row.recordId!, null, input)
      return { recordId: row.recordId! }
    }
    const named = await namedBy(tools.tx, [row.key])
    const party = named.parties.get(String(row.key.supplier))
    const item = named.items.get(String(row.key.material))
    const colourCode = colourOfKey(row.key.colour)
    const colour = item && colourCode !== null ? named.colours.get(`${item.id}|${colourCode}`) : null
    if (!party || !item || (colourCode !== null && !colour)) throw new PriceRowRefused(key, 'the supplier, the material or the colour is gone')
    const { id } = await insertSourceInCommand(tools, { tenantId, createdById: null, action: ACTION }, {
      companyId: scope.companyId,
      partyId: party.id,
      itemId: item.id,
      itemColourId: colour?.id ?? null,
      ...input,
      preference: input.preference as SourcePreference | undefined,
    })
    return { recordId: id }
  },
} satisfies ImportAdapter)
