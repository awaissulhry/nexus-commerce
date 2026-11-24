import type { Party, TaxIdentity, ViesCheck } from '../../../../parties/_shared/api'
import type { Loaded } from '../../../../parties/_shared/model'
import { actOf, type Act } from './holds'
import { daysUntil, IDENTITY_ROWS, said, text, VIES_ENDS_WITHIN_DAYS, type Said, type TermsCan } from './model'

/**
 * F-CT-511 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §5.4; 18-lead-settles D2, Z3, Z7, Z14, Z21, Z22, Z23) — section
 * 4, Tax identity & e-invoice (#party-identity), pure: the identity in force as facts (tax country, tax mode, the VAT number or the
 * foreign tax id, the codice fiscale — a PERSON's only for those who may change customers, D2 —, the e-invoice as ONE fact: by SDI
 * code, by PEC, or the fiscal drawer's warning in the server's own words, Z3 —, valid from); the dated identities told apart (earlier
 * ones; one that starts later); then, for an EU business outside Italy, the VIES row: the last attempt when it got no answer (never
 * "not valid", Z23), the proof (valid / not valid, checked when, proof until with the days left — a warning from seven), the
 * consultation number, the number checked, the name and address VIES gave (a name that differs from ours is marked, never written over
 * ours), Check again (parties.vies; held while a check runs), and every check folded: the 50 newest, "Show 50 more" with the server's
 * cursor (Z7; no total). Correct… / New identity from a date… open the record's own identity window; Check again is the record's act.
 */

const ITALIAN = new Set(['IT_B2B', 'IT_B2C'])
const realSdi = (code: string | null): code is string => code !== null && code.trim() !== '' && code !== '0000000'

export interface IdentityFact {
  readonly key: string
  readonly label: Said
  readonly value: Said
  readonly none?: boolean
  readonly mono?: boolean
  readonly warning?: boolean
  readonly subs?: readonly Said[]
  /** The fact's own address (a chip marks it). */
  readonly anchor?: string
}

export interface DatedIdentityRow {
  readonly id: string
  /** "From {date} to {date}" (an earlier one) or "From {date}" (one that starts later). */
  readonly when: Said
  readonly mode: Said
  readonly subs: readonly Said[]
}

export interface ViesRowModel {
  readonly anchor: string
  /** The last attempt got no answer (shown above the proof: "No answer … — not a refusal"). */
  readonly noAnswer: { readonly at: string } | null
  /** The decisive check (the proof): its result, when; null: never checked. */
  readonly proof: { readonly result: ViesCheck['result']; readonly at: string; readonly stillCounts: boolean } | null
  /** Proof until {date} · {n} days left — a warning from seven days. */
  readonly until: { readonly date: string; readonly days: number; readonly warning: boolean } | null
  readonly facts: readonly IdentityFact[]
  readonly checkAgain: Act
  /** The checks read (the 50 newest, then each "Show 50 more"). */
  readonly checks: ReadonlyArray<{ readonly id: string; readonly at: string; readonly result: ViesCheck['result']; readonly consultation: string | null; readonly number: string }>
  /** The checks could not be read (a key): the rest of the row still draws. */
  readonly checksProblem: string | null
  /** The server has more (its cursor): "Show 50 more". */
  readonly more: boolean
  readonly checksOpen: boolean
}

export interface IdentitySectionModel {
  readonly answer: Said
  /** No identity in force: the quiet line and Add tax identity. */
  readonly none: boolean
  readonly facts: readonly IdentityFact[]
  /** A person's codice fiscale is hidden for this reader: said ONCE. */
  readonly hiddenFiscalCode: boolean
  readonly earlier: readonly DatedIdentityRow[]
  readonly later: readonly DatedIdentityRow[]
  readonly earlierOpen: boolean
  readonly laterOpen: boolean
  /** The day the first later identity starts ("From {date} ({n})"); null: none. */
  readonly laterFrom: string | null
  /** The VIES row (an EU business outside Italy), else null and the quiet line. */
  readonly vies: ViesRowModel | null
  /** "VIES is not needed: …" (+ ", and this one is not of an EU business" outside the EU). */
  readonly viesNotNeeded: Said | null
  readonly correct: Act
  readonly add: Act
  readonly foot: Said
}

