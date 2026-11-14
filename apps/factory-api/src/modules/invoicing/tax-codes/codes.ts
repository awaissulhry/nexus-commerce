import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { INVOICES_TAX_MANAGE, INVOICES_TAX_SWITCH } from '@nexus/factory-domain/invoicing/tax-codes/permissions'
import { SWITCH_WORDS } from '@nexus/factory-domain/invoicing/tax-codes/switches'
import {
  codeActions,
  codesInForce,
  codeStateOf,
  dayBefore,
  DOCUMENT_COUNTRY,
  nextVersionProblem,
  overlappingVersion,
  taxCodeProblems,
  treatmentOfCode,
  treatmentWords,
  type TaxCodeFacts,
  type TaxCodeInput,
} from '@nexus/factory-domain/invoicing/tax-codes/tax-codes'
import { ruleStatusFromCodes, TAX_RULES, type TaxRuleId } from '@nexus/factory-domain/tax/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { officeContextOf, type Reader } from '../store'
import { assertCompany, codeFactsOf, dayValue, readCodes, readSwitches, refused, refusingInWords, TAX_CODE_COLUMNS, type TaxCodeRow } from './store'

/**
 * A company's tax codes as data (B-W2b-392; FIN-107; design finance.settings "Company & tax" → the W2b tax configuration,
 * "VAT reasons and wording"): the list with each version's state, what may be done and the catalogue's rules read from
 * the codes; a new code (or version of a period no other version covers); the change of a version not yet in force (in
 * force: its label and its end only); the next version from a later day (the current one ends the day before, ONE
 * command); archive a mistake; delete a version before its first day; record the accountant's confirmation (step-up,
 * once). Each write is ONE command on the TaxCode row (its version guards it), audited, with `tax_code.changed`. The
 * factory-domain rules refuse first, in words; the …_tax_currency_w2b_guards hold the same for every login and their
 * refusals answer 409 in words. GATE-ACCOUNTANT: the codes reach invoices only while the company's tax-codes switch is on.
 */

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const rateOf = (value: string): string => {
  const [whole, part = ''] = value.trim().split('.')
  return `${whole}.${part.padEnd(2, '0')}`
}

function wordsOf(code: TaxCodeFacts, today: string): string {
  const treatment = treatmentOfCode(code)
  const what = treatment ? treatmentWords(treatment) : `${code.ratePct} %`
  const state = codeStateOf(code, today)
  const when =
    state === 'ARCHIVED'
      ? 'archived'
      : state === 'PLANNED'
        ? `from ${code.validFrom}`
        : state === 'ENDED'
          ? `ended on ${code.validTo}`
          : code.validTo
            ? `in force from ${code.validFrom} to ${code.validTo}`
            : `in force from ${code.validFrom}`
  const verified = code.verification === 'VERIFIED' ? 'confirmed' : 'waiting for the accountant'
  return `${code.country} ${code.code}: ${what}, ${when}, ${verified}.`
}

export function taxCodeView(row: TaxCodeRow, today: string) {
  const facts = codeFactsOf(row)
  return {
    ...facts,
    version: row.version,
    confirmedById: row.confirmedById,
    state: codeStateOf(facts, today),
    words: wordsOf(facts, today),
    can: codeActions(facts, today),
  }
}

async function readCode(db: Reader, taxCodeId: string): Promise<TaxCodeRow | null> {
  return isUuid(taxCodeId) ? db.taxCode.findUnique({ where: { id: taxCodeId }, select: TAX_CODE_COLUMNS }) : null
}

