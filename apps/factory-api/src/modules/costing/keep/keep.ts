import { DomainError, ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { KeepBody, KeepView } from '@nexus/factory-domain/costing/keep/contracts'
import { KEEP_REFUSAL_WORDS, keepReasonOf, keepRefusalOf, KEEP_REASON_MAX, type KeepRefusal } from '@nexus/factory-domain/costing/keep/rules'
import { numbered } from '@nexus/factory-domain/costing/sheet-components/components'
import { COSTING_SHEETS_APPROVE } from '@nexus/factory-domain/costing/sheet-versions/permissions'
import { VERSION_REFUSAL_WORDS } from '@nexus/factory-domain/costing/sheet-versions/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, findRevision } from '../../product/bom/store'
import { costNowOf, keptOf } from '../price-against-cost/store'
import { approveAloneInCommand, askForYesInCommand } from '../sheet-versions/approval'
import { versionRefusalOf } from '../sheet-versions/refusals'
import { SHEET_COLUMNS } from '../sheet-versions/store'
import { assertManage, insertVersion } from '../sheet-versions/versions'
import { companyFor, readStyleFor, STYLE_COLUMNS } from '../store'
import { keepStandardsInCommand, keptTodayOf } from './standards'

/**
 * owb-pd3 step 3.2 (S4 settle 9; design plan § 5zh "Keep", § 10 R59; plan § 5 I) — POST /costing/styles/:styleId/revisions/:revisionId/
 * keep { reason, expectedTotal }: the cost now kept as the standard cost, in ONE command:
 *   1. the revision's live components (the same computation the Cost tab's cost now reads: price-against-cost/store costNowOf) —
 *      refused when a part is missing (MISSING_PARTS, each part in words), when the cost moved since the person read it (TOTAL_MOVED),
 *      when it is the kept standard already (SAME_AS_KEPT), when a standard of the product was kept today already (KEPT_TODAY);
 *   2. a new cost sheet version from them (the series of the product, its company and no season; its note and its inputs' `keep`
 *      hold the reason);
 *   3. the company's own costing settings let one person keep a cost (`oneKeeperAllowed`) and the person may approve cost sheets
 *      (costing.sheets.approve) → approved by the same person with the reason (`keptAloneReason`; the redefined guard allows it only
 *      then; audit `keptAlone`) and its standard costs written at once (keep/standards.ts) → `mode: 'KEPT'`;
 *      else → sent for approval through today's COST_SHEET request (four eyes) → `mode: 'SENT_FOR_APPROVAL'`; the standards follow
 *      on its yes (sheet-versions/approval.ts approvedInCommand).
 * Who: costing.sheets.manage over the product's company and the cost grain. The product's shared history gets one line "a new
 * cost" with the version, never an amount (the amounts stay in the cost versions).
 */

const keepRefused = (code: KeepRefusal, more: readonly Issue[] = []): DomainError => new DomainError('conflict', KEEP_REFUSAL_WORDS[code], [{ path: `refusal/${code}`, message: KEEP_REFUSAL_WORDS[code] }, ...more])

export async function keepCost(caller: CommandCaller, styleId: string, revisionId: string, body: KeepBody, idempotencyKey?: string): Promise<KeepView> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const style = await readStyleFor(caller, styleId)
  if (!holds(actor, 'money.cost')) throw new ForbiddenError(KEEP_REFUSAL_WORDS.NO_COST_GRAIN)
  // A tenant-wide product is kept for the company the page works in.
  const asked = style.companyId === null && context.audience === 'office' ? context.companyId : undefined
  const company = await companyFor(caller, style, asked, 'body/companyId')
  if (company.id === null) throw new ValidationError(VERSION_REFUSAL_WORDS.NO_COMPANY, [{ path: 'body/companyId', message: VERSION_REFUSAL_WORDS.NO_COMPANY }])
  const companyId = company.id
  assertManage(caller, companyId)
  const reason = keepReasonOf(body.reason)
  if (reason === null) throw new ValidationError('Say why the standard cost changes.', [{ path: 'body/reason', message: `Expected 1 to ${KEEP_REASON_MAX} characters.` }])
  const mayApprove = can(actor, COSTING_SHEETS_APPROVE, { companyId })
  // A money.cost field is optional in the contract (left out without the grain): Keep needs it, as read.
  const expectedTotal = body.expectedTotal
  if (expectedTotal === undefined) throw new ValidationError('Send the cost now as you read it.', [{ path: 'body/expectedTotal', message: 'Required.' }])

  const { result } = await command(caller, { name: 'costing.keepCost', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools): Promise<KeepView> => {
    const { tx, now } = tools
    if (tools.context.audience !== 'office') throw new ForbiddenError()
    const asker = tools.context.actorId
    const revision = await findRevision(tx, styleId, revisionId)
    const fresh = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
    const day = businessDate(now)
    const live = await costNowOf(tx, fresh, revision, { id: companyId, currency: company.currency }, day)
    const kept = await keptOf(tx, styleId, companyId, day)
    const refusal = keepRefusalOf({ total: live.total, missing: live.missing.length, expectedTotal, kept: kept?.amount ?? null })
    if (refusal) throw keepRefused(refusal, refusal === 'MISSING_PARTS' ? live.missing.map((entry) => ({ path: `missing/${entry.code}`, message: entry.message })) : [])
    if (await keptTodayOf(tools, styleId, companyId)) throw keepRefused('KEPT_TODAY')

    const sheetId = await insertVersion(
      tools,
      {
        from: null,
        companyId,
        currency: company.currency,
        styleId,
        revisionId: revision.id,
        seasonId: null,
        baseSize: live.baseSize ?? '',
        targetPrice: null,
        targetMarginPct: null,
        sizeCurveId: null,
        note: reason,
        inputs: {
          components: { writtenAt: toUtcIso(now), on: day, colourwayId: live.colourwayId, siteId: live.pieceRateSiteId, piecesPerCarton: null, leftOut: [], warnings: live.computed.warnings.map((warning) => warning.code) },
          keep: { reason, byId: asker, expectedTotal },
        },
        lines: numbered(live.computed.lines, new Set()),
      },
      { action: 'costing.createCostSheetVersion', how: 'KEEP' },
    )
    const sheet = await tx.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
    // The company's OWN costing settings row (keyed by the company's id) holds the switch; none: off.
    const settings = await tx.costingSettings.findUnique({ where: { id: companyId }, select: { companyId: true, oneKeeperAllowed: true } })
    const alone = settings?.companyId === companyId && settings.oneKeeperAllowed === true && mayApprove
    if (alone) {
      await approveAloneInCommand(tools, sheet, asker, reason)
      const standards = await keepStandardsInCommand(tools, sheet, reason)
      tools.audit({ action: 'costing.keepCost', recordType: 'Style', recordId: styleId, companyId, after: { sheetId, sheetVersion: sheet.sheetVersion, mode: 'KEPT', standards: standards.written } })
      return { mode: 'KEPT', costSheetId: sheetId, kept: { amount: asMoney('cost', live.total!), version: sheet.sheetVersion, keptAt: toUtcIso(now) } }
    }
    await askForYesInCommand(tools, sheet, asker, reason)
    tools.audit({ action: 'costing.keepCost', recordType: 'Style', recordId: styleId, companyId, after: { sheetId, sheetVersion: sheet.sheetVersion, mode: 'SENT_FOR_APPROVAL' } })
    return { mode: 'SENT_FOR_APPROVAL', costSheetId: sheetId, kept: null }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
  return result
}
