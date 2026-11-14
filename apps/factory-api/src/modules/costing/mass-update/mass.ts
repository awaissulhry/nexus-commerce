import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import type { MassApplyBody, MassApplyView, MassPreviewBody, MassPreviewView } from '@nexus/factory-domain/costing/mass-update/contracts'
import { SERIES_WORDS, type MassChange } from '@nexus/factory-domain/costing/mass-update/rules'
import { componentsOf, numbered } from '@nexus/factory-domain/costing/sheet-components/components'
import { COSTING_SHEETS_MANAGE } from '@nexus/factory-domain/costing/sheet-components/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { PRODUCT_MATERIALS_COST } from '@nexus/factory-domain/product/materials/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf, findRevision } from '../../product/bom/store'
import { mayWrite } from '../../product/materials/store'
import { versionRefusalOf } from '../sheet-versions/refusals'
import { linesOf, textOrNull, type StoredLine } from '../sheet-versions/store'
import { insertVersion } from '../sheet-versions/versions'
import { loadComponentFacts } from '../sheet-components/store'
import { massRefused, previewOf } from './preview'

/**
 * The mass cost update (B-W2b-423; FIN-022; design finance.costing › "Mass cost update", "Approve update"):
 *
 *   POST /costing/mass-updates/preview   what the new prices do (./preview.ts), nothing written (costing.view)
 *   POST /costing/mass-updates/apply     costing.massUpdate.apply + a fresh code (step-up, Admin › Security's money settings
 *                                        line): in ONE command, the preview computed again and compared with the one the person
 *                                        saw (STALE otherwise); each material's new standard price (the materials' own audit
 *                                        row and event, so the cost sheet says when it was set); and for each affected series a
 *                                        NEW DRAFT version from its components (B-W2b-420's insertVersion: the next number under
 *                                        the series' lock, its weights; the followed version's typed lines on the same revision).
 *                                        A closed season's series is left alone; one with a missing input only when the person
 *                                        lets it leave them out (NOT_RECOMPUTED otherwise). Never an approved or frozen version,
 *                                        never a posted cost: the drafts go for their yes as any version does.
 *
 * Applying also needs product.materials.cost over each material's company (a tenant-wide one: a grant over every company) and
 * costing.sheets.manage over each series' company, with the cost grain (NO_RIGHT otherwise, in words).
 */

/** The changes as sent (a price left out is refused in words by the rules: the money mark makes it optional in the shape). */
const changesOf = (changes: MassPreviewBody['changes']): MassChange[] => changes.map((change) => ({ itemId: change.itemId, newPrice: change.newPrice ?? '' }))

/** POST /costing/mass-updates/preview */
export async function previewMassUpdate(caller: CommandCaller, body: MassPreviewBody): Promise<MassPreviewView> {
  const actor = actorOf(contextOf(caller))
  if (!heldGrains(actor).has('cost')) throw new ForbiddenError('A mass cost update is about costs: it needs the cost grain.')
  const now = serverClock.now()
  return caller.withClient(async (db) => (await previewOf(db, actor, changesOf(body.changes), now)).view)
}

