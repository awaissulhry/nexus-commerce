import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { ARCHIVED_CUSTOMER, at, CUSTOMERS, inShell, NOW, ORDERS, panels, QUOTES, RECORD_CAN, recordModel, withoutMoney } from '../../../parties/_shared/fixtures'
import { failed, loaded, loading, type PartyRecordModel } from '../../../parties/_shared/model'
import type { Party } from '../../../parties/_shared/api'
import { BLANK_TERMS, editing, GROUP_TERMS, PAYMENT_TERMS, TERMS, TERMS_CAN, termsCard, termsModel } from '../_demo/fixtures'
import type { CommercialTermsModel } from '../terms/view/CommercialTermsCard'
import { MONEY_CAN, MONEY_STATES, moneyModel } from '../money/_demo/fixtures'
import type { CustomerMoneyModel } from '../money/overview'
import { CustomerRecordView } from './view/CustomerRecordView'
// B-W2b-324: the customer in depth (made-up data in ../depth/demo.ts).
import type { Metric } from '@nexus/ui/components'
import { WithMessages } from '../../../../record-panels/i18n'
import type { SupplierDepth } from '../../../parties/_shared/view/PartyRecordView'
import type { Glance } from '../depth/api'
import { DEPTH_NAMESPACES } from '../depth/CustomerDepth'
import { ALL_CAN, COMPANIES, COPY, FILES, glanceOf, HELD_GLANCE, HOLDS, KEPT, NO_HOLDS, PRIVACY, READ_CAN, REQUIREMENTS, SALES_CAN, STYLES, TERMS as COMPANY_TERMS, TODAY, TWO_HOLDS, WITHHELD, withoutPrices } from '../depth/demo'
import { basisDraftOf, blankRequirement, failedRead, LOADING, ready, requirementDraftOf, type DepthCan, type Read } from '../depth/model'
import { GlanceAside, GlanceNow, GlanceStatus, GlanceTileText } from '../depth/view/GlanceParts'
import { HoldCard, type HoldCardModel } from '../depth/view/HoldCard'
import { PoNumberCard, type PoNumberModel } from '../depth/view/PoNumberCard'
import { PrivacyCard, type PrivacyModel } from '../depth/view/PrivacyCard'
import { RequirementsTab, type RequirementsModel } from '../depth/view/RequirementsTab'
import { STEP_UP_CLOSED } from '../../../admin/shared/model'

/**
 * SCR-033 Customer record — made-up customers only. Each case is one state the Owner reviews: an Italian business that
 * can be invoiced, one that cannot yet (and why, with the step that fixes it), EU businesses with each VIES answer, a
 * person, a customer outside the EU, blocked, archived, read-only rights, no price grain, every tab, every dialog, a
 * change by someone else, loading, not found, a failed read and no access.
 */

const by = (code: string): Party => [...CUSTOMERS, ARCHIVED_CUSTOMER].find((item) => item.code === code)!
const record = (code: string, over: Partial<PartyRecordModel> = {}) => recordModel('customers', by(code), over)

/** B-W2b-324: the depth slot's models of a case (each part drawn from its own view with made-up data). */
interface DepthCase {
  glance?: Read<Glance>
  hold?: HoldCardModel
  po?: PoNumberModel
  requirements?: RequirementsModel
  privacy?: PrivacyModel
}

/** A case: the record, (B-W2a-49) the Commercial terms card of its Tax & terms tab, (B-W2a-81) its money and after-sales reads, (B-W2b-324) its depth. */
type CustomerCase = PartyRecordModel & { terms?: CommercialTermsModel; money?: CustomerMoneyModel; depth?: DepthCase }

