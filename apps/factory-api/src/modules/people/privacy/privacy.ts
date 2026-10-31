import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Grant, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { LEGAL_GATE_CHANGES } from '@nexus/factory-domain/people/events'
import { AUTOMATED_DECISIONS, informationPackDue, peopleDataFacts, purposesInOrder } from '@nexus/factory-domain/people/privacy/decisions'
import { figureRoleKeysProblems, figureRolesChangeOf, sightWords } from '@nexus/factory-domain/people/privacy/figures'
import {
  basisForSwitchOn,
  GATE_LAW,
  GATE_PURPOSE_WORDS,
  gateDriftNotes,
  gateReadiness,
  leadsChangeOf,
  leadsChangeProblems,
  reasonProblems,
  switchOffProblems,
  switchOnProblems,
  type GateFacts,
} from '@nexus/factory-domain/people/privacy/gate'
import { minimumGroupChangeOf, minimumGroupProblems } from '@nexus/factory-domain/people/privacy/groups'
import { PEOPLE_FIGURES_VIEW, PEOPLE_PRIVACY_MANAGE, PEOPLE_PRIVACY_VIEW } from '@nexus/factory-domain/people/privacy/permissions'
import { GATE_PURPOSES, type GatePurpose } from '@nexus/factory-domain/people/privacy/purposes'
import { scanSubjectOf, type MonitoringBasis, type ScanSubject } from '@nexus/factory-domain/production/settings/monitoring'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { noticeInForce } from '../../../platform/privacy/read'
import { holdsFigureRole } from './access'
import type { ChangeResult, SiteDetail } from './contract'
import { GATE_SELECT, legalGateFor, legalGatesOf, recordedBasisOf, type GateRecord } from './gate'
import { privacySettingsFor } from './groups'

/**
 * The legal gate per site and purpose and the privacy settings of people data (B-W2b-27; W2b plan §2 GATE-LABOUR;
 * PLT-207, PLT-209, ANA-075, MES-249, MES-281, MES-282; design people.settings "Privacy of people data", admin.privacy
 * "People data rules" and "DPIA"; Statuto dei Lavoratori art. 4 c.1-3; GDPR arts. 5, 13, 22, 35).
 *
 * Reads: every site the grants reach with both purposes (on or off, what switching on needs, what changed since), one
 * site with its history and its DPIA record, a company's settings, the people data rules, and what a viewer sees on a
 * People page. Writes, each ONE command with its audit row and the event legal_gate.changed or
 * people_settings.privacy_changed:
 *   switch on    people.privacy.manage + a reason + a fresh step-up: the company's worker notice in force and its stored
 *                DPIA are recorded on the gate (the DPIA record of the purpose), with the basis (ATTENDANCE: the body's;
 *                PERFORMANCE: the site's in Production › Settings); refused in words while anything is missing
 *   switch off   people.privacy.manage + a reason, never a step-up (narrowing is always allowed); the row is final
 *   leads        widening needs the recorded basis to cover leads, a reason and a step-up; narrowing never asks
 *   settings     the minimum group size and the roles that see one person's figures: lowering the size or naming
 *                another role is a widening (a reason and a step-up); raising or removing never asks
 */

type Change = (typeof LEGAL_GATE_CHANGES)[number]

const SITE_SELECT = { id: true, companyId: true, code: true, name: true } as const satisfies Prisma.SiteSelect
type SiteRow = Prisma.SiteGetPayload<{ select: typeof SITE_SELECT }>
const COMPANY_SELECT = { id: true, code: true, legalName: true, tradeName: true } as const satisfies Prisma.CompanySelect
const DPIA_SELECT = { id: true, versionNo: true, status: true, scope: true, signedByName: true, signedOn: true, reviewDueOn: true } as const satisfies Prisma.PrivacyDpiaSelect
type DpiaRow = Prisma.PrivacyDpiaGetPayload<{ select: typeof DPIA_SELECT }>

type Db = CommandTx

function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const trimmed = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const mayOn = (context: OfficeContext, permission: Permission, site: { companyId: string; id: string }): boolean => can(actorOf(context), permission, { companyId: site.companyId, siteId: site.id })