/** invoices.view over the company: its codes, its switch, and the catalogue's rules as its codes say. */
export async function listTaxCodes(caller: CommandCaller, query: { companyId: string }) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_VIEW, { companyId: query.companyId }, 'Company')
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    if (!(await client.company.findUnique({ where: { id: query.companyId }, select: { id: true } }))) throw refusedCompany()
    const rows = await readCodes(client, query.companyId)
    const switches = await readSwitches(client, query.companyId)
    const inForce = codesInForce(rows.map(codeFactsOf), today)
    const rules = (Object.keys(TAX_RULES) as TaxRuleId[]).map((ruleId) => {
      const rule = TAX_RULES[ruleId]
      return {
        id: ruleId,
        law: rule.law,
        summary: rule.summary,
        catalogueStatus: rule.status,
        status: ruleStatusFromCodes(ruleId, inForce),
        accountantToConfirm: 'accountantToConfirm' in rule ? rule.accountantToConfirm : null,
        taxCodeIds: inForce.filter((code) => code.ruleId === ruleId).map((code) => code.id),
      }
    })
    return {
      companyId: query.companyId,
      today,
      switches: { taxCodesOn: switches.taxCodesOn, stampDutyOn: switches.stampDutyOn, declarationsOfIntentOn: switches.declarationsOfIntentOn },
      waits: switches.taxCodesOn ? null : SWITCH_WORDS.taxCodesOn.off,
      codes: rows.map((row) => taxCodeView(row, today)),
      rules,
    }
  })
}

const refusedCompany = () => new NotFoundError('Company not found.')

function assertValid(input: TaxCodeInput, at = 'body'): void {
  const problems = taxCodeProblems(input, at)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'This tax code cannot be saved.', problems)
}

const auditOf = (facts: TaxCodeFacts) => ({ country: facts.country, code: facts.code, label: facts.label, ratePct: facts.ratePct, natura: facts.natura, legalRef: facts.legalRef, accountCodeKey: facts.accountCodeKey, ruleId: facts.ruleId, validFrom: facts.validFrom, validTo: facts.validTo, status: facts.status, verification: facts.verification })

/** The overlap the guards refuse, as a 409 in words before the write. */
async function refuseOverlap(tools: CommandTools, candidate: { id?: string; companyId: string; country: string; code: string; validFrom: string; validTo: string | null }): Promise<void> {
  const others = (await readCodes(tools.tx, candidate.companyId)).map(codeFactsOf)
  const clash = overlappingVersion(candidate, others)
  if (clash) throw refused('OVERLAP', `Code ${candidate.code} (${candidate.country}) has a version from ${clash.validFrom} to ${clash.validTo ?? 'open'}: its versions never overlap. End that one first, or start this one after it.`)
}

export interface CreateTaxCodeInput {
  readonly companyId: string
  readonly country?: string | undefined
  readonly code: string
  readonly label: string
  readonly ratePct: string
  readonly natura?: string | null | undefined
  readonly legalRef?: string | null | undefined
  readonly accountCodeKey?: string | null | undefined
  readonly ruleId?: string | null | undefined
  readonly validFrom: string
  readonly validTo?: string | null | undefined
}

/** invoices.tax.manage: a new code version (UNVERIFIED until the accountant's confirmation is recorded). */
export async function createTaxCode(caller: CommandCaller, body: CreateTaxCodeInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_TAX_MANAGE, { companyId: body.companyId }, 'Company')
  const input: TaxCodeInput = {
    country: body.country ?? DOCUMENT_COUNTRY,
    code: body.code.trim(),
    label: body.label.trim(),
    ratePct: rateOf(body.ratePct),
    natura: blankToNull(body.natura),
    legalRef: blankToNull(body.legalRef),
    accountCodeKey: blankToNull(body.accountCodeKey),
    ruleId: blankToNull(body.ruleId),
    validFrom: body.validFrom,
    validTo: body.validTo ?? null,
  }
  assertValid(input)
  return refusingInWords(async () => {
    const { result } = await command(caller, { name: 'invoices.createTaxCode', idempotencyKey, input: body }, async (tools) => {
      if (!(await tools.tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw refusedCompany()
      await refuseOverlap(tools, { companyId: body.companyId, ...input })
      const id = newId()
      const row = await tools.tx.taxCode.create({
        data: { id, companyId: body.companyId, ...input, validFrom: dayValue(input.validFrom), validTo: input.validTo ? dayValue(input.validTo) : null, createdById: actorIdOf(tools) },
        select: TAX_CODE_COLUMNS,
      })
      tools.audit({ action: 'invoices.createTaxCode', recordType: 'TaxCode', recordId: id, companyId: body.companyId, after: auditOf(codeFactsOf(row)) })
      tools.emit({ type: 'tax_code.changed', subject: id, companyId: body.companyId, payload: { taxCodeId: id, country: input.country, code: input.code, action: 'CREATED' } })
      return { taxCode: taxCodeView(row, businessDate(tools.now)) }
    })
    return result
  })
}

/** The code the office may see (404) and act on with `permission` (403). */
async function officeCode(caller: CommandCaller, taxCodeId: string, permission: Permission = INVOICES_TAX_MANAGE): Promise<TaxCodeRow> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => readCode(client, taxCodeId))
  assertCompany(context, INVOICES_VIEW, permission, row ? { companyId: row.companyId } : null, 'Tax code')
  return row!
}

