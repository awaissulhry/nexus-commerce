import type { Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import { markValues, type ExistingRecord, type RowIssue, type RowValues } from '@nexus/factory-domain/imports/importer'
import { bomImporter, lineRecordValues, pairsOf } from '@nexus/factory-domain/product/bom/importer'
import { PRODUCT_BOM_MANAGE, PRODUCT_BOM_VIEW } from '@nexus/factory-domain/product/bom/permissions'
import { MAX_BOM_LINES, planLine, type BomLineFields, type BomStyle, type LineChange } from '@nexus/factory-domain/product/bom/rules'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandTools, CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { CheckRow, ImportAdapter, ImportScope } from '../../../platform/imports/registry'
import { mayWrite } from '../materials/store'
import { exportedLines } from './export'
import { auditedLine, bomStyleOf, lockMaterials, lockStyleRow, readColourways, readLines, readMaterials, supplierProblems, writeLine, type LineRecord, type MaterialFacts } from './store'

/**
 * The BOM import's adapter (platform/imports; feature PRD-090; factory-domain product/bom/importer). A row is a line of
 * its style's DRAFT revision, found by style code and place:
 *
 *   authorize  a job for every company (tenant-wide styles) needs product.bom.manage over every company (the engine
 *              checks product.bom.manage against the job's company, and product.bom.view to see the plans).
 *   load       the lines the keys name: the style of that code and of the job's company, its draft, the line at that
 *              place, as the export writes it (factory-domain `lineRecordValues`).
 *   check      every row against what it names, read again: the style (the job's company, not archived, with a draft
 *              revision), the material, its colour, the colourways, the supplier, and every BOM rule (`planLine`, the
 *              same the BOM routes apply), so the review shows each problem in words before anything is written.
 *   write      one line in the batch's command: the style row FOR UPDATE (every BOM write's first lock), the draft's
 *              version moved (an open BOM edit then sees a newer version), the material FOR SHARE, the line planned
 *              again and written (bom/store `writeLine`), its audit rows, and `style.bom_changed`.
 *
 * A released revision is never written: its parts are frozen (the …_product_guards triggers). Rows of several styles in
 * one batch lock their styles in row order.
 */

const ACTION = 'product.bom.import'

/** Stops the batch: the style or line changed since the dry run in a way the row no longer fits. */
class ImportRowRefused extends ApiError {
  constructor(what: string, detail: string) {
    super('conflict', `The import row for ${what} no longer fits: ${detail}. Run the dry run again.`)
  }
}

const styleOf = (values: Readonly<Record<string, unknown>>): string => String(values.style)
const seqOf = (values: Readonly<Record<string, unknown>>): number => Number(values.seq)

interface StyleFacts {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
  readonly status: string
  readonly sizes: readonly string[]
  readonly baseSize: string | null
  readonly draft: { readonly id: string; readonly revision: number } | null
}

async function readStyles(client: CommandTx, codes: readonly string[]): Promise<Map<string, StyleFacts>> {
  const unique = [...new Set(codes)]
  const rows = unique.length === 0 ? [] : await client.style.findMany({ where: { code: { in: unique } }, select: { id: true, code: true, companyId: true, status: true, sizes: true, baseSize: true } })
  const drafts = rows.length === 0 ? [] : await client.styleRevision.findMany({ where: { styleId: { in: rows.map((row) => row.id) }, status: 'DRAFT' }, select: { id: true, styleId: true, revision: true } })
  return new Map(rows.map((row) => [row.code, { ...row, draft: drafts.find((draft) => draft.styleId === row.id) ?? null }]))
}

/** Why a row's style cannot take an imported line, or null. */
function styleRefusal(code: string, style: StyleFacts | undefined, scope: ImportScope): string | null {
  if (!style) return `No style ${code}.`
  if (style.companyId !== scope.companyId) {
    return style.companyId === null
      ? `Style ${code} is made by every company: import its BOM with a job for every company.`
      : `Style ${code} belongs to another company: import its BOM with that company.`
  }
  if (style.status === 'ARCHIVED') return `Style ${code} is archived: reactivate it before importing its BOM.`
  if (style.draft === null) return `Style ${code} has no draft revision (a released revision is frozen): start one, or copy the released one, before importing its BOM.`
  return null
}

/** A BOM rule's path as the column it is about. */
function rowIssue(issue: Issue): RowIssue {
  const head = issue.path.split('/')[0] ?? ''
  const named: Readonly<Record<string, string>> = { itemId: 'material', itemColourId: 'colour', colourwayId: 'colourway', supplierId: 'supplier' }
  const column = named[head] ?? (Object.hasOwn(bomImporter.columns, head) ? head : undefined)
  return column ? { column, message: issue.message } : { message: issue.message }
}

/** What one call reads once: the styles, their drafts' lines and rule facts, the materials by code. */
interface Facts {
  readonly styles: ReadonlyMap<string, StyleFacts>
  readonly lines: Map<string, LineRecord[]>
  readonly bomStyles: Map<string, BomStyle>
  readonly materials: Map<string, MaterialFacts | null>
}

const factsFor = async (client: CommandTx, codes: readonly string[]): Promise<Facts> => ({ styles: await readStyles(client, codes), lines: new Map(), bomStyles: new Map(), materials: new Map() })

async function linesOf(client: CommandTx, facts: Facts, draftId: string): Promise<LineRecord[]> {
  let lines = facts.lines.get(draftId)
  if (!lines) {
    lines = await readLines(client, draftId)
    facts.lines.set(draftId, lines)
  }
  return lines
}

async function bomStyleFor(client: CommandTx, facts: Facts, style: StyleFacts): Promise<BomStyle> {
  let found = facts.bomStyles.get(style.id)
  if (!found) {
    found = bomStyleOf({ sizes: [...style.sizes], baseSize: style.baseSize }, await readColourways(client, style.id))
    facts.bomStyles.set(style.id, found)
  }
  return found
}

async function materialByCode(client: CommandTx, facts: Facts, code: string): Promise<MaterialFacts | null> {
  if (!facts.materials.has(code)) {
    const row = await client.item.findFirst({ where: { code }, select: { id: true } })
    facts.materials.set(code, row ? ((await readMaterials(client, [row.id])).materials.get(row.id) ?? null) : null)
  }
  return facts.materials.get(code) ?? null
}

/** A row resolved against the database: the style and its draft, the line at that place (or null), the change in ids. */
interface Resolved {
  readonly style: StyleFacts & { readonly draft: { readonly id: string; readonly revision: number } }
  readonly seq: number
  readonly current: LineRecord | null
  readonly change: LineChange
  readonly material: MaterialFacts
  readonly bomStyle: BomStyle
}

type Resolution = { readonly ok: true; readonly row: Resolved } | { readonly ok: false; readonly issues: RowIssue[] }

/**
 * Resolves one row: the style, its draft and the line at that place; the codes the row gives as ids (the material, its
 * colour, the colourways, the supplier); the quantities by size and colours by colourway as whole sets (a size or
 * colourway the cell leaves out is cleared). Reads only.
 */
async function resolve(client: CommandTx, key: Readonly<Record<string, CellValue>>, values: RowValues, scope: ImportScope, facts: Facts): Promise<Resolution> {
  const code = styleOf(key)
  const seq = seqOf(key)
  const style = facts.styles.get(code)
  const refusal = styleRefusal(code, style, scope)
  if (refusal !== null || !style?.draft) return { ok: false, issues: [{ column: 'style', message: refusal ?? `No style ${code}.` }] }
  const draft = style.draft
  const current = (await linesOf(client, facts, draft.id)).find((line) => line.seq === seq) ?? null
  const bomStyle = await bomStyleFor(client, facts, style)
  const issues: RowIssue[] = []

  // The material: the row's, else the line's.
  let material: MaterialFacts | undefined
  if (typeof values.material === 'string') {
    const found = await materialByCode(client, facts, values.material)
    if (found === null) issues.push({ column: 'material', message: `No material ${values.material}.` })
    else if ((found.kind as string) === 'FINISHED') issues.push({ column: 'material', message: `${found.code} is a finished garment, not a material.` })
    else if (found.companyId !== null && found.companyId !== style.companyId) issues.push({ column: 'material', message: `${found.code} belongs to another company than style ${code}.` })
    else material = found
  } else if (current !== null) {
    material = (await readMaterials(client, [current.itemId])).materials.get(current.itemId)
  }
  if (!material) return { ok: false, issues: issues.length > 0 ? issues : [{ column: 'material', message: 'Material is needed for a new line.' }] }
  const chosen = material
  const colourIdOf = (colour: string): string | undefined => chosen.colours.find((entry) => entry.code === colour)?.id
  const colourwayIdOf = (colourway: string): string | undefined => bomStyle.colourways.find((entry) => entry.code === colourway)?.id

  const change: { -readonly [Field in keyof LineChange]: LineChange[Field] } = { seq }
  if (typeof values.material === 'string') change.itemId = chosen.id
  if (typeof values.placement === 'string') change.placement = values.placement
  if (typeof values.qty === 'string') change.qty = values.qty
  if (typeof values.uom === 'string') change.uom = values.uom as Uom
  if (typeof values.wastagePct === 'string') change.wastagePct = values.wastagePct
  if (typeof values.sizeDependent === 'boolean') change.sizeDependent = values.sizeDependent
  if (typeof values.colourDependent === 'boolean') change.colourDependent = values.colourDependent
  if (typeof values.note === 'string') change.note = values.note
  if (typeof values.sizes === 'string') {
    const given = pairsOf(values.sizes)
    const cleared = (current?.sizes ?? []).filter((row) => !given.has(row.size)).map((row) => ({ size: row.size, qty: null }))
    change.sizes = [...[...given].map(([size, qty]) => ({ size, qty })), ...cleared]
  }
  if (typeof values.colour === 'string') {
    const id = colourIdOf(values.colour)
    if (id === undefined) issues.push({ column: 'colour', message: `${chosen.code} has no colour ${values.colour}.` })
    else change.itemColourId = id
  }
  if (typeof values.colours === 'string') {
    const cells: { colourwayId: string; itemColourId: string | null }[] = []
    for (const [colourway, colour] of pairsOf(values.colours)) {
      const colourwayId = colourwayIdOf(colourway)
      const itemColourId = colourIdOf(colour)
      if (colourwayId === undefined) issues.push({ column: 'colours', message: `Style ${code} has no colourway ${colourway}.` })
      else if (itemColourId === undefined) issues.push({ column: 'colours', message: `${chosen.code} has no colour ${colour}.` })
      else cells.push({ colourwayId, itemColourId })
    }
    const named = new Set(cells.map((cell) => cell.colourwayId))
    // The grid is the cell's whole set: a colourway it leaves out is cleared (a new material starts an empty grid).
    const left = current !== null && current.itemId === chosen.id ? current.colours.filter((cell) => !named.has(cell.colourwayId)).map((cell) => ({ colourwayId: cell.colourwayId, itemColourId: null })) : []
    change.colours = [...cells, ...left]
  }
  if (typeof values.colourway === 'string') {
    const id = colourwayIdOf(values.colourway)
    if (id === undefined) issues.push({ column: 'colourway', message: `Style ${code} has no colourway ${values.colourway}.` })
    else change.colourwayId = id
  }
  if (typeof values.supplier === 'string') {
    const party = await client.party.findFirst({ where: { code: values.supplier }, select: { id: true } })
    if (!party) issues.push({ column: 'supplier', message: `No supplier ${values.supplier}.` })
    else {
      const problems = await supplierProblems(client, party.id, style.companyId)
      if (problems.length > 0) issues.push(...problems.map((problem) => ({ column: 'supplier', message: problem.message })))
      else change.supplierId = party.id
    }
  }
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, row: { style: { ...style, draft }, seq, current, change, material: chosen, bomStyle } }
}

