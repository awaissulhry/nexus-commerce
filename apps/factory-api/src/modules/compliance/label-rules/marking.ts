import { isLabelEditable, type LabelKind, type LabelQrTarget, type LabelTemplateStatus } from '@nexus/factory-domain/compliance/labels/rules'
import { isOriginClaimKey, ORIGIN_CLAIM_KEYS } from '@nexus/factory-domain/compliance/textile-rules/origin'
import { DomainError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import type { TemplateDetail } from '../labels/contract'
import { assertMayManage, draftProblems, labelCommand, officeOf, readTemplate, TEMPLATE_SELECT, templateDetail, type TemplateRow } from '../labels/store'
import { rulesGuarded } from '../register-of-rules/common'

/**
 * A draft label's W2b marking (B-W2b-253; B-W2b-218's columns): what the label is (PPE garment label, glove marking, fibre and
 * care label, packaging label: PRD-336), the GPSR contact it prints (PRD-346) and where its QR points (PRD-349). Like the
 * rest of the label, it changes only while the label is a DRAFT (the database refuses it later too, for every login); a
 * new revision copies it (compliance/labels templates.ts). compliance.labels.manage over the label's company (a
 * tenant-wide label: over every company). One command: the audit row with before and after, W1's event
 * compliance.label_template_saved (UPDATED). A database refusal answers 409 in words.
 *
 * B-W2b-GF2 (G032): and the origin claim it prints (`originClaimKey`, null for none): one of the origin claims the Made in
 * Italy check knows (textile-rules ORIGIN_CLAIM_KEYS), whose phrase the library holds (an ACTIVE CLAIM phrase: its words
 * print in the label's languages). The claim is checked against the routing by the textile rules (madeInItaly), and the
 * label prints it only with approved words in every language it prints.
 */

export interface MarkingBody {
  readonly version: number
  readonly kind?: LabelKind | undefined
  /** The name, postal and electronic address, lines allowed; null: none. */
  readonly gpsrContact?: string | null | undefined
  readonly qrTarget?: LabelQrTarget | undefined
  /** B-W2b-GF2: the origin claim's phrase key ("claim.made-in-italy"); null: none. */
  readonly originClaimKey?: string | null | undefined
}

const marking = (row: Pick<TemplateRow, 'kind' | 'gpsrContact' | 'qrTarget' | 'originClaimKey'>) => ({ kind: row.kind, gpsrContact: row.gpsrContact, qrTarget: row.qrTarget, originClaimKey: row.originClaimKey })

const frozen = (code: string, revision: number, status: string) =>
  new InvalidStateError(`Label ${code} r${revision} is ${status}: its kind, GPSR contact, QR and origin claim change only while it is a draft. Start a new revision of it instead.`)

/** B-W2b-GF2: an origin claim refused, 409 `refusal/ORIGIN_CLAIM` in words. */
const claimRefused = (message: string) => new DomainError('conflict', message, [{ path: 'refusal/ORIGIN_CLAIM', message }, { path: 'body/originClaimKey', message }])

/** PUT /compliance/label-rules/templates/:templateId/marking */
export async function setMarking(caller: CommandCaller, templateId: string, body: MarkingBody, idempotencyKey?: string): Promise<TemplateDetail> {
  const context = officeOf(caller)
  const before = await readTemplate(caller, templateId)
  assertMayManage(context, before.companyId)
  if (!isLabelEditable(before.status as LabelTemplateStatus)) throw frozen(before.code, before.revision, before.status)
  const data: { kind?: LabelKind; gpsrContact?: string | null; qrTarget?: LabelQrTarget; originClaimKey?: string | null } = {}
  if (body.kind !== undefined) data.kind = body.kind
  if (body.gpsrContact !== undefined) data.gpsrContact = body.gpsrContact === null || body.gpsrContact.trim() === '' ? null : body.gpsrContact.trim()
  if (body.qrTarget !== undefined) data.qrTarget = body.qrTarget
  // B-W2b-GF2 (G032): an origin claim the check knows, whose phrase the library holds.
  if (body.originClaimKey !== undefined) {
    const key = body.originClaimKey === null || body.originClaimKey.trim() === '' ? null : body.originClaimKey.trim()
    if (key !== null) {
      if (!isOriginClaimKey(key)) throw claimRefused(`"${key}" is no origin claim a label may print: ${ORIGIN_CLAIM_KEYS.join(' or ')}.`)
      const phrase = await caller.withClient((db) => db.phrase.findFirst({ where: { key, status: 'ACTIVE' }, select: { kind: true } }))
      if (!phrase || phrase.kind !== 'CLAIM') throw claimRefused(`The phrase library holds no active claim ${key}: add it (Compliance › Phrases) so the label has its words.`)
    }
    data.originClaimKey = key
  }
  if (Object.keys(data).length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Give the kind, the GPSR contact, the QR target or the origin claim.' }])

  return rulesGuarded(async () => {
    const { result } = await labelCommand(
      caller,
      { name: 'compliance.labels.marking', idempotencyKey, input: { templateId, ...body }, record: { type: 'LabelTemplate', id: templateId, expectedVersion: body.version } },
      async ({ tx, audit, emit, now }) => {
        // The row is locked now: a move that committed meanwhile is seen here (the trigger would refuse it anyway).
        const locked = await tx.labelTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { status: true, code: true, revision: true } })
        if (!isLabelEditable(locked.status as LabelTemplateStatus)) throw frozen(locked.code, locked.revision, locked.status)
        const row = await tx.labelTemplate.update({ where: { id: templateId }, data: { ...data, updatedAt: now }, select: TEMPLATE_SELECT })
        audit({ recordType: 'LabelTemplate', recordId: templateId, companyId: row.companyId, before: marking(before), after: marking(row) })
        emit({ type: 'compliance.label_template_saved', subject: templateId, companyId: row.companyId, payload: { templateId, code: row.code, revision: row.revision, styleId: row.styleId, change: 'UPDATED', problems: draftProblems(row).length } })
        return templateDetail(tx, context, templateId, businessDate(now))
      },
    )
    return result
  })
}
