import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { BomStructureView, ChangeStructureBody, SetLineStructureBody } from '@nexus/factory-domain/product/bom-structure/contracts'
import { circleProblem, groupProblem, inGroupCircle, subAssemblyCircle, subAssemblyProblems } from '@nexus/factory-domain/product/bom-structure/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMayWrite, contextOf, findRevision, lockDraft, lockMaterials, readMaterials, readRevisionFor, STYLE_COLUMNS, type LockedDraft } from '../bom/store'
import { loadStructure } from './check'
import { lockSubAssemblyLinks, readEdges, readMaterialExtras, readStructure, readStyleCodes, readTargets, type StructureRecord } from './store'
import { readTree, structureViewOf } from './views'

/**
 * A draft revision's BOM structure (B-W2b-223; PRD-077, PRD-078, PRD-106): a line filed under a section, grouped under
 * another line or ungrouped, given a sub-assembly (a revision of another style) or none; and the list's selection (several
 * lines filed or grouped at once). Every write sends the revision's version and starts as W1's line writes do (product/bom
 * store `lockDraft`: the style row FOR UPDATE, the revision a DRAFT of a style not archived, its version compared and set;
 * B-W2b-221's edit rule of the style's lifecycle state is asked there, DRAFT), then: the line's material FOR SHARE, the
 * revision named FOR SHARE, the tenant's sub-assembly links in turns (the database's own advisory lock), the circle walked,
 * the line written. Every rule of the database (…_bom_options_w2b_guards) is said in words first (400 with the issues):
 * a group row of another revision, itself or a circle; a sub-assembly of the line's own style, an obsolete revision, a line
 * whose material is not a COMPONENT we make in PCS/PAIR/SET or that the customer sends, a circle of styles, more than 10
 * levels. Audit rows on each line and on the revision; `style.bom_changed` (W1's event) with the lines changed.
 */

const STRUCTURE_FIELDS = ['section', 'parentLineId', 'subAssemblyStyleId', 'subAssemblyRevisionId'] as const
type StructureFields = Pick<StructureRecord, (typeof STRUCTURE_FIELDS)[number]>

const auditedStructure = (record: StructureFields): Record<string, unknown> => ({
  section: record.section,
  parentLineId: record.parentLineId,
  subAssemblyStyleId: record.subAssemblyStyleId,
  subAssemblyRevisionId: record.subAssemblyRevisionId,
})

function recordChange(tools: CommandTools, draft: LockedDraft, lineIds: readonly string[], change: Record<string, unknown>): void {
  const { style } = draft
  tools.audit({ recordType: 'StyleRevision', recordId: draft.revisionId, companyId: style.companyId, after: { bom: { structure: change }, version: draft.version } })
  tools.emit({
    type: 'style.bom_changed',
    subject: style.id,
    companyId: style.companyId,
    payload: { styleId: style.id, code: style.code, revisionId: draft.revisionId, revision: draft.revision, lineIds: [...lineIds] },
  })
}

const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError("The BOM's structure is not valid.", issues)

/** The structure as the command left it (its answer). */
async function viewInTx(tools: CommandTools, styleId: string, revisionId: string): Promise<BomStructureView> {
  const { tx } = tools
  const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
  const loaded = await loadStructure(tx, style, await findRevision(tx, styleId, revisionId))
  return structureViewOf(loaded, await readTree(tx, revisionId))
}

async function writeStructure(tools: CommandTools, draft: LockedDraft, record: StructureRecord, next: StructureFields): Promise<boolean> {
  const changed = STRUCTURE_FIELDS.filter((field) => record[field] !== next[field])
  if (changed.length === 0) return false
  await tools.tx.bomLine.update({
    where: { id: record.id },
    data: { ...Object.fromEntries(changed.map((field) => [field, next[field]])), version: { increment: 1 }, updatedAt: tools.now },
    select: { id: true },
  })
  tools.audit({ recordType: 'BomLine', recordId: record.id, companyId: draft.style.companyId, before: auditedStructure(record), after: auditedStructure(next) })
  return true
}

const fits = (rowCompany: string | null, companyId: string | null): boolean => rowCompany === null || rowCompany === companyId

/**
 * Why `record` cannot take `subAssembly` (issues at body/subAssembly/…), the database's rules first in words. Locks: the
 * line's material FOR SHARE, the revision named FOR SHARE, then the tenant's sub-assembly links (the circle walk).
 */
async function subAssemblyIssues(tools: CommandTools, draft: LockedDraft, record: StructureRecord, subAssembly: { styleId: string; revisionId: string }): Promise<Issue[]> {
  const { tx } = tools
  const at = 'body/subAssembly'
  await lockMaterials(tx, [record.itemId])
  const { materials } = await readMaterials(tx, [record.itemId])
  const material = materials.get(record.itemId)
  const extras = (await readMaterialExtras(tx, [record.itemId])).get(record.itemId)
  const target = (await readTargets(tx, [subAssembly.revisionId], true)).get(subAssembly.revisionId)
  if (!target || target.styleId !== subAssembly.styleId) return [{ path: `${at}/revisionId`, message: 'No such revision of that style.' }]
  if (!fits(target.companyId, draft.style.companyId)) return [{ path: `${at}/styleId`, message: `${target.code} belongs to another company than the style's.` }]
  if (!material || !extras) return [{ path: `${at}/styleId`, message: "The line's material cannot be read." }]
  const issues = subAssemblyProblems(
    { seq: record.seq, styleId: draft.style.id, uom: record.uom, customerSupplied: record.customerSuppliedByPartyId !== null, material: { code: material.code, kind: material.kind, sourcing: extras.sourcing } },
    target,
  ).map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
  if (issues.length > 0) return issues
  await lockSubAssemblyLinks(tx)
  const edges = (await readEdges(tx)).filter((edge) => edge.lineId !== record.id)
  const verdict = subAssemblyCircle({ revisionId: draft.revisionId, styleId: draft.style.id }, { revisionId: target.revisionId, styleId: target.styleId }, edges)
  const codes = await readStyleCodes(tx, verdict.circleStyleId === null ? [] : [verdict.circleStyleId])
  const problem = circleProblem(record.seq, target, verdict, (styleId) => codes.get(styleId) ?? '?')
  return problem ? [{ path: at, message: problem }] : []
}

