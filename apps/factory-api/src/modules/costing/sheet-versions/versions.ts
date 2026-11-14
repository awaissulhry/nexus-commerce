import type { Prisma } from '@nexus/factory-db'
import { Decimal } from 'decimal.js'
import { ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { componentsOf, numbered, type ComponentLine } from '@nexus/factory-domain/costing/sheet-components/components'
import { COSTING_SHEETS_MANAGE } from '@nexus/factory-domain/costing/sheet-components/permissions'
import { incompleteWords } from '@nexus/factory-domain/costing/sheet-components/rules'
import type { CreateVersionBody, UpdateVersionBody, VersionRecordView, VersionsQuery } from '@nexus/factory-domain/costing/sheet-versions/contracts'
import { COSTING_SHEETS_APPROVE } from '@nexus/factory-domain/costing/sheet-versions/permissions'
import { COST_SHEET_KIND, costSheetKey, VERSION_REFUSAL_WORDS } from '@nexus/factory-domain/costing/sheet-versions/rules'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { withdrawPending } from '../../../platform/approvals/engine'
import { contextOf, findRevision } from '../../product/bom/store'
import { loadComponentFacts } from '../sheet-components/store'
import { companyFor, readStyleFor, STYLE_COLUMNS } from '../store'
import { refused, versionRefusalOf } from './refusals'
import {
  costsOf,
  leftOutOf,
  lineView,
  linesOf,
  nextVersionOf,
  readSheetFor,
  SHEET_COLUMNS,
  splitView,
  textOrNull,
  versionRowsOf,
  weightsFor,
  weightSourceOf,
  type Reader,
  type SheetRow,
  type StoredLine,
} from './store'

/**
 * Cost sheet versions (B-W2b-420; FIN-014; design products.styles › Cost "Cost sheet versions and approval"): a style's
 * versions per company and season, one version's record, a new DRAFT version (written from the revision's components now,
 * or a copy of a version of the same series), a draft's target, size curve and note edited, and a draft deleted. Reads check
 * costing.view over the sheet's company; writes costing.sheets.manage. An approved or frozen version is never edited: a
 * change is a new version (409 LOCKED / FROZEN in words). The approval is ./approval.ts.
 */

const tenantOf = (tools: CommandTools): string => ('tenantId' in tools.context ? tools.context.tenantId : '') ?? ''
const actorIdOf = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

function assertManage(caller: CommandCaller, companyId: string): void {
  if (!can(actorOf(contextOf(caller)), COSTING_SHEETS_MANAGE, { companyId })) throw new ForbiddenError()
}

/** An approved or frozen version takes no edit. */
export function assertDraft(sheet: Pick<SheetRow, 'state'>): void {
  if (sheet.state === 'APPROVED') throw refused('LOCKED')
  if (sheet.state === 'FROZEN') throw refused('FROZEN')
}

/** One version as a list row (re-read with the client). */
export async function versionRowOf(db: Reader, sheetId: string) {
  const sheet = await db.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
  return (await versionRowsOf(db, [sheet]))[0]!
}

/** cost_sheet.version_changed with the sheet's state as it is now. */
export function emitChanged(tools: CommandTools, sheet: Pick<SheetRow, 'id' | 'styleId' | 'companyId' | 'sheetVersion'>, state: SheetRow['state'], change: 'created' | 'updated' | 'deleted' | 'submitted' | 'returned' | 'frozen', frozenReason: SheetRow['frozenReason'] = null): void {
  tools.emit({ type: 'cost_sheet.version_changed', subject: sheet.id, companyId: sheet.companyId, payload: { sheetId: sheet.id, styleId: sheet.styleId, sheetVersion: sheet.sheetVersion, state, change, frozenReason } })
}

// ---- reads --------------------------------------------------------------------------------------------------------------------

/** GET /costing/cost-sheets?styleId — the style's versions the caller sees, series by series, newest version first. */
export async function listVersions(caller: CommandCaller, query: VersionsQuery) {
  const context = contextOf(caller)
  const style = await readStyleFor(caller, query.styleId)
  return caller.withClient(async (db) => {
    const filters: Prisma.CostSheetWhereInput[] = [{ styleId: style.id }]
    if (query.companyId) filters.push({ companyId: query.companyId })
    if (query.seasonId) filters.push({ seasonId: query.seasonId })
    if (query.state && query.state !== 'ALL') filters.push({ state: query.state })
    const rows = await db.costSheet.findMany({
      where: { AND: [scopeWhere(actorOf(context), COSTING_VIEW, { company: 'companyId' }) as Prisma.CostSheetWhereInput, ...filters] },
      select: SHEET_COLUMNS,
      orderBy: [{ key: 'asc' }, { sheetVersion: 'desc' }],
    })
    return { style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, sizes: [...style.sizes] }, versions: await versionRowsOf(db, rows) }
  })
}