/** The line a resolved row makes by the BOM rules (planLine, the BOM routes' own), or its problems as row issues. */
function planned(resolved: Resolved, material: MaterialFacts): { readonly ok: true; readonly line: BomLineFields } | { readonly ok: false; readonly issues: RowIssue[] } {
  const plan = planLine(resolved.current, resolved.change, material, resolved.bomStyle, resolved.seq)
  return plan.ok ? { ok: true, line: plan.line } : { ok: false, issues: plan.issues.map(rowIssue) }
}

export const bomImportAdapter = Object.freeze({
  importer: bomImporter,
  permission: PRODUCT_BOM_MANAGE,
  viewPermission: PRODUCT_BOM_VIEW,

  authorize(actor, job) {
    if (job.companyId === null && !mayWrite(actor, PRODUCT_BOM_MANAGE, null)) {
      return [{ path: 'companyId', message: 'A BOM import for every company (styles made by every company) needs product.bom.manage over every company; import for one company instead.' }]
    }
    return []
  },

  async load(client, keys, scope) {
    const styles = await readStyles(client, keys.map(styleOf))
    const records: ExistingRecord[] = []
    const byDraft = new Map<string, Map<number, ExistingRecord>>()
    for (const key of keys) {
      const style = styles.get(styleOf(key))
      if (!style || style.companyId !== scope.companyId || !style.draft) continue
      let lines = byDraft.get(style.draft.id)
      if (!lines) {
        const colourwayIds = (await readColourways(client, style.id)).map((colourway) => colourway.id)
        const stored = await readLines(client, style.draft.id, { sizes: style.sizes, colourwayIds })
        const exported = await exportedLines(client, style, stored)
        lines = new Map(stored.map((line, index) => [line.seq, { id: line.id, values: lineRecordValues(exported[index]!) }]))
        byDraft.set(style.draft.id, lines)
      }
      const record = lines.get(seqOf(key))
      if (record) records.push(record)
    }
    return records
  },

  async check(client, rows: readonly CheckRow[], scope) {
    const facts = await factsFor(client, rows.map((row) => styleOf(row.key)))
    const added = new Map<string, number>()
    const answers: RowIssue[][] = []
    for (const row of rows) {
      const resolved = await resolve(client, row.key, row.values, scope, facts)
      if (!resolved.ok) {
        answers.push(resolved.issues)
        continue
      }
      const plan = planned(resolved.row, resolved.row.material)
      if (!plan.ok) {
        answers.push(plan.issues)
        continue
      }
      if (resolved.row.current === null) {
        const draftId = resolved.row.style.draft.id
        const count = (facts.lines.get(draftId)?.length ?? 0) + (added.get(draftId) ?? 0)
        if (count >= MAX_BOM_LINES) {
          answers.push([{ message: `A BOM has at most ${MAX_BOM_LINES} lines.` }])
          continue
        }
        added.set(draftId, (added.get(draftId) ?? 0) + 1)
      }
      answers.push([])
    }
    return answers
  },

  async write(tools: CommandTools, row, scope) {
    const { tx, now } = tools
    const code = styleOf(row.key)
    const what = `${code} line ${seqOf(row.key)}`
    const seen = (await readStyles(tx, [code])).get(code)
    if (!seen) throw new ImportRowRefused(what, 'the style is gone')
    const locked = await lockStyleRow(tx, seen.id)
    const resolved = await resolve(tx, row.key, row.values, scope, await factsFor(tx, [code]))
    if (!resolved.ok) throw new ImportRowRefused(what, resolved.issues.map((issue) => issue.message).join(' '))
    const { style, current } = resolved.row
    if ((row.action === 'UPDATE') !== (current !== null) || (current !== null && current.id !== row.recordId)) throw new ImportRowRefused(what, 'the line was added or removed')
    const revision = await tx.styleRevision.update({ where: { id: style.draft.id }, data: { version: { increment: 1 }, updatedAt: now }, select: { version: true, status: true } })
    if (revision.status !== 'DRAFT') throw new ImportRowRefused(what, `revision ${style.draft.revision} is no longer a draft`)
    // The material held, and read again under the lock: it is not archived nor its units changed under this write.
    await lockMaterials(tx, [resolved.row.material.id])
    const material = (await readMaterials(tx, [resolved.row.material.id])).materials.get(resolved.row.material.id)
    if (!material) throw new ImportRowRefused(what, 'the material is gone')
    const plan = planned(resolved.row, material)
    if (!plan.ok) throw new ImportRowRefused(what, plan.issues.map((issue) => issue.message).join(' '))

    const lineId = current?.id ?? newId()
    await writeLine(tools, { styleId: style.id, revisionId: style.draft.id, lineId }, plan.line, current)
    tools.audit({
      action: ACTION,
      recordType: 'BomLine',
      recordId: lineId,
      companyId: locked.companyId,
      ...(current ? { before: auditedLine(current) } : {}),
      after: { revisionId: style.draft.id, ...auditedLine(plan.line) },
    })
    tools.audit({
      action: ACTION,
      recordType: 'StyleRevision',
      recordId: style.draft.id,
      companyId: locked.companyId,
      after: { bom: { [current ? 'changed' : 'added']: lineId, seq: plan.line.seq, imported: markValues(bomImporter, row.values) }, version: revision.version },
    })
    tools.emit({
      type: 'style.bom_changed',
      subject: style.id,
      companyId: locked.companyId,
      payload: { styleId: style.id, code: locked.code, revisionId: style.draft.id, revision: style.draft.revision, lineIds: [lineId] },
    })
    return { recordId: lineId }
  },
} satisfies ImportAdapter)