/** product.bomStructure.setLine: one line's section, group row and sub-assembly (what is left out stays). */
export async function setLineStructure(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: SetLineStructureBody, idempotencyKey?: string): Promise<BomStructureView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.bomStructure.setLine', idempotencyKey, input: { styleId, revisionId, lineId, ...body } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const records = await readStructure(tools.tx, revisionId)
    const record = isUuid(lineId) ? records.find((entry) => entry.id === lineId) : undefined
    if (!record) throw new NotFoundError('BOM line not found.')
    const next: StructureFields = {
      section: body.section === undefined ? record.section : body.section,
      parentLineId: body.parentLineId === undefined ? record.parentLineId : body.parentLineId,
      subAssemblyStyleId: body.subAssembly === undefined ? record.subAssemblyStyleId : (body.subAssembly?.styleId ?? null),
      subAssemblyRevisionId: body.subAssembly === undefined ? record.subAssemblyRevisionId : (body.subAssembly?.revisionId ?? null),
    }
    const issues: Issue[] = []
    if (next.parentLineId !== record.parentLineId) {
      const problem = groupProblem(records, record.id, next.parentLineId)
      if (problem) issues.push({ path: 'body/parentLineId', message: problem })
    }
    if (next.subAssemblyRevisionId !== null && (next.subAssemblyRevisionId !== record.subAssemblyRevisionId || next.subAssemblyStyleId !== record.subAssemblyStyleId)) {
      issues.push(...(await subAssemblyIssues(tools, draft, record, { styleId: next.subAssemblyStyleId!, revisionId: next.subAssemblyRevisionId })))
    }
    if (issues.length > 0) throw invalid(issues)
    const changed = await writeStructure(tools, draft, record, next)
    recordChange(tools, draft, changed ? [record.id] : [], { line: record.id, ...auditedStructure(next) })
    return viewInTx(tools, styleId, revisionId)
  })
  return result
}

/** product.bomStructure.change: the list's selection filed under one section and/or grouped under one line (null: ungrouped). */
export async function changeStructure(caller: CommandCaller, styleId: string, revisionId: string, body: ChangeStructureBody, idempotencyKey?: string): Promise<BomStructureView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  if (new Set(body.lineIds).size !== body.lineIds.length) throw invalid([{ path: 'body/lineIds', message: 'Each line once.' }])

  const { result } = await command(caller, { name: 'product.bomStructure.change', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const records = await readStructure(tools.tx, revisionId)
    const unknown = body.lineIds.filter((id) => !records.some((record) => record.id === id))
    if (unknown.length > 0) throw new NotFoundError(`${unknown.length} BOM line(s) are not of this revision.`)
    const selected = new Set(body.lineIds)
    const parentLineId = body.parentLineId
    const planned = records.map((record) => (selected.has(record.id) && parentLineId !== undefined ? { ...record, parentLineId } : record))
    const issues: Issue[] = []
    if (parentLineId !== undefined && parentLineId !== null) {
      const parent = records.find((record) => record.id === parentLineId)
      if (!parent) issues.push({ path: 'body/parentLineId', message: groupProblem(records, body.lineIds[0]!, parentLineId)! })
      else if (selected.has(parent.id)) issues.push({ path: 'body/parentLineId', message: `Line ${parent.seq} is in the selection: a line is not grouped under itself.` })
      else {
        for (const record of planned.filter((entry) => selected.has(entry.id) && inGroupCircle(planned, entry.id))) {
          issues.push({ path: `body/lineIds/${body.lineIds.indexOf(record.id)}`, message: `Line ${record.seq} cannot be grouped under line ${parent.seq}: line ${parent.seq} is grouped under it (a circle). Ungroup line ${parent.seq} first.` })
        }
      }
    }
    if (issues.length > 0) throw invalid(issues)
    const changedIds: string[] = []
    for (const record of records.filter((entry) => selected.has(entry.id))) {
      const next: StructureFields = {
        section: body.section === undefined ? record.section : body.section,
        parentLineId: parentLineId === undefined ? record.parentLineId : parentLineId,
        subAssemblyStyleId: record.subAssemblyStyleId,
        subAssemblyRevisionId: record.subAssemblyRevisionId,
      }
      if (await writeStructure(tools, draft, record, next)) changedIds.push(record.id)
    }
    recordChange(tools, draft, changedIds, { lines: changedIds, ...(body.section === undefined ? {} : { section: body.section }), ...(parentLineId === undefined ? {} : { parentLineId }) })
    return viewInTx(tools, styleId, revisionId)
  })
  return result
}
