import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { languagesApproved, ppeGateOf, templateOfId, type ApprovalFacts, type PpeGate, type PpeTextKind, type TextAsk } from '@nexus/factory-domain/compliance/ppe-texts/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'

/**
 * The PPE text approvals as the generators read them (B-W2b-288, FU2:01; GATE-PPE-TEXTS): the DoC generator's and the user
 * information builder's detail (`gate`), and the label class warnings (label-rules facts.ts `ppeTextLanguages`). Office reads
 * only: the floor, portal and link sessions have no grant on PpeTextApproval (factory-db ownership/ppe-texts.json).
 */

type Reader = FactoryClient | CommandTx

export const APPROVAL_SELECT = {
  id: true,
  companyId: true,
  templateKind: true,
  templateKey: true,
  templateVersion: true,
  languages: true,
  checkedBy: true,
  recordedById: true,
  recordedAt: true,
  evidenceFileId: true,
  withdrawnAt: true,
  withdrawnById: true,
  withdrawReason: true,
  version: true,
} as const satisfies Prisma.PpeTextApprovalSelect
export type ApprovalRow = Prisma.PpeTextApprovalGetPayload<{ select: typeof APPROVAL_SELECT }>

export const factsOf = (row: Pick<ApprovalRow, 'companyId' | 'templateKind' | 'templateKey' | 'templateVersion' | 'languages' | 'withdrawnAt'>): ApprovalFacts => ({
  companyId: row.companyId,
  templateKind: row.templateKind as PpeTextKind,
  templateKey: row.templateKey,
  templateVersion: row.templateVersion,
  languages: [...row.languages],
  withdrawnAt: row.withdrawnAt ? toUtcIso(row.withdrawnAt) : null,
})

/** Every approval of one template (in force and withdrawn), oldest first. */
export async function approvalsOfTemplate(db: Pick<Reader, 'ppeTextApproval'>, kind: PpeTextKind, templateId: string | null): Promise<ApprovalRow[]> {
  const template = templateId ? templateOfId(templateId) : null
  if (!template) return []
  return db.ppeTextApproval.findMany({ where: { templateKind: kind, templateKey: template.key, templateVersion: template.version }, select: APPROVAL_SELECT, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
}

export const GATE_NAME = 'GATE-PPE-TEXTS' as const

/** The gate's words for one generated text (said by the API; the screens say their own from `state`, `languages`, `withdrawn`). */
function gateWords(gate: PpeGate<ApprovalRow>, language: string): string {
  if (gate.state === 'APPROVED') return `A PPE consultant checked this template in ${language} (${gate.approval!.checkedBy}): this generated text may leave draft.`
  if (gate.withdrawn) return `Draft until checked: the PPE consultant's yes to this template in ${language} was withdrawn; until a new one is recorded the signed PDF stays the live text.`
  if (gate.languages.length > 0) return `Draft until checked: a PPE consultant checked this template in ${gate.languages.join(', ')}, not in ${language}; until then the signed PDF stays the live text.`
  return 'Draft until checked: a PPE consultant checks the generated texts once; until then the signed PDF stays the live declaration.'
}

/**
 * The gate of one generated DoC or leaflet (its template, language and company): APPROVED when an approval in force covers
 * it (the database then lets it leave draft), else WAITING, in words.
 */
export async function ppeGateFor(db: Pick<Reader, 'ppeTextApproval'>, ask: TextAsk & { readonly language: string }) {
  const rows = await approvalsOfTemplate(db, ask.kind, ask.templateId)
  const gate = ppeGateOf(
    rows.map((row) => ({ ...factsOf(row), row })),
    ask,
  )
  const approval = gate.approval?.row ?? null
  return {
    name: GATE_NAME,
    words: gateWords({ ...gate, approval }, ask.language),
    open: gate.state !== 'APPROVED',
    state: gate.state,
    approval: approval ? { id: approval.id, checkedBy: approval.checkedBy, recordedAt: toUtcIso(approval.recordedAt), languages: [...approval.languages], companyId: approval.companyId } : null,
    languages: gate.languages,
    withdrawn: gate.withdrawn,
  }
}

/**
 * The languages approvals in force cover for a label template's class warnings (its code and revision, its company: an
 * approval of every company covers every label; a tenant-wide label needs an approval of every company). Office only.
 */
export async function labelLanguagesApproved(db: Pick<Reader, 'ppeTextApproval'>, label: { readonly code: string; readonly revision: number; readonly companyId: string | null }): Promise<string[]> {
  const rows = await db.ppeTextApproval.findMany({ where: { templateKind: 'LABEL_WARNING', templateKey: label.code, templateVersion: label.revision, withdrawnAt: null }, select: APPROVAL_SELECT })
  return languagesApproved(rows.map(factsOf), { kind: 'LABEL_WARNING', templateId: `${label.code}.${label.revision}`, companyId: label.companyId })
}
