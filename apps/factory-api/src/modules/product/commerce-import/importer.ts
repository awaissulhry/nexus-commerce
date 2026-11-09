import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { RowIssue, RowValues } from '@nexus/factory-domain/imports/importer'
import {
  commerceStylesImporter,
  gtinOf,
  isFamilyRow,
  judgeFamilies,
  knownRecordValues,
  OPEN_LIFECYCLES,
  startedNote,
  styleCodeOf,
  type BrandFact,
  type ColourFact,
  type CommerceFacts,
  type FamilyPlan,
  type KnownSku,
  type ScaleFact,
  type StyleFact,
} from '@nexus/factory-domain/product/commerce-import/importer'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { newStyle } from '@nexus/factory-domain/product/styles/rules'
import { ApiError } from '../../../core/errors'
import type { CommandTools, CommandTx } from '../../../core/command'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { CheckRow, ImportAdapter } from '../../../platform/imports/registry'
import { mayWrite } from '../materials/store'
import { brandProblems, lockStyle, scaleProblems } from '../styles/store'
import { codeTaken, columnsOf, readScaleSizes } from '../styles/styles'

/**
 * The adapter of `product.commerceStyles` (B-W2b-209; PRD-265; factory-domain product/commerce-import): a Nexus Commerce
 * product export starts draft styles. Writing needs product.styles.manage over the job's company (the engine's can(),
 * and `authorize` for a job for every company), seeing the plans product.styles.view. Nothing here reads or writes
 * Commerce: the file is the only source (factory-domain ./source, the live read OFF).
 *
 *   load       the SKUs of the sheet the factory has (with their style, colourway and size), and the styles a family's own
 *              row names by code: the plan answers UNCHANGED for the same, an error for another.
 *   check      every row judged with its family (factory-domain judgeFamilies) against what the database holds now: the
 *              styles the families' codes find, the SKUs and barcodes taken, the size scales, brands and library colours
 *              the job's company may use. The dry run runs it for the person who started the job; the apply, in its ONE
 *              batch (the importer's batchSize is its maxRows), for the person who applies, and keeps the families it
 *              passed for the writes of the same transaction.
 *   write      the first row of a family writes the whole family: a new style (DRAFT, lifecycle CONCEPT, its colourways,
 *              range, SKUs with the sheet's codes and barcodes, revision 1 a DRAFT naming the family), or the new
 *              colourways, sizes and SKUs of the style its code found (locked first, checked again). Every row answers its
 *              record: the family's own row the style, a SKU row its SKU. The worker applies (system context): no person
 *              is the rows' creator; the audit rows name the import job.
 */

export const COMMERCE_IMPORT_ACTION = 'product.styles.commerceImport'

/** Stops the batch: the database changed since the check in a way the family no longer fits (apply again later). */
class FamilyRefused extends ApiError {
  constructor(family: string, detail: string) {
    super('conflict', `Family ${family} can no longer be started: ${detail} Run the dry run again.`)
  }
}

type Reader = FactoryClient | CommandTx

const text = (value: CellValue | undefined): string | null => (value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim())

// ---- the facts ------------------------------------------------------------------------------------------------------------