/** costing.applyMassUpdate — POST /costing/mass-updates/apply */
export async function applyMassUpdate(caller: CommandCaller, body: MassApplyBody, idempotencyKey?: string): Promise<MassApplyView> {
  const actor = actorOf(contextOf(caller))
  if (!heldGrains(actor).has('cost')) throw new ForbiddenError('A mass cost update is about costs: it needs the cost grain.')
  const changes = changesOf(body.changes)
  const { result } = await command(caller, { name: 'costing.applyMassUpdate', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    // The materials first, FOR UPDATE in id order: nobody prices them between the check and the write.
    const ids = [...new Set(changes.map((change) => change.itemId))].sort()
    await tx.$queryRaw`SELECT "id" FROM "Item" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`
    const preview = await previewOf(tx, actor, changes, now)
    if (preview.view.previewHash !== body.previewHash) throw massRefused('STALE')
    const noRight = [
      ...preview.materials.filter((material) => !mayWrite(actor, PRODUCT_MATERIALS_COST, material.companyId)).map((material) => ({ path: `changes/${material.code}`, message: `${material.code}: its standard price is not yours to change.` })),
      ...preview.series.filter((entry) => !can(actor, COSTING_SHEETS_MANAGE, { companyId: entry.sheet.companyId })).map((entry) => ({ path: `series/${entry.sheet.key}`, message: `${entry.style.code}: its cost sheets are not yours to keep.` })),
    ]
    if (noRight.length > 0) throw massRefused('NO_RIGHT', noRight)
    const incomplete = preview.series.filter((entry) => entry.state === 'INCOMPLETE')
    if (incomplete.length > 0 && !body.leaveOutMissing) throw massRefused('NOT_RECOMPUTED', incomplete.map((entry) => ({ path: `series/${entry.sheet.key}`, message: `${entry.style.code} version ${entry.sheet.sheetVersion}: ${entry.missing.join(' ')}` })))

    const changed = preview.materials.filter((material, index) => material.standardCost === null || material.standardCost !== decimalText(changes[index]!.newPrice))
    const written: MassApplyView['materials'] = []
    for (const material of changed) {
      const newPrice = decimalText(changes.find((change) => change.itemId === material.id)!.newPrice)
      const row = await tx.item.update({ where: { id: material.id }, data: { standardCost: newPrice, version: { increment: 1 }, updatedAt: now }, select: { version: true } })
      tools.audit({
        recordType: 'Item',
        recordId: material.id,
        companyId: material.companyId,
        before: { standardCost: markMoney('cost', material.standardCost), currency: material.currency },
        after: { standardCost: markMoney('cost', newPrice), currency: material.currency },
        reason: body.note ?? 'Mass cost update',
      })
      tools.emit({ type: 'material.standard_cost_changed', subject: material.id, companyId: material.companyId, payload: { itemId: material.id, code: material.code } })
      written.push({ itemId: material.id, code: material.code, version: row.version })
    }

    const on = businessDate(now)
    const created: MassApplyView['created'] = []
    const skipped: MassApplyView['skipped'] = []
    const codes = changed.map((material) => material.code).join(', ')
    for (const entry of preview.series) {
      if (entry.state === 'SEASON_CLOSED') {
        skipped.push({ key: entry.sheet.key, state: entry.state, words: SERIES_WORDS[entry.state] })
        continue
      }
      const { sheet, style } = entry
      const revision = await findRevision(tx, style.id, sheet.revisionId)
      const loaded = await loadComponentFacts(tx, style, revision, { id: sheet.companyId, currency: costingCurrency(sheet.currency) }, on, entry.options)
      const computed = componentsOf(loaded.facts)
      const typed: StoredLine[] = (await linesOf(tx, sheet.id)).filter((line) => line.source === 'TYPED')
      const lines = [...typed, ...numbered(computed.lines, new Set(typed.map((line) => line.seq)))].sort((a, b) => a.seq - b.seq)
      const id = await insertVersion(
        tools,
        {
          from: sheet,
          companyId: sheet.companyId,
          currency: sheet.currency,
          styleId: style.id,
          revisionId: revision.id,
          seasonId: sheet.seasonId,
          baseSize: sheet.baseSize,
          targetPrice: textOrNull(sheet.targetPrice),
          targetMarginPct: textOrNull(sheet.targetMarginPct),
          sizeCurveId: sheet.sizeCurveId,
          note: `${body.note ? `${body.note} — ` : ''}Mass cost update: new standard price of ${codes}.`.slice(0, 2000),
          inputs: {
            components: { writtenAt: toUtcIso(now), on, colourwayId: loaded.colourway.id, siteId: loaded.pieceRate.siteId, piecesPerCarton: entry.options.piecesPerCarton ?? null, leftOut: computed.missing, warnings: computed.warnings.map((warning) => warning.code) },
            massUpdate: { items: changed.map((material) => material.id), previewHash: body.previewHash },
          },
          lines,
        },
        { action: 'costing.applyMassUpdate', how: 'MASS_UPDATE' },
      )
      created.push({ sheetId: id, key: sheet.key, sheetVersion: sheet.sheetVersion + 1, basedOnId: sheet.id, leftOut: computed.missing.length })
    }
    // The numbers the drafts really took (another version may have been made since the preview: the series' lock gave the next).
    const made = created.length === 0 ? [] : await tx.costSheet.findMany({ where: { id: { in: created.map((entry) => entry.sheetId) } }, select: { id: true, sheetVersion: true } })
    const numberOf = new Map(made.map((row) => [row.id, row.sheetVersion]))
    if (written.length > 0) tools.emit({ type: 'mass_update.applied', subject: written[0]!.itemId, companyId: null, payload: { itemIds: written.map((entry) => entry.itemId), sheetIds: created.map((entry) => entry.sheetId), skipped: skipped.length } })
    return {
      materials: written,
      created: created.map((entry) => ({ ...entry, sheetVersion: numberOf.get(entry.sheetId) ?? entry.sheetVersion })),
      skipped,
      words: `${written.length} standard price${written.length === 1 ? '' : 's'} set; ${created.length} new draft version${created.length === 1 ? '' : 's'} made${skipped.length > 0 ? `; ${skipped.length} series left alone` : ''}. Send each draft for its yes before prices are released from it.`,
    }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
  return result as MassApplyView
}
