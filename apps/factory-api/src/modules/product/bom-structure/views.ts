import type { BomStructureView, UsedInView } from '@nexus/factory-domain/product/bom-structure/contracts'
import { BOM_SECTIONS, groupOrder, MAX_BOM_LEVELS, sectionOf, type BomSection } from '@nexus/factory-domain/product/bom-structure/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { TargetRecord } from './store'
import { readTargets, type Reader } from './store'
import { checkViewOf, type LoadedStructure } from './check'

/**
 * The BOM structure's answers (B-W2b-223; design style.bom: the Section column and group rows, the Sub-assemblies tree,
 * the BOM check; "made once, used in several jackets"): read with one client, no money.
 */

type TreeNode = BomStructureView['tree'][number]

const subAssemblyRefOf = (target: TargetRecord) => ({
  style: { id: target.styleId, code: target.code, name: target.name, status: target.styleStatus },
  revision: { id: target.revisionId, revision: target.revision, status: target.status },
  outputQuantity: target.outputQuantity,
  outputUom: target.outputUom,
})

/**
 * The sub-assembly tree under a revision, depth first (each line's sub-assembly right under it), to MAX_BOM_LEVELS: each
 * revision's lines read once, level by level.
 */
export async function readTree(db: Reader, revisionId: string): Promise<{ nodes: TreeNode[]; levels: number }> {
  const lines = new Map<string, { id: string; revisionId: string; seq: number; itemId: string; qty: string; uom: TreeNode['uom']; subAssemblyRevisionId: string | null }[]>()
  let frontier = [revisionId]
  for (let level = 1; level <= MAX_BOM_LEVELS && frontier.length > 0; level += 1) {
    const rows = await db.bomLine.findMany({
      where: { revisionId: { in: frontier } },
      select: { id: true, revisionId: true, seq: true, itemId: true, qty: true, uom: true, subAssemblyRevisionId: true },
      orderBy: [{ revisionId: 'asc' }, { seq: 'asc' }],
    })
    for (const id of frontier) lines.set(id, [])
    for (const row of rows) lines.get(row.revisionId)!.push({ ...row, qty: decimalText(row.qty.toString()) })
    frontier = [...new Set(rows.flatMap((row) => (row.subAssemblyRevisionId && !lines.has(row.subAssemblyRevisionId) ? [row.subAssemblyRevisionId] : [])))]
  }
  const named = [...lines.values()].flatMap((rows) => rows.flatMap((row) => (row.subAssemblyRevisionId ? [row.subAssemblyRevisionId] : [])))
  if (named.length === 0) return { nodes: [], levels: 1 }
  const targets = await readTargets(db, named)
  const itemIds = [...new Set([...lines.values()].flatMap((rows) => rows.filter((row) => row.subAssemblyRevisionId !== null).map((row) => row.itemId)))]
  const items = new Map((await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, kind: true } })).map((item) => [item.id, item]))

  const nodes: TreeNode[] = []
  let deepest = 1
  const visit = (at: string, level: number, via: readonly string[], seen: ReadonlySet<string>) => {
    for (const line of lines.get(at) ?? []) {
      if (line.subAssemblyRevisionId === null) continue
      const target = targets.get(line.subAssemblyRevisionId)
      const item = items.get(line.itemId)
      if (!target || !item || item.kind === 'FINISHED') continue
      const own = lines.get(target.revisionId)
      nodes.push({
        level,
        via: [...via],
        revisionId: at,
        lineId: line.id,
        seq: line.seq,
        item: { id: item.id, code: item.code, name: item.name, kind: item.kind },
        qty: line.qty,
        uom: line.uom,
        subAssembly: subAssemblyRefOf(target),
        lines: own?.length ?? 0,
        subAssemblies: own?.filter((row) => row.subAssemblyRevisionId !== null).length ?? 0,
      })
      deepest = Math.max(deepest, level + 1)
      if (level < MAX_BOM_LEVELS && own && !seen.has(target.revisionId)) visit(target.revisionId, level + 1, [...via, line.id], new Set([...seen, target.revisionId]))
    }
  }
  visit(revisionId, 1, [], new Set([revisionId]))
  return { nodes, levels: deepest }
}