/** The site, when the caller may see its gates (else 404) and do `permission` there (else 403). */
async function siteOf(caller: CommandCaller, siteId: string, permission: Permission): Promise<{ context: OfficeContext; site: SiteRow }> {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: SITE_SELECT })) : null
  if (!site || !mayOn(context, PEOPLE_PRIVACY_VIEW, site)) throw new NotFoundError('Site not found.')
  if (!mayOn(context, permission, site)) throw new ForbiddenError()
  return { context, site }
}

/** The company, when the caller may see its settings (else 404) and do `permission` there (else 403). */
async function companyOf(caller: CommandCaller, companyId: string, permission: Permission) {
  const context = officeContextOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: COMPANY_SELECT })) : null
  const actor = actorOf(context)
  if (!row || !can(actor, PEOPLE_PRIVACY_VIEW, { companyId: row.id })) throw new NotFoundError('Company not found.')
  if (!can(actor, permission, { companyId: row.id })) throw new ForbiddenError()
  return { context, company: { id: row.id, code: row.code, name: row.tradeName ?? row.legalName } }
}

/** What the company and the site have on record towards a purpose (read in the caller's office scope or the command's). */
async function gateFactsFor(db: Db, site: SiteRow, purpose: GatePurpose, now: Date): Promise<GateFacts & { readonly dpiaRow: DpiaRow | null }> {
  const notice = await noticeInForce(db, site.companyId, 'WORKER_FLOOR')
  const dpiaRow = await db.privacyDpia.findFirst({ where: { companyId: site.companyId, status: 'STORED' }, select: DPIA_SELECT })
  const rules = await db.productionSettings.findUnique({ where: { id: site.id }, select: { scanSubject: true, monitoringBasis: true, monitoringReference: true } })
  return {
    purpose,
    workerNotice: notice ? { id: notice.id, label: notice.label } : null,
    dpia: dpiaRow ? { id: dpiaRow.id, versionNo: dpiaRow.versionNo, reviewDueOn: day(dpiaRow.reviewDueOn) } : null,
    dpiaRow,
    siteBasis: rules?.monitoringBasis && rules.monitoringReference ? { kind: rules.monitoringBasis as MonitoringBasis, reference: rules.monitoringReference } : null,
    scanSubject: scanSubjectOf(rules as { scanSubject: ScanSubject } | null),
    today: businessDate(now),
  }
}

const dpiaViewOf = (row: DpiaRow) => ({
  id: row.id,
  versionNo: row.versionNo,
  status: row.status,
  scope: row.scope,
  signedByName: row.signedByName,
  signedOn: day(row.signedOn),
  reviewDueOn: day(row.reviewDueOn),
})

/** The gate rows as answers show them (notices, DPIAs and office names read once for all). */
async function gateViews(db: Db, rows: readonly GateRecord[]) {
  if (rows.length === 0) return new Map<string, ReturnType<typeof gateViewOf>>()
  const notices = await db.privacyNotice.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.noticeId))] } }, select: { id: true, label: true, status: true } })
  const dpias = await db.privacyDpia.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.dpiaId))] } }, select: DPIA_SELECT })
  const userIds = [...new Set(rows.flatMap((row) => [row.switchedOnById, row.switchedOffById]).filter((value): value is string => value !== null))]
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
  const noticeById = new Map(notices.map((row) => [row.id, row]))
  const dpiaById = new Map(dpias.map((row) => [row.id, row]))
  const nameById = new Map(users.map((row) => [row.id, row.displayName]))
  return new Map(rows.map((row) => [row.id, gateViewOf(row, noticeById.get(row.noticeId)!, dpiaById.get(row.dpiaId)!, nameById)]))
}