/** A command on one TaxCode row: its version guards it and locks it. */
async function onCode<T>(caller: CommandCaller, row: TaxCodeRow, spec: { name: `invoices.${string}`; idempotencyKey: string | undefined; input: unknown; version: number }, work: (tools: CommandTools, current: TaxCodeRow) => Promise<T>): Promise<T> {
  return refusingInWords(async () => {
    const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'TaxCode', id: row.id, expectedVersion: spec.version } }, async (tools) => work(tools, (await readCode(tools.tx, row.id))!))
    return result
  })
}

export interface UpdateTaxCodeInput {
  readonly version: number
  readonly label?: string | undefined
  readonly ratePct?: string | undefined
  readonly natura?: string | null | undefined
  readonly legalRef?: string | null | undefined
  readonly accountCodeKey?: string | null | undefined
  readonly ruleId?: string | null | undefined
  readonly validFrom?: string | undefined
  readonly validTo?: string | null | undefined
}

/**
 * invoices.tax.manage: a version not yet in force changes freely; one in force changes its label and its end (not before
 * yesterday; null reopens it); an ended or archived one only its label.
 */
export async function updateTaxCode(caller: CommandCaller, taxCodeId: string, body: UpdateTaxCodeInput, idempotencyKey?: string) {
  const row = await officeCode(caller, taxCodeId)
  return onCode(caller, row, { name: 'invoices.updateTaxCode', idempotencyKey, input: { taxCodeId, ...body }, version: body.version }, async (tools, current) => {
    const today = businessDate(tools.now)
    const facts = codeFactsOf(current)
    const state = codeStateOf(facts, today)
    const next: TaxCodeInput = {
      country: facts.country,
      code: facts.code,
      label: body.label === undefined ? facts.label : body.label.trim(),
      ratePct: body.ratePct === undefined ? facts.ratePct : rateOf(body.ratePct),
      natura: body.natura === undefined ? facts.natura : blankToNull(body.natura),
      legalRef: body.legalRef === undefined ? facts.legalRef : blankToNull(body.legalRef),
      accountCodeKey: body.accountCodeKey === undefined ? facts.accountCodeKey : blankToNull(body.accountCodeKey),
      ruleId: body.ruleId === undefined ? facts.ruleId : blankToNull(body.ruleId),
      validFrom: body.validFrom ?? facts.validFrom,
      validTo: body.validTo === undefined ? facts.validTo : body.validTo,
    }
    const fixed = (['ratePct', 'natura', 'legalRef', 'accountCodeKey', 'ruleId', 'validFrom'] as const).filter((field) => next[field] !== facts[field])
    if (state !== 'PLANNED' && fixed.length > 0) {
      throw refused('IN_FORCE', `Code ${facts.code} is ${state === 'IN_FORCE' ? `in force since ${facts.validFrom}` : state === 'ENDED' ? `ended on ${facts.validTo}` : 'archived'}: a code in use is never edited (${fixed.join(', ')}). Make a new version from a later day.`)
    }
    if (next.validTo !== facts.validTo) {
      if (state === 'ENDED' || state === 'ARCHIVED') throw refused('IN_FORCE', `Code ${facts.code} ${state === 'ENDED' ? `ended on ${facts.validTo}` : 'is archived'}: its end never moves.`)
      if (state === 'IN_FORCE' && next.validTo !== null && next.validTo < dayBefore(today)) {
        throw refused('IN_FORCE', `Code ${facts.code} is in force: it ends yesterday (${dayBefore(today)}) at the earliest, so what applied to past documents stays.`)
      }
    }
    assertValid(next)
    if (facts.status === 'ACTIVE') await refuseOverlap(tools, { id: current.id, companyId: current.companyId, ...next })
    const updated = await tools.tx.taxCode.update({
      where: { id: current.id },
      data: { label: next.label, ratePct: next.ratePct, natura: next.natura, legalRef: next.legalRef, accountCodeKey: next.accountCodeKey, ruleId: next.ruleId, validFrom: dayValue(next.validFrom), validTo: next.validTo ? dayValue(next.validTo) : null },
      select: TAX_CODE_COLUMNS,
    })
    const ended = next.validTo !== facts.validTo && next.validTo !== null && state === 'IN_FORCE'
    tools.audit({ recordType: 'TaxCode', recordId: current.id, companyId: current.companyId, before: auditOf(facts), after: auditOf(codeFactsOf(updated)) })
    tools.emit({ type: 'tax_code.changed', subject: current.id, companyId: current.companyId, payload: { taxCodeId: current.id, country: facts.country, code: facts.code, action: ended ? 'ENDED' : 'EDITED' } })
    return { taxCode: taxCodeView(updated, today) }
  })
}