/** The structure of one revision's BOM, its tree and its check. */
export function structureViewOf(loaded: LoadedStructure, tree: { nodes: TreeNode[]; levels: number }): BomStructureView {
  const { bom } = loaded
  const recordOf = new Map(loaded.records.map((record) => [record.id, record]))
  const alternates = new Map<string, number>()
  for (const alternate of loaded.alternates) alternates.set(alternate.lineId, (alternates.get(alternate.lineId) ?? 0) + 1)
  const grouped = groupOrder(bom.lines.map((line) => ({ id: line.id, seq: line.seq, parentLineId: recordOf.get(line.id)?.parentLineId ?? null })))
  const lineOf = new Map(bom.lines.map((line) => [line.id, line]))
  const lines = grouped.map(({ line: ref, depth }) => {
    const line = lineOf.get(ref.id)!
    const record = recordOf.get(line.id)
    const material = bom.materials.get(line.itemId)!
    const extras = loaded.extras.get(line.itemId)
    const shown = sectionOf(record?.section ?? null, material.kind)
    const target = record?.subAssemblyRevisionId ? loaded.targets.get(record.subAssemblyRevisionId) : undefined
    return {
      id: line.id,
      seq: line.seq,
      item: { id: material.id, code: material.code, name: material.name, kind: material.kind, sourcing: extras?.sourcing ?? 'BUY', status: material.status, approval: extras?.approval ?? 'PENDING' },
      placement: line.placement,
      qty: line.qty,
      uom: line.uom,
      section: shown.section,
      filed: shown.filed,
      parentLineId: record?.parentLineId ?? null,
      depth,
      groupedLineIds: grouped.filter((entry) => entry.line.parentLineId === line.id).map((entry) => entry.line.id),
      subAssembly: target ? subAssemblyRefOf(target) : null,
      customerSuppliedByPartyId: record?.customerSuppliedByPartyId ?? null,
      issueToSubcontract: record?.issueToSubcontract ?? false,
      sourceKey: record?.sourceKey ?? null,
      optionValueId: record?.optionValueId ?? null,
      alternates: alternates.get(line.id) ?? 0,
    }
  })
  const sections = BOM_SECTIONS.flatMap((section: BomSection) => {
    const lineIds = lines.filter((line) => line.section === section).map((line) => line.id)
    return lineIds.length === 0 ? [] : [{ section, lineIds }]
  })
  const { revision, style } = bom
  return {
    revision: { id: revision.id, styleId: revision.styleId, revision: revision.revision, status: revision.status, version: revision.version },
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status },
    editable: revision.status === 'DRAFT' && style.status !== 'ARCHIVED',
    outputQuantity: loaded.output.outputQuantity,
    outputUom: loaded.output.outputUom,
    lines,
    sections,
    tree: tree.nodes,
    levels: tree.levels,
    check: checkViewOf(loaded),
  }
}

/** Every line of another style's revision that takes a revision of this style (the caller sees the styles it may). */
export async function usedInOf(db: Reader, style: { id: string; code: string; name: string; status: UsedInView['style']['status'] }, mayView: (companyId: string | null) => boolean): Promise<UsedInView> {
  const rows = await db.bomLine.findMany({
    where: { subAssemblyStyleId: style.id },
    select: { id: true, styleId: true, revisionId: true, seq: true, qty: true, uom: true, subAssemblyRevisionId: true },
    orderBy: [{ styleId: 'asc' }, { seq: 'asc' }],
  })
  if (rows.length === 0) return { style, usedIn: [] }
  const revisionIds = [...new Set(rows.flatMap((row) => [row.revisionId, row.subAssemblyRevisionId!]))]
  const revisions = new Map((await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true, status: true } })).map((row) => [row.id, row]))
  const parents = new Map((await db.style.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.styleId))] } }, select: { id: true, code: true, name: true, status: true, companyId: true } })).map((row) => [row.id, row]))
  const usedIn = rows.flatMap((row) => {
    const parent = parents.get(row.styleId)
    const revision = revisions.get(row.revisionId)
    const takes = revisions.get(row.subAssemblyRevisionId!)
    if (!parent || !revision || !takes || !mayView(parent.companyId)) return []
    return [
      {
        style: { id: parent.id, code: parent.code, name: parent.name, status: parent.status },
        revision: { id: revision.id, revision: revision.revision, status: revision.status },
        lineId: row.id,
        seq: row.seq,
        qty: decimalText(row.qty.toString()),
        uom: row.uom,
        takes: { id: takes.id, revision: takes.revision, status: takes.status },
      },
    ]
  })
  usedIn.sort((a, b) => a.style.code.localeCompare(b.style.code) || a.revision.revision - b.revision.revision || a.seq - b.seq)
  return { style, usedIn }
}