function depthNodes(depth: DepthCase | undefined, partyId: string): SupplierDepth | undefined {
  if (!depth) return undefined
  const recordHref = `/w/DEMO/sales/customers/${partyId}`
  const glance = depth.glance ? { read: depth.glance, prefix: '/w/DEMO', recordHref } : null
  const tile = (part: 'credit' | 'promises'): Metric => ({
    label: createElement(GlanceTileText, { read: depth.glance!, part, field: 'label' }),
    value: createElement(GlanceTileText, { read: depth.glance!, part, field: 'value' }),
    hint: createElement(GlanceTileText, { read: depth.glance!, part, field: 'hint' }),
  })
  return {
    ...(glance
      ? {
          numbers: [tile('credit'), { ...tile('promises'), href: `${recordHref}?tab=orders` }],
          now: createElement(GlanceNow, { model: glance }),
          status: createElement(GlanceStatus, { model: glance }),
          aside: createElement(GlanceAside, { model: glance }),
        }
      : {}),
    tax: depth.hold || depth.po ? createElement('div', { className: 'fw-cdp-two-wide' }, depth.hold ? createElement(HoldCard, { model: depth.hold }) : null, depth.po ? createElement(PoNumberCard, { model: depth.po }) : null) : null,
    requirements: depth.requirements ? createElement(RequirementsTab, { model: depth.requirements }) : null,
    contacts: depth.privacy ? createElement(PrivacyCard, { model: depth.privacy }) : null,
  }
}

function CustomerDesign({ model }: { model: CustomerCase }) {
  const { terms, money, depth, ...record } = model
  const party = record.party
  const id = party?.id ?? 'x'
  return inShell(
    `/sales/customers/${id}`,
    createElement(
      WithMessages,
      { namespaces: DEPTH_NAMESPACES },
      createElement(CustomerRecordView, { model: record, panels: party ? panels(party) : null, documents: party ? panels(party, 'files') : null, terms: termsCard(terms ?? termsModel()), money, depth: depthNodes(depth, id) }),
    ),
  )
}

// ---- B-W2b-324: the customer in depth ----

const DEPTH_CAN = { ...RECORD_CAN, depth: true }
type GlanceCode = 'MODA-DEMO' | 'MARCHIO-ESEMPIO' | 'PILOTA-DEMO'
const glanceCase = (code: GlanceCode, glance: Read<Glance>, over: Partial<PartyRecordModel> = {}): CustomerCase => ({ ...record(code, { can: DEPTH_CAN, ...over }), depth: { glance } })
const holdModel = (over: Partial<HoldCardModel> = {}, can: DepthCan = ALL_CAN): HoldCardModel => ({ read: ready(HOLDS), can, status: 'ACTIVE', prefix: '/w/DEMO', dialog: null, companies: COMPANIES, ...over })
const poModel = (over: Partial<PoNumberModel> = {}, can: DepthCan = ALL_CAN): PoNumberModel => ({ read: ready(COMPANY_TERMS), can, status: 'ACTIVE', draft: {}, saving: false, failed: null, ...over })
const taxCase = (hold: Partial<HoldCardModel> = {}, po: Partial<PoNumberModel> = {}, can: DepthCan = ALL_CAN, over: Partial<PartyRecordModel> = {}): CustomerCase => ({
  ...record('MARCHIO-ESEMPIO', { tab: 'tax', can: DEPTH_CAN, ...over }),
  depth: { hold: holdModel(hold, can), po: poModel(po, can) },
})
const reqModel = (over: Partial<RequirementsModel> = {}, can: DepthCan = ALL_CAN): RequirementsModel => ({ read: ready(REQUIREMENTS), can, status: 'ACTIVE', dialog: null, styles: ready(STYLES), files: ready(FILES), companies: COMPANIES, ...over })
const reqCase = (over: Partial<RequirementsModel> = {}, can: DepthCan = ALL_CAN, record_: Partial<PartyRecordModel> = {}): CustomerCase => ({ ...record('MARCHIO-ESEMPIO', { tab: 'requirements', can: DEPTH_CAN, ...record_ }), depth: { requirements: reqModel(over, can) } })
const privacyModel = (over: Partial<PrivacyModel> = {}, can: DepthCan = ALL_CAN): PrivacyModel => ({ read: ready(PRIVACY), can, status: 'ACTIVE', today: TODAY, dialog: null, stepUp: STEP_UP_CLOSED, portalHref: `/w/DEMO/sales/customers/${by('MODA-DEMO').id}?tab=portal`, ...over })
const privacyCase = (over: Partial<PrivacyModel> = {}, can: DepthCan = ALL_CAN): CustomerCase => ({ ...record('MODA-DEMO', { tab: 'addresses', can: DEPTH_CAN }), depth: { privacy: privacyModel(over, can) } })
const dialogState = { busy: false, failed: null, tried: false } as const
const firstContact = PRIVACY.contacts[0]!
const consentContact = PRIVACY.contacts[2]!
const words = { words: '', portal: false, copy: null, kept: null } as const

