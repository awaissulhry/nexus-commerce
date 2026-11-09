import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { ExplosionQuery, ExplosionView } from '@nexus/factory-domain/product/bom-structure/contracts'
import { explodeExact, materialTotals, roundExplosion, type ExplodeLine, type ExplodeRevision } from '@nexus/factory-domain/product/bom-structure/explode'
import { MAX_BOM_LEVELS } from '@nexus/factory-domain/product/bom-structure/rules'
import { decimalText, roundTo } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { readStructure, readTargets, type Reader } from '../bom-structure/store'
import { readLines, readMaterials, readRevisionFor, ROUND, type MaterialFacts } from './store'

/**
 * The multi-level BOM explosion (B-W2b-223; PRD-078): a revision and every sub-assembly below it read level by level (W1's
 * lines with their sizes and grid, B-W2b-211's structure columns, each revision's style range, colourways and output), then
 * walked by factory-domain product/bom-structure/explode. THE one reader of a BOM with its sub-assemblies: planning (the
 * component's own need and its materials), the subcontract kit (the lines for the workshop, the customer's material) and
 * cost (the leaves) call `readExplosion` and `explodeExact` instead of reading one revision's lines (W1's single level).
 * The route GET …/bom/explosion (modules/product/bom-structure) answers it for a person.
 */

/** A revision as the explosion reads it, with its style's name. */
export type ExplosionRevision = ExplodeRevision & { readonly name: string }

export interface ExplosionRead {
  readonly top: ExplosionRevision
  readonly revisions: ReadonlyMap<string, ExplosionRevision>
  readonly materials: ReadonlyMap<string, MaterialFacts>
}

/** A revision and its sub-assemblies to MAX_BOM_LEVELS, with every material they name (one revision not found: left out). */
export async function readExplosion(db: Reader, revisionId: string): Promise<ExplosionRead | null> {
  const revisions = new Map<string, ExplosionRevision>()
  const itemIds = new Set<string>()
  let frontier = [revisionId]
  for (let level = 1; level <= MAX_BOM_LEVELS + 1 && frontier.length > 0; level += 1) {
    const targets = await readTargets(db, frontier)
    const next: string[] = []
    for (const id of frontier) {
      const target = targets.get(id)
      if (!target) continue
      const lines = await readLines(db, id, { sizes: target.sizes, colourwayIds: target.colourways.map((colourway) => colourway.id) })
      const structure = new Map((await readStructure(db, id)).map((record) => [record.id, record]))
      const explodeLines: ExplodeLine[] = lines.map((line) => {
        const record = structure.get(line.id)
        itemIds.add(line.itemId)
        if (record?.subAssemblyRevisionId && !revisions.has(record.subAssemblyRevisionId) && !frontier.includes(record.subAssemblyRevisionId)) next.push(record.subAssemblyRevisionId)
        return {
          ...line,
          subAssemblyRevisionId: record?.subAssemblyRevisionId ?? null,
          customerSupplied: (record?.customerSuppliedByPartyId ?? null) !== null,
          issueToSubcontract: record?.issueToSubcontract ?? false,
          optionValueId: record?.optionValueId ?? null,
        }
      })
      revisions.set(id, { ...target, lines: explodeLines })
    }
    frontier = [...new Set(next)].filter((id) => !revisions.has(id))
  }
  const top = revisions.get(revisionId)
  if (!top) return null
  const { materials } = await readMaterials(db, [...itemIds])
  return { top, revisions, materials }
}

/** GET …/bom/explosion: the explosion of one colourway in each size asked, for a person (product.bom.view). */
export async function explosionFor(caller: CommandCaller, styleId: string, revisionId: string, query: ExplosionQuery): Promise<ExplosionView> {
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  return caller.withClient(async (client) => {
    const read = await readExplosion(client, revision.id)
    if (!read) throw new ValidationError('The revision cannot be read.')
    const { top, materials } = read
    const active = top.colourways.filter((colourway) => colourway.status === 'ACTIVE')
    const colourway = query.colourwayId === undefined ? (active[0] ?? top.colourways[0]) : top.colourways.find((entry) => entry.id === query.colourwayId)
    if (!colourway) throw new ValidationError('The explosion is not valid.', [{ path: 'querystring/colourwayId', message: query.colourwayId === undefined ? 'The style has no colourway yet.' : 'No such colourway of this style.' }])
    const sizes = query.sizes ?? [...style.sizes]
    const outside = sizes.filter((size) => !style.sizes.includes(size))
    if (outside.length > 0) throw new ValidationError('The explosion is not valid.', [{ path: 'querystring/sizes', message: `Not in the style's range (${style.sizes.join(', ') || 'none yet'}): ${outside.join(', ')}.` }])
    const options = new Set(query.options ?? [])
    const input = {
      top,
      revisions: read.revisions,
      unitsOf: (itemId: string) => materials.get(itemId)?.units,
      codeOf: (itemId: string) => materials.get(itemId)?.code ?? '?',
      options,
    }
    const item = (itemId: string) => {
      const material = materials.get(itemId)
      return { id: itemId, code: material?.code ?? '?', name: material?.name ?? '', kind: material?.kind ?? 'COMPONENT' }
    }
    const styleOf = (revisionIdOf: string) => read.revisions.get(revisionIdOf)
    return {
      revision: { id: revision.id, styleId: revision.styleId, revision: revision.revision, status: revision.status, version: revision.version },
      style: { id: style.id, code: style.code, name: style.name },
      colourway: { id: colourway.id, code: colourway.code, status: colourway.status },
      options: [...options],
      outputQuantity: top.outputQuantity,
      outputUom: top.outputUom,
      sizes: sizes.map((size) => {
        const exact = explodeExact(input, { size, colourwayId: colourway.id, colourwayCode: colourway.code })
        const rounded = roundExplosion(exact, ROUND)
        const via = (steps: readonly { lineId: string }[]) => steps.map((step) => step.lineId)
        return {
          size,
          materials: rounded.materials.map((row) => ({ level: row.level, revisionId: row.revisionId, lineId: row.lineId, via: via(row.via), item: item(row.itemId), itemColourId: row.itemColourId, uom: row.uom, quantity: row.quantity, customerSupplied: row.customerSupplied, issueToSubcontract: row.issueToSubcontract })),
          subAssemblies: rounded.subAssemblies.map((row) => {
            const target = styleOf(row.subRevisionId)
            return {
              level: row.level,
              revisionId: row.revisionId,
              lineId: row.lineId,
              via: via(row.via),
              item: item(row.itemId),
              itemColourId: row.itemColourId,
              uom: row.uom,
              quantity: row.quantity,
              customerSupplied: row.customerSupplied,
              issueToSubcontract: row.issueToSubcontract,
              subAssembly: { style: { id: row.styleId, code: row.code, name: target?.name ?? '' }, revision: { id: row.subRevisionId, revision: row.revision, status: row.status } },
              size: row.size,
              colourwayId: row.colourwayId,
              batches: row.batches,
            }
          }),
          byMaterial: materialTotals(exact).map((total) => ({
            item: item(total.itemId),
            itemColourId: total.itemColourId,
            uom: total.uom,
            quantity: decimalText(roundTo(total.quantity, ROUND)),
            customerSupplied: total.customerSupplied,
            levels: [...total.levels],
          })),
          problems: [...rounded.problems],
        }
      }),
    }
  })
}