export interface NewVersionInput extends Omit<UpdateTaxCodeInput, 'validFrom'> {
  readonly validFrom: string
}

/** invoices.tax.manage: the next version from `validFrom`; the current one ends the day before (ONE command). */
export async function newTaxCodeVersion(caller: CommandCaller, taxCodeId: string, body: NewVersionInput, idempotencyKey?: string) {
  const row = await officeCode(caller, taxCodeId)
  return onCode(caller, row, { name: 'invoices.newTaxCodeVersion', idempotencyKey, input: { taxCodeId, ...body }, version: body.version }, async (tools, current) => {
    const today = businessDate(tools.now)
    const facts = codeFactsOf(current)
    const problem = nextVersionProblem(facts, body.validFrom, today)
    if (problem) throw refused('NEXT_VERSION', problem)
    const next: TaxCodeInput = {
      country: facts.country,
      code: facts.code,
      label: body.label === undefined ? facts.label : body.label.trim(),
      ratePct: body.ratePct === undefined ? facts.ratePct : rateOf(body.ratePct),
      natura: body.natura === undefined ? facts.natura : blankToNull(body.natura),
      legalRef: body.legalRef === undefined ? facts.legalRef : blankToNull(body.legalRef),
      accountCodeKey: body.accountCodeKey === undefined ? facts.accountCodeKey : blankToNull(body.accountCodeKey),
      ruleId: body.ruleId === undefined ? facts.ruleId : blankToNull(body.ruleId),
      validFrom: body.validFrom,
      validTo: body.validTo ?? null,
    }
    assertValid(next)
    const endDay = dayBefore(body.validFrom)
    const ended = await tools.tx.taxCode.update({ where: { id: current.id }, data: { validTo: dayValue(endDay) }, select: TAX_CODE_COLUMNS })
    await refuseOverlap(tools, { companyId: current.companyId, ...next })
    const id = newId()
    const created = await tools.tx.taxCode.create({
      data: { id, companyId: current.companyId, ...next, validFrom: dayValue(next.validFrom), validTo: next.validTo ? dayValue(next.validTo) : null, createdById: actorIdOf(tools) },
      select: TAX_CODE_COLUMNS,
    })
    tools.audit({ recordType: 'TaxCode', recordId: current.id, companyId: current.companyId, before: { validTo: facts.validTo }, after: { validTo: endDay, nextVersionId: id } })
    tools.audit({ action: 'invoices.createTaxCode', recordType: 'TaxCode', recordId: id, companyId: current.companyId, after: { ...auditOf(codeFactsOf(created)), previousVersionId: current.id } })
    tools.emit({ type: 'tax_code.changed', subject: current.id, companyId: current.companyId, payload: { taxCodeId: current.id, country: facts.country, code: facts.code, action: 'ENDED' } })
    tools.emit({ type: 'tax_code.changed', subject: id, companyId: current.companyId, payload: { taxCodeId: id, country: facts.country, code: facts.code, action: 'VERSIONED' } })
    return { ended: taxCodeView(ended, today), taxCode: taxCodeView(created, today) }
  })
}