function gateViewOf(row: GateRecord, notice: { id: string; label: string; status: string }, dpia: DpiaRow, names: ReadonlyMap<string, string>) {
  return {
    id: row.id,
    purpose: row.purpose as GatePurpose,
    basis: recordedBasisOf(row),
    basisCoversLeads: row.basisCoversLeads,
    leadsSeeFigures: row.leadsSeeFigures,
    notice: { id: notice.id, label: notice.label, status: notice.status },
    dpia: dpiaViewOf(dpia),
    switchedOnAt: toUtcIso(row.switchedOnAt),
    switchedOnByName: names.get(row.switchedOnById) ?? null,
    switchedOffAt: row.switchedOffAt ? toUtcIso(row.switchedOffAt) : null,
    switchedOffByName: row.switchedOffById ? (names.get(row.switchedOffById) ?? null) : null,
    switchOffReason: row.switchOffReason,
    version: row.version,
  }
}

/** Both purposes of one site: the gate in force (or off), what switching on needs, what changed since. */
async function purposesOf(db: Db, site: SiteRow, inForce: ReadonlyMap<GatePurpose, GateRecord>, now: Date) {
  const views = await gateViews(db, [...inForce.values()])
  const answer = []
  for (const purpose of GATE_PURPOSES) {
    const facts = await gateFactsFor(db, site, purpose, now)
    const gate = inForce.get(purpose) ?? null
    answer.push({
      purpose,
      words: `${GATE_PURPOSE_WORDS[purpose][0]!.toUpperCase()}${GATE_PURPOSE_WORDS[purpose].slice(1)}.`,
      law: GATE_LAW[purpose],
      open: gate !== null,
      gate: gate ? views.get(gate.id)! : null,
      readiness: gateReadiness(facts),
      notes: gate
        ? gateDriftNotes({
            purpose,
            recordedNoticeId: gate.noticeId,
            recordedDpiaId: gate.dpiaId,
            recordedBasis: recordedBasisOf(gate),
            workerNoticeInForceId: facts.workerNotice?.id ?? null,
            dpiaInForceId: facts.dpia?.id ?? null,
            siteBasis: facts.siteBasis,
          })
        : [],
    })
  }
  return answer
}

async function siteDetailOf(db: Db, site: SiteRow, now: Date): Promise<SiteDetail> {
  const facts = await gateFactsFor(db, site, 'PERFORMANCE', now)
  const inForce = (await legalGatesOf(db, [site.id])).get(site.id) ?? new Map<GatePurpose, GateRecord>()
  const history = await db.peopleLegalGate.findMany({ where: { siteId: site.id }, select: GATE_SELECT, orderBy: [{ switchedOnAt: 'desc' }, { id: 'desc' }] })
  const views = await gateViews(db, history)
  return {
    site,
    scanSubject: facts.scanSubject,
    siteBasis: facts.siteBasis,
    workerNotice: facts.workerNotice,
    dpia: facts.dpiaRow ? dpiaViewOf(facts.dpiaRow) : null,
    privacyPage: 'admin.privacy',
    purposes: await purposesOf(db, site, inForce, now),
    history: history.map((row) => views.get(row.id)!),
  }
}

/** people.privacy.view: every site the grants reach with both purposes, and the companies' privacy settings. */
export async function overview(caller: CommandCaller, query: { companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({
      where: { AND: [scopeWhere(actor, PEOPLE_PRIVACY_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.companyId ? { companyId: query.companyId } : {}] },
      select: SITE_SELECT,
      orderBy: [{ companyId: 'asc' }, { code: 'asc' }],
    })
    const gates = await legalGatesOf(client, sites.map((site) => site.id))
    const answer = []
    for (const site of sites) answer.push({ site, purposes: await purposesOf(client, site, gates.get(site.id) ?? new Map(), now) })
    const companies = await client.company.findMany({
      where: { AND: [scopeWhere(actor, PEOPLE_PRIVACY_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput, query.companyId ? { id: query.companyId } : {}] },
      select: COMPANY_SELECT,
      orderBy: { code: 'asc' },
    })
    const settings = []
    for (const company of companies) settings.push({ company: { id: company.id, code: company.code, name: company.tradeName ?? company.legalName }, settings: await privacySettingsFor(client, company.id) })
    return { sites: answer, companies: settings }
  })
}

/** people.privacy.view: one site's gates, what switching on needs, its DPIA record and every decision of the past. */
export async function siteDetail(caller: CommandCaller, siteId: string): Promise<SiteDetail> {
  const { site } = await siteOf(caller, siteId, PEOPLE_PRIVACY_VIEW)
  return caller.withClient((client) => siteDetailOf(client, site, serverClock.now()))
}

function refuse(problems: readonly Issue[], message: string): void {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : message, problems)
}