const FROZEN_WORDS: Readonly<Record<NonNullable<SheetRow['frozenReason']>, string>> = Object.freeze({
  SUPERSEDED: 'Frozen: a newer version of the series was approved in its place. Kept to compare.',
  SEASON_CLOSED: 'Frozen: its season closed. Kept to compare.',
  WITHDRAWN: 'Frozen: it was taken back. Kept to compare; a new version follows.',
})

function stateWords(sheet: SheetRow, waiting: boolean): string {
  if (sheet.state === 'APPROVED') return 'Approved and locked: prices are released from it. A change is a new version.'
  if (sheet.state === 'FROZEN') return FROZEN_WORDS[sheet.frozenReason ?? 'SUPERSEDED']
  return waiting
    ? 'Waiting for its yes: whoever approves cost sheets decides it in Approvals. A change to the draft sends the request back.'
    : 'A draft: its lines, target and size curve change. Send it for its yes to approve and lock it.'
}

/** GET /costing/cost-sheets/:sheetId — one version: its lines, split by size, weighted cost and what may happen to it now. */
export async function versionRecord(caller: CommandCaller, sheetId: string): Promise<VersionRecordView> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const sheet = await readSheetFor(caller, sheetId)
  return caller.withClient(async (db) => {
    const style = await db.style.findUniqueOrThrow({ where: { id: sheet.styleId }, select: { sizes: true } })
    const lines = await linesOf(db, sheet.id)
    const { split, weights, weighted } = costsOf(sheet, lines, style.sizes)
    const row = (await versionRowsOf(db, [sheet]))[0]!
    const season = sheet.seasonId ? await db.season.findUnique({ where: { id: sheet.seasonId }, select: { status: true } }) : null
    const seasonOpen = sheet.seasonId === null || season?.status === 'OPEN'
    const manage = can(actor, COSTING_SHEETS_MANAGE, { companyId: sheet.companyId })
    const waiting = row.approval?.status === 'PENDING'
    return {
      sheet: { ...row, note: sheet.note },
      sizes: [...style.sizes],
      lines: lines.map(lineView),
      split: splitView(split),
      leftOut: leftOutOf(sheet.inputs),
      weights: { source: weightSourceOf(sheet.inputs), sizeCurveId: sheet.sizeCurveId, weights, shares: [...weighted.shares], weighted: asMoney('cost', weighted.weighted), missing: [...weighted.missing] },
      can: {
        edit: manage && sheet.state === 'DRAFT',
        remove: manage && sheet.state === 'DRAFT',
        submit: manage && sheet.state === 'DRAFT' && !waiting && lines.length > 0 && seasonOpen,
        newVersion: manage && seasonOpen,
        takeBack: sheet.state === 'APPROVED' && can(actor, COSTING_SHEETS_APPROVE, { companyId: sheet.companyId }),
      },
      words: stateWords(sheet, waiting),
    }
  })
}

// ---- a new version ------------------------------------------------------------------------------------------------------------

/** The data of a new line of a sheet from a line computed or copied. */
const lineData = (sheetId: string, line: ComponentLine & { readonly seq: number }, now: Date, createdById: string | null): Prisma.CostSheetLineCreateManyInput => ({
  id: newId(),
  costSheetId: sheetId,
  seq: line.seq,
  category: line.category,
  source: line.source,
  sourceRecordType: line.sourceRecordType,
  sourceRecordId: line.sourceRecordId,
  itemId: line.itemId,
  workCentreKind: line.workCentreKind,
  label: line.label,
  size: line.size,
  quantity: line.quantity,
  uom: line.uom,
  unitCost: line.unitCost,
  cost: line.cost,
  pct: line.pct,
  note: line.note,
  createdAt: now,
  updatedAt: now,
  createdById,
})

/** The inputs object of a sheet, as an object (null: empty). */
const inputsObject = (inputs: Prisma.JsonValue | null): Record<string, unknown> => (inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? { ...(inputs as Record<string, unknown>) } : {})

export interface NewVersion {
  readonly from: SheetRow | null
  readonly companyId: string
  readonly currency: string
  readonly styleId: string
  readonly revisionId: string
  readonly seasonId: string | null
  readonly baseSize: string
  readonly targetPrice: string | null
  readonly targetMarginPct: string | null
  readonly sizeCurveId: string | null
  readonly note: string | null
  readonly inputs: Record<string, unknown>
  readonly lines: readonly (ComponentLine & { readonly seq: number })[]
}

