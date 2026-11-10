import type { Prisma } from '@nexus/factory-db'
import {
  IMPORTED_OFF_REASON,
  ruleFromRow,
  ruleRecordValues,
  substanceFromRow,
  substanceRecordValues,
  substanceRulesImporter,
  substancesImporter,
  type ImportedRule,
  type ImportedSubstance,
} from '@nexus/factory-domain/compliance/substances/importer'
import { SUBSTANCES_MANAGE, SUBSTANCES_VIEW } from '@nexus/factory-domain/compliance/substances/permissions'
import { looksLikeCas, ruleProblems, substanceProblems, type EvidenceKind, type LimitBound, type RuleCode, type RuleSource, type SubstanceList, type SubstanceStatus, type SubstanceUnit } from '@nexus/factory-domain/compliance/substances/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists these adapters, so a value import back from it would be a cycle.
import type { ImportAdapter } from '../../../platform/imports/registry'
import { mayWrite } from '../../product/materials/store'
import { RULE_SELECT, SUBSTANCE_SELECT, type RuleRow, type SubstanceRow } from './store'

/**
 * The substance list's import adapters (platform/imports; B-W2b-250, PRD-318; design compliance.tests › Substance list
 * "Yearly AFIRM import through the import flow (dry run first)"): factory-domain's `substancesImporter` and
 * `substanceRulesImporter` decide what each row does in the dry run; these load the records the keys find (a substance by
 * its CAS number or family name, a rule by its key), check what a row names (the Candidate List version of a day, the
 * substance a rule restricts, the brand), and write one planned row inside the batch's command, audited, with
 * `compliance_substances.substance_changed` / `rule_changed` (by IMPORT). Writing needs compliance.substances.manage,
 * seeing the plans compliance.certificates.view; a job for every company needs compliance.substances.manage over every
 * company.
 */

class ImportRowRefused extends ApiError {
  constructor(what: string, detail: string) {
    super('conflict', `The import row for ${what} no longer fits: ${detail}. Run the dry run again.`)
  }
}

const day = (value: Date): string => value.toISOString().slice(0, 10)
const dateOf = (value: string): Date => new Date(`${value}T00:00:00.000Z`)
const authorizeTenantWide = (what: string) => (actor: Parameters<NonNullable<ImportAdapter['authorize']>>[0], job: { readonly companyId: string | null }) =>
  job.companyId === null && !mayWrite(actor, SUBSTANCES_MANAGE, null)
    ? [{ path: 'companyId', message: `An import of ${what} for every company needs compliance.substances.manage over every company; import for one company instead.` }]
    : []

// ==== substances =====================================================================================================

/** The Candidate List version of a day: its id; null when the day is before every recorded version (added before them); undefined: none of that day. */
async function versionOfDay(tx: CommandTx, value: string): Promise<string | null | undefined> {
  const publishedOn = dateOf(value)
  const exact = await tx.svhcListVersion.findFirst({ where: { publishedOn }, select: { id: true } })
  if (exact) return exact.id
  const earlier = await tx.svhcListVersion.findFirst({ where: { publishedOn: { lte: publishedOn } }, select: { id: true } })
  return earlier ? undefined : null
}

/** The substance an identifier finds: by CAS number, or a family (no CAS) by its name; the ACTIVE one first. */
async function substanceByIdentifier(tx: CommandTx, identifier: string): Promise<SubstanceRow | null> {
  const text = identifier.trim()
  const where: Prisma.RestrictedSubstanceWhereInput = looksLikeCas(text) ? { casNumber: text } : { casNumber: null, name: { equals: text, mode: 'insensitive' } }
  return tx.restrictedSubstance.findFirst({ where, select: SUBSTANCE_SELECT, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }] })
}

function importedSubstance(row: SubstanceRow, versionDay: string | null): Omit<ImportedSubstance, 'status' | 'foreign'> {
  return {
    casNumber: row.casNumber,
    ecNumber: row.ecNumber,
    name: row.name,
    nameI18n: (row.nameI18n as Record<string, string> | null) ?? null,
    groupCode: row.groupCode,
    lists: [...row.lists] as SubstanceList[],
    annexXviiEntries: [...row.annexXviiEntries],
    svhcAddedOn: versionDay,
    note: row.note,
  }
}

async function versionDayOf(tx: CommandTx, versionId: string | null): Promise<string | null> {
  if (!versionId) return null
  const version = await tx.svhcListVersion.findUnique({ where: { id: versionId }, select: { publishedOn: true } })
  return version ? day(version.publishedOn) : null
}