const gateAudit = (row: GateRecord | null) =>
  row
    ? {
        purpose: row.purpose,
        basis: row.basis,
        basisReference: row.basisReference,
        basisCoversLeads: row.basisCoversLeads,
        leadsSeeFigures: row.leadsSeeFigures,
        noticeId: row.noticeId,
        dpiaId: row.dpiaId,
        switchedOnAt: toUtcIso(row.switchedOnAt),
        switchedOffAt: row.switchedOffAt ? toUtcIso(row.switchedOffAt) : null,
      }
    : null

const CHANGE_WORDS: Readonly<Record<Change, (purpose: GatePurpose) => string>> = {
  SWITCHED_ON: (purpose) => `From now on ${GATE_PURPOSE_WORDS[purpose]} may be recorded and read at this site, by the people the rules allow; every opening of one person's figures is recorded.`,
  SWITCHED_OFF: (purpose) => `From now on ${GATE_PURPOSE_WORDS[purpose]} is closed at this site: every read about one person is refused. Records already made keep what they recorded.`,
  LEADS_WIDENED: () => "From now on a team lead at this site may open one person's figures of their own team, with a reason; every opening is recorded.",
  LEADS_NARROWED: () => "From now on team leads at this site see team totals only; one person's figures are for the worker and HR.",
}

export interface SwitchOnBody {
  readonly basis?: { readonly kind: string; readonly reference: string } | undefined
  readonly basisCoversLeads?: boolean | undefined
  readonly leadsSeeFigures?: boolean | undefined
  readonly reason: string
}

/**
 * people.privacy.manage: switches a purpose of people data on at a site (a reason and a fresh step-up, after the rules:
 * a refused switch asks for no code). Refused while the worker notice, the DPIA or (PERFORMANCE) the site's basis is
 * missing, and while the purpose is on already.
 */
export async function switchOn(caller: CommandCaller, siteId: string, purpose: GatePurpose, body: SwitchOnBody, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined }): Promise<ChangeResult> {
  const { context, site } = await siteOf(caller, siteId, PEOPLE_PRIVACY_MANAGE)
  const now = serverClock.now()
  const { facts, current } = await caller.withClient(async (client) => ({ facts: await gateFactsFor(client, site, purpose, now), current: await legalGateFor(client, site.id, purpose) }))
  if (current.open) throw new ConflictError(`This purpose is on at this site already (since ${toUtcIso(current.gate!.switchedOnAt)}); switch it off first to record another basis.`)
  refuse(switchOnProblems({ facts, basis: body.basis, basisCoversLeads: body.basisCoversLeads, leadsSeeFigures: body.leadsSeeFigures, reason: body.reason }), 'This purpose cannot be switched on yet.')
  options.stepUp()
  const { result } = await command(caller, { name: 'people.switchOnPurpose', idempotencyKey: options.idempotencyKey, input: { siteId: site.id, purpose, ...body } }, async (tools) => {
    // Read again in the transaction: a notice, a DPIA or a site basis that changed since the check is never recorded.
    const inTx = await gateFactsFor(tools.tx, site, purpose, tools.now)
    const problems = switchOnProblems({ facts: inTx, basis: body.basis, basisCoversLeads: body.basisCoversLeads, leadsSeeFigures: body.leadsSeeFigures, reason: body.reason })
    if (problems.length > 0 || inTx.workerNotice?.id !== facts.workerNotice?.id || inTx.dpia?.id !== facts.dpia?.id) {
      throw new ConflictError('What this purpose rests on just changed (the worker notice, the impact assessment or the site basis); reload and switch it on again.')
    }
    const basis = basisForSwitchOn({ facts: inTx, basis: body.basis })!
    const id = newId()
    const { count } = await tools.tx.peopleLegalGate.createMany({
      data: [
        {
          id,
          companyId: site.companyId,
          siteId: site.id,
          purpose,
          basis: basis.kind,
          basisReference: basis.reference,
          basisCoversLeads: body.basisCoversLeads ?? false,
          leadsSeeFigures: body.leadsSeeFigures ?? false,
          noticeId: inTx.workerNotice!.id,
          dpiaId: inTx.dpia!.id,
          switchedOnAt: tools.now,
          switchedOnById: context.actorId,
          createdById: context.actorId,
        },
      ],
      skipDuplicates: true,
    })
    if (count !== 1) throw new ConflictError('This purpose was just switched on at this site by someone else; reload it.')
    const after = (await tools.tx.peopleLegalGate.findUnique({ where: { id }, select: GATE_SELECT }))!
    tools.audit({ action: 'people.switchOnPurpose', recordType: 'PeopleLegalGate', recordId: id, companyId: site.companyId, siteId: site.id, before: null, after: gateAudit(after), reason: body.reason.trim() })
    tools.emit({
      type: 'legal_gate.changed',
      subject: id,
      companyId: site.companyId,
      siteId: site.id,
      payload: { gateId: id, siteId: site.id, purpose, change: 'SWITCHED_ON', open: true, leadsSeeFigures: after.leadsSeeFigures },
    })
    return { ...(await siteDetailOf(tools.tx, site, tools.now)), change: 'SWITCHED_ON' as const, changed: true, words: [CHANGE_WORDS.SWITCHED_ON(purpose)] }
  })
  return result
}

