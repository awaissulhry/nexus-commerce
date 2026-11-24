import type { FreightBilling } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import type { CommercialTerms } from '../../terms/api'
import type { Read } from '../../depth/model'
import { actOf, ARCHIVED_HELD, HIDDEN, type Act, type WaitingRow } from './holds'
import { companyOf, termsInForce, type CompanyTermsEntry, type TermsInForce, type TermsSource } from './in-force'
import { companyAnchor, kitProblemOf, said, text, type Said, type TermsCan } from './model'

/**
 * F-CT-105 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §5.2; 18-lead-settles Z2, Z8, Z11, Z21, Z24, Z25, Z26, Z29,
 * Z31) — section 2, Commercial terms (#party-commercial), pure: How it pays · Ordering rules · Delivery — three groups that STACK (Z21),
 * their facts Money's own label → value facts — then, for a customer of two or more of our companies, "With each of our companies":
 * one row per company with its own terms and where each comes from. Every fact is the terms IN FORCE with the company the reader works
 * in (the ONE helper, in-force.ts). The minimum order only with the price grain (else said once); the credit limit is a door to Money,
 * never an amount; the carrier account says "On file · The number is never shown" (Z2); a company row says "changed <date>", never
 * "set by" (Z11: one `updatedBy` per row, the credit limit writes it too). Every act is HIDDEN without its right (the server's
 * `mayChange` first, the session's right as fallback) and held only by state: an archived customer; a credit limit set with a company
 * keeps its own terms ("Back to the customer's terms…" is held with its words, the window never opens to be refused — R6 answers 409).
 */

/** The customer's own terms as the tab reads them (R1; `mayChange` from S3 — absent before ct-s). */
export type OwnTermsRead = CommercialTerms & { readonly mayChange?: boolean | undefined }

/** A company's terms row as the company-terms read gives it (R4: the live row and the ended ones). */
export interface CompanyTermsRow {
  readonly id: string
  readonly paymentTermsId: string | null
  readonly paymentTermsLabel: { readonly code: string; readonly name: string } | null
  readonly paymentTermsText: string | null
  readonly priceListId: string | null
  readonly priceListLabel: { readonly code: string; readonly name: string } | null
  readonly depositPct: string | null
  readonly poNumberRequired: boolean
  /** The credit limit's currency: a limit is set on the row (its amount is the price grain's and never drawn here). */
  readonly creditLimitCurrency: string | null
  readonly setAt: string
  readonly endedAt: string | null
  readonly endedBy: string | null
  readonly version: number
}
export interface CompanyTermsReadEntry extends CompanyTermsEntry {
  readonly terms: CompanyTermsRow | null
  readonly mayChange: boolean
  readonly history: readonly CompanyTermsRow[]
}
export interface CompanyTermsRead {
  readonly tenantWide: boolean
  readonly companies: readonly CompanyTermsReadEntry[]
}

/** The customer's carrier block (R19 `GET /shipping/customer-carrier-accounts/:id`). */
export interface CarrierFacts {
  readonly carrierCode: string | null
  readonly carrierName: string | null
  readonly accountOnFile: boolean
  readonly freightBilling: FreightBilling
  readonly defaultCarrierService: string | null
  /** The party's version (the change's edit guard). */
  readonly version: number
}

/** A fact: label → value (Money's Facts draws it); its value may be a door, with sub-lines and its source. */
export interface Fact {
  readonly key: string
  readonly label: Said
  readonly value: Said
  /** The value is the quiet "none" words. */
  readonly none?: boolean
  readonly subs?: readonly Said[]
  /** Where it comes from (two or more of our companies): the customer's own, or the company's own row. */
  readonly source?: { readonly from: TermsSource; readonly company: string } | null
  /** The value is a door (a DS link). */
  readonly href?: string | null
  /** The fact's own address (a chip marks it). */
  readonly anchor?: string
}

export interface CompanyRow {
  readonly id: string
  readonly anchor: string
  readonly name: string
  /** The company the reader works in ("You work in it"). */
  readonly current: boolean
  /** It has its own live terms row (else it uses the customer's terms). */
  readonly own: boolean
  /** When its row last changed (never "set by", Z11). */
  readonly changed: string | null
  readonly paymentTerms: { readonly value: Said; readonly none: boolean; readonly source: TermsSource }
  readonly priceList: { readonly value: Said; readonly source: TermsSource }
  readonly deposit: { readonly value: Said; readonly source: TermsSource }
  readonly po: boolean
  /** Set terms for {company}… */
  readonly set: Act
  /** Back to the customer's terms… (an own row only; held while a credit limit is set). */
  readonly back: Act
  readonly entry: CompanyTermsReadEntry
}

