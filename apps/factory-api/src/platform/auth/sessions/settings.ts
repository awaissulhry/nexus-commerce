import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { FLOOR_SESSION } from '@nexus/factory-domain/auth/floor/session'
import {
  lengthProblems,
  lengthsWiden,
  SECURITY_BOUNDS,
  SECURITY_DEFAULTS,
  stepUpRuleProblems,
  stepUpRulesWiden,
  type SecurityNumber,
  type SecurityRules,
  type SessionLengths,
  type StepUpRules,
} from '@nexus/factory-domain/auth/sessions/lengths'
import { SECURITY_SETTINGS_MANAGE } from '@nexus/factory-domain/auth/sessions/permissions'
import { ConflictError, ValidationError } from '@nexus/factory-domain/core/errors'
import { holds } from '@nexus/factory-domain/core/permissions'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { requireStepUp } from '../office/account'
import { STEP_UP_VALID_MS } from './session-store'
import { stepUpActionsView, STEP_UP_ACTION_BY_KEY } from '../office/step-up-policy'
import type { OfficeAuth } from './office-auth'
import type { SessionLengthsBody, StepUpRulesBody } from './contract'
import { securityRulesIn } from './rules'

/**
 * The company's security settings (B-W2b-404; PLT-068, PLT-063; design admin.security "Session lengths" and "Actions that
 * ask for a fresh code"): ONE SecuritySettings row per tenant (id = the tenant's id; made at the first save), no row = the
 * defaults of factory-domain auth/sessions/lengths. Reading them is security.view; changing them security.settings.manage,
 * and a change that is wider (a longer session, an action switched off, more wrong codes, a shorter lock) asks for a fresh
 * code first (requireStepUp: the change itself is the fixed `security.settings` action). Each save is ONE command with its
 * audit row (before → after) and the event `security.settings_changed`. The floor keeps its own times per site
 * (FloorSettings: idle minutes and shift ends, Admin › Devices): shown here, changed there.
 */

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

async function floorTimes(client: FactoryClient) {
  const sites = await client.site.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: 200, select: { id: true, code: true, name: true, companyId: true } })
  const settings = await client.floorSettings.findMany({ where: { id: { in: sites.map((site) => site.id) } }, select: { id: true, idleMinutes: true, shiftEnds: true } })
  const byId = new Map(settings.map((row) => [row.id, row]))
  return sites.map((site) => ({
    siteId: site.id,
    companyId: site.companyId,
    code: site.code,
    name: site.name,
    idleMinutes: byId.get(site.id)?.idleMinutes ?? FLOOR_SESSION.defaultIdleMinutes,
    shiftEnds: byId.get(site.id)?.shiftEnds ?? [],
  }))
}

const boundOf = (key: SecurityNumber) => ({ min: SECURITY_BOUNDS[key][0], max: SECURITY_BOUNDS[key][1], default: SECURITY_DEFAULTS[key] })

function settingsView(rules: SecurityRules, version: number, floor: Awaited<ReturnType<typeof floorTimes>>, canChange: boolean) {
  return {
    version,
    sessions: {
      office: { idleMinutes: rules.officeIdleMinutes, longestHours: rules.officeLongestHours },
      portal: { idleMinutes: rules.portalIdleMinutes, longestHours: rules.portalLongestHours },
      floor,
    },
    stepUp: {
      actions: stepUpActionsView(rules.stepUpOff),
      maxFailures: rules.stepUpMaxFailures,
      lockMinutes: rules.stepUpLockMinutes,
      validMinutes: STEP_UP_VALID_MS / 60_000,
    },
    bounds: {
      officeIdleMinutes: boundOf('officeIdleMinutes'),
      officeLongestHours: boundOf('officeLongestHours'),
      portalIdleMinutes: boundOf('portalIdleMinutes'),
      portalLongestHours: boundOf('portalLongestHours'),
      stepUpMaxFailures: boundOf('stepUpMaxFailures'),
      stepUpLockMinutes: boundOf('stepUpLockMinutes'),
    },
    canChange,
  }
}