/** The gate in force of a site and purpose, at the version the caller read (404 when off, 409 when stale). */
async function gateInForce(caller: CommandCaller, site: SiteRow, purpose: GatePurpose): Promise<GateRecord> {
  const { gate } = await caller.withClient((client) => legalGateFor(client, site.id, purpose))
  if (!gate) throw new NotFoundError('This purpose is switched off at this site.')
  return gate
}

/** people.privacy.manage: switches a purpose off at a site (a reason; never a step-up). The row is final. */
export async function switchOff(caller: CommandCaller, siteId: string, purpose: GatePurpose, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<ChangeResult> {
  const { context, site } = await siteOf(caller, siteId, PEOPLE_PRIVACY_MANAGE)
  refuse(switchOffProblems(body.reason), 'Say why this purpose closes.')
  const gate = await gateInForce(caller, site, purpose)
  const { result } = await command(
    caller,
    { name: 'people.switchOffPurpose', idempotencyKey, input: { siteId: site.id, purpose, ...body }, record: { type: 'PeopleLegalGate', id: gate.id, expectedVersion: body.version } },
    async (tools) => {
      const before = (await tools.tx.peopleLegalGate.findUnique({ where: { id: gate.id }, select: GATE_SELECT }))!
      if (before.switchedOffAt !== null) throw new ConflictError('This purpose was just switched off at this site; reload it.')
      // A decision dated later than now (an import, a clock ahead) closes from that moment on, not before (the database's rule too).
      if (before.switchedOnAt.getTime() > tools.now.getTime()) {
        throw new ConflictError(`This purpose was switched on with a later date (${toUtcIso(before.switchedOnAt)}); it can be switched off from then on.`)
      }
      // B-W2b-34: piece pay at this site needs the PERFORMANCE gate; its switch goes off here, in this same command.
      await tools.tx.peopleLegalGate.update({ where: { id: gate.id }, data: { switchedOffAt: tools.now, switchedOffById: context.actorId, switchOffReason: body.reason.trim() }, select: { id: true } })
      const after = (await tools.tx.peopleLegalGate.findUnique({ where: { id: gate.id }, select: GATE_SELECT }))!
      tools.audit({ action: 'people.switchOffPurpose', recordType: 'PeopleLegalGate', recordId: gate.id, companyId: site.companyId, siteId: site.id, before: gateAudit(before), after: gateAudit(after), reason: body.reason.trim() })
      tools.emit({
        type: 'legal_gate.changed',
        subject: gate.id,
        companyId: site.companyId,
        siteId: site.id,
        payload: { gateId: gate.id, siteId: site.id, purpose, change: 'SWITCHED_OFF', open: false, leadsSeeFigures: false },
      })
      return { ...(await siteDetailOf(tools.tx, site, tools.now)), change: 'SWITCHED_OFF' as const, changed: true, words: [CHANGE_WORDS.SWITCHED_OFF(purpose)] }
    },
  )
  return result
}

/**
 * people.privacy.manage: whether team leads at the site see one person's figures. Widening needs the recorded basis to
 * cover leads, a reason and a fresh step-up; narrowing never asks. The same choice again changes nothing.
 */
export async function changeLeads(
  caller: CommandCaller,
  siteId: string,
  purpose: GatePurpose,
  body: { readonly version: number; readonly leadsSeeFigures: boolean; readonly reason?: string | null | undefined },
  options: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined },
): Promise<ChangeResult> {
  const { site } = await siteOf(caller, siteId, PEOPLE_PRIVACY_MANAGE)
  const { gate } = await caller.withClient((client) => legalGateFor(client, site.id, purpose))
  refuse(leadsChangeProblems({ gate: gate ? { ...gate, purpose: gate.purpose as GatePurpose, basis: gate.basis as MonitoringBasis } : null, leadsSeeFigures: body.leadsSeeFigures, reason: body.reason }), 'Leads cannot change this way.')
  const change = leadsChangeOf(gate!.leadsSeeFigures, body.leadsSeeFigures)
  if (change === 'NONE') return { ...(await caller.withClient((client) => siteDetailOf(client, site, serverClock.now()))), change: null, changed: false, words: [] }
  if (change === 'WIDEN') options.stepUp()
  const eventChange: Change = change === 'WIDEN' ? 'LEADS_WIDENED' : 'LEADS_NARROWED'
  const { result } = await command(
    caller,
    { name: 'people.changePurposeLeads', idempotencyKey: options.idempotencyKey, input: { siteId: site.id, purpose, ...body }, record: { type: 'PeopleLegalGate', id: gate!.id, expectedVersion: body.version } },
    async (tools) => {
      const before = (await tools.tx.peopleLegalGate.findUnique({ where: { id: gate!.id }, select: GATE_SELECT }))!
      if (before.switchedOffAt !== null || before.leadsSeeFigures !== gate!.leadsSeeFigures) throw new ConflictError('This purpose just changed at this site; reload it.')
      await tools.tx.peopleLegalGate.update({ where: { id: gate!.id }, data: { leadsSeeFigures: body.leadsSeeFigures }, select: { id: true } })
      const after = (await tools.tx.peopleLegalGate.findUnique({ where: { id: gate!.id }, select: GATE_SELECT }))!
      const reason = trimmed(body.reason)
      tools.audit({
        action: 'people.changePurposeLeads',
        recordType: 'PeopleLegalGate',
        recordId: gate!.id,
        companyId: site.companyId,
        siteId: site.id,
        before: gateAudit(before),
        after: gateAudit(after),
        ...(reason ? { reason } : {}),
      })
      tools.emit({
        type: 'legal_gate.changed',
        subject: gate!.id,
        companyId: site.companyId,
        siteId: site.id,
        payload: { gateId: gate!.id, siteId: site.id, purpose, change: eventChange, open: true, leadsSeeFigures: body.leadsSeeFigures },
      })
      return { ...(await siteDetailOf(tools.tx, site, tools.now)), change: eventChange, changed: true, words: [CHANGE_WORDS[eventChange](purpose)] }
    },
  )
  return result
}