export interface EndedCompanyRow {
  readonly id: string
  readonly company: string
  readonly terms: Said
  readonly deposit: Said
  readonly po: boolean
  readonly ended: string | null
  readonly by: string | null
}

export interface CommercialSectionModel {
  /** R1 still reads (the section's skeleton). */
  readonly reading: boolean
  /** R1 failed (a kit key): the whole section's Try again. */
  readonly problem: string | null
  readonly answer: readonly Said[]
  /** Nothing set beyond what every customer starts with: the answer says it in one line, no body. */
  readonly blank: boolean
  readonly inForce: TermsInForce | null
  readonly pays: readonly Fact[]
  /** The minimum order is not in the reader's role: said ONCE under How it pays. */
  readonly noPrice: boolean
  readonly order: readonly Fact[]
  /** The PO rule's own act ("Change…": the company window with the PO switch only — a customer of ONE company, Z26). */
  readonly poChange: Act
  /** The company the PO act is for (a customer of one company). */
  readonly poCompanyId: string | null
  /** The accepted quotes that wait for a PO number (rows with quotes.view; else their count). */
  readonly poWaiting: readonly WaitingRow[]
  readonly poWaitingCount: number
  readonly delivery: readonly Fact[]
  /** R19 reads / failed (a kit key): the Delivery group's carrier facts wait or say so. */
  readonly deliveryReading: boolean
  readonly deliveryProblem: string | null
  /** Two or more of our companies: the rows, else null. */
  readonly companies: readonly CompanyRow[] | null
  /** R4 failed (a kit key): the company rows and the PO fact say so; the rest still draws. */
  readonly companiesProblem: string | null
  readonly ended: readonly EndedCompanyRow[]
  readonly endedOpen: boolean
  readonly foot: Said
  readonly head: {
    readonly change: Act
    readonly delivery: Act
  }
  readonly menu: {
    /** Set terms for {company}… per company (two or more). */
    readonly setFor: ReadonlyArray<{ readonly companyId: string; readonly name: string; readonly act: Act }>
    /** Customer PO number… (one company). */
    readonly po: { readonly companyId: string; readonly act: Act } | null
    readonly library: string | null
    readonly priceList: { readonly code: string; readonly href: string } | null
    readonly money: string | null
    readonly history: string | null
  }
}

export interface CommercialInput {
  readonly commercial: Read<OwnTermsRead> | null
  readonly companies: Read<CompanyTermsRead> | null
  readonly carrier: Read<CarrierFacts> | null
  /** The company the reader works in (the session's). */
  readonly companyId: string | null
  /** party.paymentTerms — the old typed text, the last fallback. */
  readonly typed: string | null
  readonly can: TermsCan
  readonly archived: boolean
  readonly prefix: string
  readonly partyId: string
  readonly poWaiting: readonly WaitingRow[]
  readonly poWaitingCount: number
  readonly endedOpen: boolean
  readonly locale: 'en' | 'it'
}

const enc = encodeURIComponent
const ready = <T>(read: Read<T> | null): T | null => (read?.status === 'ready' ? read.value : null)

/** A customer of two or more of our companies (the company rows show; the sentence names the company). */
export const isMulti = (companies: CompanyTermsRead | null): boolean => !!companies && companies.tenantWide && companies.companies.length > 1

/** Nothing set beyond what every customer starts with (EUR, Italian, an invoice per shipment, we pay the freight). Needs every read. */
export function isBlank(own: OwnTermsRead | null, companies: CompanyTermsRead | null, carrier: CarrierFacts | null, typed: string | null): boolean {
  if (!own || !companies || !carrier) return false
  return (
    own.paymentTermsId === null &&
    !own.paymentTermsText &&
    !typed &&
    own.priceListId === null &&
    own.defaultDepositPct === null &&
    (own.minimumOrderAmount === null || own.minimumOrderAmount === undefined) &&
    own.incoterm === null &&
    own.discountGroup === null &&
    own.invoiceTiming === 'PER_SHIPMENT' &&
    own.currency === 'EUR' &&
    own.language === 'it' &&
    carrier.carrierCode === null &&
    !carrier.accountOnFile &&
    carrier.freightBilling === 'SENDER' &&
    companies.companies.every((entry) => entry.terms === null)
  )
}

