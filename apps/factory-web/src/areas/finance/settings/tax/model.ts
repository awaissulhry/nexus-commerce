import { NATURA_CODES } from '@nexus/factory-domain/tax/natura'
import { TAX_RULES } from '@nexus/factory-domain/tax/rules'
import { taxCodeProblems } from '@nexus/factory-domain/invoicing/tax-codes/tax-codes'
import type { Phrase, Tone } from '../../_shared/model'
import type { CodeFields, CompanyTax, TaxCode, TaxCodeState, TaxSwitch } from './api'

/**
 * The company's tax set-up, pure (B-W2b-417; design finance.settings sec:company "Per company (W2b tax configuration:
 * rates, reason codes, effective dates)"; GATE-ACCOUNTANT): the four switches the accountant decides (tax codes, stamp duty,
 * declarations of intent; self-invoices with debit notes and the VAT time limit), the codes' rows, the code dialog's draft
 * checked as factory-domain checks it, the verbs each version allows today, and the refusals' codes (`finance-invoices-depth`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface TaxSetUpAbilities {
  view: boolean
  manage: boolean
  switch: boolean
}

export const taxSetUpAbilitiesOf = (permissions: readonly string[]): TaxSetUpAbilities => {
  const held = new Set(permissions)
  return { view: held.has('invoices.view'), manage: held.has('invoices.tax.manage'), switch: held.has('invoices.tax.switch') }
}

/** The accountant's switches: B-W2b-392's three and B-W2b-401's one (self-invoices, debit notes, the VAT time limit). */
export const SWITCHES = ['taxCodesOn', 'stampDutyOn', 'declarationsOfIntentOn', 'selfInvoicesOn'] as const
export type AnySwitch = (typeof SWITCHES)[number]

export const switchOn = (company: Pick<CompanyTax, 'switches' | 'selfInvoicesOn'>, name: AnySwitch): boolean => (name === 'selfInvoicesOn' ? company.selfInvoicesOn : company.switches[name as TaxSwitch])

/** Why a switch is held: the right, busy. */
export const switchHeld = (can: TaxSetUpAbilities, busy: boolean): Phrase | null => (!can.switch ? phrase('held.noTaxSwitch') : busy ? phrase('held.busy') : null)

export const CODE_ROWS = ['current', 'all'] as const
export type CodeRows = (typeof CODE_ROWS)[number]

/** The rows shown: in force and planned (the default), or every version (ended and archived too). */
export const codesShown = (codes: readonly TaxCode[], rows: CodeRows): TaxCode[] => (rows === 'all' ? [...codes] : codes.filter((code) => code.state === 'IN_FORCE' || code.state === 'PLANNED'))

export const STATE_TONE: Record<TaxCodeState, Tone> = { PLANNED: 'info', IN_FORCE: 'success', ENDED: 'neutral', ARCHIVED: 'neutral' }

/** The dialogs of the card: a code's form (new, edit while planned, relabel, end, next version), a verb on several, a switch. */
export type CodeForm = 'new' | 'edit' | 'relabel' | 'end' | 'version'
export type TaxDialog = { kind: 'form'; mode: CodeForm; code: TaxCode | null } | { kind: 'verb'; verb: 'archive' | 'delete' | 'confirm'; codes: TaxCode[] } | { kind: 'switch'; name: AnySwitch; on: boolean }

export interface CodeDraft {
  country: string
  code: string
  label: string
  ratePct: string
  natura: string
  legalRef: string
  accountCodeKey: string
  ruleId: string
  validFrom: string
  validTo: string
}

const decimalText = (value: string): string => value.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')