/** The office roles of the tenant (the keys People settings may name). */
async function officeRoles(db: Db) {
  return db.role.findMany({ where: { audience: 'OFFICE' }, select: { key: true, name: true, system: true, audience: true }, orderBy: [{ system: 'desc' }, { key: 'asc' }] })
}

async function companySettingsOf(db: Db, company: { id: string; code: string; name: string }) {
  const settings = await privacySettingsFor(db, company.id)
  const roles = await officeRoles(db)
  const nameByKey = new Map(roles.map((role) => [role.key, role.name]))
  return {
    company,
    settings,
    named: settings.figureRoleKeys.map((key) => ({ key, name: nameByKey.get(key) ?? null })),
    roles: roles.map((role) => ({ key: role.key, name: role.name, system: role.system })),
  }
}

/** people.privacy.view: a company's minimum group size and the roles that see one person's figures, with the choices. */
export async function companySettings(caller: CommandCaller, companyId: string) {
  const { company } = await companyOf(caller, companyId, PEOPLE_PRIVACY_VIEW)
  return caller.withClient((client) => companySettingsOf(client, company))
}

export interface SettingsBody {
  readonly minimumGroupSize: number
  readonly figureRoleKeys: readonly string[]
  readonly reason?: string | null | undefined
  readonly version?: number | undefined
}