/** Where a fact comes from, as its tag says it (two or more of our companies only). */
export const sourceWords = (source: { readonly from: TermsSource; readonly company: string }): Said => (source.from === 'COMPANY' ? said('ct.com.setFor', { params: { company: source.company } }) : said('ct.com.customerDefault'))

/** The deposit as Commercial terms says it: "30 %" · "30 % — from its payment terms" · "From the sales settings" (Money's format). */
export function depositWords(inForce: TermsInForce): Said {
  const deposit = inForce.deposit
  if (deposit.from === 'COMPANY' || deposit.from === 'PARTY') return said('customer-money:cm.credit.pct', { pcts: { pct: deposit.pct! } })
  if (deposit.from === 'TERMS') return said('ct.com.depositFromTerms', { pcts: { pct: deposit.pct! } })
  return said('terms.depositSettings')
}

/** The section's model (pure). */
export function commercialSection(input: CommercialInput): CommercialSectionModel {
  const { can, archived, prefix, partyId } = input
  const own = ready(input.commercial)
  const companies = ready(input.companies)
  const carrier = ready(input.carrier)
  const multi = isMulti(companies)
  const sources = { commercial: own, companies, typed: input.typed }
  const inForce = own ? termsInForce({ ...sources, companyId: input.companyId }, input.locale) : null
  const current = companyOf(companies, input.companyId) as CompanyTermsReadEntry | null
  const sourceOf = (from: TermsSource) => (multi && current ? { from, company: current.company.name } : null)
  const blank = isBlank(own, companies, carrier, input.typed)
  const answer: Said[] = blank ? [said('ct.com.nothingSet')] : [said('ct.com.answer'), ...(multi && current ? [said('ct.com.shownFor', { params: { company: current.company.name } })] : [])]

  // ---- How it pays
  const pays: Fact[] = []
  if (own && inForce) {
    const terms = inForce.paymentTerms
    pays.push(
      terms
        ? { key: 'paymentTerms', label: said('termsField.paymentTerms'), value: text(terms.name), subs: [...(terms.meaning ? [text(terms.meaning)] : []), ...(terms.typed ? [said('terms.typedOnly')] : [])], source: sourceOf(terms.source) }
        : { key: 'paymentTerms', label: said('termsField.paymentTerms'), value: said('ct.com.ptNone'), none: true },
    )
    pays.push({ key: 'deposit', label: said('customer-money:cm.credit.deposit'), value: depositWords(inForce), source: sourceOf(inForce.deposit.source) })
    pays.push({ key: 'invoicing', label: said('termsField.invoicing'), value: said(`invoicing.${own.invoiceTiming}`) })
    const list = inForce.priceList
    const chain = list && list.source === 'PARTY' && own.priceChain.length > 1 ? [said('terms.chain', { params: { chain: own.priceChain.map((entry) => entry.code).join(' → ') } })] : []
    pays.push(
      list
        ? { key: 'priceList', label: said('termsField.priceList'), value: said(can.lists ? 'ct.com.listDoor' : 'ct.com.list', { params: { code: list.code, name: list.name } }), href: can.lists ? `${prefix}/sales/price-lists/${enc(list.id)}` : null, subs: chain, source: sourceOf(list.source) }
        : { key: 'priceList', label: said('termsField.priceList'), value: said('terms.noList'), none: true },
    )
    pays.push(own.discountGroup ? { key: 'discountGroup', label: said('termsField.discountGroup'), value: said('ct.com.list', { params: { code: own.discountGroup.code, name: own.discountGroup.name } }) } : { key: 'discountGroup', label: said('termsField.discountGroup'), value: said('terms.noGroup'), none: true })
    pays.push({ key: 'currency', label: said('termsField.currency'), value: text(own.currency), subs: [said('ct.com.currencySub')] })
    // The money wall: the minimum order only with the price grain (ABSENT from the read without it); said once otherwise.
    if (can.price) {
      const minimum = own.minimumOrderAmount
      pays.push(
        minimum === null || minimum === undefined
          ? { key: 'minimum', label: said('termsField.minimum'), value: said('terms.none'), none: true }
          : { key: 'minimum', label: said('termsField.minimum'), value: said('ct.amount', { amounts: { amount: { minor: minimum, currency: own.currency } } }), subs: [said('terms.minimumHint', { params: { currency: own.currency } })] },
      )
    }
    // The credit limit: a quiet door to Money (who opens Money), never an amount here.
    if (can.money) {
      const limited = (companies?.companies ?? []).filter((entry) => entry.terms?.creditLimitCurrency).map((entry) => entry.company.name)
      pays.push({ key: 'credit', label: said('ct.com.credit'), value: said('ct.com.inMoney'), href: `${prefix}/sales/customers/${enc(partyId)}?tab=money#credit`, subs: limited.length > 0 ? [said('ct.com.limitWith', { lists: { companies: limited } })] : [] })
    }
  }

  // ---- Ordering rules: the PO number (one company: its rule + Change…; two or more: required with / not with), the language
  const order: Fact[] = []
  let poChange: Act = HIDDEN
  let poCompanyId: string | null = null
  if (own) {
    if (input.companies?.status === 'error') order.push({ key: 'po', label: said('sales-customers-depth:po.title'), value: said('ct.com.notRead'), none: true })
    else if (companies) {
      if (multi) {
        const per = companies.companies.map((entry) => ({ name: entry.company.name, required: entry.inForce.poNumberRequired }))
        const required = per.filter((entry) => entry.required).map((entry) => entry.name)
        const not = per.filter((entry) => !entry.required).map((entry) => entry.name)
        order.push({ key: 'po', label: said('sales-customers-depth:po.title'), value: required.length > 0 ? said('sales-customers-depth:po.required', { lists: { company: required } }) : said('ct.com.poNot'), subs: required.length > 0 && not.length > 0 ? [said('ct.com.poNotWith', { lists: { companies: not } })] : [] })
      } else if (current) {
        poCompanyId = current.company.id
        poChange = actOf(can.manage && current.mayChange, archived)
        order.push({ key: 'po', label: said('sales-customers-depth:po.title'), value: said(current.inForce.poNumberRequired ? 'ct.com.poRequired' : 'ct.com.poNot'), subs: current.terms ? [said('ct.com.changed', { days: { date: current.terms.setAt } })] : [] })
      }
    }
    order.push({ key: 'language', label: said('termsField.language'), value: said('ct.language', { languages: { name: own.language } }), subs: [said('ct.com.languageSub')] })
  }

  // ---- Delivery: the Intrastat terms (on the terms PATCH, Z24), then the carrier block (R19)
  const delivery: Fact[] = []
  if (own) delivery.push(own.incoterm ? { key: 'incoterm', label: said('ct.com.incoterm'), value: said(`incoterm.${own.incoterm}`), subs: [said('ct.com.incotermSub')] } : { key: 'incoterm', label: said('ct.com.incoterm'), value: said('ct.com.incotermNone'), none: true })
  if (carrier) {
    const name = carrier.carrierName ?? carrier.carrierCode
    delivery.push(
      name
        ? { key: 'carrier', label: said('ct.com.carrier'), value: carrier.defaultCarrierService ? said('ct.com.carrierService', { params: { carrier: name, service: carrier.defaultCarrierService } }) : text(name), subs: [said(carrier.defaultCarrierService ? 'ct.com.serviceSub' : 'ct.com.noService')] }
        : { key: 'carrier', label: said('ct.com.carrier'), value: said('ct.com.carrierNone'), none: true },
    )
    delivery.push({ key: 'freight', label: said('ct.com.freight'), value: said(`ct.freight.${carrier.freightBilling}`) })
    // Z2: the read says only that an account is on file — the number (and its last digits) is never read back.
    delivery.push(carrier.accountOnFile ? { key: 'account', label: said('ct.com.account'), value: said('ct.com.onFile'), subs: [said('ct.com.neverShown')] } : { key: 'account', label: said('ct.com.account'), value: said('ct.com.accountNone'), none: true })
  }

  // ---- With each of our companies (two or more)
  const rows: CompanyRow[] | null =
    companies && multi && own
      ? companies.companies.map((entry) => {
          const mine = termsInForce({ ...sources, companyId: entry.company.id }, input.locale)
          const terms = mine.paymentTerms
          const live = entry.terms
          const mayChange = can.manage && entry.mayChange
          return {
            id: entry.company.id,
            anchor: companyAnchor(entry.company.id),
            name: entry.company.name,
            current: entry.company.id === input.companyId,
            own: live !== null,
            changed: live?.setAt ?? null,
            paymentTerms: terms ? { value: text(terms.name), none: false, source: terms.source } : { value: said('ct.com.ptNoneShort'), none: true, source: 'PARTY' },
            priceList: { value: mine.priceList ? text(mine.priceList.code) : said('ct.com.baseList'), source: mine.priceList?.source ?? 'PARTY' },
            deposit: { value: mine.deposit.pct ? said('customer-money:cm.credit.pct', { pcts: { pct: mine.deposit.pct } }) : said('ct.com.salesSettings'), source: mine.deposit.source },
            po: entry.inForce.poNumberRequired,
            set: actOf(mayChange, archived),
            // R6 answers 409 while a credit limit is set on the row: held with its words, the window never opens to be refused.
            back: live && mayChange ? { shown: true, held: archived ? ARCHIVED_HELD : live.creditLimitCurrency ? said('ct.co.backHeld', { params: { company: entry.company.name } }) : null } : HIDDEN,
            entry,
          }
        })
      : null
  const ended: EndedCompanyRow[] =
    companies && multi
      ? companies.companies.flatMap((entry) =>
          entry.history.map((row) => ({
            id: row.id,
            company: entry.company.name,
            terms: row.paymentTermsLabel ? text(row.paymentTermsLabel.name) : row.paymentTermsText ? text(row.paymentTermsText) : said('ct.co.customersTerms'),
            deposit: row.depositPct ? said('customer-money:cm.credit.pct', { pcts: { pct: row.depositPct } }) : said('ct.co.customersDeposit'),
            po: row.poNumberRequired,
            ended: row.endedAt,
            by: row.endedBy,
          })),
        )
      : []

  return {
    // ct-fx3 G-W01 (walk W-01): the kit's reading state until BOTH the customer's own terms and the terms per company have answered.
    reading: input.commercial === null || input.commercial.status === 'loading' || input.companies === null || input.companies.status === 'loading',
    problem: input.commercial?.status === 'error' ? kitProblemOf(input.commercial.problem) : null,
    answer,
    blank,
    inForce,
    pays,
    noPrice: !!own && !can.price,
    order,
    poChange,
    poCompanyId,
    poWaiting: input.poWaiting,
    poWaitingCount: input.poWaitingCount,
    delivery,
    deliveryReading: input.carrier === null || input.carrier.status === 'loading',
    deliveryProblem: input.carrier?.status === 'error' ? kitProblemOf(input.carrier.problem) : null,
    companies: rows,
    companiesProblem: input.companies?.status === 'error' && own ? kitProblemOf(input.companies.problem) : null,
    ended,
    endedOpen: input.endedOpen,
    foot: said(multi ? 'ct.com.footMulti' : 'ct.com.foot'),
    head: {
      // The server's answer first (S3's mayChange on R1), the session's right as the fallback; Change delivery… needs the carrier read.
      change: actOf(can.manage && !!own && (own.mayChange ?? true), archived),
      delivery: actOf(can.manage && !!carrier, archived),
    },
    menu: {
      setFor: rows ? rows.filter((row) => row.set.shown).map((row) => ({ companyId: row.id, name: row.name, act: row.set })) : [],
      po: !multi && poCompanyId && poChange.shown ? { companyId: poCompanyId, act: poChange } : null,
      library: can.paymentTerms && can.invoices ? `${prefix}/finance/settings` : null,
      priceList: inForce?.priceList && can.lists ? { code: inForce.priceList.code, href: `${prefix}/sales/price-lists/${enc(inForce.priceList.id)}` } : null,
      money: can.money ? `${prefix}/sales/customers/${enc(partyId)}?tab=money#credit` : null,
      history: can.audit ? `${prefix}/admin/audit?${new URLSearchParams({ type: 'Party', record: partyId }).toString()}` : null,
    },
  }
}