/** invoices.tax.manage: a version made by mistake is archived (it leaves the overlap rule and every invoice check). */
export async function archiveTaxCode(caller: CommandCaller, taxCodeId: string, body: { version: number }, idempotencyKey?: string) {
  const row = await officeCode(caller, taxCodeId)
  return onCode(caller, row, { name: 'invoices.archiveTaxCode', idempotencyKey, input: { taxCodeId, ...body }, version: body.version }, async (tools, current) => {
    if (current.status === 'ARCHIVED') throw refused('ARCHIVED', `Code ${current.code} is archived already.`)
    const updated = await tools.tx.taxCode.update({ where: { id: current.id }, data: { status: 'ARCHIVED' }, select: TAX_CODE_COLUMNS })
    tools.audit({ recordType: 'TaxCode', recordId: current.id, companyId: current.companyId, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
    tools.emit({ type: 'tax_code.changed', subject: current.id, companyId: current.companyId, payload: { taxCodeId: current.id, country: current.country, code: current.code, action: 'ARCHIVED' } })
    return { taxCode: taxCodeView(updated, businessDate(tools.now)) }
  })
}

/** invoices.tax.manage: a version not yet in force is deleted (from its first day it is archived). */
export async function deleteTaxCode(caller: CommandCaller, taxCodeId: string, query: { version: number }, idempotencyKey?: string) {
  const row = await officeCode(caller, taxCodeId)
  return onCode(caller, row, { name: 'invoices.deleteTaxCode', idempotencyKey, input: { taxCodeId, ...query }, version: query.version }, async (tools, current) => {
    const facts = codeFactsOf(current)
    if (codeStateOf(facts, businessDate(tools.now)) !== 'PLANNED') throw refused('NOT_PLANNED', `Code ${current.code} applies since ${facts.validFrom}: archive it instead (only a version not yet in force is deleted).`)
    await tools.tx.taxCode.delete({ where: { id: current.id }, select: { id: true } })
    tools.audit({ recordType: 'TaxCode', recordId: current.id, companyId: current.companyId, before: auditOf(facts) })
    tools.emit({ type: 'tax_code.changed', subject: current.id, companyId: current.companyId, payload: { taxCodeId: current.id, country: current.country, code: current.code, action: 'DELETED' } })
    return { deleted: true as const, id: current.id }
  })
}

/**
 * invoices.tax.switch (step-up): records the accountant's confirmation of a version (VERIFIED, when and who, once; never
 * back). GATE-ACCOUNTANT: the rule it applies is settled for the company once each of its codes in force is confirmed.
 */
export async function confirmTaxCode(caller: CommandCaller, taxCodeId: string, body: { version: number }, idempotencyKey: string | undefined, stepUp: () => void) {
  const row = await officeCode(caller, taxCodeId, INVOICES_TAX_SWITCH)
  stepUp()
  return onCode(caller, row, { name: 'invoices.confirmTaxCode', idempotencyKey, input: { taxCodeId, ...body }, version: body.version }, async (tools, current) => {
    if (current.status === 'ARCHIVED') throw refused('ARCHIVED', `Code ${current.code} is archived: nothing to confirm.`)
    if (current.verification === 'VERIFIED') throw refused('CONFIRMED', `Code ${current.code} is confirmed already${current.confirmedAt ? ` (${current.confirmedAt.toISOString().slice(0, 10)})` : ''}.`)
    const updated = await tools.tx.taxCode.update({ where: { id: current.id }, data: { verification: 'VERIFIED', confirmedAt: tools.now, confirmedById: actorIdOf(tools) }, select: TAX_CODE_COLUMNS })
    tools.audit({ recordType: 'TaxCode', recordId: current.id, companyId: current.companyId, before: { verification: 'UNVERIFIED' }, after: { verification: 'VERIFIED' } })
    tools.emit({ type: 'tax_code.changed', subject: current.id, companyId: current.companyId, payload: { taxCodeId: current.id, country: current.country, code: current.code, action: 'CONFIRMED' } })
    return { taxCode: taxCodeView(updated, businessDate(tools.now)) }
  })
}