export interface IdentityInput {
  readonly party: Party
  readonly can: TermsCan
  readonly history: Loaded<ViesCheck>
  readonly viesRunning: boolean
  readonly now: string
  readonly earlierOpen: boolean
  readonly laterOpen: boolean
  readonly checksOpen: boolean
}

/** D2: a PERSON's codice fiscale (it holds the birth date) only for those who may change customers. */
export const fiscalCodeHidden = (party: Pick<Party, 'kind'>, can: Pick<TermsCan, 'manage'>): boolean => party.kind === 'PERSON' && !can.manage

/** The identities ordered by the day they start; the one in force, the earlier ones, the later ones (a future change). */
export function datedIdentities(party: Pick<Party, 'taxIdentities'>): { readonly current: TaxIdentity | null; readonly earlier: readonly TaxIdentity[]; readonly later: readonly TaxIdentity[] } {
  const all = [...party.taxIdentities].sort((a, b) => a.validFrom.localeCompare(b.validFrom))
  const current = all.find((row) => row.current) ?? null
  if (!current) return { current: null, earlier: [], later: all }
  return { current, earlier: all.filter((row) => row !== current && row.validFrom < current.validFrom), later: all.filter((row) => row !== current && row.validFrom > current.validFrom) }
}

/** The e-invoice of an Italian identity as ONE fact: by SDI code, by PEC, else the fiscal drawer (a warning, never "cannot be invoiced", Z3). */
function einvoiceFact(identity: TaxIdentity): IdentityFact {
  const base = { key: 'einvoice', label: said('ct.id.einvoice'), anchor: IDENTITY_ROWS.einvoice }
  if (realSdi(identity.sdiRecipientCode)) return { ...base, value: said('ct.id.bySdi', { params: { code: identity.sdiRecipientCode } }), mono: true }
  if (identity.pec) return { ...base, value: said('ct.id.byPec', { params: { pec: identity.pec } }) }
  // said once: the drawer's own words name the missing SDI code and PEC
  return { ...base, value: said('parties:warning.FISCAL_DRAWER'), warning: true }
}

/** The identity's own facts (shared by the one in force and the dated rows' words). */
function identityFacts(identity: TaxIdentity, hidden: boolean): IdentityFact[] {
  const facts: IdentityFact[] = [
    { key: 'country', label: said('parties:field.taxCountry'), value: said('ct.country', { countries: { name: identity.country } }) },
    { key: 'mode', label: said('parties:field.taxMode'), value: said(`parties:taxMode.${identity.taxMode}`) },
    identity.vatNumber
      ? { key: 'vat', label: said(identity.taxMode === 'EXTRA_EU' ? 'parties:field.foreignTaxId' : 'parties:field.vatNumber'), value: text(identity.vatNumber), mono: true }
      : { key: 'vat', label: said(identity.taxMode === 'EXTRA_EU' ? 'parties:field.foreignTaxId' : 'parties:field.vatNumber'), value: said('ct.none'), none: true },
  ]
  if (ITALIAN.has(identity.taxMode) && identity.fiscalCode)
    facts.push(hidden ? { key: 'fiscalCode', label: said('parties:field.fiscalCode'), value: said('ct.id.hidden'), none: true, subs: [said('ct.id.personal')] } : { key: 'fiscalCode', label: said('parties:field.fiscalCode'), value: text(identity.fiscalCode), mono: true })
  if (identity.taxMode === 'IT_B2B') facts.push(einvoiceFact(identity))
  facts.push({ key: 'validFrom', label: said('parties:field.validFrom'), value: said('ct.day', { days: { date: identity.validFrom } }) })
  return facts
}