/** What the database holds about the sheet's families (factory-domain CommerceFacts), one query after the other. */
export async function readFacts(client: Reader, rows: readonly { readonly values: RowValues }[], companyId: string | null): Promise<CommerceFacts> {
  const codes = [...new Set(rows.map((row) => styleCodeOf(row.values)).filter((code): code is string => code !== null))]
  const skus = [...new Set(rows.filter((row) => !isFamilyRow(row.values)).map((row) => String(row.values.sku)))]
  const gtins = [...new Set(rows.map((row) => gtinOf(row.values)).filter((gtin): gtin is string => gtin !== undefined))]

  const styleRows = codes.length === 0 ? [] : await client.style.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, companyId: true, status: true, lifecycle: true, sizeScaleId: true, sizes: true } })
  const styleIds = styleRows.map((row) => row.id)
  const released = new Set(
    (styleIds.length === 0 ? [] : await client.styleRevision.findMany({ where: { styleId: { in: styleIds }, status: 'RELEASED' }, select: { styleId: true } })).map((row) => row.styleId),
  )
  const styleColourways = styleIds.length === 0 ? [] : await client.colourway.findMany({ where: { styleId: { in: styleIds } }, select: { id: true, styleId: true, code: true, name: true } })
  const styleVariants = styleIds.length === 0 ? [] : await client.variant.findMany({ where: { styleId: { in: styleIds } }, select: { styleId: true, colourwayId: true, size: true, sku: true } })
  const colourwayCode = new Map(styleColourways.map((row) => [row.id, row.code]))
  const styles = new Map<string, StyleFact>(
    styleRows.map((row) => [
      row.code,
      {
        id: row.id,
        code: row.code,
        companyId: row.companyId,
        status: row.status,
        lifecycle: row.lifecycle,
        released: released.has(row.id),
        sizeScaleId: row.sizeScaleId,
        sizes: row.sizes,
        colourways: styleColourways.filter((entry) => entry.styleId === row.id).map((entry) => ({ code: entry.code, name: entry.name })),
        cells: new Map(styleVariants.filter((entry) => entry.styleId === row.id).map((entry) => [`${colourwayCode.get(entry.colourwayId) ?? ''}|${entry.size}`, entry.sku])),
      },
    ]),
  )

  const known = new Map<string, KnownSku>()
  if (skus.length > 0) {
    const variants = await client.variant.findMany({ where: { sku: { in: skus } }, select: { sku: true, size: true, styleId: true, colourwayId: true } })
    const owners = new Map((variants.length === 0 ? [] : await client.style.findMany({ where: { id: { in: [...new Set(variants.map((row) => row.styleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const colourways = new Map((variants.length === 0 ? [] : await client.colourway.findMany({ where: { id: { in: [...new Set(variants.map((row) => row.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    for (const row of variants) known.set(row.sku, { kind: 'sku', style: owners.get(row.styleId) ?? '', colourCode: colourways.get(row.colourwayId) ?? '', size: row.size })
  }
  const taken = new Map((gtins.length === 0 ? [] : await client.variant.findMany({ where: { gtin: { in: gtins } }, select: { gtin: true, sku: true } })).map((row) => [row.gtin!, row.sku]))

  // Every size scale of the tenant (a named one of another company is refused in words, not "not found").
  const scaleRows = await client.sizeScale.findMany({ select: { id: true, code: true, name: true, companyId: true, status: true }, orderBy: { code: 'asc' } })
  const sizes = scaleRows.length === 0 ? [] : await client.size.findMany({ where: { scaleId: { in: scaleRows.map((row) => row.id) } }, select: { scaleId: true, code: true, label: true, seq: true, status: true } })
  const scales: ScaleFact[] = scaleRows.map((row) => ({ ...row, sizes: sizes.filter((size) => size.scaleId === row.id) }))

  const fitting = { OR: [{ companyId: null }, ...(companyId === null ? [] : [{ companyId }])] }
  const wantsBrand = rows.some((row) => text(row.values.brand) !== null)
  const brands: BrandFact[] = wantsBrand
    ? (await client.party.findMany({ where: { AND: [fitting, { roles: { has: 'BRAND' } }, { status: { notIn: ['BLOCKED', 'ARCHIVED'] } }] }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => ({
        id: row.id,
        code: row.code.toUpperCase(),
        names: [row.legalName, ...(row.tradeName ? [row.tradeName] : [])],
      }))
    : []
  const colours: ColourFact[] = (await client.colour.findMany({ where: { AND: [fitting, { status: 'ACTIVE' }] }, select: { id: true, code: true, name: true, nameI18n: true } })).map((row) => ({
    id: row.id,
    code: row.code.toUpperCase(),
    names: [row.name, ...Object.values((row.nameI18n ?? {}) as Record<string, string>)],
  }))

  return { companyId, styles, skus: known, gtins: taken, scales, brands, colours }
}

// ---- the batch's families -------------------------------------------------------------------------------------------------

/** What the batch's check passed, for the writes of the same transaction (the apply's ONE command). */
interface Passed {
  readonly families: ReadonlyMap<string, FamilyPlan>
  /** The style the code of a family found, for a family's own row whose style exists (nothing to write). */
  readonly existing: ReadonlyMap<string, string>
}
const PASSED = new WeakMap<object, Passed>()
/** What the batch wrote, per family: the style and its new SKUs by code. */
const WRITTEN = new WeakMap<object, Map<string, { readonly styleId: string; readonly skus: ReadonlyMap<string, string> }>>()

async function checkRows(client: CommandTx, rows: readonly CheckRow[], companyId: string | null): Promise<RowIssue[][]> {
  const sheet = rows.map((row) => ({ rowNumber: row.rowNumber, values: { ...row.key, ...row.values } as RowValues }))
  const facts = await readFacts(client, sheet, companyId)
  const judged = judgeFamilies(sheet, facts)
  const existing = new Map<string, string>()
  for (const row of sheet) {
    const style = facts.styles.get(styleCodeOf(row.values) ?? '')
    if (style && isFamilyRow(row.values)) existing.set(String(row.values.sku), style.id)
  }
  PASSED.set(client, { families: new Map(judged.families.map((family) => [family.family, family])), existing })
  return judged.issues.map((list) => [...list])
}

// ---- the writes -------------------------------------------------------------------------------------------------------------

/** A new style for a family: the rules again on the scale as it is now (locked), then the style, its parts and revision 1. */
async function startStyle(tools: CommandTools, plan: FamilyPlan, companyId: string | null, jobId: string | null): Promise<{ styleId: string; skus: Map<string, string> }> {
  const { tx, now } = tools
  const action = COMMERCE_IMPORT_ACTION
  const scale = await scaleProblems(tx, plan.sizeScaleId, companyId, true)
  if (scale.length > 0) throw new FamilyRefused(plan.family, scale.map((issue) => issue.message).join(' '))
  const outcome = newStyle(
    { code: plan.styleCode, name: plan.name, productType: plan.productType, season: plan.season, brandPartyId: plan.brandPartyId, sizeScaleId: plan.sizeScaleId, sizes: plan.sizes },
    await readScaleSizes(tx, plan.sizeScaleId),
  )
  if (!outcome.ok) throw new FamilyRefused(plan.family, outcome.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' '))
  const style = outcome.style
  const brand = await brandProblems(tx, style.brandPartyId, companyId)
  if (brand.length > 0) throw new FamilyRefused(plan.family, brand.map((issue: Issue) => issue.message).join(' '))
  if (await codeTaken(tx, style.code)) throw new FamilyRefused(plan.family, `the style code ${style.code} was taken meanwhile.`)

  const styleId = newId()
  await tx.style.create({ data: { ...(columnsOf(style) as Prisma.StyleUncheckedCreateInput), id: styleId, companyId, lifecycle: 'CONCEPT', createdAt: now, updatedAt: now, createdById: null }, select: { id: true } })
  const colourways = plan.colourways.map((colourway) => ({ id: newId(), ...colourway }))
  if (colourways.length > 0) {
    await tx.colourway.createMany({ data: colourways.map((colourway) => ({ id: colourway.id, styleId, code: colourway.code, name: colourway.name, colourId: colourway.colourId, description: null, createdAt: now, updatedAt: now, createdById: null })) })
  }
  const colourwayIds = new Map(colourways.map((colourway) => [colourway.code, colourway.id]))
  const skus = await insertSkus(tools, { id: styleId, code: style.code, companyId }, plan, colourwayIds, action)

  const revisionId = newId()
  const changeNote = startedNote(plan.family)
  await tx.styleRevision.create({ data: { id: revisionId, styleId, revision: 1, status: 'DRAFT', changeNote, createdAt: now, updatedAt: now, createdById: null }, select: { id: true } })

  const startedFrom = { source: 'NEXUS_COMMERCE_EXPORT', family: plan.family, importJobId: jobId }
  tools.audit({ action, recordType: 'Style', recordId: styleId, companyId, after: { ...style, status: 'DRAFT', lifecycle: 'CONCEPT', colourways: plan.colourways.map((colourway) => ({ ...colourway })), startedFrom } })
  tools.audit({ action, recordType: 'StyleRevision', recordId: revisionId, companyId, after: { styleId, revision: 1, status: 'DRAFT', changeNote } })
  tools.emit({ type: 'style.created', subject: styleId, companyId, payload: { styleId, code: style.code } })
  tools.emit({ type: 'style.skus_changed', subject: styleId, companyId, payload: { styleId, code: style.code, created: skus.size, archived: 0, restored: 0, updated: 0 } })
  tools.emit({ type: 'style.revision_created', subject: styleId, companyId, payload: { styleId, code: style.code, revisionId, revision: 1 } })
  return { styleId, skus }
}

/** The new colourways, sizes and SKUs of the style a family's code found: locked, and checked again as it is now. */
async function extendStyle(tools: CommandTools, plan: FamilyPlan, companyId: string | null, jobId: string | null): Promise<{ styleId: string; skus: Map<string, string> }> {
  const { tx, now } = tools
  const action = COMMERCE_IMPORT_ACTION
  const styleId = plan.existingStyleId!
  const locked = await lockStyle(tx, styleId)
  const row = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { code: true, lifecycle: true, sizes: true, sizeScaleId: true, companyId: true } })
  const released = await tx.styleRevision.count({ where: { styleId, status: 'RELEASED' } })
  if (locked.status !== 'DRAFT' || released > 0 || !(OPEN_LIFECYCLES as readonly string[]).includes(row.lifecycle) || row.companyId !== companyId || row.sizeScaleId !== plan.sizeScaleId) {
    throw new FamilyRefused(plan.family, `style ${row.code} moved on meanwhile (${locked.status.toLowerCase()}, ${row.lifecycle.toLowerCase().replace(/_/g, ' ')}).`)
  }
  const target = { id: styleId, code: row.code, companyId }
  const taken = new Set((await tx.colourway.findMany({ where: { styleId }, select: { code: true } })).map((entry) => entry.code))
  const fresh = plan.colourways.filter((colourway) => !taken.has(colourway.code)).map((colourway) => ({ id: newId(), ...colourway }))
  if (fresh.length > 0) {
    await tx.colourway.createMany({ data: fresh.map((colourway) => ({ id: colourway.id, styleId, code: colourway.code, name: colourway.name, colourId: colourway.colourId, description: null, createdAt: now, updatedAt: now, createdById: null })) })
    for (const colourway of fresh) tools.audit({ action, recordType: 'Colourway', recordId: colourway.id, companyId, after: { styleId, code: colourway.code, name: colourway.name, colourId: colourway.colourId, status: 'ACTIVE' } })
    tools.emit({ type: 'style.colourways_changed', subject: styleId, companyId, payload: { styleId, code: row.code, colourwayIds: fresh.map((colourway) => colourway.id) } })
  }
  const added = plan.newSizes.filter((size) => !row.sizes.includes(size))
  if (added.length > 0) {
    // The range as planned: the style's range then, with the new sizes in the scale's order (a size the scale archived
    // since is refused by the rules here, never written).
    const outcome = newStyle({ code: row.code, name: row.code, productType: 'OTHER', sizeScaleId: plan.sizeScaleId, sizes: [...row.sizes, ...added] }, await readScaleSizes(tx, plan.sizeScaleId))
    if (!outcome.ok) throw new FamilyRefused(plan.family, outcome.issues.map((issue) => issue.message).join(' '))
    await tx.style.update({ where: { id: styleId }, data: { sizes: [...outcome.style.sizes], version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action, recordType: 'Style', recordId: styleId, companyId, before: { sizes: row.sizes }, after: { sizes: outcome.style.sizes } })
    tools.emit({ type: 'style.updated', subject: styleId, companyId, payload: { styleId, code: row.code, fields: ['sizes'] } })
  }
  const colourwayIds = new Map((await tx.colourway.findMany({ where: { styleId }, select: { id: true, code: true } })).map((entry) => [entry.code, entry.id]))
  const skus = await insertSkus(tools, target, plan, colourwayIds, action)
  tools.audit({ action, recordType: 'Style', recordId: styleId, companyId, after: { addedFrom: { source: 'NEXUS_COMMERCE_EXPORT', family: plan.family, importJobId: jobId, colourways: fresh.map((colourway) => colourway.code), sizes: added } } })
  tools.emit({ type: 'style.skus_changed', subject: styleId, companyId, payload: { styleId, code: row.code, created: skus.size, archived: 0, restored: 0, updated: 0 } })
  return { styleId, skus }
}

/** The family's SKUs with the sheet's codes and barcodes: each audited, and one audit row on the style that lists them. */
async function insertSkus(tools: CommandTools, style: { id: string; code: string; companyId: string | null }, plan: FamilyPlan, colourwayIds: ReadonlyMap<string, string>, action: string): Promise<Map<string, string>> {
  const { tx, now } = tools
  const rows = plan.skus.map((entry) => {
    const colourwayId = colourwayIds.get(entry.colourCode)
    if (!colourwayId) throw new FamilyRefused(plan.family, `colourway ${entry.colourCode} is not on style ${style.code}.`)
    return { id: newId(), styleId: style.id, colourwayId, size: entry.size, sku: entry.sku, gtin: entry.gtin, createdAt: now, updatedAt: now, createdById: null }
  })
  const clash = rows.length === 0 ? null : await tx.variant.findFirst({ where: { OR: [{ sku: { in: rows.map((row) => row.sku) } }, { gtin: { in: rows.flatMap((row) => (row.gtin ? [row.gtin] : [])) } }] }, select: { sku: true } })
  if (clash) throw new FamilyRefused(plan.family, `SKU ${clash.sku} (or its barcode) was made meanwhile.`)
  if (rows.length > 0) await tx.variant.createMany({ data: rows })
  for (const row of rows) tools.audit({ action, recordType: 'Variant', recordId: row.id, companyId: style.companyId, after: { sku: row.sku, colourwayId: row.colourwayId, size: row.size, gtin: row.gtin, status: 'ACTIVE' } })
  tools.audit({ action, recordType: 'Style', recordId: style.id, companyId: style.companyId, after: { skus: { created: rows.map((row) => row.sku) } } })
  return new Map(rows.map((row) => [row.sku, row.id]))
}

export const commerceStylesImportAdapter: ImportAdapter = Object.freeze({
  importer: commerceStylesImporter,
  permission: PRODUCT_STYLES_MANAGE,
  viewPermission: PRODUCT_STYLES_VIEW,

  authorize(actor, job) {
    const issues: Issue[] = []
    if (job.companyId === null && !mayWrite(actor, PRODUCT_STYLES_MANAGE, null)) {
      issues.push({ path: 'companyId', message: 'Styles for every company are started only by a role over every company: import for one company instead.' })
    }
    return issues
  },

  async load(client, keys) {
    const skus = [...new Set(keys.map((key) => String(key.sku)))]
    if (skus.length === 0) return []
    const variants = await client.variant.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, size: true, styleId: true, colourwayId: true } })
    const owners = new Map((variants.length === 0 ? [] : await client.style.findMany({ where: { id: { in: [...new Set(variants.map((row) => row.styleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const colourways = new Map((variants.length === 0 ? [] : await client.colourway.findMany({ where: { id: { in: [...new Set(variants.map((row) => row.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const answer = variants.map((row) => ({ id: row.id, values: knownRecordValues(row.sku, { kind: 'sku', style: owners.get(row.styleId) ?? '', colourCode: colourways.get(row.colourwayId) ?? '', size: row.size }) }))
    // A family's own row: its code may be a style's (the style it started before).
    const rest = skus.filter((sku) => !variants.some((row) => row.sku === sku))
    const styles = rest.length === 0 ? [] : await client.style.findMany({ where: { code: { in: rest } }, select: { id: true, code: true } })
    return [...answer, ...styles.map((row) => ({ id: row.id, values: knownRecordValues(row.code, { kind: 'style', style: row.code }) }))]
  },

  check(client, rows, scope) {
    return checkRows(client, rows, scope.companyId)
  },

  async write(tools: CommandTools, row, scope) {
    if (row.action !== 'CREATE') throw new Error('A Commerce import only starts styles and SKUs.')
    const passed = PASSED.get(tools.tx)
    if (!passed) throw new Error('The Commerce families were not checked in this batch: apply the import again.')
    const values = { ...row.key, ...row.values } as RowValues
    const sku = String(values.sku)
    const family = familyOfValues(passed, values)
    if (family === null) {
      // A family's own row whose style exists: nothing to write (its SKU rows add what is new).
      const existing = isFamilyRow(values) ? passed.existing.get(sku) : undefined
      if (existing) return { recordId: existing }
      throw new Error(`Row ${sku} was not passed by the check in this batch: apply the import again.`)
    }
    let written = WRITTEN.get(tools.tx)
    if (!written) {
      written = new Map()
      WRITTEN.set(tools.tx, written)
    }
    let done = written.get(family.family)
    if (!done) {
      const jobId = tools.record?.id ?? null
      done = family.existingStyleId === null ? await startStyle(tools, family, scope.companyId, jobId) : await extendStyle(tools, family, scope.companyId, jobId)
      written.set(family.family, done)
    }
    if (isFamilyRow(values)) return { recordId: done.styleId }
    const recordId = done.skus.get(sku)
    if (!recordId) throw new Error(`SKU ${sku} was not in its family as checked: apply the import again.`)
    return { recordId }
  },
} satisfies ImportAdapter)

/** The passed family a row belongs to (by the codes it makes), or null. */
function familyOfValues(passed: Passed, values: RowValues): FamilyPlan | null {
  for (const family of passed.families.values()) {
    if (isFamilyRow(values) ? family.family === String(values.sku) || family.styleCode === styleCodeOf(values) : family.skus.some((entry) => entry.sku === String(values.sku))) return family
  }
  return null
}