export const substancesImportAdapter = Object.freeze({
  importer: substancesImporter,
  permission: SUBSTANCES_MANAGE,
  viewPermission: SUBSTANCES_VIEW,
  authorize: authorizeTenantWide('the substance list'),

  async check(client, rows) {
    const out: { column?: string; message: string }[][] = []
    for (const row of rows) {
      const issues: { column?: string; message: string }[] = []
      const added = row.values.svhcAddedOn
      if (typeof added === 'string' && (await versionOfDay(client, added)) === undefined) {
        issues.push({ column: 'svhcAddedOn', message: `No Candidate List version of ${added} is recorded: record it first (Substance list › Candidate List versions).` })
      }
      out.push(issues)
    }
    return out
  },

  async load(client, keys, scope) {
    const found = []
    for (const key of keys) {
      const asked = String(key.identifier)
      const row = await substanceByIdentifier(client, asked)
      if (!row) continue
      const record: ImportedSubstance = { ...importedSubstance(row, await versionDayOf(client, row.svhcListVersionId)), status: row.status as SubstanceStatus, foreign: row.companyId !== scope.companyId }
      // The engine finds a record by its key as the sheet wrote it.
      found.push({ id: row.id, values: { ...substanceRecordValues(record), identifier: asked } })
    }
    return found
  },

  async write(tools, row, scope) {
    const { tx, now } = tools
    const what = String(row.key.identifier)
    const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
    const added = row.values.svhcAddedOn
    const versionId = typeof added === 'string' ? await versionOfDay(tx, added) : undefined
    if (typeof added === 'string' && versionId === undefined) throw new ImportRowRefused(what, `no Candidate List version of ${added} is recorded`)

    if (row.action === 'CREATE') {
      const fields = substanceFromRow(row.values, null)
      const data = { ...fields, svhcListVersionId: versionId ?? null }
      const problems = substanceProblems(data)
      if (problems.length > 0) throw new ImportRowRefused(what, problems.map((issue) => issue.message).join(' '))
      const twin = await substanceByIdentifier(tx, what)
      if (twin && twin.status === 'ACTIVE') throw new ImportRowRefused(what, 'the substance was added since')
      const id = newId()
      const created = await tx.restrictedSubstance.create({
        data: {
          id,
          companyId: scope.companyId,
          casNumber: fields.casNumber,
          ecNumber: fields.ecNumber,
          name: fields.name,
          nameI18n: fields.nameI18n ?? undefined,
          groupCode: fields.groupCode,
          lists: [...fields.lists],
          annexXviiEntries: [...fields.annexXviiEntries],
          svhcListVersionId: versionId ?? null,
          note: fields.note,
          createdAt: now,
          updatedAt: now,
          createdById: actorId,
        },
        select: SUBSTANCE_SELECT,
      })
      tools.audit({ action: 'compliance.substances.import', recordType: 'RestrictedSubstance', recordId: id, companyId: scope.companyId, after: { ...fields, svhcListVersionId: created.svhcListVersionId } })
      tools.emit({ type: 'compliance_substances.substance_changed', subject: id, companyId: scope.companyId, payload: { substanceId: id, casNumber: created.casNumber, groupCode: created.groupCode, change: 'CREATED', by: 'IMPORT' } })
      return { recordId: id }
    }

    const recordId = row.recordId!
    // The row FOR UPDATE: the list's own writes compare and set its version under the same lock.
    await tx.$queryRaw`SELECT "id" FROM "RestrictedSubstance" WHERE "id" = ${recordId}::uuid FOR UPDATE`
    const current = await tx.restrictedSubstance.findUniqueOrThrow({ where: { id: recordId }, select: SUBSTANCE_SELECT })
    if (current.status !== 'ACTIVE' || current.companyId !== scope.companyId) throw new ImportRowRefused(what, 'it was archived or belongs to another company')
    const before = importedSubstance(current, await versionDayOf(tx, current.svhcListVersionId))
    const next = substanceFromRow(row.values, before)
    const svhcListVersionId = typeof added === 'string' ? (versionId ?? null) : current.svhcListVersionId
    const problems = substanceProblems({ ...next, svhcListVersionId })
    if (current.ecNumber !== null && next.ecNumber !== current.ecNumber) problems.push({ path: 'ecNumber', message: 'the EC number is given once' })
    if (problems.length > 0) throw new ImportRowRefused(what, problems.map((issue) => issue.message).join(' '))
    await tx.restrictedSubstance.update({
      where: { id: recordId },
      data: {
        ecNumber: next.ecNumber,
        name: next.name,
        // An import never clears a JSON column (a blank cell is "not given"): set only when there are words.
        ...(next.nameI18n !== null ? { nameI18n: next.nameI18n } : {}),
        groupCode: next.groupCode,
        lists: [...next.lists],
        annexXviiEntries: [...next.annexXviiEntries],
        svhcListVersionId,
        note: next.note,
        version: { increment: 1 },
        updatedAt: now,
      },
      select: { id: true },
    })
    tools.audit({ action: 'compliance.substances.import', recordType: 'RestrictedSubstance', recordId, companyId: current.companyId, before: { ...before, svhcListVersionId: current.svhcListVersionId }, after: { ...next, svhcListVersionId } })
    tools.emit({ type: 'compliance_substances.substance_changed', subject: recordId, companyId: current.companyId, payload: { substanceId: recordId, casNumber: current.casNumber, groupCode: next.groupCode, change: 'EDITED', by: 'IMPORT' } })
    return { recordId }
  },
} satisfies ImportAdapter)