/** A dated identity's row: when it applies, its mode, its numbers each under its own name. */
function datedRow(identity: TaxIdentity, next: TaxIdentity | null, hidden: boolean): DatedIdentityRow {
  const subs: Said[] = []
  if (identity.vatNumber) subs.push(said('ct.id.rowVat', { params: { vat: identity.vatNumber } }))
  if (identity.fiscalCode) subs.push(hidden ? said('ct.id.rowFiscalHidden') : said('ct.id.rowFiscal', { params: { code: identity.fiscalCode } }))
  if (realSdi(identity.sdiRecipientCode)) subs.push(said('ct.id.rowSdi', { params: { code: identity.sdiRecipientCode } }))
  else if (identity.pec) subs.push(said('ct.id.rowPec', { params: { pec: identity.pec } }))
  return {
    id: identity.id,
    when: next ? said('ct.id.fromTo', { days: { from: identity.validFrom, to: next.validFrom } }) : said('ct.id.from', { days: { from: identity.validFrom } }),
    mode: said(`parties:taxMode.${identity.taxMode}`),
    subs,
  }
}

/** The section's model (pure). */
export function identitySection(input: IdentityInput): IdentitySectionModel {
  const { party, can } = input
  const archived = party.status === 'ARCHIVED'
  const hidden = fiscalCodeHidden(party, can)
  const { current, earlier, later } = datedIdentities(party)
  const sorted = [...earlier, ...(current ? [current] : []), ...later]
  const nextOf = (identity: TaxIdentity) => sorted[sorted.indexOf(identity) + 1] ?? null
  const facts = current ? identityFacts(current, hidden) : []
  const applies = party.vies.state !== 'NOT_APPLICABLE'
  const checks = input.history.items ?? party.viesChecks
  const last = checks[0] ?? party.viesChecks[0] ?? null
  const proofCheck = party.vies.proofCheckId ? ([...checks, ...party.viesChecks].find((check) => check.id === party.vies.proofCheckId) ?? null) : null
  const days = daysUntil(party.vies.validUntil, input.now)
  const vies: ViesRowModel | null =
    applies && current
      ? {
          anchor: IDENTITY_ROWS.vies,
          noAnswer: last && last.result === 'ERROR' ? { at: last.requestedAt } : null,
          proof: proofCheck ? { result: proofCheck.result, at: proofCheck.requestedAt, stillCounts: last !== null && last.result === 'ERROR' && proofCheck.result === 'VALID' } : last && last.result !== 'ERROR' ? { result: last.result, at: last.requestedAt, stillCounts: false } : null,
          until: party.vies.state === 'VALID' && party.vies.validUntil && days !== null ? { date: party.vies.validUntil, days: Math.max(days, 0), warning: days <= VIES_ENDS_WITHIN_DAYS } : null,
          facts: (() => {
            const shown = proofCheck ?? (last && last.result !== 'ERROR' ? last : null)
            if (!shown) return []
            const ours = party.legalName.trim().toLocaleLowerCase()
            const differs = shown.traderName !== null && shown.traderName.trim() !== '' && shown.traderName.trim().toLocaleLowerCase() !== ours
            return [
              { key: 'consultation', label: said('parties:vies.consultation'), value: shown.consultationNumber ? text(shown.consultationNumber) : said('ct.none'), none: !shown.consultationNumber, mono: true },
              { key: 'number', label: said('parties:vies.number'), value: text(`${shown.countryCode}${shown.vatNumber}`), mono: true },
              { key: 'name', label: said('parties:vies.traderName'), value: shown.traderName ? text(shown.traderName) : said('ct.none'), none: !shown.traderName, subs: differs ? [said('ct.id.differs', { params: { name: party.legalName } })] : [] },
              { key: 'address', label: said('parties:vies.traderAddress'), value: shown.traderAddress ? text(shown.traderAddress) : said('ct.none'), none: !shown.traderAddress },
            ]
          })(),
          // Check again: parties.vies (hidden without it); held by state only — a check running, an archived customer.
          checkAgain: can.vies ? { shown: true, held: archived ? said('parties:held.archived') : input.viesRunning ? said('parties:vies.checking') : null } : { shown: false, held: null },
          checks: checks.map((check) => ({ id: check.id, at: check.requestedAt, result: check.result, consultation: check.consultationNumber, number: `${check.countryCode}${check.vatNumber}` })),
          checksProblem: input.history.problem ?? null,
          more: input.history.more === true,
          checksOpen: input.checksOpen,
        }
      : null
  return {
    answer: identityAnswer(party, current, hidden),
    none: current === null,
    facts,
    hiddenFiscalCode: hidden && facts.some((fact) => fact.key === 'fiscalCode'),
    earlier: earlier.map((identity) => datedRow(identity, nextOf(identity), hidden)),
    later: later.map((identity) => datedRow(identity, nextOf(identity), hidden)),
    earlierOpen: input.earlierOpen,
    laterOpen: input.laterOpen,
    laterFrom: later[0]?.validFrom ?? null,
    vies,
    viesNotNeeded: current && !applies ? said(current.taxMode === 'EXTRA_EU' ? 'ct.id.viesNotNeededExtra' : 'ct.id.viesNotNeeded') : null,
    correct: actOf(can.manage && current !== null, archived),
    add: actOf(can.manage, archived),
    foot: said('ct.id.foot', { words: { keep: said('parties:identity.documentsKeep') } }),
  }
}

