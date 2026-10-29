import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { LEGAL_CR_VI_LIMIT } from '@nexus/factory-domain/inventory/receipts/rules'
import { QUALITY_LOTS_VIEW, QUALITY_SETTINGS_MANAGE } from '@nexus/factory-domain/quality/lab/permissions'
import { DEFAULT_EVIDENCE_RULE, EVIDENCE_RULE_WORDS, isLoosening, LAB_LAW, reasonProblem, type EvidenceRule, type SettingSource } from '@nexus/factory-domain/quality/lab/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { ruleFor } from './read'
import { processQualitySettings, type QualitySettingsRow } from './settings-store'
import { officeOf } from './store'

/**
 * The Cr VI evidence rule (B-W1-34; Owner question Q14; design compliance.settings rm-cr6, compliance.tests ts-rule):
 * what counts as chromium VI evidence, for a company or tenant-wide (the company's row wins; none: the default, Q14 (a)
 * "a supplier report covering the article and the period counts"). The legal limit, 3 mg/kg (REACH Annex XVII entry
 * 47), is not a setting; a brand's lower limit is the material's (Item.crViLimitMgKg).
 *
 *   GET /quality/settings?companyId   quality.lots.view (over the company; tenant-wide: any grant)
 *   PUT /quality/settings             quality.settings.manage over the company (tenant-wide: a grant over every
 *                                     company); `version` = the version read (0: never saved). Loosening (a lab report for
 *                                     every lot → a supplier report) asks for a fresh code (step-up) and a reason;
 *                                     tightening never does. Saved through the settings seam (settings-store.ts).
 */

const view = (companyId: string | null, inForce: { rule: EvidenceRule; source: SettingSource }, own: QualitySettingsRow | null) => ({
  companyId,
  crViEvidenceRule: inForce.rule,
  source: inForce.source,
  words: EVIDENCE_RULE_WORDS[inForce.rule],
  default: DEFAULT_EVIDENCE_RULE,
  legalLimitMgKg: LEGAL_CR_VI_LIMIT,
  law: LAB_LAW,
  /** The row of this company (or the tenant-wide one), when saved: its version for the next save. */
  version: own?.version ?? 0,
  updatedAt: own?.updatedAt ?? null,
  updatedById: own?.updatedById ?? null,
})

async function assertCompany(caller: CommandCaller, companyId: string): Promise<void> {
  const context = officeOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !(can(actorOf(context), QUALITY_LOTS_VIEW, { companyId }) || can(actorOf(context), QUALITY_SETTINGS_MANAGE, { companyId }))) throw new NotFoundError('Company not found.')
}

/** GET /quality/settings. */
export async function getQualitySettings(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null) await assertCompany(caller, companyId)
  return caller.withClient(async (client) => {
    const rows = await processQualitySettings().rows(client, context.tenantId, companyId)
    const own = rows.find((row) => row.id === (companyId ?? context.tenantId)) ?? null
    return { settings: view(companyId, await ruleFor(client, context.tenantId, companyId), own) }
  })
}

export interface SaveQualitySettingsBody {
  readonly companyId?: string | null | undefined
  readonly crViEvidenceRule: EvidenceRule
  readonly version: number
  readonly reason?: string | null | undefined
}

/** PUT /quality/settings. */
export async function saveQualitySettings(caller: CommandCaller, body: SaveQualitySettingsBody, options: { readonly stepUp: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), QUALITY_SETTINGS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The tenant-wide Cr VI evidence rule is changed only by a role over every company.' : undefined)
  }
  if (companyId !== null) await assertCompany(caller, companyId)
  const before = await caller.withClient((client) => ruleFor(client, context.tenantId, companyId))
  const loosens = isLoosening(before.rule, body.crViEvidenceRule)
  if (loosens) {
    const problem = reasonProblem(body.reason)
    if (problem) throw new ValidationError('Accepting a supplier report as chromium VI evidence again needs the reason.', [{ ...problem, path: `body/${problem.path}` }])
    await options.stepUp()
  }
  const id = companyId ?? context.tenantId
  const { result } = await command(caller, { name: 'quality.settings.save', idempotencyKey: options.idempotencyKey, input: body }, async (tools) => {
    // The rule in force before, read again in the transaction; the seam's save takes the row's lock and refuses a
    // stale version, so of two saves of one version only one commits.
    const previous = (await ruleFor(tools.tx, context.tenantId, companyId)).rule
    if (isLoosening(previous, body.crViEvidenceRule) && !loosens) {
      // It became a loosening while the request was on its way: ask again (the step-up and the reason).
      throw new ValidationError('The rule in force changed: reload it, then loosen it with the reason and a fresh code.', [{ path: 'body/version', message: 'Reload the settings.' }])
    }
    const saved = await processQualitySettings().save(tools, { id, companyId, crViEvidenceRule: body.crViEvidenceRule, expectedVersion: body.version, byId: context.actorId, reason: body.reason?.trim() || null })
    if (previous !== body.crViEvidenceRule) {
      tools.emit({
        type: 'quality.settings_changed',
        subject: id,
        companyId,
        payload: { companyId, crViEvidenceRule: body.crViEvidenceRule, previousRule: previous, loosened: isLoosening(previous, body.crViEvidenceRule) },
      })
    }
    return { saved, previous }
  })
  return { settings: view(companyId, { rule: result.saved.crViEvidenceRule, source: (companyId === null ? 'TENANT' : 'COMPANY') as SettingSource }, result.saved), previousRule: result.previous }
}