// ==== rules ==========================================================================================================

/** The substance a rule names by CAS number or family name, ACTIVE, of the job's company or tenant-wide. */
async function ruleSubstance(tx: CommandTx, named: string, companyId: string | null): Promise<{ id: string } | null> {
  const row = await substanceByIdentifier(tx, named)
  if (!row || row.status !== 'ACTIVE' || (row.companyId !== null && row.companyId !== companyId)) return null
  return { id: row.id }
}

const partyByCode = (tx: CommandTx, code: string) => tx.party.findFirst({ where: { code: { equals: code, mode: 'insensitive' } }, select: { id: true, code: true } })

async function importedRule(tx: CommandTx, row: RuleRow): Promise<ImportedRule> {
  const substance = row.substanceId ? await tx.restrictedSubstance.findUnique({ where: { id: row.substanceId }, select: { casNumber: true, name: true } }) : null
  const party = row.customerPartyId ? await tx.party.findUnique({ where: { id: row.customerPartyId }, select: { code: true } }) : null
  return {
    key: row.key,
    code: row.code as RuleCode,
    name: row.name,
    nameI18n: (row.nameI18n as Record<string, string> | null) ?? null,
    substance: substance ? (substance.casNumber ?? substance.name) : null,
    substanceGroup: row.substanceGroup,
    materialKinds: [...row.materialKinds],
    productTypes: [...row.productTypes],
    marketCodes: [...row.marketCodes],
    scopeNote: row.scopeNote,
    limitValue: row.limitValue === null ? null : row.limitValue.toFixed(),
    limitUnit: row.limitUnit as SubstanceUnit | null,
    limitBound: row.limitBound as LimitBound | null,
    testMethod: row.testMethod,
    evidence: row.evidence as EvidenceKind,
    exemptPpe: row.exemptPpe,
    exemptNaturalLeather: row.exemptNaturalLeather,
    source: row.source as RuleSource,
    customer: party?.code ?? null,
    legalReference: row.legalReference,
    legalUrl: row.legalUrl,
    note: row.note,
  }
}

/** The columns of a rule as the database takes them (the substance and brand by id). */
function ruleData(rule: ImportedRule, substanceId: string | null, customerPartyId: string | null) {
  return {
    code: rule.code,
    name: rule.name,
    // An import never clears a JSON column (a blank cell is "not given"): set only when there are words.
    ...(rule.nameI18n !== null ? { nameI18n: rule.nameI18n } : {}),
    substanceId,
    substanceGroup: rule.substance ? null : rule.substanceGroup,
    materialKinds: [...rule.materialKinds] as Prisma.SubstanceRuleCreateInput['materialKinds'],
    productTypes: [...rule.productTypes] as Prisma.SubstanceRuleCreateInput['productTypes'],
    marketCodes: [...rule.marketCodes],
    scopeNote: rule.scopeNote,
    limitValue: rule.limitValue,
    limitUnit: rule.limitUnit,
    limitBound: rule.limitBound,
    testMethod: rule.testMethod,
    evidence: rule.evidence,
    exemptPpe: rule.exemptPpe,
    exemptNaturalLeather: rule.exemptNaturalLeather,
    source: rule.source,
    customerPartyId,
    legalReference: rule.legalReference,
    legalUrl: rule.legalUrl,
    note: rule.note,
  }
}

