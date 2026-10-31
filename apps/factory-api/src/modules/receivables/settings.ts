import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import type { SettingsBody, SwitchBody } from '@nexus/factory-domain/receivables/contracts'
import {
  effectiveSettings,
  INTEREST_WORDS,
  interestProblems,
  ladderJson,
  ladderOf,
  ladderProblems,
  numberedLadder,
  stepWords,
  SWITCH_BLOCKERS,
  switchBlockers,
  switchWords,
  type LateInterestMode,
} from '@nexus/factory-domain/receivables/ladder'
import { RECEIVABLES_REMINDERS_SWITCH, RECEIVABLES_SETTINGS_MANAGE, RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import { REMINDER_TEMPLATES, TEMPLATE_WORDS, WORDING_TO_CONFIRM } from '@nexus/factory-domain/receivables/wording'
import type { CommandCaller, CommandTools } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { statutoryToday } from './interest-rates'
import { mayEveryCompany, officeContextOf, receivablesCommand, SETTINGS_COLUMNS, settingsRowOf, settingsRows, tenantIdOf, type SettingsRecord } from './store'

/**
 * The receivables settings (B-W2a-55; FIN-111; W2a plan §2 "Owner switch", GATE-ACCOUNTANT): the reminder ladder, the
 * minimum amount, the late-payment rule and the Owner's switch, per company (its own row wins whole) or tenant-wide (id =
 * the tenant's, a grant over every company).
 *
 *   GET /receivables/settings?companyId          receivables.view: the company's row, the tenant row, which holds, the
 *                                                 switch and what keeps it off, the interest rule in words (and, B-W2b-21,
 *                                                 whether statutory interest has today's half-year rate), the wording
 *                                                 (placeholders TO CONFIRM with the accountant)
 *   PUT /receivables/settings                     receivables.settings.manage: the ladder (levels numbered in order), the
 *                                                 late-payment rule as the accountant decided it, the recovery charge and
 *                                                 the minimum (price grain); a company's first change makes its own row
 *                                                 from the tenant's, with the switch as it was there
 *   PUT /receivables/settings/switch              receivables.reminders.switch (the owner's; switching ON also asks a fresh
 *                                                 step-up): refused in words while there is no ladder or the late-payment
 *                                                 rule is UNDECIDED (the database refuses it too); OFF always
 * Every change is ONE command on the row FOR UPDATE at the version read; receivables_settings.changed tells the ladder
 * (its worker handler re-plans the timers of the company's customers).
 */

function viewOf(row: SettingsRecord | null) {
  if (!row) return null
  const settings = settingsRowOf(row)
  return {
    id: row.id,
    companyId: row.companyId,
    version: row.version,
    remindersEnabled: row.remindersEnabled,
    ladder: ladderOf(row.ladder).map((step) => ({ ...step, words: { en: stepWords(step.offsetDays, 'en'), it: stepWords(step.offsetDays, 'it') } })),
    lateInterestMode: settings.lateInterestMode,
    lateInterestAgreedPct: settings.lateInterestAgreedPct,
    recoveryChargeAmount: asMoney('price', row.recoveryChargeAmount),
    minimumAmount: asMoney('price', row.minimumAmount),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const mayAt = (context: OfficeContext, permission: typeof RECEIVABLES_SETTINGS_MANAGE | typeof RECEIVABLES_REMINDERS_SWITCH | typeof RECEIVABLES_VIEW, companyId: string | null): boolean =>
  companyId === null ? mayEveryCompany(context, permission) : can(actorOf(context), permission, { companyId })

/** GET /receivables/settings (receivables.view). */
export async function getSettings(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null && !can(actorOf(context), RECEIVABLES_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  if (companyId === null && !mayEveryCompany(context, RECEIVABLES_VIEW) && !can(actorOf(context), RECEIVABLES_VIEW, {})) throw new ForbiddenError()
  const { rows, statutory } = await caller.withClient(async (db) => {
    if (companyId !== null && !(await db.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    return { rows: await settingsRows(db, companyId), statutory: await statutoryToday(db) }
  })
  const effective = effectiveSettings(rows.company ? settingsRowOf(rows.company) : null, rows.tenant ? settingsRowOf(rows.tenant) : null)
  const effectiveRow = effective.source === 'COMPANY' ? rows.company : effective.source === 'TENANT' ? rows.tenant : null
  const blockers = switchBlockers(effective)
  return {
    companyId,
    source: effective.source,
    effective: viewOf(effectiveRow),
    company: viewOf(rows.company),
    tenant: viewOf(rows.tenant),
    switch: { on: effective.remindersEnabled, words: switchWords(effective), blockers: blockers.map((code) => ({ code, words: SWITCH_BLOCKERS[code] })), mayChange: mayAt(context, RECEIVABLES_REMINDERS_SWITCH, companyId) },
    // B-W2b-21: whether STATUTORY interest has an amount today (the half-year's rate recorded, GET /receivables/interest-rates).
    interest: { mode: effective.lateInterestMode, words: INTEREST_WORDS[effective.lateInterestMode], statutory: { halfYearStart: statutory.halfYearStart, ratePct: statutory.ratePct, missing: statutory.missing, words: statutory.words } },
    wording: { toConfirm: true as const, words: WORDING_TO_CONFIRM, templates: REMINDER_TEMPLATES.map((key) => ({ key, words: TEMPLATE_WORDS[key] })) },
    mayManage: mayAt(context, RECEIVABLES_SETTINGS_MANAGE, companyId),
  }
}

/** The row a change writes, locked: the company's own (made from the tenant's on its first change), or the tenant's. */
async function rowToChange(tools: CommandTools, companyId: string | null, version: number | undefined): Promise<{ row: SettingsRecord; created: boolean }> {
  const { tx, now } = tools
  const tenantId = tenantIdOf(tools.context)
  const id = companyId ?? tenantId
  if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
  await tx.$queryRaw`SELECT id FROM "ReceivablesSettings" WHERE id = ${id}::uuid FOR UPDATE`
  const existing = await tx.receivablesSettings.findUnique({ where: { id }, select: SETTINGS_COLUMNS })
  if (existing) {
    if (version === undefined || version !== existing.version) {
      throw new DomainError('conflict', `These settings changed since they were read; they are now at version ${existing.version}. Reload them and change them again.`, [{ path: 'body/version', message: `The current version is ${existing.version}.` }])
    }
    return { row: existing, created: false }
  }
  if (version !== undefined) throw new DomainError('conflict', 'These settings do not exist yet: send no version to make them.', [{ path: 'body/version', message: 'Leave it out for new settings.' }])
  // A company's first own row starts from the tenant's (the switch as it was, when it may stay on).
  const tenant = companyId !== null ? await tx.receivablesSettings.findUnique({ where: { id: tenantId }, select: SETTINGS_COLUMNS }) : null
  const created = await tx.receivablesSettings.create({
    data: {
      id,
      companyId,
      remindersEnabled: tenant?.remindersEnabled ?? false,
      ladder: (tenant?.ladder ?? []) as object,
      lateInterestMode: tenant?.lateInterestMode ?? 'UNDECIDED',
      lateInterestAgreedPct: tenant?.lateInterestAgreedPct ?? null,
      recoveryChargeAmount: tenant?.recoveryChargeAmount ?? null,
      minimumAmount: tenant?.minimumAmount ?? null,
      createdAt: now,
      updatedAt: now,
      createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
    },
    select: SETTINGS_COLUMNS,
  })
  tools.audit({ action: 'receivables.settingsCreate', recordType: 'ReceivablesSettings', recordId: id, companyId, after: { from: tenant ? 'TENANT' : 'NONE', remindersEnabled: created.remindersEnabled } })
  return { row: created, created: true }
}

const audited = (row: SettingsRecord) => ({
  remindersEnabled: row.remindersEnabled,
  ladder: row.ladder,
  lateInterestMode: row.lateInterestMode,
  lateInterestAgreedPct: row.lateInterestAgreedPct === null ? null : row.lateInterestAgreedPct.toString(),
  recoveryChargeAmount: markMoney('price', row.recoveryChargeAmount),
  minimumAmount: markMoney('price', row.minimumAmount),
})

/** PUT /receivables/settings (receivables.settings.manage). */
export async function putSettings(caller: CommandCaller, body: SettingsBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  if (!mayAt(context, RECEIVABLES_SETTINGS_MANAGE, body.companyId)) throw new ForbiddenError(body.companyId === null ? 'The settings of every company are changed only by a role over every company.' : undefined)
  const problems = [...ladderProblems(body.ladder), ...interestProblems(body.lateInterestMode as LateInterestMode, body.lateInterestAgreedPct ?? null)]
  if (problems.length > 0) throw new ValidationError('The receivables settings are not valid.', problems)
  const ladder = ladderJson(numberedLadder(body.ladder))
  await receivablesCommand(caller, { name: 'receivables.settings', idempotencyKey, input: body }, async (tools) => {
    const { row, created } = await rowToChange(tools, body.companyId, body.version)
    const data = {
      ladder,
      lateInterestMode: body.lateInterestMode,
      lateInterestAgreedPct: body.lateInterestMode === 'AGREED' ? (body.lateInterestAgreedPct ?? null) : null,
      recoveryChargeAmount: body.recoveryChargeAmount ?? null,
      minimumAmount: body.minimumAmount ?? null,
    }
    // Reminders stay on only with a ladder and a decided rule: switch them off first (the database refuses it too).
    let remindersEnabled = row.remindersEnabled
    const blockers = switchBlockers({ ladder: ladder.map((step) => ({ ...step, template: step.template ?? null })), lateInterestMode: body.lateInterestMode })
    if (remindersEnabled && blockers.length > 0) {
      if (!created) throw new DomainError('conflict', `Reminders are switched on for these settings: ${blockers.map((code) => SWITCH_BLOCKERS[code]).join(' ')} Switch them off first.`, [{ path: 'settings/SWITCHED_ON', message: 'Switch reminders off first.' }])
      remindersEnabled = false
    }
    const after = await tools.tx.receivablesSettings.update({ where: { id: row.id }, data: { ...data, remindersEnabled, version: row.version + 1, updatedAt: tools.now }, select: SETTINGS_COLUMNS })
    tools.audit({ action: 'receivables.settings', recordType: 'ReceivablesSettings', recordId: row.id, companyId: row.companyId, before: audited(row), after: audited(after) })
    tools.emit({ type: 'receivables_settings.changed', subject: row.id, companyId: row.companyId, payload: { settingsId: row.id, companyId: row.companyId, steps: ladder.length, remindersEnabled: after.remindersEnabled, switched: after.remindersEnabled !== row.remindersEnabled } })
    return { id: row.id }
  })
  return getSettings(caller, { companyId: body.companyId ?? undefined })
}

/** PUT /receivables/settings/switch (receivables.reminders.switch; ON also a fresh step-up). */
export async function putSwitch(caller: CommandCaller, body: SwitchBody, stepUp: () => void, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  if (!mayAt(context, RECEIVABLES_REMINDERS_SWITCH, body.companyId)) throw new ForbiddenError(body.companyId === null ? 'Reminders of every company are switched only by a role over every company.' : undefined)
  if (body.on) stepUp()
  await receivablesCommand(caller, { name: 'receivables.switch', idempotencyKey, input: body }, async (tools) => {
    const { row } = await rowToChange(tools, body.companyId, body.version)
    if (row.remindersEnabled === body.on) {
      tools.audit({ action: 'receivables.switch', recordType: 'ReceivablesSettings', recordId: row.id, companyId: row.companyId, after: { remindersEnabled: row.remindersEnabled, unchanged: true } })
      return { id: row.id, unchanged: true }
    }
    if (body.on) {
      const blockers = switchBlockers(effectiveSettings(settingsRowOf(row), null))
      if (blockers.length > 0) throw new DomainError('conflict', blockers.map((code) => SWITCH_BLOCKERS[code]).join(' '), blockers.map((code) => ({ path: `switch/${code}`, message: SWITCH_BLOCKERS[code] })))
    }
    const after = await tools.tx.receivablesSettings.update({ where: { id: row.id }, data: { remindersEnabled: body.on, version: row.version + 1, updatedAt: tools.now }, select: SETTINGS_COLUMNS })
    tools.audit({ action: 'receivables.switch', recordType: 'ReceivablesSettings', recordId: row.id, companyId: row.companyId, before: { remindersEnabled: row.remindersEnabled }, after: { remindersEnabled: after.remindersEnabled } })
    tools.emit({ type: 'receivables_settings.changed', subject: row.id, companyId: row.companyId, payload: { settingsId: row.id, companyId: row.companyId, steps: ladderOf(row.ladder).length, remindersEnabled: after.remindersEnabled, switched: true } })
    return { id: row.id, unchanged: false }
  })
  return getSettings(caller, { companyId: body.companyId ?? undefined })
}