export async function getSecuritySettings(request: FastifyRequest) {
  const context = officeContextOf(request)
  const { rules, version, floor } = await request.withClient(async (client) => ({ ...(await securityRulesIn(client, context.tenantId)), floor: await floorTimes(client) }))
  return settingsView(rules, version, floor, holds(actorOf(context), SECURITY_SETTINGS_MANAGE))
}

/**
 * Saves one part of the settings in ONE command: the row read again in the transaction (FOR its version), the change
 * checked, a wider one only with a fresh code, then made (the row created at the first save) and audited.
 */
async function saveSettings(
  auth: OfficeAuth,
  request: FastifyRequest,
  part: 'SESSIONS' | 'STEP_UP',
  expectedVersion: number,
  reason: string | undefined,
  change: (before: SecurityRules) => { readonly after: SecurityRules; readonly wider: boolean; readonly fields: readonly (keyof SecurityRules)[] },
) {
  const context = officeContextOf(request)
  const { result } = await auth.command(context, { name: part === 'SESSIONS' ? 'security.setSessionLengths' : 'security.setStepUpRules', input: { expectedVersion, reason } }, async ({ tx, audit, emit }) => {
    const { rules: before, version } = await securityRulesIn(tx, context.tenantId)
    if (version !== expectedVersion) throw new ConflictError('The security settings changed meanwhile. Reload them, then try again.')
    const { after, wider, fields } = change(before)
    // Longer = wider: a fresh code first (the database keeps the bounds; nobody loses access by a stricter rule).
    if (wider) requireStepUp(auth, request)
    const data = Object.fromEntries(fields.map((field) => [field, after[field]]))
    if (version === 0) {
      await tx.securitySettings.create({ data: { id: context.tenantId, ...data, createdById: context.actorId } })
    } else {
      const { count } = await tx.securitySettings.updateMany({ where: { id: context.tenantId, version }, data: { ...data, version: version + 1 } })
      if (count !== 1) throw new ConflictError('The security settings changed meanwhile. Reload them, then try again.')
    }
    const newVersion = version === 0 ? 1 : version + 1
    audit({
      recordType: 'SecuritySettings',
      recordId: context.tenantId,
      companyId: null,
      before: Object.fromEntries(fields.map((field) => [field, before[field]])),
      after: { ...data, wider },
      ...(reason ? { reason } : {}),
    })
    emit({ type: 'security.settings_changed', subject: context.tenantId, payload: { part, version: newVersion } })
    return { rules: after, version: newVersion }
  })
  const floor = await request.withClient((client) => floorTimes(client))
  return settingsView(result.rules, result.version, floor, true)
}

export async function saveSessionLengths(auth: OfficeAuth, request: FastifyRequest, body: SessionLengthsBody) {
  const lengths: SessionLengths = {
    officeIdleMinutes: body.officeIdleMinutes,
    officeLongestHours: body.officeLongestHours,
    portalIdleMinutes: body.portalIdleMinutes,
    portalLongestHours: body.portalLongestHours,
  }
  const problems = lengthProblems(lengths)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return saveSettings(auth, request, 'SESSIONS', body.version, body.reason, (before) => ({
    after: { ...before, ...lengths },
    wider: lengthsWiden(before, lengths),
    fields: ['officeIdleMinutes', 'officeLongestHours', 'portalIdleMinutes', 'portalLongestHours'],
  }))
}

export async function saveStepUpRules(auth: OfficeAuth, request: FastifyRequest, body: StepUpRulesBody) {
  const rules: StepUpRules = { stepUpOff: [...body.off], stepUpMaxFailures: body.maxFailures, stepUpLockMinutes: body.lockMinutes }
  const problems = stepUpRuleProblems(rules, STEP_UP_ACTION_BY_KEY)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return saveSettings(auth, request, 'STEP_UP', body.version, body.reason, (before) => ({
    after: { ...before, ...rules, stepUpOff: [...rules.stepUpOff].sort() },
    wider: stepUpRulesWiden(before, rules),
    fields: ['stepUpOff', 'stepUpMaxFailures', 'stepUpLockMinutes'],
  }))
}