/** The section's answer: Italian "{mode} · Partita IVA {vat} · e-invoices by SDI code {code}." · EU "… VIES: valid until {date}." · none. */
export function identityAnswer(party: Pick<Party, 'vies' | 'viesChecks'>, current: TaxIdentity | null, hidden: boolean): Said {
  if (!current) return said('parties:customers.identity.none')
  const mode = said(`parties:taxMode.${current.taxMode}`)
  if (ITALIAN.has(current.taxMode)) {
    // D2: a person's codice fiscale never reaches the answer line of a reader who may not change customers.
    const number = current.vatNumber ? said('ct.id.answer.vat', { params: { vat: current.vatNumber } }) : current.fiscalCode && !hidden ? said('ct.id.answer.fiscal', { params: { code: current.fiscalCode } }) : null
    const how = current.taxMode !== 'IT_B2B' ? null : realSdi(current.sdiRecipientCode) ? said('ct.id.answer.sdi', { params: { code: current.sdiRecipientCode } }) : current.pec ? said('ct.id.answer.pec') : said('ct.id.answer.drawer')
    return said(number ? (how ? 'ct.id.answer.italianHow' : 'ct.id.answer.italianNumber') : how ? 'ct.id.answer.italianModeHow' : 'ct.id.answer.italianMode', { words: { mode, ...(number ? { number } : {}), ...(how ? { how } : {}) } })
  }
  const country = said('ct.country', { countries: { name: current.country } })
  if (party.vies.state === 'NOT_APPLICABLE') return said('ct.id.answer.other', { words: { mode, country } })
  const vat = current.vatNumber ?? ''
  const noAnswer = party.viesChecks[0]?.result === 'ERROR'
  if (party.vies.state === 'VALID' && party.vies.validUntil) return said(noAnswer ? 'ct.id.answer.viesValidNoAnswer' : 'ct.id.answer.viesValid', { words: { mode, country }, params: { vat }, days: { date: party.vies.validUntil } })
  if (party.vies.state === 'INVALID') return said('ct.id.answer.viesInvalid', { words: { mode, country }, params: { vat } })
  // Z23: no answer (HELD) is never "not valid"; an old proof (EXPIRED) asks for a new check.
  if (party.vies.state === 'HELD') return said('ct.id.answer.viesHeld', { words: { mode, country }, params: { vat } })
  if (party.vies.state === 'EXPIRED') return said('ct.id.answer.viesExpired', { words: { mode, country }, params: { vat } })
  return said('ct.id.answer.viesUnchecked', { words: { mode, country }, params: { vat } })
}