/** Writes a new DRAFT version of a series (the next number under the series' lock), its lines, its audit row and event. */
export async function insertVersion(tools: CommandTools, version: NewVersion, change: { readonly action: string; readonly how: string }): Promise<string> {
  const { tx, now } = tools
  const key = costSheetKey(version.styleId, version.companyId, version.seasonId)
  const sheetVersion = await nextVersionOf(tx, tenantOf(tools), key)
  const style = await tx.style.findUniqueOrThrow({ where: { id: version.styleId }, select: { id: true, sizes: true } })
  const weights = await weightsFor(tx, style, version.seasonId, version.sizeCurveId)
  const id = newId()
  const createdById = actorIdOf(tools)
  await tx.costSheet.create({
    data: {
      id,
      companyId: version.companyId,
      styleId: version.styleId,
      revisionId: version.revisionId,
      seasonId: version.seasonId,
      key,
      sheetVersion,
      basedOnId: version.from?.id ?? null,
      currency: version.currency,
      baseSize: version.baseSize,
      targetPrice: version.targetPrice,
      targetMarginPct: version.targetMarginPct,
      sizeCurveId: version.sizeCurveId,
      ...(weights.weights ? { sizeWeights: weights.weights } : {}),
      inputs: { ...version.inputs, weights: { source: weights.source } } as Prisma.InputJsonObject,
      note: version.note,
      createdAt: now,
      updatedAt: now,
      createdById,
    },
    select: { id: true },
  })
  if (version.lines.length > 0) await tx.costSheetLine.createMany({ data: version.lines.map((line) => lineData(id, line, now, createdById)) })
  tools.audit({
    action: change.action,
    recordType: 'CostSheet',
    recordId: id,
    companyId: version.companyId,
    after: { key, sheetVersion, basedOnId: version.from?.id ?? null, how: change.how, revisionId: version.revisionId, seasonId: version.seasonId, baseSize: version.baseSize, lines: version.lines.length, total: markMoney('cost', version.lines.map((line) => line.cost)), targetPrice: markMoney('price', version.targetPrice), targetMarginPct: markMoney('margin', version.targetMarginPct), weights: weights.source },
  })
  emitChanged(tools, { id, styleId: version.styleId, companyId: version.companyId, sheetVersion }, 'DRAFT', 'created')
  return id
}

/**
 * costing.createCostSheetVersion — POST /costing/cost-sheets: a new DRAFT version of a style's cost for a company and a season
 * (or none). COMPONENTS: the revision's components now (B-W2b-418's computation; missing inputs refuse it in words unless they
 * are left out, which the version records), with the typed lines of the version it follows on the same revision. COPY: the
 * lines of a version of the same series, as they are (its revision, inputs and what it left out). The number is the series'
 * next; the size weights the style's own for the season, else for every season, else the size curve named.
 */