export const substanceRulesImportAdapter = Object.freeze({
  importer: substanceRulesImporter,
  permission: SUBSTANCES_MANAGE,
  viewPermission: SUBSTANCES_VIEW,
  authorize: authorizeTenantWide('substance rules'),

  async check(client, rows, scope) {
    const out: { column?: string; message: string }[][] = []
    for (const row of rows) {
      const issues: { column?: string; message: string }[] = []
      const substance = row.values.substance
      if (typeof substance === 'string' && !(await ruleSubstance(client, substance, scope.companyId))) {
        issues.push({ column: 'substance', message: `No ACTIVE substance ${substance} of this company or for every company on the list: add it first.` })
      }
      const customer = row.values.customer
      if (typeof customer === 'string' && !(await partyByCode(client, customer))) issues.push({ column: 'customer', message: `No party with the code ${customer}.` })
      out.push(issues)
    }
    return out
  },

  async load(client, keys, scope) {
    const found = []
    for (const key of keys) {
      const row = await client.substanceRule.findFirst({ where: { key: String(key.key) }, select: RULE_SELECT })
      if (!row) continue
      found.push({ id: row.id, values: ruleRecordValues({ ...(await importedRule(client, row)), status: row.status as SubstanceStatus, foreign: row.companyId !== scope.companyId }) })
    }
    return found
  },

  async write(tools, row, scope) {
    const { tx, now } = tools
    const key = String(row.key.key)
    const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
    const resolve = async (rule: ImportedRule) => {
      const substance = rule.substance ? await ruleSubstance(tx, rule.substance, scope.companyId) : null
      if (rule.substance && !substance) throw new ImportRowRefused(key, `substance ${rule.substance} is no longer an ACTIVE substance of the list`)
      const party = rule.customer ? await partyByCode(tx, rule.customer) : null
      if (rule.customer && !party) throw new ImportRowRefused(key, `party ${rule.customer} is not in the address book`)
      const problems = ruleProblems({ ...rule, substanceId: substance?.id ?? null, substanceGroup: rule.substance ? null : rule.substanceGroup, customerPartyId: party?.id ?? null })
      if (problems.length > 0) throw new ImportRowRefused(key, problems.map((issue) => issue.message).join(' '))
      return ruleData(rule, substance?.id ?? null, party?.id ?? null)
    }

    if (row.action === 'CREATE') {
      const rule = ruleFromRow(row.values, null)
      const data = await resolve(rule)
      if (await tx.substanceRule.findFirst({ where: { key }, select: { id: true } })) throw new ImportRowRefused(key, 'the key was taken since')
      // A brand's RSL reaches that brand's styles only: on. Any other new rule comes in off (Owner answer 11-09, question 5 A).
      const on = rule.source === 'CUSTOMER'
      const id = newId()
      await tx.substanceRule.create({
        data: {
          id,
          companyId: scope.companyId,
          key,
          ...data,
          switchedOn: on,
          offReason: on ? null : IMPORTED_OFF_REASON,
          ...(on ? {} : { switchedAt: now, switchedById: actorId }),
          createdAt: now,
          updatedAt: now,
          createdById: actorId,
        },
        select: { id: true },
      })
      tools.audit({ action: 'compliance.substances.importRule', recordType: 'SubstanceRule', recordId: id, companyId: scope.companyId, after: { ...rule, switchedOn: on } })
      tools.emit({ type: 'compliance_substances.rule_changed', subject: id, companyId: scope.companyId, payload: { ruleId: id, key, code: rule.code, switchedOn: on, change: 'CREATED', by: 'IMPORT' } })
      return { recordId: id }
    }

    const recordId = row.recordId!
    await tx.$queryRaw`SELECT "id" FROM "SubstanceRule" WHERE "id" = ${recordId}::uuid FOR UPDATE`
    const current = await tx.substanceRule.findUniqueOrThrow({ where: { id: recordId }, select: RULE_SELECT })
    if (current.status !== 'ACTIVE' || current.companyId !== scope.companyId) throw new ImportRowRefused(key, 'it was archived or belongs to another company')
    const before = await importedRule(tx, current)
    const next = ruleFromRow(row.values, before)
    const data = await resolve(next)
    await tx.substanceRule.update({ where: { id: recordId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'compliance.substances.importRule', recordType: 'SubstanceRule', recordId, companyId: current.companyId, before, after: next })
    tools.emit({ type: 'compliance_substances.rule_changed', subject: recordId, companyId: current.companyId, payload: { ruleId: recordId, key, code: next.code, switchedOn: current.switchedOn, change: 'EDITED', by: 'IMPORT' } })
    return { recordId }
  },
} satisfies ImportAdapter)