const termsCase = (code: string, terms: CommercialTermsModel, over: Partial<PartyRecordModel> = {}): CustomerCase => ({ ...record(code, { tab: 'tax', ...over }), terms })

export const designScreen = defineDesignScreen<CustomerCase>({
  screen: 'SCR-033',
  title: 'Customer record',
  view: CustomerDesign,
  cases: [
    {
      id: 'overview',
      label: 'Overview: an Italian business ready to invoice',
      model: record('MODA-DEMO'),
      note: 'Key numbers and Now come from its quotes and orders; the side panel says nothing waits.',
    },
    {
      id: 'overview-missing',
      label: "Overview: a prospect that can't be invoiced yet",
      model: record('NUOVO-PROVA', { quotes: loaded([]), orders: loaded([]) }),
      note: 'Each next step has the button that fixes it; Activate is the primary action.',
    },
    { id: 'overview-fiscal-drawer', label: 'Overview: a brand without SDI code or PEC', model: record('MARCHIO-ESEMPIO') },
    // B-W2a-81: Overdue and Returns this year (key numbers), Open returns and claims (Now), Finance › Receivables.
    { id: 'w2a-numbers', label: 'Overview (W2a): Overdue, Returns this year, open returns and claims', model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.sales) }, note: 'Overdue 4,270.00, oldest 38 days late (opens Finance › Receivables for this customer); 3 returns in 2026, 6 units, 2 open; one complaint being investigated.' },
    { id: 'w2a-numbers-no-price', label: 'Overview (W2a) without the price grain: late invoices counted, no amount', model: { ...record('MODA-DEMO', { can: { ...RECORD_CAN, price: false }, quotes: loaded(withoutMoney(QUOTES)), orders: loaded(withoutMoney(ORDERS)) }), money: moneyModel(MONEY_CAN.noPrice) } },
    { id: 'w2a-numbers-nothing', label: 'Overview (W2a): nothing late, no return this year, nothing open', model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.finance, { ageing: loaded([]), returns: loaded([]), complaints: loaded([]) }) } },
    { id: 'w2a-numbers-loading', label: 'Overview (W2a) reading: tiles "—"', model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.finance, MONEY_STATES.loading) } },
    { id: 'w2a-numbers-failed', label: "Overview (W2a): Overdue and returns couldn't be read", model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.finance, MONEY_STATES.failed) } },
    { id: 'w2a-numbers-no-receivables', label: 'Overview (W2a) without receivables.view: no Overdue tile', model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.none) } },
    { id: 'overview-eu-valid', label: 'Overview: EU business, VIES valid', model: record('DE-BEISPIEL') },
    { id: 'overview-person', label: 'Overview: a private person (rider)', model: record('PILOTA-DEMO', { quotes: loaded([]), orders: loaded([]) }) },
    { id: 'overview-extra-eu', label: 'Overview: a customer outside the EU (CHF)', model: record('CH-DEMO', { quotes: loaded([]), orders: loaded([]) }) },
    {
      id: 'overview-no-price',
      label: 'Overview: a role without the price grain',
      model: record('MODA-DEMO', { can: { ...RECORD_CAN, price: false }, quotes: loaded(withoutMoney(QUOTES)), orders: loaded(withoutMoney(ORDERS)) }),
      note: 'Counts only: amounts are not sent and not drawn.',
    },
    { id: 'blocked', label: 'Blocked, with its reason', model: record('BLOCCATO-DEMO') },
    { id: 'archived', label: 'Archived: read only until reactivated', model: record('ARCHIVIATO-DEMO', { quotes: loaded([]), orders: loaded([]) }) },
    { id: 'read-only', label: 'Read-only rights: you can view, not change', model: record('MODA-DEMO', { can: { ...RECORD_CAN, manage: false, block: false, vies: false } }) },
    { id: 'addresses', label: 'Addresses & contacts', model: record('MODA-DEMO', { tab: 'addresses' }), note: 'The default switches save at once; Edit opens the address.' },
    { id: 'addresses-saving', label: 'Addresses: a default being saved', model: record('MODA-DEMO', { tab: 'addresses', saving: `shipTo:${by('MODA-DEMO').addresses[1]!.id}` }) },
    { id: 'addresses-empty', label: 'Addresses & contacts: none yet', model: record('NUOVO-PROVA', { tab: 'addresses' }) },
    { id: 'address-new', label: 'Add an address', model: record('MODA-DEMO', { tab: 'addresses', dialog: { kind: 'address' } }) },
    {
      id: 'address-edit',
      label: 'Edit an address (sent documents keep their copy)',
      model: record('MODA-DEMO', { tab: 'addresses', dialog: { kind: 'address', addressId: by('MODA-DEMO').addresses[1]!.id } }),
    },
    {
      id: 'address-refused',
      label: 'An address refused by the API',
      model: record('MODA-DEMO', { tab: 'addresses', dialog: { kind: 'address', addressId: by('MODA-DEMO').addresses[0]!.id }, dialogProblem: 'problem.invalid', refused: ['postalCode'] }),
    },
    { id: 'contact-new', label: 'Add a contact', model: record('MODA-DEMO', { tab: 'addresses', dialog: { kind: 'contact' } }) },
    { id: 'tax', label: 'Tax & terms: an Italian identity', model: record('MODA-DEMO', { tab: 'tax' }) },
    { id: 'tax-eu-valid', label: 'Tax & terms: VIES valid, with its proof', model: record('DE-BEISPIEL', { tab: 'tax' }) },
    { id: 'tax-eu-invalid', label: 'Tax & terms: VIES answered not valid', model: record('FR-EXEMPLE', { tab: 'tax' }) },
    { id: 'tax-eu-held', label: "Tax & terms: VIES didn't answer (held, not a refusal)", model: record('AT-MUSTER', { tab: 'tax' }) },
    { id: 'tax-eu-unchecked', label: 'Tax & terms: never checked', model: record('ES-PRUEBA', { tab: 'tax', history: loaded([]) }) },
    {
      id: 'tax-checking',
      label: 'Tax & terms: a check running',
      model: record('ES-PRUEBA', { tab: 'tax', viesRunning: true, notice: { key: 'vies.checkingOne', tone: 'info', params: { name: 'Prueba Motos S.L.' } } }),
    },
    { id: 'identity-new', label: 'New tax identity from a date', model: record('MODA-DEMO', { tab: 'tax', dialog: { kind: 'identity', mode: 'new' } }) },
    { id: 'identity-correct', label: 'Correct the identity in force (add the SDI code)', model: record('MARCHIO-ESEMPIO', { tab: 'tax', dialog: { kind: 'identity', mode: 'correct' } }) },
    { id: 'identity-first', label: 'A first tax identity', model: record('NUOVO-PROVA', { tab: 'tax', dialog: { kind: 'identity', mode: 'new' } }) },
    { id: 'quotes-orders', label: 'Quotes & orders: open', model: record('MODA-DEMO', { tab: 'orders' }) },
    { id: 'quotes-orders-all', label: 'Quotes & orders: all', model: record('MODA-DEMO', { tab: 'orders', deals: 'all' }) },
    {
      id: 'quotes-orders-no-price',
      label: 'Quotes & orders: without the price grain',
      model: record('MODA-DEMO', { tab: 'orders', deals: 'all', can: { ...RECORD_CAN, price: false }, quotes: loaded(withoutMoney(QUOTES)), orders: loaded(withoutMoney(ORDERS)) }),
    },
    { id: 'quotes-orders-empty', label: 'Quotes & orders: none yet', model: record('NUOVO-PROVA', { tab: 'orders', quotes: loaded([]), orders: loaded([]) }) },
    { id: 'quotes-orders-error', label: "Quotes & orders: couldn't load", model: record('MODA-DEMO', { tab: 'orders', quotes: failed('problem.unavailable') }) },
    { id: 'documents', label: 'Documents (files of the record)', model: record('MODA-DEMO', { tab: 'documents' }) },
    { id: 'activity', label: 'Activity (thread, files, history)', model: record('MODA-DEMO', { tab: 'activity' }) },
    { id: 'dock', label: 'Thread beside Overview (≥ 1280 px, ⌘J)', model: record('MODA-DEMO', { dockOpen: true }), note: 'Owner O1: wide screens only; narrower, the button opens Activity.' },
    { id: 'edit', label: 'Edit the identity (explicit save)', model: record('MODA-DEMO', { dialog: { kind: 'edit' } }) },
    { id: 'block', label: 'Block customer', model: record('MODA-DEMO', { dialog: { kind: 'block' } }) },
    { id: 'archive', label: 'Archive customer', model: record('NUOVO-PROVA', { dialog: { kind: 'archive' } }) },
    { id: 'changed', label: 'Changed by someone else while editing', model: record('MODA-DEMO', { changedAt: at(29, 9, 40) }), note: 'Our unsaved work is kept until Reload.' },
    { id: 'conflict', label: 'A save refused: changed meanwhile', model: record('MODA-DEMO', { notice: { key: 'problem.conflict', tone: 'warning' } }) },
    { id: 'offline', label: 'Offline', model: record('MODA-DEMO', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: record('MODA-DEMO', { party: null, asOf: null, live: 'connecting', quotes: loading(), orders: loading() }) },
    { id: 'not-found', label: 'Not found', model: record('MODA-DEMO', { party: null, problem: 'problem.notFound' }) },
    { id: 'error', label: "The API didn't answer", model: record('MODA-DEMO', { party: null, problem: 'problem.unavailable' }) },
    { id: 'no-access', label: 'No permission', model: record('MODA-DEMO', { can: { ...RECORD_CAN, view: false } }) },
    { id: 'shortcuts', label: 'Keyboard shortcuts (?)', model: record('MODA-DEMO', { dialog: { kind: 'shortcuts' }, asOf: NOW }) },
    // B-W2a-49 (design customer.tax.terms, SAL-012): the customer's commercial terms below identity and VIES.
    { id: 'terms', label: 'W2a: Commercial terms — library terms, its price list and the list it falls back to', model: termsCase('MODA-DEMO', termsModel()), note: 'Payment terms in words (deposit 30 % at once); the price list links to its record; minimum order with the price grain.' },
    { id: 'terms-group', label: 'W2a: Commercial terms — a dealer in a discount group (read only: the group list gives it)', model: termsCase('MODA-DEMO', termsModel({ terms: GROUP_TERMS })) },
    { id: 'terms-blank', label: 'W2a: Commercial terms — none from the library yet (the typed W1 text)', model: termsCase('NUOVO-PROVA', termsModel({ terms: BLANK_TERMS })) },
    { id: 'terms-edit', label: 'W2a: Edit — the fields, nothing changed yet', model: termsCase('MODA-DEMO', editing(TERMS)) },
    {
      id: 'terms-edit-changed',
      label: 'W2a: Edit — two changes, Save with ⌘S',
      model: termsCase('MODA-DEMO', editing(TERMS, { paymentTermsId: PAYMENT_TERMS[1]!.id, incoterm: 'EXW' })),
      note: 'The EditModeBar says 2 changes; the payment terms say what they mean under the field.',
    },
    { id: 'terms-edit-problem', label: 'W2a: Edit — a deposit that is not a percent (Save held with the reason)', model: termsCase('MODA-DEMO', editing(TERMS, { defaultDepositPct: '130' })) },
    { id: 'terms-no-lists-manage', label: 'W2a: Edit — a role that may not give price lists (the list field held)', model: termsCase('MODA-DEMO', editing(TERMS, {}, { can: TERMS_CAN.noLists })) },
    { id: 'terms-refused', label: 'W2a: Save refused — a price list in another currency', model: termsCase('MODA-DEMO', editing(TERMS, { currency: 'CHF' }, { saveProblem: 'terms.refused.list' })) },
    { id: 'terms-saved', label: 'W2a: Saved', model: termsCase('MODA-DEMO', termsModel({ saved: true })) },
    { id: 'terms-no-price', label: 'W2a: A role without selling prices (no minimum order)', model: termsCase('MODA-DEMO', termsModel({ can: TERMS_CAN.noPrice })) },
    { id: 'terms-view-only', label: 'W2a: Finance reads, may not change', model: termsCase('MODA-DEMO', termsModel({ can: TERMS_CAN.finance, held: 'terms.held.noManage' }), { can: { ...RECORD_CAN, manage: false, block: false, vies: false } }) },
    { id: 'terms-loading', label: 'W2a: Commercial terms loading', model: termsCase('MODA-DEMO', termsModel({ terms: null })) },
    { id: 'terms-error', label: "W2a: Commercial terms couldn't be read", model: termsCase('MODA-DEMO', termsModel({ terms: null, problem: 'problem.read.unavailable' })) },
    // B-W2b-324 (SAL-019): the customer at a glance, the hold, the PO number, requirements, consent and personal data.
    { id: 'w2b-324-overview', label: 'W2b Customer 360: free credit, promises, samples in progress, repairs, requirements in force', model: glanceCase('MODA-DEMO', ready(glanceOf('MODA-DEMO'))), note: 'One read for the screen\'s company; the W1 quotes and orders and the W2a money keep their own reads.' },
    { id: 'w2b-324-overview-hold', label: 'W2b Customer 360: on hold (a credit check and a quality dispute), over the credit limit', model: glanceCase('MODA-DEMO', ready(glanceOf('MODA-DEMO', HELD_GLANCE))) },
    { id: 'w2b-324-overview-team', label: 'W2b Customer 360: a team with its riders and their measurement profiles', model: glanceCase('MARCHIO-ESEMPIO', ready(glanceOf('MARCHIO-ESEMPIO'))) },
    { id: 'w2b-324-overview-rider', label: 'W2b Customer 360: a rider (a person) under a team, with a profile', model: glanceCase('PILOTA-DEMO', ready(glanceOf('PILOTA-DEMO')), { quotes: loaded([]), orders: loaded([]) }) },
    { id: 'w2b-324-overview-no-price', label: 'W2b Customer 360 without the price grain: credit said in words, no amount', model: glanceCase('MODA-DEMO', ready(withoutPrices(glanceOf('MODA-DEMO', HELD_GLANCE))), { can: { ...DEPTH_CAN, price: false }, quotes: loaded(withoutMoney(QUOTES)), orders: loaded(withoutMoney(ORDERS)) }) },
    { id: 'w2b-324-overview-withheld', label: 'W2b Customer 360: parts the role may not read say what they need', model: glanceCase('MARCHIO-ESEMPIO', ready(glanceOf('MARCHIO-ESEMPIO', WITHHELD))) },
    { id: 'w2b-324-overview-nothing', label: 'W2b Customer 360: nothing open, no limit, no rule', model: glanceCase('PILOTA-DEMO', ready(glanceOf('PILOTA-DEMO', { team: null, profiles: { count: 0, rows: [] } })), { quotes: loaded([]), orders: loaded([]) }) },
    { id: 'w2b-324-overview-loading', label: 'W2b Customer 360 reading', model: glanceCase('MODA-DEMO', LOADING) },
    { id: 'w2b-324-overview-error', label: "W2b Customer 360 couldn't be read", model: glanceCase('MODA-DEMO', failedRead('problem.offline')) },
    { id: 'w2b-324-tax', label: 'W2b Tax & terms: Hold (in force, history, an order waiting) and Customer PO number per company', model: taxCase() },
    { id: 'w2b-324-tax-none', label: 'W2b Tax & terms: not on hold, no history', model: taxCase({ read: ready(NO_HOLDS) }) },
    { id: 'w2b-324-tax-many', label: 'W2b Tax & terms: two holds in force (the toggle says to release each)', model: taxCase({ read: ready(TWO_HOLDS) }) },
    { id: 'w2b-324-tax-place', label: 'W2b Put on hold: company, reason, why', model: taxCase({ read: ready(NO_HOLDS), dialog: { kind: 'place', draft: { companyId: COMPANIES[0]!.id, reason: 'CREDIT', words: 'Two invoices overdue (made-up).' }, ...dialogState } }) },
    { id: 'w2b-324-tax-place-problem', label: 'W2b Put on hold: held until a reason is picked', model: taxCase({ read: ready(NO_HOLDS), dialog: { kind: 'place', draft: { companyId: null, reason: null, words: '' }, busy: false, failed: null, tried: true } }) },
    { id: 'w2b-324-tax-place-refused', label: 'W2b Put on hold refused: one for that reason is in force', model: taxCase({ dialog: { kind: 'place', draft: { companyId: null, reason: 'QUALITY_DISPUTE', words: 'Again (made-up).' }, busy: false, failed: 'hold.refused.same', tried: true } }) },
    { id: 'w2b-324-tax-release', label: 'W2b Release the hold, with why', model: taxCase({ dialog: { kind: 'release', hold: HOLDS.holds[0]!, draft: { holdId: HOLDS.holds[0]!.id, words: 'Answered and closed (made-up).' }, ...dialogState } }) },
    { id: 'w2b-324-tax-po-changed', label: 'W2b Customer PO number: one change waiting for Save (⌘S)', model: taxCase({}, { draft: { [COMPANIES[1]!.id]: true } }) },
    { id: 'w2b-324-tax-read-only', label: 'W2b Tax & terms for a reader: Put on hold, Release and the switches held with why', model: taxCase({}, {}, READ_CAN, { can: { ...DEPTH_CAN, manage: false, block: false } }) },
    { id: 'w2b-324-tax-loading', label: 'W2b Tax & terms: hold and PO number reading', model: taxCase({ read: LOADING }, { read: LOADING }) },
    { id: 'w2b-324-tax-error', label: "W2b Tax & terms: hold and PO number couldn't be read", model: taxCase({ read: failedRead('problem.unavailable') }, { read: failedRead('problem.unavailable') }) },
    { id: 'w2b-324-req', label: 'W2b Requirements: the rules in force with where they show, the ended ones', model: reqCase() },
    { id: 'w2b-324-req-empty', label: 'W2b Requirements: no special requirements', model: reqCase({ read: ready({ inForce: [], ended: [] }) }) },
    { id: 'w2b-324-req-add', label: 'W2b Add rule: company, kind, rule, shown on, applies to, attachment', model: reqCase({ dialog: { kind: 'add', target: null, draft: { ...blankRequirement(COMPANIES[0]!.id), words: 'Pallets no higher than 1.6 m (made-up).', appliesAt: ['SHIPMENT'], fileId: FILES[0]!.id }, ...dialogState } }) },
    { id: 'w2b-324-req-add-styles', label: 'W2b Add rule for some styles', model: reqCase({ dialog: { kind: 'add', target: null, draft: { ...blankRequirement(COMPANIES[0]!.id), kind: 'LABEL', words: 'Reflective tape on the back (made-up).', everyStyle: false, styles: [{ id: STYLES[0]!.id, code: STYLES[0]!.code }] }, ...dialogState } }) },
    { id: 'w2b-324-req-add-problems', label: 'W2b Add rule: what is missing said field by field', model: reqCase({ dialog: { kind: 'add', target: null, draft: { ...blankRequirement(null), appliesAt: [], everyStyle: false }, busy: false, failed: null, tried: true } }) },
    { id: 'w2b-324-req-replace', label: 'W2b Replace a rule (the old one ends in the same step)', model: reqCase({ dialog: { kind: 'replace', target: REQUIREMENTS.inForce[0]!, draft: { ...requirementDraftOf(REQUIREMENTS.inForce[0]!), words: 'Three hangtags per jacket (made-up).', reason: 'New brand book (made-up).' }, ...dialogState } }) },
    { id: 'w2b-324-req-end', label: 'W2b End a rule, with why', model: reqCase({ dialog: { kind: 'end', target: REQUIREMENTS.inForce[1]!, reason: '', busy: false, failed: null, tried: true } }) },
    { id: 'w2b-324-req-refused', label: 'W2b Add rule refused: a style of another company', model: reqCase({ dialog: { kind: 'add', target: null, draft: { ...blankRequirement(COMPANIES[0]!.id), words: 'Made-up.', everyStyle: false, styles: [{ id: STYLES[2]!.id, code: STYLES[2]!.code }] }, busy: false, failed: 'req.refused.styles', tried: true } }) },
    { id: 'w2b-324-req-read-only', label: 'W2b Requirements for a reader: Add, Replace and End held with why', model: reqCase({}, READ_CAN) },
    { id: 'w2b-324-req-loading', label: 'W2b Requirements reading', model: reqCase({ read: LOADING }) },
    { id: 'w2b-324-req-error', label: "W2b Requirements couldn't be read", model: reqCase({ read: failedRead('problem.unavailable') }) },
    { id: 'w2b-324-privacy', label: 'W2b Contacts: lawful basis, consent, objection, an erased contact; one not recorded', model: privacyCase() },
    { id: 'w2b-324-privacy-basis', label: 'W2b Record the lawful basis: consent with when and how', model: privacyCase({ dialog: { kind: 'basis', contact: consentContact, draft: basisDraftOf(consentContact), portal: false, ...dialogState } }) },
    { id: 'w2b-324-privacy-basis-problem', label: 'W2b Lawful basis: consent without when and how is held', model: privacyCase({ dialog: { kind: 'basis', contact: PRIVACY.contacts[1]!, draft: { contactId: PRIVACY.contacts[1]!.id, basis: 'CONSENT', consentDay: '', consentSource: '' }, portal: false, busy: false, failed: null, tried: true } }) },
    { id: 'w2b-324-privacy-objection', label: 'W2b Record an objection', model: privacyCase({ dialog: { kind: 'objection', contact: firstContact, ...words, words: 'By mail on 3 Nov: no more newsletters (made-up).', busy: false, failed: null, tried: false } }) },
    { id: 'w2b-324-privacy-copy', label: 'W2b Access copy: what the person asked and how', model: privacyCase({ dialog: { kind: 'copy', contact: firstContact, ...words, words: 'Request by mail on 3 Nov (made-up).', busy: false, failed: null, tried: false } }) },
    { id: 'w2b-324-privacy-copy-made', label: 'W2b Access copy made: what we hold, kind by kind, Download', model: privacyCase({ dialog: { kind: 'copy', contact: firstContact, ...words, copy: COPY, busy: false, failed: null, tried: true } }) },
    { id: 'w2b-324-privacy-erase', label: 'W2b Erase: what is blanked, what the law keeps, a fresh code', model: privacyCase({ dialog: { kind: 'erase', contact: firstContact, ...words, words: 'Erasure asked by letter on 3 Nov (made-up).', busy: false, failed: null, tried: false } }) },
    { id: 'w2b-324-privacy-erase-step-up', label: 'W2b Erase: the fresh code asked', model: privacyCase({ dialog: { kind: 'erase', contact: firstContact, ...words, words: 'Erasure asked by letter (made-up).', busy: true, failed: null, tried: true }, stepUp: { open: true, busy: false, sentence: 'erase.stepUp', problem: null } }) },
    { id: 'w2b-324-privacy-erase-portal', label: 'W2b Erase refused: a portal user still has the e-mail (Portal access)', model: privacyCase({ dialog: { kind: 'erase', contact: firstContact, ...words, words: 'Erasure asked by letter (made-up).', portal: true, busy: false, failed: 'privacy.refused.portalUser', tried: true } }) },
    { id: 'w2b-324-privacy-erased', label: 'W2b Erased: what was kept and why', model: privacyCase({ dialog: { kind: 'erase', contact: firstContact, ...words, kept: KEPT, busy: false, failed: null, tried: true } }) },
    { id: 'w2b-324-privacy-sales', label: 'W2b Contacts for sales: Erase held (finance erases)', model: privacyCase({}, SALES_CAN) },
    { id: 'w2b-324-privacy-read-only', label: 'W2b Contacts for a reader: every act held with why', model: privacyCase({}, READ_CAN) },
    { id: 'w2b-324-privacy-loading', label: 'W2b Contacts\' personal data reading', model: privacyCase({ read: LOADING }) },
    { id: 'w2b-324-privacy-error', label: "W2b Contacts' personal data couldn't be read", model: privacyCase({ read: failedRead('problem.unavailable') }) },
  ],
})