/**
 * people.privacy.manage: the company's minimum group size and the roles that see one person's figures. Lowering the
 * size or naming a role not named before widens (a reason and a fresh step-up); raising or removing never asks. ONE
 * command on the company's People settings row (made the first time with the other defaults); the same again changes
 * nothing.
 */
export async function changeSettings(caller: CommandCaller, companyId: string, body: SettingsBody, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined }) {
  const { context, company } = await companyOf(caller, companyId, PEOPLE_PRIVACY_MANAGE)
  const keys = [...body.figureRoleKeys]
  const { before, roles, exists } = await caller.withClient(async (client) => ({
    before: await privacySettingsFor(client, company.id),
    roles: await officeRoles(client),
    exists: (await client.peopleSettings.findUnique({ where: { id: company.id }, select: { id: true } })) !== null,
  }))
  if (!exists && body.version !== undefined) throw new NotFoundError('This company has no People settings yet; save without a version.')
  const groupChange = minimumGroupChangeOf(before.minimumGroupSize, body.minimumGroupSize)
  const rolesChange = figureRolesChangeOf(before.figureRoleKeys, keys)
  const widens = groupChange === 'WIDEN' || rolesChange === 'WIDEN'
  refuse(
    [
      ...minimumGroupProblems(body.minimumGroupSize),
      ...figureRoleKeysProblems(keys, roles.map((role) => ({ key: role.key, audience: role.audience }))),
      ...(widens ? reasonProblems(body.reason, "Say why smaller groups, or more people, may see people figures.") : []),
    ],
    'The privacy settings are not valid.',
  )
  if (groupChange === 'NONE' && rolesChange === 'NONE') return { ...(await caller.withClient((client) => companySettingsOf(client, company))), changed: false, words: [] }
  if (widens) options.stepUp()
  const { result } = await command(
    caller,
    {
      name: 'people.changePrivacySettings',
      idempotencyKey: options.idempotencyKey,
      input: { companyId: company.id, ...body },
      ...(exists ? { record: { type: 'PeopleSettings' as const, id: company.id, expectedVersion: body.version } } : {}),
    },
    async (tools) => {
      const inTx = await privacySettingsFor(tools.tx, company.id)
      if (inTx.minimumGroupSize !== before.minimumGroupSize || figureRolesChangeOf(before.figureRoleKeys, inTx.figureRoleKeys) !== 'NONE') {
        throw new ConflictError('The privacy settings of this company just changed; reload them and save again.')
      }
      if (exists) {
        await tools.tx.peopleSettings.update({ where: { id: company.id }, data: { minimumGroupSize: body.minimumGroupSize, figureRoleKeys: keys }, select: { id: true } })
      } else {
        const { count } = await tools.tx.peopleSettings.createMany({
          data: [{ id: company.id, companyId: company.id, minimumGroupSize: body.minimumGroupSize, figureRoleKeys: keys, createdById: context.actorId }],
          skipDuplicates: true,
        })
        if (count !== 1) throw new ConflictError('The People settings of this company were just saved by someone else; reload them and save again.')
      }
      const reason = trimmed(body.reason)
      tools.audit({
        action: 'people.changePrivacySettings',
        recordType: 'PeopleSettings',
        recordId: company.id,
        companyId: company.id,
        before: { minimumGroupSize: before.minimumGroupSize, figureRoleKeys: before.figureRoleKeys },
        after: { minimumGroupSize: body.minimumGroupSize, figureRoleKeys: keys },
        ...(reason ? { reason } : {}),
      })
      tools.emit({
        type: 'people_settings.privacy_changed',
        subject: company.id,
        companyId: company.id,
        payload: { companyId: company.id, minimumGroupSize: body.minimumGroupSize, figureRoleCount: keys.length, change: widens ? 'WIDENED' : 'NARROWED' },
      })
      const words = [
        ...(groupChange === 'NONE' ? [] : [`From now on a group of fewer than ${body.minimumGroupSize} people shows '—' instead of its figures.`]),
        ...(rolesChange === 'NONE'
          ? []
          : [keys.length === 0 ? "From now on nobody but the worker sees one person's figures." : `From now on one person's figures are seen by the worker and by: ${keys.join(', ')} (where the site's gate is open).`]),
      ]
      return { ...(await companySettingsOf(tools.tx, company)), changed: true, words }
    },
  )
  return result
}

