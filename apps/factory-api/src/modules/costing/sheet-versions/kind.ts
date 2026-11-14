import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { changePctOf, COST_SHEET_FIELDS, COST_SHEET_KIND, factNumber, leftOutWords, marginPctOf, VERSION_REFUSAL_WORDS, type SnapshotLine } from '@nexus/factory-domain/costing/sheet-versions/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from '../../../platform/approvals/kinds/kind'
import { approvedInCommand, returnedInCommand } from './approval'
import { costsOf, coveredByTypedOf, leftOutOf, linesOf, SHEET_COLUMNS, textOrNull } from './store'

/**
 * COST_SHEET (B-W2b-420; FIN-015; plan "A sheet is approved by the costing owner before prices are released (a COST_SHEET
 * approval kind; nobody approves their own)"): a cost sheet version, approved and locked before prices are released from it.
 * Only its module asks (POST /costing/cost-sheets/:sheetId/submit: `ask` null); when no rule in force holds, the costing
 * owner's role decides (modules/costing/sheet-versions/approval.ts).
 *
 *   facts      the base size's cost and the weighted cost (cost grain), the target price (price grain), the target margin
 *              and the margin at the target price (margin grain), how far the cost moved on the version in force, the
 *              version's number, a first version, the inputs left out, the style's and season's codes
 *   snapshot   the version as it would be locked: its revision, season (and whether it is open), base size, currency, target,
 *              size curve and weights, whether its typed lines cover what was left out, and every line — a line written or a
 *              target changed while waiting makes the request STALE
 *   yes        the version in force frozen (SUPERSEDED), this one APPROVED by the decider on this request; never its maker
 *   no / withdrawn / stale   the draft stays a draft, the request no longer named on it
 */

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const sheet = await client.costSheet.findUnique({ where: { id: recordId }, select: SHEET_COLUMNS })
  if (!sheet) return null
  const [style, season, lines, inForce] = await Promise.all([
    client.style.findUnique({ where: { id: sheet.styleId }, select: { code: true, name: true, sizes: true } }),
    sheet.seasonId ? client.season.findUnique({ where: { id: sheet.seasonId }, select: { code: true, status: true } }) : Promise.resolve(null),
    linesOf(client, sheet.id),
    client.costSheet.findFirst({ where: { key: sheet.key, state: 'APPROVED', id: { not: sheet.id } }, select: SHEET_COLUMNS }),
  ])
  const sizes = style?.sizes ?? []
  const costs = costsOf(sheet, lines, sizes)
  const cost = costs.weighted.weighted ?? costs.baseCost
  let before: string | null = null
  if (inForce) {
    const was = costsOf(inForce, await linesOf(client, inForce.id), sizes)
    before = costs.weighted.weighted !== null ? was.weighted.weighted : was.baseCost
  }
  const targetPrice = textOrNull(sheet.targetPrice)
  const leftOut = leftOutOf(sheet.inputs)
  const seasonOpen = sheet.seasonId === null || season?.status === 'OPEN'
  const code = style?.code ?? ''
  const held = sheet.state !== 'DRAFT' ? VERSION_REFUSAL_WORDS[sheet.state === 'APPROVED' ? 'LOCKED' : 'FROZEN'] : lines.length === 0 ? VERSION_REFUSAL_WORDS.NO_LINES : !seasonOpen ? VERSION_REFUSAL_WORDS.SEASON_CLOSED : leftOut.length > 0 && !coveredByTypedOf(sheet.inputs) ? leftOutWords(leftOut.length) : null
  const snapshotLines: SnapshotLine[] = lines.map((line) => ({ seq: line.seq, category: line.category, source: line.source, sourceRecordId: line.sourceRecordId, itemId: line.itemId, size: line.size, quantity: line.quantity, unitCost: line.unitCost, cost: line.cost, pct: line.pct }))
  return {
    companyId: sheet.companyId,
    siteId: null,
    label: `${code} · v${sheet.sheetVersion}${season ? ` · ${season.code}` : ''}`.slice(0, 200),
    summary: `${code} ${style?.name ?? ''}: cost sheet version ${sheet.sheetVersion}${season ? ` for ${season.code}` : ''}, ${lines.length === 1 ? '1 line' : `${lines.length} lines`}, to be approved and locked before prices are released`.slice(0, 500),
    facts: {
      baseCost: factNumber(costs.baseCost),
      weightedCost: factNumber(costs.weighted.weighted),
      targetPrice: factNumber(targetPrice),
      targetMarginPct: factNumber(textOrNull(sheet.targetMarginPct)),
      marginAtTarget: factNumber(marginPctOf(targetPrice, cost)),
      costChangePct: factNumber(changePctOf(cost, before)),
      sheetVersion: sheet.sheetVersion,
      firstVersion: inForce === null && sheet.basedOnId === null,
      leftOut: leftOut.length,
      styleCode: code || null,
      seasonCode: season?.code ?? null,
    },
    snapshot: {
      state: sheet.state,
      revisionId: sheet.revisionId,
      seasonId: sheet.seasonId,
      seasonOpen,
      baseSize: sheet.baseSize,
      currency: sheet.currency,
      targetPrice,
      targetMarginPct: textOrNull(sheet.targetMarginPct),
      sizeCurveId: sheet.sizeCurveId,
      sizeWeights: sheet.sizeWeights ?? null,
      coveredByTyped: coveredByTypedOf(sheet.inputs),
      lines: snapshotLines,
    },
    changes: [{ field: 'state', from: 'DRAFT', to: 'APPROVED' }],
    held,
  }
}

export const COST_SHEET_APPROVAL_KIND: ApprovalKindDefinition = Object.freeze({
  kind: COST_SHEET_KIND,
  recordType: 'CostSheet',
  label: { en: 'Cost sheet', it: 'Scheda costo' },
  view: COSTING_VIEW,
  ask: null,
  fields: COST_SHEET_FIELDS,
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    await tx.$queryRaw`SELECT 1 FROM "CostSheet" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.costSheet.findMany({ where: companyId ? { companyId } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  onApproved: (tools: CommandTools, task: TaskRef) => approvedInCommand(tools, task),
  onRejected: (tools: CommandTools, task: TaskRef) => returnedInCommand(tools, task),
  onWithdrawn: (tools: CommandTools, task: TaskRef) => returnedInCommand(tools, task),
  onStale: (tools: CommandTools, task: TaskRef) => returnedInCommand(tools, task),
  async parent(client: Reader, recordId: string) {
    const sheet = await client.costSheet.findUnique({ where: { id: recordId }, select: { styleId: true } })
    return sheet ? { type: 'Style', id: sheet.styleId } : null
  },
})