export async function createVersion(caller: CommandCaller, body: CreateVersionBody, idempotencyKey?: string) {
  const style = await readStyleFor(caller, body.styleId)
  const basedOn = body.basedOnId ? await readSheetFor(caller, body.basedOnId) : null
  // A tenant-wide style is costed for the company asked, else the one of the version it follows.
  const asked = body.companyId ?? (style.companyId === null ? basedOn?.companyId : undefined)
  if (style.companyId === null && !asked) throw new ValidationError(VERSION_REFUSAL_WORDS.NO_COMPANY, [{ path: 'body/companyId', message: VERSION_REFUSAL_WORDS.NO_COMPANY }])
  const company = await companyFor(caller, style, asked, 'body/companyId')
  const companyId = company.id!
  assertManage(caller, companyId)
  if (body.from === 'COPY' && !basedOn) throw new ValidationError('Say which version to copy.', [{ path: 'body/basedOnId', message: 'Say which version to copy.' }])
  const seasonId = body.seasonId !== undefined ? body.seasonId : (basedOn?.seasonId ?? null)
  if (basedOn && basedOn.key !== costSheetKey(style.id, companyId, seasonId)) throw refused('OTHER_SERIES')
  const revisionId = body.from === 'COPY' ? basedOn!.revisionId : body.revisionId
  if (body.from === 'COPY' && body.revisionId && body.revisionId !== basedOn!.revisionId) throw refused('OTHER_REVISION')
  if (!revisionId) throw new ValidationError('Say which revision the version costs.', [{ path: 'body/revisionId', message: 'Say which revision the version costs.' }])
  const baseSize = body.baseSize ?? basedOn?.baseSize ?? style.baseSize ?? style.sizes[0] ?? ''
  if (!style.sizes.includes(baseSize)) throw new ValidationError(VERSION_REFUSAL_WORDS.BASE_SIZE, [{ path: 'body/baseSize', message: VERSION_REFUSAL_WORDS.BASE_SIZE }])
  if (seasonId) {
    const season = await caller.withClient((db) => db.season.findUnique({ where: { id: seasonId }, select: { companyId: true, status: true } }))
    if (!season || season.companyId !== companyId) throw new ValidationError('Not a season of this company.', [{ path: 'body/seasonId', message: 'Expected a season of the company.' }])
    if (season.status !== 'OPEN') throw refused('SEASON_CLOSED')
  }
  const { result } = await command(caller, { name: 'costing.createCostSheetVersion', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const revision = await findRevision(tx, style.id, revisionId)
    let lines: (ComponentLine & { readonly seq: number })[]
    let inputs: Record<string, unknown>
    if (body.from === 'COPY') {
      lines = await linesOf(tx, basedOn!.id)
      inputs = { ...inputsObject(basedOn!.inputs), copiedFrom: basedOn!.id }
    } else {
      const fresh = await tx.style.findUniqueOrThrow({ where: { id: style.id }, select: STYLE_COLUMNS })
      const on = businessDate(now)
      const loaded = await loadComponentFacts(tx, fresh, revision, { id: companyId, currency: costingCurrency(company.currency) }, on, { colourwayId: body.colourwayId, siteId: body.siteId, piecesPerCarton: body.piecesPerCarton })
      const computed = componentsOf(loaded.facts)
      if (computed.missing.length > 0 && !body.leaveOutMissing) {
        throw refused('INCOMPLETE', incompleteWords(computed.missing.length), computed.missing.map((entry) => ({ path: `missing/${entry.code}`, message: entry.message })))
      }
      const typed: StoredLine[] = basedOn && basedOn.revisionId === revision.id ? (await linesOf(tx, basedOn.id)).filter((line) => line.source === 'TYPED') : []
      lines = [...typed, ...numbered(computed.lines, new Set(typed.map((line) => line.seq)))].sort((a, b) => a.seq - b.seq)
      inputs = {
        components: { writtenAt: toUtcIso(now), on, colourwayId: loaded.colourway.id, siteId: loaded.pieceRate.siteId, piecesPerCarton: body.piecesPerCarton ?? null, leftOut: computed.missing, warnings: computed.warnings.map((warning) => warning.code) },
      }
    }
    const id = await insertVersion(
      tools,
      {
        from: basedOn,
        companyId,
        currency: company.currency,
        styleId: style.id,
        revisionId: revision.id,
        seasonId,
        baseSize,
        targetPrice: body.targetPrice ?? textOrNull(basedOn?.targetPrice ?? null),
        targetMarginPct: body.targetMarginPct ?? textOrNull(basedOn?.targetMarginPct ?? null),
        sizeCurveId: body.sizeCurveId ?? basedOn?.sizeCurveId ?? null,
        note: body.note ?? null,
        inputs,
        lines,
      },
      { action: 'costing.createCostSheetVersion', how: body.from },
    )
    return { sheet: await versionRowOf(tx, id) }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
  return result
}

// ---- a draft edited, a draft deleted ------------------------------------------------------------------------------------------

/** A waiting request for the draft's yes, sent back (the draft changed or went away). */
async function sendBack(tools: CommandTools, sheetId: string, words: string): Promise<number> {
  return withdrawPending(tools, { kind: COST_SHEET_KIND, recordId: sheetId, byId: actorIdOf(tools), words })
}

/** costing.updateCostSheetVersion — PATCH /costing/cost-sheets/:sheetId: a draft's target price and margin, size curve, note; its weights read again. */
export async function updateVersion(caller: CommandCaller, sheetId: string, body: UpdateVersionBody, idempotencyKey?: string) {
  const seen = await readSheetFor(caller, sheetId)
  assertManage(caller, seen.companyId)
  assertDraft(seen)
  const { result } = await command(caller, { name: 'costing.updateCostSheetVersion', idempotencyKey, input: { sheetId, ...body }, record: { type: 'CostSheet', id: sheetId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const sheet = await tx.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
    assertDraft(sheet)
    const before = { targetPrice: textOrNull(sheet.targetPrice), targetMarginPct: textOrNull(sheet.targetMarginPct), sizeCurveId: sheet.sizeCurveId, note: sheet.note, sizeWeights: sheet.sizeWeights }
    const after = {
      targetPrice: body.targetPrice === undefined ? before.targetPrice : body.targetPrice,
      targetMarginPct: body.targetMarginPct === undefined ? before.targetMarginPct : body.targetMarginPct,
      sizeCurveId: body.sizeCurveId === undefined ? before.sizeCurveId : body.sizeCurveId,
      note: body.note === undefined ? before.note : body.note,
    }
    let weights: Awaited<ReturnType<typeof weightsFor>> | null = null
    if (body.refreshWeights || after.sizeCurveId !== before.sizeCurveId) {
      const style = await tx.style.findUniqueOrThrow({ where: { id: sheet.styleId }, select: { id: true, sizes: true } })
      weights = await weightsFor(tx, style, sheet.seasonId, after.sizeCurveId)
    }
    const sameNumber = (a: string | null, b: string | null) => (a === null || b === null ? a === b : new Decimal(a).equals(b))
    const weightsChanged = weights !== null && JSON.stringify(weights.weights) !== JSON.stringify(before.sizeWeights ?? null)
    if (sameNumber(after.targetPrice, before.targetPrice) && sameNumber(after.targetMarginPct, before.targetMarginPct) && after.sizeCurveId === before.sizeCurveId && after.note === before.note && !weightsChanged) throw refused('NOTHING_CHANGES')
    await sendBack(tools, sheetId, 'The draft changed: send it for its yes again.')
    const inputs = weights ? ({ ...inputsObject(sheet.inputs), weights: { source: weights.source } } as Prisma.InputJsonObject) : undefined
    await tx.costSheet.update({
      where: { id: sheetId },
      data: { targetPrice: after.targetPrice, targetMarginPct: after.targetMarginPct, sizeCurveId: after.sizeCurveId, note: after.note, approvalTaskId: null, ...(inputs ? { inputs } : {}), ...(weights?.weights ? { sizeWeights: weights.weights } : {}), updatedAt: now },
      select: { id: true },
    })
    // factory-db has no runtime DbNull: no weights any more clears the column in SQL.
    if (weights !== null && weights.weights === null) await tx.$executeRaw`UPDATE "CostSheet" SET "sizeWeights" = NULL WHERE id = ${sheetId}::uuid`
    tools.audit({
      recordType: 'CostSheet',
      recordId: sheetId,
      companyId: sheet.companyId,
      before: { targetPrice: markMoney('price', before.targetPrice), targetMarginPct: markMoney('margin', before.targetMarginPct), sizeCurveId: before.sizeCurveId, note: before.note, sizeWeights: before.sizeWeights },
      after: { targetPrice: markMoney('price', after.targetPrice), targetMarginPct: markMoney('margin', after.targetMarginPct), sizeCurveId: after.sizeCurveId, note: after.note, sizeWeights: weights ? weights.weights : before.sizeWeights },
    })
    emitChanged(tools, sheet, 'DRAFT', 'updated')
    return { sheet: await versionRowOf(tx, sheetId) }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
  return result
}

/** costing.removeCostSheetVersion — DELETE /costing/cost-sheets/:sheetId?version: a draft and its lines (a waiting request sent back). */
export async function removeVersion(caller: CommandCaller, sheetId: string, version: number, idempotencyKey?: string) {
  const seen = await readSheetFor(caller, sheetId)
  assertManage(caller, seen.companyId)
  assertDraft(seen)
  await command(caller, { name: 'costing.removeCostSheetVersion', idempotencyKey, input: { sheetId, version }, record: { type: 'CostSheet', id: sheetId, expectedVersion: version } }, async (tools) => {
    const { tx } = tools
    const sheet = await tx.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
    assertDraft(sheet)
    if ((await tx.costSheet.count({ where: { basedOnId: sheetId } })) > 0) throw refused('COPIED_FROM')
    await sendBack(tools, sheetId, 'The draft was deleted.')
    const lines = await tx.costSheetLine.count({ where: { costSheetId: sheetId } })
    await tx.costSheet.delete({ where: { id: sheetId }, select: { id: true } })
    tools.audit({ recordType: 'CostSheet', recordId: sheetId, companyId: sheet.companyId, before: { key: sheet.key, sheetVersion: sheet.sheetVersion, state: sheet.state, lines }, after: null })
    emitChanged(tools, sheet, 'DRAFT', 'deleted')
    return { sheetId }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
}