/** people.privacy.view: the people data rules (purposes, facts, a person decides) and each site's switches. */
export async function rules(caller: CommandCaller) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({ where: scopeWhere(actor, PEOPLE_PRIVACY_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, select: SITE_SELECT, orderBy: [{ companyId: 'asc' }, { code: 'asc' }] })
    const gates = await legalGatesOf(client, sites.map((site) => site.id))
    return {
      purposes: purposesInOrder().map(({ purpose, rule }) => ({ purpose, words: rule.words, law: rule.law, gate: rule.gate, note: rule.note, floor: rule.floor })),
      gateLaw: { ATTENDANCE: GATE_LAW.ATTENDANCE, PERFORMANCE: GATE_LAW.PERFORMANCE },
      facts: peopleDataFacts(),
      automatedDecisions: [...AUTOMATED_DECISIONS],
      informationPackDue: informationPackDue(),
      sites: sites.map((site) => ({ site, open: GATE_PURPOSES.filter((purpose) => gates.get(site.id)?.has(purpose)) })),
    }
  })
}

const reaches = (grants: readonly Grant[], place: { companyId: string; siteId: string }): boolean =>
  grants.some((grant) => (grant.companies === 'all' || grant.companies.includes(place.companyId)) && (grant.sites === 'all' || grant.sites.includes(place.siteId)))

/**
 * Any office person: what a People page shows them for a site and a purpose, before anything is read (design
 * PrivacyNote "What you see here"): groups only, or one person on request (a role People settings name, with
 * people.figures.view there), the gate's state and the minimum group size. A site none of their roles reach is 404.
 */
export async function sight(caller: CommandCaller, query: { readonly siteId: string; readonly purpose: GatePurpose }) {
  const context = officeContextOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const site = await client.site.findUnique({ where: { id: query.siteId }, select: SITE_SELECT })
    if (!site || !reaches(context.grants, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
    const { gate } = await legalGateFor(client, site.id, query.purpose)
    const settings = await privacySettingsFor(client, site.companyId)
    const place = { companyId: site.companyId, siteId: site.id }
    const mayOpen = can(actorOf(context), PEOPLE_FIGURES_VIEW, place)
    const figureRole = mayOpen && (await holdsFigureRole(client, context.actorId, settings.figureRoleKeys, place, now))
    const level = gate !== null && figureRole ? ('ONE_PERSON_ON_REQUEST' as const) : ('GROUPS_ONLY' as const)
    const leadsSeeFigures = gate !== null && gate.basisCoversLeads && gate.leadsSeeFigures
    return {
      siteId: site.id,
      purpose: query.purpose,
      open: gate !== null,
      level,
      minimumGroupSize: settings.minimumGroupSize,
      leadsSeeFigures,
      words: sightWords({ purpose: query.purpose, gateOpen: gate !== null, level, minimumGroup: settings.minimumGroupSize, leadsSeeFigures }),
    }
  })
}
