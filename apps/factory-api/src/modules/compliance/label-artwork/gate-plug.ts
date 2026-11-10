import type { CheckResult } from '@nexus/factory-domain/compliance/gates/gate'
import { approvedNow, inForceAt, reconciliationWords } from '@nexus/factory-domain/compliance/label-artwork/rules'
import { labelFacts } from '../../production/serials/facts'
import { readLabelSpoils } from '../../production/serials/label-log'
import { readHeader } from '../../production/serials/store'
import { plugGateCheck } from '../gates/plugs'
import { reconciliationOf } from './reconciliation'
import { readArtwork } from './store'

/**
 * B-W2b-259's two checks plugged into B-W2b-254's ONE gate by name (no second gate; loaded with this module's routes):
 *
 *   label.artwork         (PRD-347 "only an approved version prints") the label revision the gate reads has an approved
 *                         artwork proof; a work order that printed before follows the version in force at its first print
 *                         ("reprints use the same version"). For a requirement of kind LABEL that blocks LABEL_PRINT.
 *   label.reconciliation  (MES-140 "a difference holds the work order's release") the size's labels balance: printed = used
 *                         + spoiled + returned. For a requirement of kind LABEL that blocks FINAL_RELEASE; asked of a work
 *                         order only (the status board's style × market cell has none: shown as checked per work order).
 *
 * A check runs only for a requirement row that names its key and is ACTIVE and ON (B-W2b-254's `checksAsked`): the rows are
 * the Owner's (Rules & markets › Gates, B-W2b-265: POST /compliance/requirements, kind LABEL, checkKey the key, blocks the
 * place). The gate's reader is never the floor role (an office transaction or the tenant's system client).
 */

export const LABEL_ARTWORK_CHECK_KEYS = ['label.artwork', 'label.reconciliation'] as const

const NO_LABEL: CheckResult = { state: 'MISSING', message: 'No garment label template is set, so its artwork is not known.', fix: 'set one on the style revision (Products › Labels).', facts: { code: 'artwork.noLabel' }, evidence: null }

plugGateCheck(['label.artwork'], { kinds: ['LABEL'], market: false, who: 'COMPLIANCE', fix: 'labels' }, async (context) => {
  const templateId = context.labelTemplateId
  if (!templateId) return () => NO_LABEL
  const template = await context.db.labelTemplate.findUnique({ where: { id: templateId }, select: { code: true, revision: true } })
  const name = template ? `${template.code} r${template.revision}` : 'The label'
  const rows = await readArtwork(context.db, templateId)
  // A work order that printed before follows the version in force at its first print.
  const first =
    context.subject?.type === 'WorkOrder' ? await context.db.garmentLabelPrint.findFirst({ where: { workOrderId: context.subject.id }, select: { createdAt: true }, orderBy: [{ createdAt: 'asc' }] }) : null
  const pinned = first ? inForceAt(rows, first.createdAt) : null
  const approved = pinned ?? approvedNow(rows)
  const evidence = { recordType: 'LabelTemplate', recordId: templateId, label: `${name} artwork` }
  const result: CheckResult = approved
    ? {
        state: 'PRESENT',
        message: pinned ? `Label ${name} prints as artwork v${approved.versionNo}, the version its first labels printed with.` : `Label ${name} has approved artwork v${approved.versionNo}.`,
        fix: null,
        facts: { code: 'artwork.approved', versionNo: approved.versionNo, pinned: pinned !== null },
        evidence,
      }
    : {
        state: 'MISSING',
        message: rows.some((row) => row.status === 'DRAFT') ? `Label ${name} has artwork waiting for approval by a second person.` : `Label ${name} has no approved artwork.`,
        fix: 'a person other than its author approves the proof (Compliance › Labels & marking › Artwork & approval).',
        facts: { code: rows.some((row) => row.status === 'DRAFT') ? 'artwork.waiting' : 'artwork.none' },
        evidence: null,
      }
  return () => result
})

plugGateCheck(['label.reconciliation'], { kinds: ['LABEL'], market: false, who: 'PRODUCTION', fix: 'labels' }, async (context) => {
  if (context.subject?.type !== 'WorkOrder') {
    const perOrder: CheckResult = { state: 'MANUAL', message: 'The labels are reconciled per work order (printed = used + spoiled + returned).', fix: null, facts: { code: 'reconciliation.perWorkOrder' }, evidence: null }
    return () => perOrder
  }
  const header = await readHeader(context.db, context.subject.id)
  if (!header) {
    const none: CheckResult = { state: 'MANUAL', message: 'The work order is not found.', fix: null, facts: { code: 'reconciliation.noWorkOrder' }, evidence: null }
    return () => none
  }
  const result = reconciliationOf(await labelFacts(context.db, header), await readLabelSpoils(context.db, header.id))
  return (_requirement, _key, target) => {
    const row = result.cells.find((cell) => cell.cellId === target.key)
    if (!row) return { state: 'NOT_NEEDED', message: 'Not a size of the work order.', fix: null, facts: { code: 'reconciliation.notACell' }, evidence: null }
    const facts = { code: row.balanced ? 'reconciliation.balanced' : 'reconciliation.difference', printed: row.printed, used: row.used, spoiled: row.spoiled, returned: row.returned, difference: row.difference }
    const evidence = { recordType: 'WorkOrder', recordId: header.id, label: `${header.number} labels` }
    if (row.balanced) return { state: 'PRESENT', message: reconciliationWords(row), fix: null, facts, evidence }
    return { state: 'MISSING', message: reconciliationWords(row), fix: 'log the spoiled or returned labels on the floor (Garment labels › Log spoiled labels), or reprint the missing ones.', facts, evidence: null }
  }
})
