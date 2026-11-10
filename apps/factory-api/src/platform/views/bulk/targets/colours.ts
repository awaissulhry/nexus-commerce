import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_COLOURS_MANAGE } from '@nexus/factory-domain/product/colours/permissions'
import { COLOUR_LIMITS, COLOUR_SYSTEMS, type ColourSystem } from '@nexus/factory-domain/product/colours/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { BulkRefusal } from '@nexus/factory-domain/views/bulk/rules'
import { actorOf } from '../../../../core/context'
import { updateColour } from '../../../../modules/product/colours/colours'
import { COLOUR_SCOPE } from '../../../../modules/product/colours/store'
import { contextOf } from '../../../../modules/product/styles/store'
import { defineBulkTarget } from '../target'

/**
 * Products › Libraries › Colours & artwork (SCR-118, `/products/colours`; B-W2b-247, design sec:colours.grid "Inline edit
 * of every field, autosave per cell"): a colour's name, system, reference, family and hex, by the list frame's column ids,
 * each written through the module's own product.colours.update (product.colours.manage over the colour's company, its
 * version check, the database's Colour_system_check said in words, its audit row and colour.changed). An archived colour
 * keeps them (restore it first). No money, no person.
 */

interface Row {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
  readonly name: string
  readonly system: ColourSystem | null
  readonly reference: string | null
  readonly family: string | null
  readonly hex: string | null
  readonly status: 'ACTIVE' | 'ARCHIVED'
  readonly version: number
}

const SELECT = { id: true, code: true, companyId: true, name: true, system: true, reference: true, family: true, hex: true, status: true, version: true } as const satisfies Prisma.ColourSelect
const held = (row: Row): BulkRefusal | null => (row.status === 'ARCHIVED' ? { code: 'held', status: row.status } : null)

export const colours = defineBulkTarget<Row>({
  listKey: 'products.colours',
  permission: PRODUCT_COLOURS_MANAGE,
  fields: {
    name: { kind: 'text', maxLength: COLOUR_LIMITS.name, read: (row) => row.name, held },
    system: { kind: 'choice', nullable: true, choices: COLOUR_SYSTEMS, read: (row) => row.system, held },
    reference: { kind: 'text', nullable: true, maxLength: COLOUR_LIMITS.reference, read: (row) => row.reference, held },
    family: { kind: 'text', nullable: true, maxLength: COLOUR_LIMITS.family, read: (row) => row.family, held },
    hex: { kind: 'text', nullable: true, maxLength: 20, read: (row) => row.hex, held },
  },
  async load(caller, ids) {
    const wanted = ids.filter(isUuid)
    if (wanted.length === 0) return []
    const actor = actorOf(contextOf(caller))
    const rows = await caller.withClient((client) => client.colour.findMany({ where: { AND: [scopeWhere(actor, PRODUCT_STYLES_VIEW, COLOUR_SCOPE) as Prisma.ColourWhereInput, { id: { in: wanted } }] }, select: SELECT }))
    return rows.map((row) => ({ ...row, system: (row.system as ColourSystem | null) ?? null }))
  },
  idOf: (row) => row.id,
  labelOf: (row) => row.code,
  versionOf: (row) => row.version,
  statusOf: (row) => row.status,
  rowHeld: (caller, row) => (can(actorOf(contextOf(caller)), PRODUCT_COLOURS_MANAGE, { companyId: row.companyId }) ? null : { code: 'forbidden' }),
  async write(caller, row, changes, version, idempotencyKey) {
    const text = (key: string) => (Object.hasOwn(changes, key) ? { [key]: changes[key] === null ? null : String(changes[key]) } : {})
    const colour = await updateColour(
      caller,
      row.id,
      {
        version,
        ...(Object.hasOwn(changes, 'name') ? { name: String(changes.name ?? '') } : {}),
        ...(Object.hasOwn(changes, 'system') ? { system: (changes.system as ColourSystem | null) ?? null } : {}),
        ...text('reference'),
        ...text('family'),
        ...text('hex'),
      },
      idempotencyKey,
    )
    return { id: colour.id, code: colour.code, companyId: colour.companyId, name: colour.name, system: colour.system, reference: colour.reference, family: colour.family, hex: colour.hex, status: colour.status, version: colour.version }
  },
})