/** A form's starting draft: empty for a new code (from today), the version's values otherwise (a new version from tomorrow). */
export function codeDraftOf(mode: CodeForm, code: TaxCode | null, today: string): CodeDraft {
  if (!code || mode === 'new') return { country: 'IT', code: '', label: '', ratePct: '22', natura: '', legalRef: '', accountCodeKey: '', ruleId: '', validFrom: today, validTo: '' }
  const tomorrow = new Date(`${today}T00:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  return {
    country: code.country,
    code: code.code,
    label: code.label,
    ratePct: decimalText(code.ratePct),
    natura: code.natura ?? '',
    legalRef: code.legalRef ?? '',
    accountCodeKey: code.accountCodeKey ?? '',
    ruleId: code.ruleId ?? '',
    validFrom: mode === 'version' ? tomorrow.toISOString().slice(0, 10) : code.validFrom,
    validTo: mode === 'version' ? '' : (code.validTo ?? ''),
  }
}

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The fields a form may change (relabel: the label; end: the last day; edit, new and version: the code's values). */
export const FORM_FIELDS: Readonly<Record<CodeForm, ReadonlyArray<keyof CodeDraft>>> = {
  new: ['country', 'code', 'label', 'ratePct', 'natura', 'legalRef', 'accountCodeKey', 'ruleId', 'validFrom', 'validTo'],
  edit: ['label', 'ratePct', 'natura', 'legalRef', 'accountCodeKey', 'ruleId', 'validFrom', 'validTo'],
  version: ['label', 'ratePct', 'natura', 'legalRef', 'accountCodeKey', 'ruleId', 'validFrom', 'validTo'],
  relabel: ['label'],
  end: ['validTo'],
}

/** The draft's problems as message keys by field (factory-domain taxCodeProblems, read by path; the end's own rules). */
export function codeProblems(mode: CodeForm, draft: CodeDraft, code: TaxCode | null, today: string): Partial<Record<keyof CodeDraft, string>> {
  const out: Partial<Record<keyof CodeDraft, string>> = {}
  const shown = new Set(FORM_FIELDS[mode])
  const issues = taxCodeProblems({
    country: draft.country.trim().toUpperCase(),
    code: draft.code.trim().toUpperCase(),
    label: draft.label,
    ratePct: draft.ratePct.trim().replace(',', '.'),
    natura: blank(draft.natura),
    legalRef: blank(draft.legalRef),
    accountCodeKey: blank(draft.accountCodeKey),
    ruleId: blank(draft.ruleId),
    validFrom: draft.validFrom,
    validTo: blank(draft.validTo),
  })
  for (const issue of issues) {
    const field = issue.path.split('/').pop() as keyof CodeDraft
    if (shown.has(field)) out[field] ??= `tax.problem.${field}`
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.validFrom) && shown.has('validFrom')) out.validFrom = 'tax.problem.validFrom'
  if (mode === 'version' && code && draft.validFrom <= (code.validFrom > today ? code.validFrom : today)) out.validFrom = 'tax.problem.versionFrom'
  if (mode === 'end') {
    if (draft.validTo === '') out.validTo = 'tax.problem.endDay'
    else if (code && draft.validTo < code.validFrom) out.validTo = 'tax.problem.validTo'
  }
  return out
}

/** What the form sends (codes in capitals, the rate with a dot, blanks as null; only the fields its mode may change). */
export function codeFieldsOf(mode: CodeForm, draft: CodeDraft): CodeFields & { country?: string; code?: string } {
  if (mode === 'relabel') return { label: draft.label.trim() }
  if (mode === 'end') return { validTo: blank(draft.validTo) }
  const fields: CodeFields & { country?: string; code?: string } = {
    label: draft.label.trim(),
    ratePct: draft.ratePct.trim().replace(',', '.'),
    natura: blank(draft.natura),
    legalRef: blank(draft.legalRef),
    accountCodeKey: blank(draft.accountCodeKey),
    ruleId: blank(draft.ruleId),
    validFrom: draft.validFrom,
    validTo: blank(draft.validTo),
  }
  if (mode === 'new') {
    fields.country = draft.country.trim().toUpperCase()
    fields.code = draft.code.trim().toUpperCase()
  }
  return fields
}

/** The verbs a version allows today (the API's `can`), as the row's ⋯ shows them; a held one says why. */
export function codeVerbs(code: TaxCode, can: TaxSetUpAbilities): Array<{ id: CodeForm | 'archive' | 'delete' | 'confirm'; held: Phrase | null }> {
  const manage = can.manage ? null : phrase('held.noTaxManage')
  const verbs: Array<{ id: CodeForm | 'archive' | 'delete' | 'confirm'; held: Phrase | null }> = []
  if (code.can.edit) verbs.push({ id: 'edit', held: manage })
  else if (code.can.relabel || code.state === 'ENDED' || code.state === 'ARCHIVED') verbs.push({ id: 'relabel', held: manage })
  if (code.can.end) verbs.push({ id: 'end', held: manage })
  if (code.can.newVersion) verbs.push({ id: 'version', held: manage })
  if (code.can.confirm) verbs.push({ id: 'confirm', held: can.switch ? null : phrase('held.noTaxSwitch') })
  if (code.can.archive) verbs.push({ id: 'archive', held: manage })
  if (code.can.delete) verbs.push({ id: 'delete', held: manage })
  return verbs
}

/** Why a row may not be chosen for the bulk verbs (confirm, archive): nothing either verb could do to it. */
export const rowSelectable = (code: TaxCode, can: TaxSetUpAbilities): Phrase | null => ((code.can.confirm && can.switch) || (code.can.archive && can.manage) ? null : phrase('tax.notSelectable'))

/** The natura codes a person picks from (SDI's detailed codes). */
export const NATURA_CHOICES: readonly string[] = NATURA_CODES

/** The rules a code may follow (the catalogue's ids). */
export const RULE_CHOICES: readonly string[] = Object.keys(TAX_RULES)

/** The refusal codes of the tax set-up this step words. */
export const TAX_REFUSALS = ['DATABASE', 'SWITCH_OFF', 'IN_FORCE', 'OVERLAP', 'NOT_PLANNED', 'NEXT_VERSION', 'CONFIRMED', 'ARCHIVED'] as const
