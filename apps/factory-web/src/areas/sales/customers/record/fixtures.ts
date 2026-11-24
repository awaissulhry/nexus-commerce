import { createElement, Fragment, useMemo, useRef, useState, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { ARCHIVED_CUSTOMER, at, CUSTOMERS, inShell, NOW, ORDERS, partyThread, QUOTES, RECORD_CAN, recordModel, withoutMoney } from '../../../parties/_shared/fixtures'
import { loaded, loading, type PartyRecordModel } from '../../../parties/_shared/model'
import { recordTabs, shownTab, SIDES } from '../../../parties/_shared/model' // F-CO-103: the tab the page shows (the Overview is built for it)
import type { Party } from '../../../parties/_shared/api'
import { BLANK_TERMS, editing, GROUP_TERMS, PAYMENT_TERMS, TERMS, TERMS_CAN, termsCard, termsModel } from '../_demo/fixtures'
import type { CommercialTermsModel } from '../terms/view/CommercialTermsCard'
import { MONEY_CAN, MONEY_STATES, moneyModel } from '../money/_demo/fixtures'
import { OVERDUE_ROWS } from '../money/_demo/fixtures' // F-CO-301: Moda Demo's late money
import { grantOf } from '@nexus/factory-domain/auth/roles/roles' // F-CO-301: a role's REAL grant
import { templateOf } from '@nexus/factory-domain/auth/roles/templates' // F-CO-301
import { withheldParts } from '@nexus/factory-domain/sales/customer-360/glance' // F-CO-301: the glance's parts by right
import { moneyTabDemo } from '../money/_demo/fixtures' // F-CM-104: the Money tab's made-up reads
import { CustomerMoneyTab } from './view/money/CustomerMoneyTab' // F-CM-104: the Money tab's view
import { CM_CASES, cmHeld, CmMoneyDesign, type CmCaseModel } from './money/_demo/fixtures' // F-CM T.1: the Money tab's cm-* cases
import type { CustomerMoneyModel } from '../money/overview'
import { CustomerRecordView } from './view/CustomerRecordView'
// F-SA-272 → F-CO-201: who looks after the customer, as People's rows and their two Change… windows (made-up people of the portal demo).
import { DesignerWindow, SupervisorWindow } from '../portal/view/CustomerSupervisorCard'
import { SUPERVISOR_CASES } from '../portal/demo'
import { DESIGNER_CASES } from '../portal/demo' // F-CP-155
import type { DesignerModel } from '../portal/designer/model' // F-CP-155
import { designerModel, designerSlot, DESIGNERS } from '../portal/demo' // F-CP-158: the designer rows' last states
import type { OpenOrderMoney } from '../money/api' // F-SA-273
import type { SupervisorModel } from '../portal/limits/model'
// B-W2b-324: the customer in depth (made-up data in ../depth/_demo/fixtures.ts).
import { WithMessages } from '../../../../record-panels/i18n'
import type { SupplierDepth } from '../../../parties/_shared/view/PartyRecordView'
import type { Glance } from '../depth/api'
import { DEPTH_NAMESPACES } from '../depth/CustomerDepth'
import { ALL_CAN, COMPANIES, COPY, FILES, glanceOf, HELD_GLANCE, HOLDS, KEPT, NO_HOLDS, PRIVACY, READ_CAN, REQUIREMENTS, SALES_CAN, STYLES, TERMS as COMPANY_TERMS, TODAY, TWO_HOLDS, WITHHELD, withoutPrices } from '../depth/_demo/fixtures'
import { basisDraftOf, blankRequirement, failedRead, LOADING, ready, requirementDraftOf, type DepthCan, type Read } from '../depth/model'
import { GlanceNow } from '../depth/view/GlanceParts'
import { HoldCard, type HoldCardModel } from '../depth/view/HoldCard'
import { PoNumberCard, type PoNumberModel } from '../depth/view/PoNumberCard'
import { PrivacyCard, type PrivacyModel } from '../depth/view/PrivacyCard'
import { RequirementsTab, type RequirementsModel } from '../depth/view/RequirementsTab'
// F-CA-120 (customer People & addresses, lane ca-; 15-steps W1.4): the People tab of a case — the page's own model rule over the case's
// party, rights, portal and personal data (made-up), today's riders and personal-data cards under it until ca-w2.
import { PeopleTab } from './view/people/PeopleTab'
import { PEOPLE_TAB_START, peopleTabModel } from './people/tab'
import { peopleBadge as peopleBadgeOf } from './people/answer'
import { readyRead as peopleReady, type PeopleCan, type Read as PeopleRead } from './people/model'
import type { RidersView } from './people/api' // F-CA-205
import type { PortalAccessModel } from '../portal/model'
import { customerAccess, portalModel as portalDemo } from '../portal/demo'
import type { PartnerPerson } from '../../../admin/users/partners/api'
// F-CA-120: end
import { STEP_UP_CLOSED } from '../../../admin/shared/model'
// ---- F-SA-276: the Work tab (the waiting strip with made-up reads, the ONE Orders sheet locked to the customer) ----
import { useT } from '../../../../lib/i18n/provider'
import { at as ordersAt, BOARD, canOf, LIST_ROWS, TODAY as ORDERS_TODAY } from '../../orders/_demo/fixtures'
// ---- F-CP-113: the New order page's own lines editor in its window over the Work tab (made-up lines) ----
import { BLK, BRN, COMPANY, MANUAL_PREVIEW, PARTY as ORDER_PARTY, STYLE, STYLE_ID } from '../../orders/_demo/fixtures'
import { newKey } from '../../orders/daily-model'
import { COMPOSER_EMPTY } from '../../orders/record/record-model'
import type { NewOrderModel } from '../../orders/new/new-model'
import { NewOrderWindow } from '../../orders/new/view/NewOrderView'
// ---- end F-CP-113
// ---- F-CP-107: Drafts of <customer> (made-up portal drafts) and one in its read-only window ----
import { CATALOGUE_RECORD } from '../../inquiries/demo/fixtures'
import { REQUEST_STATUS_WORDS } from '@nexus/factory-domain/sales/portal-ordering/rules' // cp-walk: a draft's own state words
import { inquiriesCan } from '../../inquiries/model'
import type { CatalogueRecord } from '../../inquiries/api' // cp-walk
import type { DraftRow } from './drafts/api'
import { draftTitle } from './drafts/model'
import { DraftWindow } from './drafts/view/DraftWindow'
// ---- cq W3 (F-CQ-303, T part 2): the drafts are Quotes & incoming's "Customer is writing" — that tab's own gallery parts, mounted here
import { QuotesTabDesign, quotesTabFor, writingTabFor, type TabRole } from './quotes-tab/fixtures'
// ---- end cq W3
// ---- end F-CP-107
import type { OrderRow } from '../../orders/api'
import type { RowView } from '../../orders/model'
import type { OrdersListActions, OrdersListModel } from '../../orders/list/list-model'
// cp-walk (F-CP-103): Views ▾, Customise and Export from the list tools in memory, as the Office mounts them for the live sheet.
import { ListToolsContext } from '../../../../list-frame/tools/transport'
import { memoryStore, memoryTransport, type MemoryToolsModel } from '../../../_shared/list-tools/memory'
import { OrdersListView } from '../../orders/list/view/OrdersListView'
import { WORK_DEFAULT_ROWS, type WorkReads } from './use-customer-work'
import type { Read as WorkRead } from './use-customer-work' // F-CO-301: the work reads' own states (reading · ready · failed · off)
import type { CustomerWork } from '../list/api' // F-CO-301: this customer's row of the joined read
import { priceWindowOf, type PriceWindowCase } from '../../orders/price-check/fixtures' // F-CP-114
import { workViewCounts } from './use-customer-work' // F-CP-103: the Views ▾ counts
// ---- F-CW-101: the band in the strip's place (made-up counts: the domain's own rule over the made-up states) ----
import { ORDER_PHASES, phaseCountsOf } from '@nexus/factory-domain/production-brand/stages'
import { IN_PRODUCTION_VIEW } from './use-customer-work'
import { beforeLineOf, NO_BEFORE_ORDER } from './before-order'
import { beforeOrderFor } from './before-order' // F-CO-103: the Overview's band says the same "Before an order" line
import { quotesGroupDoor } from './before-order' // F-CQ-303: the drafts' door is Quotes & incoming at WRITING
import { bandOf, chipsOf, whysOf } from './work-band'
import { WorkBand } from './view/WorkBand'
// ---- end F-CW-101
import { workEmptyOf, workPreset, workViewsOf } from './view/WorkTab' // F-CP-101: the views and empty states per view
import { NOT_EQUAL_VIEW } from './view/WorkTab' // F-CP-141: the Not equal view
import { columnSetOf, type ColumnSet } from './view/WorkTab' // F-CP-105: Columns: Work · Money
import type { UnreadMap } from '../../../../lib/last-message-cell/model' // F-CP-107 (cp-fx16): the New messages column, as live
// ---- end F-SA-276
// ---- F-CP-112 (SCR-033): the row's Next steps window, the bulk window over the ticked orders, the band's New order window ----
import { order as demoOrder } from '../../orders/_demo/fixtures'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import { STEP_UP_CLOSED as ORDERS_STEP_UP_CLOSED } from '../../orders/hooks'
import type { OrderAbilities } from '../../orders/model'
import { manyTargetsOf, type ManyRead, type ManyResult, type OrderCommandManyModel, type OrderCommandModel } from '../../orders/list/commands/model'
import type { NewOrderDialogModel } from '../../orders/list/list-model'
// ---- end F-CP-112
// ---- cw T.1 (customer Work tab: every state the seed lacks — made-up orders SEED-SO-0001 … 0014 of a made-up customer) ----
import { useRecordFrame } from '../../../_shared/record-frame/RecordFrame'
import { useDockTop } from '../../../_shared/record-thread/ThreadPick'
import { recordDockedThread } from '../../../../lib/record-thread/fixtures'
import { ThreadCase } from '../../../../lib/record-thread/ThreadCase'
import type { CardMessage } from '../../../../lib/record-thread/card/model'
import type { UrgencyAct } from '../../../_shared/customer-urgency/model'
import { noteModel } from '../../../production/_shared/notes/fixtures'
import type { NoteCheck } from '../../../production/_shared/notes/api'
import { NOTES_NS, type NoteResult } from '../../../production/_shared/notes/model'
import { useLocale } from '../../../../lib/i18n/provider'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { startDraft } from '../../../../lib/record-thread/composer/model'
import { READY as READY_TO_SHIP } from '../../../warehouse/shipments/_demo/fixtures'
import type { ReadyOrder } from '../../../warehouse/shipments/api'
import type { NewShipmentModel } from '../../../warehouse/shipments/list/list-model'
import { abilitiesOf as shippingAbilitiesOf } from '../../../warehouse/shipments/model'
import type { OrderPhase, OrderSort } from '../../orders/api'
import { abilitiesOf as orderAbilitiesOf, sortChoicesOf } from '../../orders/model'
import { replyComposerContext, replyTargetsOf, type ReplyManyModel } from '../../orders/list/reply-many'
import { NAMESPACE as SHEET_NS, noteTargetsOf } from '../../orders/list/sheet/model'
import type { ShipTogetherModel } from '../../orders/list/sheet/ship'
import { urgencyDialogOf, urgencyLeftOf, type SheetUrgencyModel } from '../../orders/list/sheet/urgency'
import type { BeforeOrderCounts } from './before-order'
import { workFootOf, type UrgencyFoot } from './urgency-foot'
import { WorkFoot } from './view/WorkFoot'
import type { WorkRoom } from './view/WorkTab'
// ---- end cw T.1
// ---- F-CO-103 (customer page › Overview): the tab's rules over each case's own models, drawn by the shared overview kit's parts ----
import type { BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import { customerMoneyCanOf } from '../money/model'
import { customerHref, workOrdersDoor } from './overview/doors'
import { urgencyOf as looksUrgencyOf, type LooksAfter, type OverviewInput } from './overview/model' // F-CO-201: the urgency from who looks after
import { overviewOf } from './overview/rows'
import { CustomerOverviewView } from './view/overview/CustomerOverviewView'
// ---- end F-CO-103

/**
 * SCR-033 Customer record — made-up customers only. Each case is one state the Owner reviews: an Italian business that
 * can be invoiced, one that cannot yet (and why, with the step that fixes it), EU businesses with each VIES answer, a
 * person, a customer outside the EU, blocked, archived, read-only rights, no price grain, every tab, every dialog, a
 * change by someone else, loading, not found, a failed read and no access.
 */

/** F-CA-120: the portal of the people-portal case — Moda Demo's orders contact (same e-mail, another case of letters) and one person who is no contact. */
const PEOPLE_PORTAL: PartnerPerson[] = [
  { id: 'd0000000-0000-4000-8000-0000000ca001', displayName: 'Anna Demo', email: 'ACQUISTI@moda-demo.example.com', kind: 'CUSTOMER', status: 'ACTIVE', roleKey: 'customer-buyer', roleName: 'Buyer', seesPrices: true, admin: false, capabilities: ['comment'], accessUntil: null, accessEndsSoon: false, lastSignInAt: '2026-10-28T15:10:00.000Z', invitation: null, version: 3 },
  { id: 'd0000000-0000-4000-8000-0000000ca002', displayName: 'Paolo Campione', email: 'paolo.campione@example.com', kind: 'CUSTOMER', status: 'INVITED', roleKey: null, roleName: null, seesPrices: false, admin: false, capabilities: [], accessUntil: null, accessEndsSoon: false, lastSignInAt: null, invitation: { id: 'd0000000-0000-4000-8000-0000000ca003', expiresAt: '2026-11-30T09:00:00.000Z' }, version: 1 },
]
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

/** F-SA-273: three made-up open orders of MODA-DEMO with their deposits and balances (minor units). */
const OPEN_ORDER_MONEY: OpenOrderMoney[] = [
  { id: 'd0000000-0000-4000-8000-000000000271', number: 'SO-0142', currency: 'EUR', deposit: { state: 'OPEN', dueDate: '2026-12-01' }, paid: 0, balance: 420000 },
  { id: 'd0000000-0000-4000-8000-000000000272', number: 'SO-0150', currency: 'EUR', deposit: { state: 'PAID', dueDate: null }, paid: 120000, balance: 280000 },
  { id: 'd0000000-0000-4000-8000-000000000273', number: 'SO-0155', currency: 'EUR', deposit: { state: 'NOT_NEEDED', dueDate: null }, paid: 0, balance: 0 },
]

/** A case: the record, (B-W2a-49) the Commercial terms card of its Terms & requirements tab (B-TH-260), (B-W2a-81) its money and after-sales reads, (B-W2b-324) its depth. */
// F-SA-272: + the Overview's "Who looks after <customer>" card (the supervisor and backup, moved from Portal settings).
// F-SA-274 → F-CA-120: + People's portal (one row per person: the portal state on the contact of the same e-mail).
type CustomerCase = PartyRecordModel & { terms?: CommercialTermsModel; money?: CustomerMoneyModel; depth?: DepthCase; supervisor?: SupervisorModel; people?: PeopleCase /* F-CA-120 */; work?: WorkCase /* F-SA-276 */; designer?: DesignerModel /* F-CP-155 */; priceDiffer?: number /* F-CP-141 */; shipmentLine?: boolean /* cw T.1: the docked ORDER's thread with the draft shipment's office line */; supervisorOpen?: boolean /* F-CO-201: People's Change… (the supervisor) open — the form's own states */; overview?: OverviewOver /* F-CO-301: the Overview's own state */; cm?: CmCaseModel /* F-CM T.1: a cm-* case of the Money tab */ }

// F-CA-120: what a People case adds — the portal of THIS customer as its container would read it (null: none read).
interface PeopleCase {
  readonly portal?: PortalAccessModel | null
}

/** F-CA-120: the tab's rights from a case's record rights (the gallery's roles: a portal right covers invite and manage). */
const peopleCanOf = (can: PartyRecordModel['can']): PeopleCan => ({ view: can.view, manage: can.manage, ordersManage: can.ordersManage === true, portal: can.partners === true, invite: can.partners === true, portalManage: can.partners === true, audit: false, ...NO_MEASUREMENTS })
/** F-CA-205 (ca-w2): the gallery's older People cases see no measurement profile and no personal-data act (the ca-* cases set their own). */
const NO_MEASUREMENTS = { measurements: false, mtmRecord: false, mtmLink: false, mtmReview: false, fittings: false, ordersView: false, privacy: false, erase: false, privacyRequests: false } as const
/** F-CA-205: a case's riders read, from its glance (its riders with their own page, a rider's team); none: a team with no rider yet. */
function ridersOfCase(party: Party, glance: Read<Glance> | undefined): PeopleRead<RidersView> {
  const value = glance?.status === 'ready' ? glance.value : null
  return peopleReady({
    partyId: party.id,
    code: party.code,
    kind: party.kind,
    team: value?.team ? { id: value.team.id, code: value.team.code, legalName: value.team.name, status: value.team.status } : null,
    riders: (value?.riders?.rows ?? []).map((rider) => ({ id: rider.id, code: rider.code, legalName: rider.name, tradeName: null, status: rider.status, country: 'IT', language: 'it', measurementProfiles: null, version: 1, updatedAt: NOW })),
    version: party.version,
  })
}
// F-CA-120: end

// ---- F-SA-276: the Work tab's cases — the strip's reads and the sheet's rows (made-up; the production part as the API sends it) ----
interface WorkCase {
  readonly reads: WorkReads
  /** null: the rows still read. */
  readonly rows: readonly OrderRow[] | null
  readonly view?: RowView
  readonly problem?: string | null
  readonly price?: boolean
  /** F-CP-113: the lines window open over the sheet (priced lines; or the Discard question). */
  readonly linesWindow?: 'lines' | 'discard'
  /** F-CP-107: "Drafts of <customer>" shown (its list, none yet, or one draft open in its window). */
  readonly drafts?: 'list' | 'empty' | 'window'
  /** F-CP-114: the ONE customer's-price window open over the sheet (typing, changed meanwhile, a closed order). */
  readonly priceWindow?: PriceWindowCase
  /**
   * F-CP-141: the Not equal view — `view`: shown to a price holder (its money columns, its count, its chip); `held`: a shared saved
   * view or a link with the term opened by a reader without the price grain (one line, no rows, Show all orders).
   */
  readonly notEqual?: 'view' | 'held'
  /** F-CP-105: the person's pick of "Columns: Work · Money" (`cols=`); and the production manager's page (no price grain, no orders.manage). */
  readonly cols?: ColumnSet
  readonly role?: 'manager'
  /** F-CP-107 (cp-fx16): the reader's new messages per order — the live Work tab's New messages column (threads.read). */
  readonly unread?: UnreadMap
  // ---- F-CP-112 (SCR-033) ----
  /** A row's ⋯ "Next steps" window over the sheet (the order page's own dialog on the order as read): Mark ready…, Close order… on a
   *  shipped order not settled, held (the row is older than the order), or the order being read. */
  readonly command?: 'ready' | 'close' | 'held' | 'reading'
  /** The bulk window over the ticked orders: its preview (runs on 2 · not on 1, one reason) or its result (1 done · 1 not done). */
  readonly many?: 'preview' | 'result'
  /** Orders ticked on the sheet (the bar's Mark N ready… · Close N… · Confirm N…). */
  readonly ticked?: number
  /** The band's New order window: the customer held (no Change), Add the lines next. */
  readonly newOrder?: boolean
  // ---- end F-CP-112
  // ---- cw T.1: the Work tab as the live page gives it (W1–W3), and the states the seed lacks ----
  /**
   * The sheet with the live Work tab's own options: "Most urgent first", no List ⇄ Board switch, the count of all orders, the
   * shipping and urgency acts by the reader's rights, the foot line. (The earlier cases stay as they were drawn.)
   */
  readonly live?: boolean
  /** Who reads it (each act by its OWN right); absent: the Owner. */
  readonly reader?: WorkReader
  /** The tab's own room (the columns it shows). */
  readonly room?: WorkRoom
  /** The sheet's sort (absent: Most urgent first, the tab's default). */
  readonly sort?: OrderSort | null
  /** A door of the band shown: the sheet narrowed to that group, its chip, its why. */
  readonly phase?: OrderPhase
  /** The band's "Before an order" line (absent: the made-up counts of the earlier cases). */
  readonly before?: BeforeOrderCounts
  /** The customer's urgency as the tab read it (the foot's part; `on: false`: the switch off). */
  readonly urgencyFoot?: UrgencyFoot | null
  /** The rows ticked (by id). */
  readonly tickedIds?: readonly string[]
  /** Ship N together…: the window at step 1 (Runs on 4 · Not on 2) or step 2, or the notice after Create. */
  readonly ship?: 'step1' | 'step2' | 'notice'
  /** The shared urgency window over one row (`row`) or the ticked rows (`many`), or its outcome. */
  readonly urgency?: { readonly act: UrgencyAct; readonly on: 'row' | 'many' } | 'outcome'
  /** Production's Note window as "Ask production about N…" (Needs an answer ticked), or its receipt. */
  readonly note?: 'ask' | 'receipt'
  /** Reply to N as "Ask <customer> about N…" (the to-do tick on), or its receipt. */
  readonly reply?: 'ask' | 'receipt'
  /** Customise columns open (the tab's own set ticked). */
  readonly customise?: boolean
  // ---- end cw T.1
}
/** cw T.1: the readers of 10-design §4's table. */
type WorkReader = 'owner' | 'sales' | 'warehouse' | 'manager' | 'reader'

/** F-CP-141: made-up rows whose prices differ (the customer's price, the check, the difference), as a price holder's answer carries them. */
const notEqualRows = (party: Party): OrderRow[] =>
  workRows(party, (row, index) => ({ brandPrice: (row.netAmount ?? 0) + (index === 0 ? -6000 : 6000), priceMatch: 'NOT_EQUAL' as const, priceDiff: index === 0 ? 6000 : -6000, priceNotEqualLines: index === 0 ? 2 : 1 })).slice(0, 2)

/** F-CP-107: made-up portal drafts of the customer (one ready to send, one just started). */
const draftRowsOf = (party: Party, price: boolean): DraftRow[] => {
  const file = (id: string, locked = false) => ({ id, lineId: null, originalName: locked ? null : `${id}.pdf`, kind: 'ATTACHMENT', sizeBytes: 120000, status: 'READY', locked })
  const base = { status: 'DRAFT', party: { id: party.id, code: party.code, name: party.tradeName ?? party.legalName }, customerRef: null, currency: 'EUR', ...(price ? { netShown: '18400.00' } : {}) }
  return [
    { ...base, id: 'd0000000-0000-4000-8000-000000000701', number: null, requestedDate: '2026-12-15', lines: 3, pieces: 140, version: 6, draft: { startedBy: 'Giulia Verdi', startedAt: '2026-11-12T09:00:00.000Z', lastEditedBy: 'Giulia Verdi', lastEditedAt: '2026-11-19T10:42:00.000Z', title: 'STY-01 Giacca demo', people: 12, readiness: { parts: [], done: 5, of: price ? 7 : 6, problems: 1 }, later: ['PEOPLE'], thread: { messages: 4, lastAt: '2026-11-19T10:40:00.000Z', designerAsked: true }, files: { logos: [file('l1'), file('l2')], references: [], sheets: [file('s1', true)] } } },
    { ...base, id: 'd0000000-0000-4000-8000-000000000702', number: null, requestedDate: null, lines: 0, pieces: 0, version: 1, draft: { startedBy: 'Luca Bianchi', startedAt: '2026-11-18T15:10:00.000Z', lastEditedBy: 'Luca Bianchi', lastEditedAt: '2026-11-18T15:20:00.000Z', title: null, people: 0, readiness: { parts: [], done: 1, of: price ? 7 : 6, problems: 0 }, later: [], thread: null, files: { logos: [file('l3')], references: [], sheets: [] } } },
  ]
}

// ---- cp-walk (F-CP-107): the draft open in its window is THIS customer's — its name, its address, the draft's own state words (the
// made-up record was Incoming's sent order of another customer: "Demo Rider Shop — … · Request sent" over Moda Demo's draft). ----
export const draftRequestOf = (party: Party): CatalogueRecord['request'] => {
  const name = party.tradeName ?? party.legalName
  const request = CATALOGUE_RECORD.request
  return { ...request, status: 'DRAFT', words: REQUEST_STATUS_WORDS.DRAFT, number: null, sentAt: null, sentBy: null, party: { id: party.id, code: party.code, name }, customerRef: null, shipTo: request.shipTo ? { ...request.shipTo, name: `${name} · warehouse` } : null }
}
// ---- end cp-walk

/** F-CP-113: the lines window's made-up model (two colour lines, one at the list price, one typed; priced by the API). */
// cp-walk (F-CP-113): the window names the page's customer (it said "New order · Moto Demo S.r.l." over Moda Demo's page).
export const linesWindowOf = (kind: 'lines' | 'discard', price: boolean, party: Party): NewOrderModel => ({
  prefix: '/w/DEMO',
  can: price ? canOf('owner') : canOf('sales'), // B-CP-011: prices are the Owner's; the real Sales role holds no grain
  today: ORDERS_TODAY,
  header: { companyId: COMPANY, partyId: party.id, contactId: ORDER_PARTY.contacts[0]!.id, customerRef: 'PO-ESEMPIO-89' },
  party: { status: 'ready', value: { ...ORDER_PARTY, id: party.id, code: party.code, legalName: party.legalName, tradeName: party.tradeName ?? null } },
  number: 'SO-2026-0089',
  draft: {
    lines: [
      { key: newKey(STYLE_ID, BLK.id), lineId: null, styleId: STYLE_ID, colourwayId: BLK.id, sizes: { '48': 2, '50': 2, '52': 2, '54': 2 }, price: '', locked: false },
      { key: newKey(STYLE_ID, BRN.id), lineId: null, styleId: STYLE_ID, colourwayId: BRN.id, sizes: { '50': 2, '52': 2 }, price: price ? '430' : '', locked: false },
    ],
    requestedDate: '2026-12-01',
    promiseDate: '2026-12-08',
    internalNote: '',
  },
  styles: { [STYLE_ID]: STYLE },
  composer: COMPOSER_EMPTY,
  preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null },
  busy: false,
  problem: null,
  discardAsk: kind === 'discard',
})
// F-CW-101: the made-up board as the API answers it now — the seven phases (the domain's rule over the made-up states: one of the two
// orders in production has started) and the two whys of "Not sent to the factory".
const DESIGN_PHASES = phaseCountsOf(Object.fromEntries(BOARD.byStatus.map((entry) => [entry.status, entry.count])) as Partial<Record<OrderRow['status'], number>>, 1)
const STRIP_READY: WorkReads = {
  board: {
    status: 'ready',
    value: {
      ...BOARD,
      byPhase: ORDER_PHASES.map((phase) => ({ phase, count: DESIGN_PHASES[phase] })),
      notSent: { waitsForYes: 0, waitsForDeposit: 1 },
      tiles: BOARD.tiles.map((tile) => (tile.key === 'late' ? { ...tile, count: 1 } : tile.key === 'waitingForDeposit' ? { ...tile, count: 1 } : tile)),
    },
  },
  requests: { status: 'ready', value: { items: [], open: 2, countered: 1 } },
  replies: { status: 'ready', value: { rows: [], count: 3, complete: true } },
  asks: { status: 'ready', value: { items: [], complete: true } },
  tasks: { status: 'ready', value: { items: [], total: 4, complete: true } },
}
const STRIP_READING: WorkReads = { board: { status: 'reading' }, requests: { status: 'reading' }, replies: { status: 'reading' }, asks: { status: 'reading' }, tasks: { status: 'reading' } }
const workRows = (party: Party, over: (row: OrderRow, index: number) => Partial<OrderRow> = () => ({})): OrderRow[] =>
  LIST_ROWS.filter((row) => row.status === 'IN_PRODUCTION' || row.status === 'CONFIRMED').map((row, index) => ({
    ...row,
    partyId: party.id,
    partyName: party.tradeName ?? party.legalName,
    progress: index === 1 ? { inWork: 120, cut: 120, sewn: null, finished: null } : { inWork: 266, cut: 266, sewn: 100, finished: 40 },
    production: { stage: index === 2 ? 'CUTTING' : 'SEWING', stageSince: '2026-10-27', health: index === 1 ? 'LATE' : index === 0 ? 'AT_RISK' : 'ON_TRACK', waitingOn: index === 2 ? 'SUPPLIER' : null, since: index === 2 ? ordersAt(27, 9) : null, held: false, supervisorMark: index === 0 ? 'ME' : index === 1 ? 'SOMEONE_ELSE' : 'NOT_SET', openRequests: index === 0 ? 1 : 0, openIssues: 0, withheld: [] },
    ...over(row, index),
  }))
// ---- F-CP-107 (cp-fx16): All orders as live with a waiting-for-a-yes row (no stage kept, no piece in work yet) on the longest seed
// number, beside a real number in production; the New messages column on (threads.read), as the live Work tab draws it. ----
const W39_ID = 'd0000000-0000-4000-8000-000000000391'
const waitingYesRows = (party: Party): OrderRow[] => {
  const [first, ...rest] = workRows(party)
  const waiting: OrderRow = { ...first!, id: W39_ID, number: 'SEED-SO-W39-01', status: 'PENDING_APPROVAL', customerRef: 'SEED-PO-W39-1', progress: null, production: { ...first!.production!, stage: null, stageSince: null, health: null, waitingOn: null, since: null, supervisorMark: 'NOT_SET', openRequests: 0 } }
  return [waiting, { ...first!, number: 'SO-2026-0089' }, ...rest]
}
const waitingYesUnread = (party: Party): UnreadMap => ({ [workRows(party)[0]!.id]: { newCount: 2, lastAt: '2026-11-17T09:42:00.000Z' } })
// ---- end F-CP-107 (cp-fx16)
// cp-walk (F-CP-104 / F-CP-112): the band's New order open for a person who takes orders (the Owner, Sales), as the live page draws
// it — RECORD_CAN has no orders.manage, so every Work case held it ("Needs the right Work on sales orders") beside its own window.
const workCase = (code: string, work: WorkCase, over: Partial<PartyRecordModel> = {}): CustomerCase => ({ ...record(code, { tab: 'work', ...over, can: { ...RECORD_CAN, ordersManage: true, ...over.can } }), work })

// ---- F-CP-112 (SCR-033): made-up windows as the sheet mounts them (the order page's own dialogs, A14's rules on the order as read) ----
/** The rows of the command cases: two in production and one confirmed (the bulk preview runs on 2, not on 1). */
const commandRows = (party: Party): OrderRow[] => workRows(party, (_row, index) => ({ status: index < 2 ? ('IN_PRODUCTION' as const) : ('CONFIRMED' as const) })).slice(0, 3)
function commandWindowOf(kind: NonNullable<WorkCase['command']>, rows: readonly OrderRow[], can: OrderAbilities): OrderCommandModel {
  const row = rows[0]!
  const at = { id: row.id, number: row.number }
  const read = kind === 'reading' ? null : kind === 'close' ? demoOrder('SHIPPED', { ...at, settled: false }) : kind === 'held' ? demoOrder('CONFIRMED', at) : demoOrder('IN_PRODUCTION', at)
  return { command: kind === 'close' ? 'close' : 'ready', target: at, order: read, problem: null, busy: false, dialogProblem: null, cancelCheck: null, refuse: null, refuseReasons: null, stepUp: ORDERS_STEP_UP_CLOSED, can, prefix: '/w/DEMO' }
}
function manyWindowOf(kind: NonNullable<WorkCase['many']>, rows: readonly OrderRow[], can: OrderAbilities): OrderCommandManyModel {
  const reads: Record<string, ManyRead> = Object.fromEntries(rows.map((row) => [row.id, { state: 'ready', order: demoOrder(row.status, { id: row.id, number: row.number }) } satisfies ManyRead]))
  // The result: the first done, the second changed meanwhile (the third never ran: not in production).
  const results: Record<string, ManyResult> = kind === 'result' ? { [rows[0]!.id]: { state: 'done' }, [rows[1]!.id]: { state: 'notDone', why: { key: 'commands.many.stale', params: { number: rows[1]!.number }, sheet: true } } } : {}
  return { command: 'ready', targets: manyTargetsOf(rows), reads, reason: kind === 'result' ? 'Made-up: the lot is finished and checked.' : '', phase: kind === 'result' ? 'done' : 'preview', progress: null, results, stepUp: ORDERS_STEP_UP_CLOSED, can }
}
/** The band's New order window over the Work tab, the customer of the page held (picked on open, no Change). */
const newOrderOf = (party: Party, price: boolean): NewOrderDialogModel => ({
  companies: DEMO_COMPANIES.slice(0, 1),
  companyId: DEMO_COMPANIES[0].id,
  results: null,
  searchProblem: null,
  party: { ...ORDER_PARTY, id: party.id, code: party.code, legalName: party.legalName, tradeName: party.tradeName ?? null },
  partyProblem: null,
  contactId: ORDER_PARTY.contacts[0]!.id,
  customerRef: '',
  number: 'SO-2026-0089',
  incomingHref: '/w/DEMO/sales/incoming?new=1',
  price,
  partyLocked: true,
})
// ---- end F-CP-112

// ---- cw T.1 (customer Work tab plan; 10-design §8, §9): the states the seed lacks — a busy customer with orders in all seven groups
// (2 · 1 · 4 · 1 · 2 · 3 · 1), the customer's urgency in every state, our own priority, and each window the bar and the row open.
// Made-up only: orders SEED-SO-0001 … 0014, shipments SEED-SH-0011 and SEED-SH-0012; no amount is added anywhere.
const SEED_CUSTOMER = 'MODA-DEMO'
const SEED_ID = (n: number): string => `d0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`
const SEED_NUMBER = (n: number): string => `SEED-SO-${String(n).padStart(4, '0')}`
type MadeUp = NonNullable<OrderRow['production']>
const made = (over: Partial<MadeUp> = {}): MadeUp => ({ stage: 'SEWING', stageSince: '2026-10-20', health: 'ON_TRACK', waitingOn: null, since: null, held: false, supervisorMark: 'ME', openRequests: 0, openIssues: 0, openIssuesSince: null, readyNow: 0, withheld: [], ...over })
/** An order with no stage kept: before production, or after it. */
const NO_STAGE: MadeUp = made({ stage: null, stageSince: null, health: null, supervisorMark: 'NOT_SET' })
type UrgencyState = NonNullable<OrderRow['customerUrgencyState']>
const urgent = (state: UrgencyState['state'], over: Partial<UrgencyState> = {}): UrgencyState => ({ state, urgentRank: null, locked: false, requestId: null, ...over })
type OurPriority = NonNullable<OrderRow['priority']>
const level = (value: OurPriority['level']): OurPriority => ({ level: value, number: 1, urgentReason: value === 'URGENT' ? 'Made-up: the shop opening' : null })
const pieces = (cut: number, sewn: number, finished: number, ordered: number): NonNullable<OrderRow['progress']> => ({ inWork: ordered, cut, sewn, finished, ordered })
const RUSH_REQUEST = 'd0000000-0000-4000-8000-00000000a007'
/** One made-up order of the customer on a whole row of the API (the first demo row's shape): no stage, nothing marked, nothing invoiced. */
const seedRow = (party: Party, n: number, status: OrderRow['status'], over: Partial<OrderRow> = {}): OrderRow => ({
  ...LIST_ROWS[0]!,
  id: SEED_ID(n),
  number: SEED_NUMBER(n),
  customerRef: null,
  partyId: party.id,
  partyName: party.tradeName ?? party.legalName,
  status,
  deposit: { state: 'PAID', dueDate: null },
  reaccept: false,
  units: 244,
  shippedUnits: 0,
  daysLate: null,
  promiseDate: '2026-11-20',
  priority: level('NORMAL'),
  waits: null,
  customerUrgency: null,
  customerUrgencyState: null,
  atRisk: null,
  progress: null,
  production: NO_STAGE,
  invoiced: null,
  doors: { quote: null, depositInvoice: null, deliveryNotes: null, invoices: null },
  ...over,
})
/** The busy customer's fourteen orders, in the seven groups' order. */
const busyRows = (party: Party): OrderRow[] => [
  // Not sent to the factory (2): one waits for its deposit, one for a yes.
  seedRow(party, 1, 'CONFIRMED', { deposit: { state: 'OPEN', dueDate: '2026-11-05' }, promiseDate: '2026-12-18' }),
  seedRow(party, 2, 'PENDING_APPROVAL', { waits: ['REQUEST_PENDING'], promiseDate: null, customerRef: 'SEED-PO-0002' }),
  // Production not started (1): set to regular by us and locked; our Low.
  seedRow(party, 3, 'IN_PRODUCTION', { priority: level('LOW'), customerUrgencyState: urgent('SET_BACK', { locked: true }), production: made({ stage: 'PREPARING', stageSince: '2026-10-27' }), promiseDate: '2026-12-11' }),
  // In production (4): the customer's urgent 1–3 (our Top and High on the first two; the third on hold), one "Urgent – asked".
  seedRow(party, 4, 'IN_PRODUCTION', { priority: level('URGENT'), customerUrgency: 'URGENT', customerUrgencyState: urgent('URGENT', { urgentRank: 1 }), production: made({ stage: 'SEWING', health: 'AT_RISK', readyNow: 10 }), progress: pieces(244, 152, 40, 244), promiseDate: '2026-11-06', atRisk: { daysLeft: 8, daysBeforePromise: 10 } }),
  seedRow(party, 5, 'IN_PRODUCTION', { priority: level('HIGH'), customerUrgency: 'URGENT', customerUrgencyState: urgent('URGENT', { urgentRank: 2 }), production: made({ stage: 'CUTTING', health: 'LATE', supervisorMark: 'SOMEONE_ELSE' }), progress: pieces(120, 0, 0, 180), units: 180, promiseDate: '2026-10-25', daysLate: 4 }),
  seedRow(party, 6, 'IN_PRODUCTION', { customerUrgency: 'URGENT', customerUrgencyState: urgent('URGENT', { urgentRank: 3 }), production: made({ stage: 'QUALITY', held: true, readyNow: 24 }), progress: pieces(96, 96, 72, 96), units: 96, promiseDate: '2026-11-13' }),
  seedRow(party, 7, 'IN_PRODUCTION', { customerUrgencyState: urgent('ASKED', { requestId: RUSH_REQUEST }), production: made({ stage: 'SEWING', openRequests: 1, waitingOn: 'US', since: ordersAt(27, 9), openIssues: 1, openIssuesSince: ordersAt(27, 9) }), progress: pieces(60, 20, 0, 60), units: 60, promiseDate: '2026-11-27' }),
  // Ready to ship (1).
  seedRow(party, 8, 'READY', { production: made({ stage: 'READY', readyNow: 40 }), progress: pieces(40, 40, 40, 40), units: 40, promiseDate: '2026-11-03' }),
  // Shipped (2): one partly, one whole.
  seedRow(party, 9, 'PARTLY_SHIPPED', { production: made({ stage: 'READY', readyNow: 12 }), units: 120, shippedUnits: 80, promiseDate: '2026-10-30' }),
  seedRow(party, 10, 'SHIPPED', { units: 60, shippedUnits: 60, promiseDate: '2026-10-20' }),
  // Done (3) and cancelled (1): no stage any more.
  seedRow(party, 11, 'DELIVERED', { units: 90, shippedUnits: 90, promiseDate: '2026-10-10' }),
  seedRow(party, 12, 'CLOSED', { units: 150, shippedUnits: 150, promiseDate: '2026-09-26' }),
  seedRow(party, 13, 'CLOSED', { units: 48, shippedUnits: 48, promiseDate: '2026-09-12' }),
  seedRow(party, 14, 'CANCELLED', { units: 30, promiseDate: null }),
]
type PhaseCounts = Readonly<Record<OrderPhase, number>>
const NO_PHASES: PhaseCounts = { NOT_SENT: 0, NOT_STARTED: 0, IN_PRODUCTION: 0, READY: 0, SHIPPED: 0, DONE: 0, CANCELLED: 0 }
const BUSY_PHASES: PhaseCounts = { NOT_SENT: 2, NOT_STARTED: 1, IN_PRODUCTION: 4, READY: 1, SHIPPED: 2, DONE: 3, CANCELLED: 1 }
interface SeedWaits {
  readonly yes?: number
  readonly deposit?: number
  readonly late?: number
  readonly requests?: number
  readonly replies?: number
  readonly tasks?: number
}
const BUSY_WAITS: SeedWaits = { yes: 1, deposit: 1, late: 1, requests: 1, replies: 2, tasks: 3 }
/** The page's reads for a set of made-up rows: the board's seven groups (as the API counts them), the two whys, what waits. */
function seedReads(rows: readonly OrderRow[], phases: PhaseCounts, waits: SeedWaits = {}): WorkReads {
  const statuses = [...new Set(rows.map((row) => row.status))]
  return {
    board: {
      status: 'ready',
      value: {
        ...BOARD,
        byStatus: statuses.map((status) => ({ status, count: rows.filter((row) => row.status === status).length })),
        byPhase: ORDER_PHASES.map((phase) => ({ phase, count: phases[phase] })),
        notSent: { waitsForYes: waits.yes ?? 0, waitsForDeposit: waits.deposit ?? 0 },
        tiles: BOARD.tiles.map((tile) => ({ ...tile, count: tile.key === 'late' ? (waits.late ?? 0) : tile.key === 'waitingForDeposit' ? (waits.deposit ?? 0) : 0 })),
      },
    },
    requests: { status: 'ready', value: { items: [], open: waits.requests ?? 0, countered: 0 } },
    replies: { status: 'ready', value: { rows: [], count: waits.replies ?? 0, complete: true } },
    asks: { status: 'ready', value: { items: [], complete: true } },
    tasks: { status: 'ready', value: { items: [], total: waits.tasks ?? 0, complete: true } },
  }
}
/** What each reader of 10-design §4 holds beyond the demo roles (made-up permission lists; each act reads its OWN right). */
const READER_RIGHTS: Readonly<Record<'warehouse' | 'reader', readonly string[]>> = {
  warehouse: ['home.view', 'threads.read', 'threads.post', 'orders.view', 'shipping.view', 'shipping.manage'],
  reader: ['home.view', 'threads.read', 'orders.view'],
}
const SHIP_RIGHTS: readonly string[] = ['shipping.view', 'shipping.manage']
/** Six ticked for "Ship 6 together…": four have garments ready, one ships to another address, one has nothing released. */
const SHIP_TICKED = [8, 9, 6, 4, 5, 7].map(SEED_ID)
const SHIP_ON = [8, 9, 6, 4].map(SEED_ID)
/** What can ship of a made-up order, as the ready read answers it (the Warehouse demo's own cell, this order's ids and pieces). */
const readyOf = (row: OrderRow, shippable: number, shipsWith: ReadyOrder['shipsWith']): ReadyOrder => ({
  salesOrderId: row.id,
  number: row.number,
  customerRef: row.customerRef,
  status: row.status,
  companyId: row.companyId,
  partyId: row.partyId,
  party: { code: 'SEED', legalName: row.partyName },
  shipsWith,
  cells: READY_TO_SHIP[0]!.cells.slice(0, 1).map((cell) => ({ ...cell, workOrderSizeId: `${row.id}-cell`, pieces: shippable, released: shippable, onShipments: 0, shippable })),
})
/** Warehouse's New shipment window as the sheet opens it over the six ticked orders: step 1 (Runs on 4 · Not on 2) or step 2. */
function shipWindowOf(rows: readonly OrderRow[], step: 1 | 2): NewShipmentModel {
  const pick = (n: number): OrderRow => rows.find((row) => row.id === SEED_ID(n))!
  const may = { allowed: true, why: null }
  const orders = [readyOf(pick(8), 40, null), readyOf(pick(9), 12, may), readyOf(pick(6), 24, may), readyOf(pick(4), 10, may), readyOf(pick(5), 6, { allowed: false, code: 'SHIP_TO', why: null })]
  const quantities = step === 2 ? Object.fromEntries(orders.filter((order) => SHIP_ON.includes(order.salesOrderId)).flatMap((order) => order.cells.map((cell) => [cell.workOrderSizeId, cell.shippable] as const))) : {}
  return { step, orders, problem: null, salesOrderId: SEED_ID(8), quantities, transportBy: 'CARRIER', carrierCode: 'brt', serviceCode: '', busy: false, refused: null, together: true, others: SHIP_ON.slice(1), asked: [...SHIP_TICKED] }
}
/** The sheet's mount of the shipping window for a case: the reader's right, the window or the notice after Create. */
function shipOf(work: WorkCase, rows: readonly OrderRow[], may: boolean, customer: string): ShipTogetherModel {
  const can = shippingAbilitiesOf(may ? SHIP_RIGHTS : [])
  const none: ShipTogetherModel = { can, window: null, complete: {}, draft: null, notice: null }
  if (!may || !work.ship) return none
  if (work.ship === 'notice') return { ...none, notice: { shipmentId: 'd0000000-0000-4000-8000-0000000b0012', number: 'SEED-SH-0012', orders: [8, 9, 6, 4].map((n) => ({ id: SEED_ID(n), number: SEED_NUMBER(n) })), customer } }
  // SEED-SO-0009 ships complete: the shipment would carry 12 of the 40 pieces it still owes; a draft of the customer exists already.
  return { ...none, window: shipWindowOf(rows, work.ship === 'step2' ? 2 : 1), complete: { [SEED_ID(9)]: true }, draft: { shipmentId: 'd0000000-0000-4000-8000-0000000b0011', number: 'SEED-SH-0011' } }
}
/** The shared urgency window as the sheet mounts it: over one row, over the ticked rows (Runs on / Not on), or its outcome. */
function urgencyOf(work: WorkCase, rows: readonly OrderRow[], may: boolean): SheetUrgencyModel | null {
  if (!may) return null
  const closed: SheetUrgencyModel = { dialog: null, busy: false, problem: null, outcome: null, can: true, stepUp: ORDERS_STEP_UP_CLOSED, left: [] }
  const ask = work.urgency
  if (!ask) return closed
  if (ask === 'outcome') return { ...closed, outcome: { act: 'regular', done: [SEED_NUMBER(4), SEED_NUMBER(5)], notDone: [{ number: SEED_NUMBER(6), words: { en: 'It changed meanwhile: read it again.', it: 'È cambiato nel frattempo: rileggilo.' } }], notShown: 0 } }
  // One row: the urgent order (Set to regular…, Lock…) or the locked one (Unlock…); many: the ticked rows.
  const asked = ask.on === 'row' ? rows.filter((row) => row.id === SEED_ID(ask.act === 'unlock' ? 3 : 4)) : rows.filter((row) => (work.tickedIds ?? []).includes(row.id))
  return { ...closed, dialog: urgencyDialogOf(ask.act, asked), left: ask.on === 'many' ? urgencyLeftOf(ask.act, asked) : [], draft: { reason: 'Made-up: the line is full until the 20th.' } }
}
type Words = (key: string, params?: Readonly<Record<string, string | number>>) => string
/** Production's Note window as "Ask production about N…" (each order's supervisor asked, Needs an answer ticked), or its receipt. */
function askNoteOf(kind: NonNullable<WorkCase['note']>, rows: readonly OrderRow[], s: Words, n: Words) {
  const targets = noteTargetsOf(rows)
  const answer: NoteCheck = {
    records: targets.salesOrders.map((record) => ({ type: record.type, id: record.id, label: record.label, customer: { id: record.partyId, name: record.partyName }, canWrite: true, why: null, supervisor: 'SOMEONE_ELSE' as const })),
    unknown: 0,
    customers: 1,
    people: [],
    noSupervisor: [],
    noIssue: [],
    namesOtherCustomer: [],
    held: false,
  }
  const result: NoteResult = { lines: targets.salesOrders.map((record) => ({ key: `SalesOrder:${record.id}`, label: record.label, state: 'written' as const, mentioned: 0, supervisorAsked: true, issue: true })), written: targets.salesOrders.length, unknown: 0, notMentioned: [], tasks: [], notRaised: [] }
  return noteModel({
    targets,
    answer,
    draft: { on: 'salesOrders', body: 'Made-up: when does the lining for these arrive?', needsAnswer: true },
    preset: { title: s('bar.askProductionTitle', { count: rows.length }), body: '', needsAnswer: true, send: n('send', { count: rows.length }), hint: s('bar.askProductionThen') },
    result: kind === 'receipt' ? result : null,
  })
}
/** Reply to N as "Ask <customer> about N…": the to-do tick on with its day; or its receipt (posted, and the to-do made, per order). */
function askReplyOf(kind: NonNullable<WorkCase['reply']>, rows: readonly OrderRow[]): ReplyManyModel {
  const targets = replyTargetsOf(rows)
  const customer = { id: targets[0]!.partyId, name: targets[0]!.partyName }
  const sent = kind === 'receipt'
  return {
    customer,
    targets,
    batchId: 'd0000000-0000-4000-8000-0000000c0203',
    draft: { ...startDraft(replyComposerContext(customer.name)), body: 'Made-up: can you confirm the label position on these orders by Friday?' },
    notes: [],
    language: 'en',
    portal: 'on',
    sending: false,
    progress: null,
    results: sent ? Object.fromEntries(targets.map((target) => [target.id, { state: 'sent' as const, todo: { state: 'made' as const } }])) : {},
    done: sent,
    todo: { on: true, due: '2026-11-03' },
    asked: true,
    today: ORDERS_TODAY,
  }
}
/**
 * The doors the live page hands the sheet since W2 and W3 (use-orders-sheet): without them the row ⋯ draws no Create shipment…
 * and no urgency act. Made-up: a pick does nothing here (each window has its own case).
 */
function liveDoors(work: Pick<WorkCase, 'role'>, price: boolean): OrdersListActions {
  return { ...workDoors(work, price), onReplyMany: () => undefined, onShipTogether: () => undefined, onCreateShipment: () => undefined, onUrgency: () => undefined, onAskProduction: () => undefined, onNote: () => undefined, onAssignSupervisor: () => undefined, onAddTask: () => undefined }
}
/**
 * The docked ORDER's thread with the office-only line a draft shipment writes on each order it carries (the API's own words); the
 * customer never reads it. Made-up: the demo thread of the order, one system note added.
 */
function ShipmentLineThread({ party }: { party: Party }) {
  const frame = useRecordFrame()
  const top = useDockTop()
  const base = recordDockedThread({ recordType: 'SalesOrder', record: SEED_NUMBER(3), party: { name: party.tradeName ?? party.legalName, role: 'customer' } }, { width: frame?.width ?? null })
  const line: CardMessage = { id: 'd0000000-0000-4000-8000-0000000d0012', kind: 'note', channel: 'APP', author: null, authorKind: 'SYSTEM', at: ordersAt(17, 16, 0, 11), body: `On draft shipment SEED-SH-0012 with ${SEED_NUMBER(3)}, ${SEED_NUMBER(4)}.`, mentions: [], files: [] }
  const feed = base.thread.feed
  return createElement(ThreadCase, { model: { ...base, thread: { ...base.thread, feed: feed.state === 'ready' ? { ...feed, messages: [...feed.messages, line] } : feed } }, onWidth: frame?.choose, top })
}
const NO_MONEY = { netAmount: undefined, grossAmount: undefined, paid: undefined, balance: undefined }
const busy = (): OrderRow[] => busyRows(by(SEED_CUSTOMER))
/** A case of the live Work tab over the busy customer (the Owner reads it unless the case says who). */
const liveCase = (work: Partial<WorkCase> = {}, over: Partial<PartyRecordModel> = {}): CustomerCase => {
  const rows = work.rows === undefined ? busy() : work.rows
  return workCase(SEED_CUSTOMER, { live: true, reads: seedReads(rows ?? [], BUSY_PHASES, BUSY_WAITS), urgencyFoot: { on: true, used: 3, max: 3, companies: [] }, ...work, rows }, over)
}
/** The same seen by another reader: no price grain (no amount on any row), the acts by that reader's own rights. */
const seenAs = (reader: Exclude<WorkReader, 'owner'>, work: Partial<WorkCase> = {}): CustomerCase =>
  liveCase({ reader, price: false, rows: busy().map((row) => ({ ...row, ...NO_MONEY })), ...work }, { can: { ...RECORD_CAN, price: false, ordersManage: reader === 'sales' } })
const ROLE_TICKED = [4, 5, 3].map(SEED_ID)
// ---- end cw T.1

// ---- cp-walk (review walk, F-CP-108 / F-CP-109 / F-CP-114 / F-CP-103): the sheet's doors and list tools as the live Work tab gives them ----
/**
 * The live page hands the sheet its doors (use-orders-sheet): without them the design drew no row ⋯ "Next steps", no "Set
 * customer's price…" and none of the bar's Reply to N · Mark N ready… · Close N… · Confirm N… — the opposite of the cases' words.
 * Made-up: a pick does nothing here (each window has its own case). The price door only with the price grain, as live.
 */
export function workDoors(work: Pick<WorkCase, 'role'>, price: boolean): OrdersListActions {
  return {
    onCommand: () => undefined,
    onCommandMany: () => undefined,
    ...(work.role !== 'manager' ? { onReplyMany: () => undefined } : {}),
    ...(price ? { onPriceCheck: () => undefined } : {}),
  }
}
const workTools: MemoryToolsModel = { pageKey: 'sales.orders', locale: 'en', answer: { views: [], roleDefaultId: null, personalDefaultId: null, roles: [], allRoles: [], can: { save: true, manage: false, export: true }, exports: { formats: ['XLSX', 'CSV'] } }, jobs: [] }
/** Views ▾ (the customer's built-in views, their counts, Not equal for a price holder), Customise and Export, in memory. */
function WorkTools({ tools, children }: { tools: MemoryToolsModel; children?: ReactNode }) {
  const [query, setQuery] = useState('')
  const store = useRef(memoryStore(tools))
  const transport = useMemo(() => memoryTransport(tools, store.current, query, setQuery), [tools, query])
  return createElement(ListToolsContext.Provider, { value: transport }, children)
}
// ---- end cp-walk

/** The Work tab as the page draws it: the strip, then the Orders sheet embedded and locked to the customer (its views, its preset). */
// ---- F-CQ-303 (T part 2): the customer's portal drafts on Quotes & incoming (the WRITING door): the same list, one open in its window ----
function DraftsTabDesign({ work, party }: { work: WorkCase; party: Party }) {
  const t = useT('parties')
  const name = party.tradeName ?? party.legalName
  const price = work.price !== false
  const rows = work.drafts === 'empty' ? [] : draftRowsOf(party, price)
  const role: TabRole = work.role === 'manager' ? 'production' : price ? 'owner' : 'sales'
  const window =
    work.drafts === 'window'
      ? createElement(DraftWindow, {
          model: {
            customer: name,
            title: draftTitle(draftRowsOf(party, true)[0]!, t('customers.drafts.untitled')),
            nav: { ids: draftRowsOf(party, true).map((row) => row.id), current: draftRowsOf(party, true)[0]!.id },
            pane: { prefix: '/w/DEMO', can: inquiriesCan(['orders.view', 'orders.manage', 'quotes.manage', 'threads.read', ...(price ? ['money.price'] : [])]), offline: false, loaded: { status: 'ready', value: { ...CATALOGUE_RECORD, request: draftRequestOf(party), may: { order: false, quote: false, refuse: false } } }, notice: null, dialog: null, handled: null, draft: { title: 'STY-01 Giacca demo' } },
          },
        })
      : null
  const drafts = { customer: name, read: { status: 'ready' as const, rows }, updates: work.drafts === 'list' ? 1 : 0, activeId: null, wide: true }
  return createElement(QuotesTabDesign, { model: writingTabFor({ id: party.id, name }, drafts, role, window) })
}
// ---- end F-CQ-303

function WorkDesign({ work, party }: { work: WorkCase; party: Party }) {
  const t = useT('parties')
  const o = useT('orders') // F-CW-101: the In production view's own word
  const name = party.tradeName ?? party.legalName
  const view = work.view ?? WORK_DEFAULT_ROWS
  const notEqual = work.notEqual === 'view' && work.price !== false // F-CP-141
  // F-CP-105: the production manager. B-CP-011: a price holder is the Owner; without prices the real Sales role (no grain).
  // cw T.1: + the readers of 10-design §4 (Warehouse and Read-only by their own made-up rights); absent: as before.
  const can =
    work.reader === 'warehouse' || work.reader === 'reader' ? orderAbilitiesOf(READER_RIGHTS[work.reader]) : work.role === 'manager' || work.reader === 'manager' ? canOf('manager') : work.price !== false && work.reader !== 'sales' ? canOf('owner') : canOf('sales')
  const columnSet = columnSetOf(work.cols, notEqual, can.price) // F-CP-105: without the price grain always Work
  // ---- cw T.1: the live Work tab's own options since W1–W3 — only for the cases that ask (`live`); the earlier cases stay as drawn.
  const locale = useLocale()
  const s = useMemo(() => createTranslator(locale, messagesFor(locale, [SHEET_NS])[SHEET_NS] ?? {}), [locale])
  const n = useMemo(() => createTranslator(locale, messagesFor(locale, [NOTES_NS])[NOTES_NS] ?? {}), [locale])
  const reader: WorkReader = work.reader ?? (work.role === 'manager' ? 'manager' : work.price !== false ? 'owner' : 'sales')
  const shown = work.rows ?? []
  const ticked = shown.filter((row) => (work.tickedIds ?? []).includes(row.id))
  const sort: OrderSort | null = work.sort === undefined ? 'urgent' : work.sort
  const room: WorkRoom = work.room ?? 'base'
  const whysWords = whysOf(work.reads.board)
    .map((entry) => t(`customers.work.band.why.${entry.why}`, { count: entry.count }))
    .join(' · ')
  const recordHref = `/w/DEMO/sales/customers/${party.id}`
  // F-CQ-303: the empty line's way to the drafts opens Quotes & incoming at WRITING ("Customer is writing").
  const drafts = work.before && typeof work.before.drafts === 'number' && work.before.drafts > 0 ? { count: work.before.drafts, href: quotesGroupDoor(recordHref, 'WRITING') } : null
  const live: Partial<OrdersListModel> = work.live
    ? {
        sort,
        preset: workPreset(view, null, columnSet === 'money', room),
        wide: columnSet === 'money' ? room !== 'base' : room === 'widest',
        countOf: workViewCounts(work.reads.board)?.all ?? null,
        layoutSwitch: false,
        searchLabel: t('customers.work.search'),
        urgencyOff: !!work.urgencyFoot && !work.urgencyFoot.on,
        // Each act by its OWN right: shipping.manage (Owner, Warehouse), production.brand.override (Owner, Production manager), …
        ship: shipOf(work, shown, reader === 'owner' || reader === 'warehouse', name),
        urgency: urgencyOf(work, shown, reader === 'owner' || reader === 'manager'),
        bulkCan: { supervisor: reader === 'owner' || reader === 'manager', note: reader !== 'reader', task: reader === 'reader' ? 'held.noRight' : null, reply: reader !== 'reader', todo: reader === 'owner' || reader === 'sales' },
        commands: { window: null, moved: [], receipt: null, many: null, decide: reader === 'owner' || reader === 'sales' || reader === 'warehouse' },
        ...(work.tickedIds ? { selected: [...work.tickedIds] } : {}),
        ...(work.phase ? { extra: { phase: work.phase }, phaseNote: work.phase === 'NOT_SENT' && whysWords ? whysWords : null } : {}),
        ...(work.note ? { note: askNoteOf(work.note, ticked, s, n) } : {}),
        ...(work.reply ? { replyMany: askReplyOf(work.reply, ticked) } : {}),
        empty: workEmptyOf(view, null, name, t, `${recordHref}?tab=work&rows=all`, { phase: work.phase ?? null, plain: true, drafts }),
      }
    : {}
  const sortChoice = sortChoicesOf(true).find((choice) => choice.value === (sort ?? '')) ?? null
  const foot = workFootOf({ sort, sortWord: sortChoice ? s(`sort.${sortChoice.word}`) : null, customer: name, foot: work.urgencyFoot ?? null, portalHref: `${recordHref}?tab=portal#production-limits`, mayPortal: reader === 'owner' })
  // ---- end cw T.1
  const list: OrdersListModel = {
    prefix: '/w/DEMO',
    can,
    today: ORDERS_TODAY,
    layout: 'list',
    rows: view,
    q: '',
    list: { items: work.rows ? [...work.rows] : null, more: false, problem: work.problem ?? null },
    lanes: [],
    board: BOARD,
    asOf: ordersAt(29, 9, 42),
    live: 'live',
    updates: 0,
    notice: null,
    customer: { id: party.id, name },
    embedded: true,
    locked: { party: true, kind: false },
    listKey: 'sales.orders',
    views: workViewsOf({ price: work.price !== false }, work.notEqual ? { priceCheck: true } : {}), // F-CP-101; F-CP-141: Not equal (price grain only)
    viewCounts: { ...(workViewCounts(work.reads.board) ?? {}), ...(notEqual ? { [NOT_EQUAL_VIEW]: 2 } : {}) }, // F-CP-103; F-CP-141: the customer's own count
    defaultRows: WORK_DEFAULT_ROWS,
    preset: workPreset(view, null, columnSet === 'money'), // F-CP-141: the Not equal view opens on the money columns; F-CP-105: the toggle
    columnSet: can.price ? { value: columnSet } : null, // F-CP-105: the toggle, a price holder's only
    // ---- F-CP-141: the Not equal view (its host item ticked, the term's chip) or, without the price grain, the held line ----
    // F-CW-101 (S3): In production = the started orders' door, a view of the host (beside Not equal for a price holder).
    hostViews: [{ id: IN_PRODUCTION_VIEW, label: o('rows.IN_PRODUCTION') }, ...(work.notEqual && work.price !== false ? [{ id: NOT_EQUAL_VIEW, label: t('customers.work.view.notEqual'), active: notEqual }] : [])],
    ...(work.notEqual && work.price !== false ? { extra: { priceMatch: 'NOT_EQUAL' as const } } : {}),
    ...(work.notEqual && work.price === false ? { priceHeld: true } : {}),
    empty: workEmptyOf(view, null, name, t, `/w/DEMO/sales/customers/${party.id}?tab=work&rows=all`), // F-CP-101: per view
    // ---- F-CP-112: the row's Next steps window, the ticked orders and their bulk window, the band's New order window ----
    // cp-walk: the ticked orders' bar decides yeses too (Confirm N…), not only while a window is open.
    ...(work.command || work.many || work.ticked ? { commands: { window: work.command ? commandWindowOf(work.command, work.rows ?? [], can) : null, moved: [], receipt: null, many: work.many ? manyWindowOf(work.many, (work.rows ?? []).slice(0, 3), can) : null, decide: work.role !== 'manager' } } : {}),
    ...(work.ticked ? { selected: (work.rows ?? []).slice(0, work.ticked).map((row) => row.id) } : {}),
    // cp-walk: the bar's acts by each one's own right, as the live page reads them. F-CW-202 (10-design §4, §8): the Owner and the
    // Production manager assign supervisors, Sales does not; everyone here writes notes, replies and tasks (threads.post, tasks.manage).
    bulkCan: { supervisor: work.role === 'manager' || work.price !== false, note: true, task: null, reply: true },
    ...(work.newOrder ? { newOrder: newOrderOf(party, can.price) } : {}),
    // ---- end F-CP-112
    ...(work.unread ? { unread: work.unread } : {}), // F-CP-107 (cp-fx16)
    ...live, // cw T.1: the live tab's own options, over the earlier cases' ones
  }
  return createElement(
    'div',
    { className: 'fw-cw' },
    // F-CW-101: the band as the page draws it — the seven groups, the notes, what waits (a pick does nothing here: made-up).
    createElement(WorkBand, {
      model: {
        customer: name,
        picture: bandOf(work.reads.board),
        shown: work.phase ?? null, // cw T.1: a door pressed
        whys: whysOf(work.reads.board),
        before: beforeLineOf(work.before ?? (work.reads.board.status === 'ready' ? { drafts: 2, toAnswer: 1, openQuotes: 3, orderWaits: null } : NO_BEFORE_ORDER), `/w/DEMO/sales/customers/${party.id}`),
        chips: chipsOf({ orders: true, workorders: true, threads: true, partners: true }, work.reads),
        workOrdersHref: `/w/DEMO/production/work-orders?party=${party.id}`,
        repliesHref: '/w/DEMO/sales/incoming?tile=CUSTOMER_REPLIES',
        requestsHref: null,
      },
      actions: { onGroup: () => undefined, onAll: () => undefined, onView: () => undefined, onWindow: () => undefined } /* F-CQ-303: no onDrafts */,
    }),
    // F-CQ-303: the Work tab always shows the sheet — the drafts are Quotes & incoming's "Customer is writing" (DraftsTabDesign below).
    createElement(
      WorkTools,
      // cw T.1 → cw fx4: the Customise columns DIALOG open (the list tools' own design state). It was the Views ▾ MENU open: a DS
      // Menu draws into document.body, so that case could not draw on the server (every case of this screen must).
      { tools: work.customise ? { ...workTools, design: { dialog: 'customise' } } : workTools },
      createElement(OrdersListView, { model: work.priceWindow && work.price !== false ? { ...list, priceCheck: priceWindowOf(work.priceWindow) } : list /* F-CP-114 */, actions: work.live ? liveDoors(work, can.price) /* cw T.1 */ : workDoors(work, can.price) }),
    ),
    // cw T.1 (10-design §3.6): the foot line under the sheet — the order the rows stand in, the customer's urgency state.
    work.live ? createElement(WithMessages, { namespaces: [SHEET_NS] }, createElement(WorkFoot, { line: foot })) : null,
    work.linesWindow ? createElement(NewOrderWindow, { model: linesWindowOf(work.linesWindow, work.price !== false, party) }) : null, // F-CP-113
  )
}
// ---- end F-SA-276

function depthNodes(depth: DepthCase | undefined, partyId: string): SupplierDepth | undefined {
  if (!depth) return undefined
  const recordHref = `/w/DEMO/sales/customers/${partyId}`
  const glance = depth.glance ? { read: depth.glance, prefix: '/w/DEMO', recordHref } : null
  return {
    // F-SA-274: riders and measurement profiles on People & addresses. F-CO-203: the Overview's old parts (tiles, Now's samples and
    // repairs, the status card, the side panel) went — the Overview's rules read the case's glance (OverviewDesign below).
    ...(glance ? { people: createElement(GlanceNow, { model: glance, parts: ['profiles', 'riders'] }) } : {}),
    tax: depth.hold || depth.po ? createElement('div', { className: 'fw-cdp-two-wide' }, depth.hold ? createElement(HoldCard, { model: depth.hold }) : null, depth.po ? createElement(PoNumberCard, { model: depth.po }) : null) : null,
    requirements: depth.requirements ? createElement(RequirementsTab, { model: depth.requirements }) : null,
    contacts: depth.privacy ? createElement(PrivacyCard, { model: depth.privacy }) : null,
  }
}

// ---- F-CO-103 (customer page › Overview; 13-backend §3.9): the Overview tab of a case — the tab's own rules (./overview) over the
// case's models, with made-up work reads, counts and standing, so every case that drew the old Overview draws the new one. A read
// the case's reader has no right for is `off` / null, as the page and the API leave it (never a zero). Made-up data only.
const OFF_READ = { status: 'off' } as const

/** A plain glance for a case that hands none: nothing on hold, no part of the depth read. */
const plainGlance = (party: Party): Glance => ({
  party: { id: party.id, code: party.code, name: party.tradeName ?? party.legalName, kind: party.kind, status: party.status },
  company: { id: DEMO_COMPANIES[0].id, code: DEMO_COMPANIES[0].code, name: DEMO_COMPANIES[0].name },
  hold: { onHold: false, holds: [] },
  team: null,
  requirements: { count: 0, rows: [] },
  promises: null,
  credit: null,
  samples: null,
  profiles: null,
  riders: null,
  repairs: null,
  withheld: [],
  readAt: NOW,
})

// ---- F-CO-301 (customer Overview co-t T.1): what a case changes of the Overview's made-up reads — each a state its label promises.
// A read the case's reader has no right for stays `off` / null whatever the case says (as the page and the API leave it).
interface OverviewOver {
  /** The Work tab's reads (the board, requests, replies, our asks, tasks). */
  readonly reads?: Partial<WorkReads>
  /** The page's ONE count read: its parts (a part the reader may not read stays null), or still read, or failed. */
  readonly counts?: { readonly openQuotes?: number | null; readonly waitsOnUs?: number | null; readonly groups?: Partial<BeforeOrderCountsAnswer['groups']> } | 'reading' | 'failed'
  /** THIS customer's row of the joined read. */
  readonly standing?: WorkRead<CustomerWork | null>
  /** The glance (the depth provider's one read). */
  readonly glance?: Read<Glance>
}

function OverviewDesign({ record, party, money, depth, supervisor, designer, supervisorOpen = false, over = {} }: { record: PartyRecordModel; party: Party; money?: CustomerMoneyModel | undefined; depth?: DepthCase | undefined; supervisor?: SupervisorModel | undefined; designer?: DesignerModel | undefined; supervisorOpen?: boolean; over?: OverviewOver }) {
  const can = record.can
  const moneyCan = money?.can ?? customerMoneyCanOf([])
  const quotesTab = can.quotes || can.inquiries === true
  const given = { ...STRIP_READY, ...over.reads }
  const reads: WorkReads = {
    board: can.orders ? given.board : OFF_READ,
    requests: can.orders || can.workorders === true ? given.requests : OFF_READ,
    replies: can.threads ? given.replies : OFF_READ,
    asks: can.partners === true ? given.asks : OFF_READ,
    tasks: can.threads ? given.tasks : OFF_READ,
  }
  // The page's ONE count read as the API answers it: a part the reader has no right for is null (left out), never 0.
  const toAnswer = can.inquiries === true ? 1 : null
  const orderWaits = can.quotes ? 0 : null
  const derived: BeforeOrderCountsAnswer = {
    partyId: party.id,
    asOf: NOW,
    sampleRounds: null,
    openQuotes: can.quotes ? 3 : null,
    waitsOnUs: toAnswer === null && orderWaits === null ? null : (toAnswer ?? 0) + (orderWaits ?? 0),
    groups: { WRITING: can.orders ? 2 : null, TO_ANSWER: toAnswer, PREPARING: can.quotes ? 1 : null, APPROVAL: can.quotes ? 0 : null, WAITING_CUSTOMER: can.quotes ? 2 : null, ORDER_WAITS: orderWaits, WON: can.quotes ? 4 : null, MOVED: can.inquiries === true ? 0 : null, LOST: can.quotes ? 1 : null },
    byKind: { quotes: null, requests: null, portalOrders: null, drafts: null },
  }
  // A case's own counts keep the right's gate: a part the reader may not read stays null.
  const gated = <T,>(mine: T | null, theirs: T | null | undefined): T | null => (mine === null ? null : theirs === undefined ? mine : theirs)
  const overCounts = typeof over.counts === 'object' ? over.counts : null
  const counts: BeforeOrderCountsAnswer = overCounts
    ? {
        ...derived,
        openQuotes: gated(derived.openQuotes, overCounts.openQuotes),
        waitsOnUs: gated(derived.waitsOnUs, overCounts.waitsOnUs),
        groups: Object.fromEntries(Object.entries(derived.groups).map(([group, count]) => [group, gated(count, overCounts.groups?.[group as keyof BeforeOrderCountsAnswer['groups']])])) as BeforeOrderCountsAnswer['groups'],
      }
    : derived
  const looks: LooksAfter | null = supervisor ? { supervisor, designer: designer ?? null } : null
  // The glance's parts this case's reader may read: what its own answer withholds (a glance not in yet: every part, as the Owner).
  const glanceRead = over.glance ?? depth?.glance ?? ready(plainGlance(party))
  const mayRead = (part: 'samples' | 'repairs' | 'credit'): boolean => glanceRead.status !== 'ready' || !glanceRead.value.withheld.includes(part)
  const input: OverviewInput = {
    prefix: record.prefix,
    party,
    can: { orders: can.orders, quotesTab, moneyTab: can.money === true, receivables: moneyCan.receivables, price: can.price, returns: moneyCan.returns, complaints: moneyCan.complaints, partners: can.partners === true, manage: can.manage, block: can.block, vies: can.vies, workorders: can.workorders === true, samples: mayRead('samples'), repairs: mayRead('repairs'), credit: mayRead('credit') },
    today: TODAY,
    reads,
    counts: over.counts === 'reading' ? { counts: null, failed: false } : over.counts === 'failed' ? { counts: null, failed: true } : { counts, failed: false },
    glance: glanceRead,
    money: money ? { ageing: money.ageing, returns: money.returns, complaints: money.complaints, orders: money.orders ?? null, returnsHref: money.returnsHref } : { ageing: loading(), returns: loading(), complaints: loading(), orders: null, returnsHref: null },
    // This customer's row of the joined read (asked only with orders.view).
    standing: can.orders ? over.standing ?? { status: 'ready', value: { partyId: party.id, orders: 9, phases: [], late: 1, waitsForYes: 0, depositOpen: 1, requests: { open: 2, firstId: null }, replies: 3, customerUrgent: { count: 0, byCompany: [] }, priority: { top: 0, high: 0 }, nextPromise: '2026-11-14', lastOrderDate: '2026-10-21' } } : OFF_READ,
    // F-CO-201: who looks after (partners.view: the case's own models) — People's rows, and the urgency from the same read.
    urgency: looksUrgencyOf(looks),
    looksAfter: looks,
    projects: can.projects ? (record.projects ?? null) : null,
    viesRunning: record.viesRunning === true,
  }
  const recordHref = customerHref(record.prefix, party.id)
  const before = beforeLineOf(can.orders && typeof over.counts !== 'string' ? beforeOrderFor(counts, quotesTab) : NO_BEFORE_ORDER, recordHref)
  // Card 2: the Work tab's band as the page builds it for the Overview — no chips, no group pressed (a press does nothing here: made-up).
  const band = can.orders
    ? {
        model: { customer: party.tradeName ?? party.legalName, picture: bandOf(reads.board), shown: null, whys: whysOf(reads.board), before, chips: [], workOrdersHref: can.workorders === true ? workOrdersDoor(record.prefix, party.id) : null },
        actions: { onGroup: () => undefined, onAll: () => undefined },
      }
    : null
  const overview = overviewOf(input)
  // People's two Change… windows, the page's own — in a design case their INSIDE on a plain card, under the tab (F-CO-301: never a
  // Modal open on a server render). A case opens the supervisor's to show its form; the designer's opens by its model.
  return createElement(
    Fragment,
    null,
    createElement(CustomerOverviewView, { model: overview, band, before }),
    supervisor && supervisorOpen ? createElement(SupervisorWindow, { model: supervisor, name: overview.customer, onClose: () => undefined, inside: true }) : null,
    designer ? createElement(DesignerWindow, { model: designer, name: overview.customer, inside: true }) : null,
  )
}
// ---- end F-CO-103

// ---- F-CO-301 (customer Overview co-t T.1; 15-steps T.1; 13-backend §4): the Overview's own states (ids `co-*`) and the Overview as
// each office role reads it. Made-up data only (Moda Demo and the Seed people, SEED-* numbers, example.com). A role's rights are its
// template's REAL grant (the domain's role templates: permissions + grains as money.*); the glance's parts follow the domain's own rule
// (withheldParts), the money reads the Money lane's (customerMoneyCanOf); the record's rights mirror usePartyRecord's keys (a test
// holds the two together).
export const OVERVIEW_ROLES = ['owner', 'sales', 'production_manager', 'warehouse', 'finance', 'read_only'] as const
export type OverviewRole = (typeof OVERVIEW_ROLES)[number]

/** What a role's session holds on every company: its template's grant (its permissions, its grains as money.*). */
export const roleHeld = (role: OverviewRole): ReadonlySet<string> => new Set<string>(grantOf(templateOf(role)!, { allCompanies: true, companyIds: [], siteIds: [], partyIds: [] }).permissions)

/** The customer record's rights for what a session holds — usePartyRecord's own keys (areas/parties/_shared/PartyRecord.tsx). */
export function recordCanOf(held: ReadonlySet<string>): PartyRecordModel['can'] {
  return {
    ...RECORD_CAN,
    view: held.has('parties.view'),
    manage: held.has('parties.manage'),
    block: held.has('parties.block'),
    vies: held.has('parties.vies'),
    quotes: held.has('quotes.view'),
    orders: held.has('orders.view'),
    price: held.has('money.price'),
    cost: held.has('money.cost'),
    threads: held.has('threads.read'),
    partners: held.has('partners.view'),
    projects: held.has('threads.read'),
    projectsManage: held.has('projects.manage'),
    inquiries: held.has('sales.inquiries.view'),
    money: held.has('money.price') || held.has('receivables.view') || held.has('sales.credit.view'),
    ordersManage: held.has('orders.manage'),
    tasks: held.has('tasks.manage'),
    workorders: held.has('workorders.view'),
  }
}

const MODA_ID = by('MODA-DEMO').id
/** Moda Demo's ageing rows as the API sends them now: with its count of late invoices (S39; the API's cm-s). */
const LATE_AGEING = OVERDUE_ROWS.filter((row) => row.customer.id === MODA_ID).map((row, index) => ({ ...row, lateInvoices: index === 0 ? 3 : 1 }))
/** The same for a reader without the price grain: the server drops every amount (the count stays: it is no money). */
const noAmounts = (rows: typeof LATE_AGEING) => rows.map((row) => ({ ...row, open: undefined, overdue: undefined, buckets: undefined }))

/** Moda Demo at a glance for a role: on hold (a credit check, a quality dispute), over the limit — each part with its right only. */
function roleGlance(held: ReadonlySet<string>): Glance {
  const withheld = withheldParts((permission) => held.has(permission))
  const full = glanceOf('MODA-DEMO', HELD_GLANCE)
  const hidden = (part: (typeof withheld)[number]): boolean => withheld.includes(part)
  const shown: Glance = {
    ...full,
    promises: hidden('promises') ? null : full.promises,
    credit: hidden('credit') ? null : full.credit,
    samples: hidden('samples') ? null : full.samples,
    profiles: hidden('profiles') ? null : full.profiles,
    riders: hidden('riders') ? null : full.riders,
    repairs: hidden('repairs') ? null : full.repairs,
    withheld,
  }
  return held.has('money.price') ? shown : withoutPrices(shown)
}

/** Who looks after, for a role: read with partners.view only; Change… (supervisor) with production.brand.manage, (designer) partners.manage. */
function roleLooks(held: ReadonlySet<string>): Pick<CustomerCase, 'supervisor' | 'designer'> {
  if (!held.has('partners.view')) return {}
  const supervise = held.has('production.brand.manage')
  return {
    supervisor: { ...SUPERVISOR_CASES.saved, supervise, ...(supervise ? {} : { pick: { status: 'held', key: 'held.noRight', ns: 'production-supervisor' } as const }) },
    designer: designerModel({ manage: held.has('partners.manage') }),
  }
}

/** The Overview of Moda Demo (on hold, over the limit, invoices late) as a role reads it. */
export function roleCase(role: OverviewRole): CustomerCase {
  const held = roleHeld(role)
  const price = held.has('money.price')
  return {
    ...record('MODA-DEMO', { tab: 'overview', can: recordCanOf(held) }),
    money: moneyModel(customerMoneyCanOf([...held]), { ageing: loaded(price ? LATE_AGEING : noAmounts(LATE_AGEING)) }),
    ...roleLooks(held),
    overview: { glance: ready(roleGlance(held)) },
  }
}

/** A board of the case's own counts by state (the phases follow the states, as the API counts them; nothing late). */
function boardOfStates(byStatus: Partial<Record<OrderRow['status'], number>>): WorkReads['board'] {
  const phases = phaseCountsOf(byStatus, 1)
  return {
    status: 'ready',
    value: {
      ...BOARD,
      byStatus: (Object.entries(byStatus) as Array<[OrderRow['status'], number]>).map(([status, count]) => ({ status, count })),
      byPhase: ORDER_PHASES.map((phase) => ({ phase, count: phases[phase] })),
      notSent: { waitsForYes: 0, waitsForDeposit: 0 },
      tiles: BOARD.tiles.map((tile) => ({ ...tile, count: 0 })),
    },
  }
}

/** A case of Moda Demo on its Overview, made of the case's own reads. */
const coCase = (over: { code?: string; record?: Partial<PartyRecordModel>; money?: CustomerMoneyModel; overview?: OverviewOver; looks?: boolean } = {}): CustomerCase => ({
  ...record(over.code ?? 'MODA-DEMO', { tab: 'overview', ...over.record }),
  money: over.money ?? moneyModel(MONEY_CAN.finance, { ageing: loaded(LATE_AGEING) }),
  ...(over.looks === false ? {} : { supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.set }),
  ...(over.overview ? { overview: over.overview } : {}),
})
const NOTHING_LATE = moneyModel(MONEY_CAN.finance, { ageing: loaded([]), returns: loaded([]), complaints: loaded([]) })
const warning = (code: Party['warnings'][number]['code'], blocksInvoice: boolean): Party['warnings'][number] => ({ code, message: '', blocksInvoice })
// ---- end F-CO-301 (helpers)

function CustomerDesign({ model }: { model: CustomerCase }) {
  const { terms, money, depth, supervisor, people, work, designer, priceDiffer, shipmentLine, supervisorOpen, overview, ...record } = model
  // ---- cq W3 (T part 2): Quotes & incoming — the tab's own gallery parts (quotes-tab/fixtures.ts) for this customer; a Work case's
  // portal drafts are its "Customer is writing" (F-CQ-303).
  const quotesIncoming = record.party && record.tab === 'quotes' ? (work?.drafts ? createElement(DraftsTabDesign, { work, party: record.party }) : createElement(QuotesTabDesign, { model: quotesTabFor({ id: record.party.id, name: record.party.tradeName ?? record.party.legalName }) })) : null
  // ---- end cq W3
  const party = record.party
  const id = party?.id ?? 'x'
  // F-CO-103: the Overview tab, built for the tab the page shows (as the live container builds it); F-CO-201: who looks after is
  // People's rows (the case's supervisor and designer models), each Change… the page's own window.
  const overviewTab = party && shownTab(recordTabs(SIDES.customers, record.can), record.tab) === 'overview' ? createElement(OverviewDesign, { record, party, money, depth, supervisor, designer, supervisorOpen: supervisorOpen === true, ...(overview ? { over: overview } : {}) }) : null
  // ---- F-CM-104 (cm-w1 W1.4): the Money tab, built for the tab the page shows (as the live container builds it) from made-up reads —
  // Finance's view with the price grain, else Sales' (words only); a case's priceDiffer is the page's price count.
  // F-CM T.1: a cm-* case draws the tab with every section's reads, its room and the window it opens in place (money/_demo/fixtures.ts).
  const moneyTab = party && shownTab(recordTabs(SIDES.customers, record.can), record.tab) === 'money' ? (model.cm ? createElement(CmMoneyDesign, { cm: model.cm }) : createElement(CustomerMoneyTab, { input: moneyTabDemo(record.can.price ? 'finance' : 'sales', { priceDiffer: priceDiffer ?? null }), prefix: record.prefix, asOf: '2026-10-31T09:44:00.000Z', onRetry: () => undefined })) : null
  // ---- end F-CM-104
  // F-CA-120 (ca-w1 W1.4): People & addresses, built for the tab the page shows (as the live container builds it) — the page's own model
  // rule over the case's models; today's riders / profiles and personal-data cards under it (the depth slot's, until ca-w2).
  const nodes = depthNodes(depth, id)
  const portal = record.can.partners ? (people?.portal ?? null) : null
  const peopleTab =
    party && shownTab(recordTabs(SIDES.customers, record.can), record.tab) === 'people'
      ? createElement(PeopleTab, {
          model: peopleTabModel({ party, prefix: record.prefix, can: peopleCanOf(record.can), now: NOW, portal, privacy: depth?.privacy?.read ?? null, usage: null, approverId: null, profiles: null, riders: ridersOfCase(party, depth?.glance) }, PEOPLE_TAB_START),
          portal: portal ? { model: portal } : null,
          recordHref: `${record.prefix}/sales/customers/${id}`,
          after: createElement(Fragment, null, nodes?.people, nodes?.contacts),
        })
      : null
  // F-CA-120: end
  return inShell(
    `/sales/customers/${id}`,
    createElement(
      WithMessages,
      { namespaces: DEPTH_NAMESPACES },
      // B-TH-260: the customer's docked thread (Activity and Documents went to it), with threads.read.
      createElement(CustomerRecordView, { model: record, thread: party ? (shipmentLine && record.can.threads ? createElement(ShipmentLineThread, { party }) /* cw T.1 */ : partyThread(party, 'customers', record.can)) : null, terms: termsCard(terms ?? termsModel()), money, depth: nodes, overviewTab /* F-CO-103 */, peopleTab /* F-CA-120 */, peopleBadge: party ? peopleBadgeOf(party) : null /* F-CA-120 */, work: work && party ? createElement(WithMessages, { namespaces: ['orders'] /* F-CW-101: as the live Work tab loads them */ }, createElement(WorkDesign, { work, party })) : null /* F-SA-276 */, workCount: work ? { count: 5, attention: true } : null, priceDiffer: priceDiffer ?? null /* F-CP-141 */, quotesIncoming /* cq W3 */, moneyTab /* F-CM-104 */ }),
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
  ...record('MARCHIO-ESEMPIO', { tab: 'terms', can: DEPTH_CAN, ...over }),
  depth: { hold: holdModel(hold, can), po: poModel(po, can) },
})
const reqModel = (over: Partial<RequirementsModel> = {}, can: DepthCan = ALL_CAN): RequirementsModel => ({ read: ready(REQUIREMENTS), can, status: 'ACTIVE', dialog: null, styles: ready(STYLES), files: ready(FILES), companies: COMPANIES, ...over })
const reqCase = (over: Partial<RequirementsModel> = {}, can: DepthCan = ALL_CAN, record_: Partial<PartyRecordModel> = {}): CustomerCase => ({ ...record('MARCHIO-ESEMPIO', { tab: 'terms', can: DEPTH_CAN, ...record_ }), depth: { requirements: reqModel(over, can) } })
const privacyModel = (over: Partial<PrivacyModel> = {}, can: DepthCan = ALL_CAN): PrivacyModel => ({ read: ready(PRIVACY), can, status: 'ACTIVE', today: TODAY, dialog: null, stepUp: STEP_UP_CLOSED, portalHref: `/w/DEMO/sales/customers/${by('MODA-DEMO').id}?tab=portal`, ...over })
const privacyCase = (over: Partial<PrivacyModel> = {}, can: DepthCan = ALL_CAN): CustomerCase => ({ ...record('MODA-DEMO', { tab: 'people', can: DEPTH_CAN }), depth: { privacy: privacyModel(over, can) } })
const dialogState = { busy: false, failed: null, tried: false } as const
const firstContact = PRIVACY.contacts[0]!
const consentContact = PRIVACY.contacts[2]!
const words = { words: '', portal: false, copy: null, kept: null } as const

const termsCase = (code: string, terms: CommercialTermsModel, over: Partial<PartyRecordModel> = {}): CustomerCase => ({ ...record(code, { tab: 'terms', ...over }), terms })

export const designScreen = defineDesignScreen<CustomerCase>({
  screen: 'SCR-033',
  title: 'Customer record',
  view: CustomerDesign,
  cases: [
    {
      id: 'overview',
      label: 'Overview: an Italian business ready to invoice',
      model: record('MODA-DEMO'),
      note: 'F-CO-301: the Overview from the shared kit — the sentence, the band in its card, People both sides, Next dates, Requests & changes, Linked records, Customer facts.',
    },
    {
      id: 'overview-missing',
      label: "Overview: a prospect that can't be invoiced yet",
      model: record('NUOVO-PROVA', { quotes: loaded([]), orders: loaded([]) }),
      note: "F-CO-301: the sentence says Prospect; Can't invoice yet with each step's own button; what is still to complete sits in Customer facts.",
    },
    { id: 'overview-fiscal-drawer', label: 'Overview: a brand without SDI code or PEC', model: record('MARCHIO-ESEMPIO') },
    // B-W2a-81: Overdue and Returns this year (key numbers), Open returns and claims (Now), Finance › Receivables.
    { id: 'w2a-numbers', label: 'Overview (W2a): the Overdue strip with its amount and its oldest day; open returns and complaints in Linked records; Receivables & credit ›', model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.finance) }, note: 'Overdue · €4,270.00, oldest 38 days late (a door to Money); 2 open returns, the oldest named, and 1 open complaint with its next answer, in Linked records.' }, // B-CP-011
    { id: 'w2a-numbers-no-price', label: 'Overview (W2a) without the price grain: "Invoices are late", the oldest day — no amount, no count of invoices', model: { ...record('MODA-DEMO', { can: { ...RECORD_CAN, price: false }, quotes: loaded(withoutMoney(QUOTES)), orders: loaded(withoutMoney(ORDERS)) }), money: moneyModel(MONEY_CAN.noPrice) } },
    { id: 'w2a-numbers-nothing', label: 'Overview (W2a): nothing late, no return this year, nothing open', model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.finance, { ageing: loaded([]), returns: loaded([]), complaints: loaded([]) }) } },
    { id: 'w2a-numbers-loading', label: 'Overview (W2a): the money reads still out — Returns and Complaints read in Linked records', model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.finance, MONEY_STATES.loading) } },
    { id: 'w2a-numbers-failed', label: "Overview (W2a): the ageing and the returns couldn't be read — no Overdue strip; Returns says Could not be read", model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.finance, MONEY_STATES.failed) } },
    { id: 'w2a-numbers-no-receivables', label: 'Overview (W2a) without receivables.view: no Overdue strip, no Receivables & credit door', model: { ...record('MODA-DEMO'), money: moneyModel(MONEY_CAN.none) } },
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
    // ---- F-CO-301 (customer Overview co-t T.1; 15-steps T.1): the Overview's own states — made-up data only ----
    { id: 'co-busy', label: 'co · A busy customer: the sentence, the seven groups in their card, People both sides, Next dates, Requests & changes, Linked records (Urgent (customer), Priority Top / High), Customer facts', model: coCase({ overview: { glance: ready(glanceOf('MODA-DEMO')), standing: { status: 'ready', value: { partyId: MODA_ID, orders: 14, phases: [], late: 1, waitsForYes: 0, depositOpen: 1, requests: { open: 2, firstId: null }, replies: 3, customerUrgent: { count: 3, byCompany: [] }, priority: { top: 1, high: 1 }, nextPromise: '2026-11-14', lastOrderDate: '2026-10-21' } } } }) },
    { id: 'co-hold', label: 'co · On hold (a credit check and a quality dispute) and over the credit limit — ONE strip for the credit hold, the limit its line; Overdue with its amount and how many invoices are late', model: coCase({ overview: { glance: ready(glanceOf('MODA-DEMO', HELD_GLANCE)) } }) },
    { id: 'co-blocked', label: 'co · Blocked: "Blocked since …", its reason, and "Unblock it from the ⋯ menu above." (no button on the strip)', model: coCase({ code: 'BLOCCATO-DEMO', money: NOTHING_LATE }) },
    { id: 'co-invoice-vies', label: "co · Can't invoice yet (no tax identity: its own step) and VIES not proven (Check VIES in place)", model: coCase({ record: { party: { ...by('MODA-DEMO'), invoiceBlocked: true, warnings: [warning('NO_TAX_IDENTITY', true), warning('VIES_NOT_PROVEN', false)] } }, money: NOTHING_LATE }) },
    { id: 'co-prospect', label: 'co · A prospect with no order: "Prospect", activate it to take orders; the band says no order yet with the Before-an-order doors', model: coCase({ code: 'NUOVO-PROVA', money: NOTHING_LATE, overview: { reads: { board: boardOfStates({}) } } }) },
    { id: 'co-quotes-only', label: 'co · No order yet, quotes only: "No order yet"; the band\'s one quiet line and its Before-an-order doors; Linked records says the open quotes', model: coCase({ money: NOTHING_LATE, overview: { reads: { board: boardOfStates({}) }, counts: { openQuotes: 2, groups: { WRITING: 1, ORDER_WAITS: 0 } } } }) },
    { id: 'co-no-open', label: 'co · No open order (five done, one cancelled): "No open order" with the last order; Next dates is left out and People takes the row', model: coCase({ money: NOTHING_LATE, overview: { reads: { board: boardOfStates({ DELIVERED: 3, CLOSED: 2, CANCELLED: 1 }), requests: { status: 'ready', value: { items: [], open: 0, countered: 0 } }, replies: { status: 'ready', value: { rows: [], count: 0, complete: true } }, tasks: { status: 'ready', value: { items: [], total: 0, complete: true } } }, standing: { status: 'ready', value: { partyId: MODA_ID, orders: 6, phases: [], late: 0, waitsForYes: 0, depositOpen: 0, requests: { open: 0, firstId: null }, replies: 0, customerUrgent: { count: 0, byCompany: [] }, priority: { top: 0, high: 0 }, nextPromise: null, lastOrderDate: '2026-09-03' } } } }) },
    { id: 'co-archived', label: 'co · Archived: "Archived", read only until it is reactivated; every button held with "Archived: reactivate it first"', model: coCase({ code: 'ARCHIVIATO-DEMO', money: NOTHING_LATE }) },
    { id: 'co-five-strips', label: 'co · Six things stop the customer: Blocked, two holds, Can\'t invoice yet, VIES not proven, Overdue — the first four, then "Show 2 more"', model: coCase({ code: 'BLOCCATO-DEMO', record: { party: { ...by('BLOCCATO-DEMO'), invoiceBlocked: true, warnings: [warning('NO_TAX_IDENTITY', true), warning('VIES_NOT_PROVEN', false)] } }, overview: { glance: ready(glanceOf('MODA-DEMO', HELD_GLANCE)) } }) },
    { id: 'co-reading', label: 'co · Every read still out: the sentence\'s placeholder, the strips\' reading row, each card\'s skeleton, Requests & changes loading', model: { ...coCase({ looks: false, money: moneyModel(MONEY_CAN.finance, MONEY_STATES.loading), overview: { reads: { board: { status: 'reading' }, requests: { status: 'reading' }, replies: { status: 'reading' }, asks: { status: 'reading' }, tasks: { status: 'reading' } }, counts: 'reading', standing: { status: 'reading' }, glance: LOADING } }), supervisor: { ...SUPERVISOR_CASES.saved, state: 'loading', read: null }, designer: DESIGNER_CASES.loading } },
    { id: 'co-failed', label: 'co · Every read failed: the holds and the credit could not be read (Try again, the last strip), the band and Requests & changes with Try again, People\'s failed state, rows that say "Could not be read"', model: { ...coCase({ looks: false, money: moneyModel(MONEY_CAN.finance, MONEY_STATES.failed), overview: { reads: { board: { status: 'failed' }, requests: { status: 'failed' }, replies: { status: 'failed' }, asks: { status: 'failed' }, tasks: { status: 'failed' } }, counts: 'failed', standing: { status: 'failed' }, glance: failedRead('problem.unavailable') } }), supervisor: { ...SUPERVISOR_CASES.saved, state: 'error', read: null, problem: 'failed.title' }, designer: DESIGNER_CASES.error } },
    { id: 'co-no-orders', label: 'co · A reader without orders.view: the status word, then only what its reads say — no band, no order row, no next promise', model: coCase({ record: { can: { ...RECORD_CAN, orders: false } } }) },
    // The Overview as each office role reads it (the role template's real grant): Moda Demo on hold, over the limit, invoices late.
    { id: 'co-role-owner', label: 'co · As Owner: every card, every amount, both Change…', model: roleCase('owner') },
    { id: 'co-role-sales', label: 'co · As Sales (no price grain): "Invoices are late" and the credit in words — no amount, no count of invoices; Change… on the designer only', model: roleCase('sales') },
    { id: 'co-role-production-manager', label: 'co · As Production manager: no money strip, no Credit fact, no Money door; Change… on the supervisor only; "You can view, not change"', model: roleCase('production_manager') },
    { id: 'co-role-warehouse', label: 'co · As Warehouse: the sentence, the band, the contacts, the order dates, requests and tasks, orders / repairs / returns, the facts — no office people, no portal, no money; no button', model: roleCase('warehouse') },
    { id: 'co-role-finance', label: 'co · As Finance: the money with its amounts, quotes, repairs, returns — no office people, no portal, no samples, no complaints', model: roleCase('finance') },
    { id: 'co-role-read-only', label: 'co · As Read-only: every card, no amount, no button; "You can view, not change"', model: roleCase('read_only') },
    // ---- end F-CO-301 (cases)
    { id: 'addresses', label: 'People & addresses', model: record('MODA-DEMO', { tab: 'people' }), note: 'The default switches save at once; Edit opens the address.' },
    { id: 'addresses-saving', label: 'Addresses: a default being saved', model: record('MODA-DEMO', { tab: 'people', saving: `shipTo:${by('MODA-DEMO').addresses[1]!.id}` }) },
    { id: 'addresses-empty', label: 'People & addresses: none yet', model: record('NUOVO-PROVA', { tab: 'people' }) },
    { id: 'address-new', label: 'Add an address', model: record('MODA-DEMO', { tab: 'people', dialog: { kind: 'address' } }) },
    {
      id: 'address-edit',
      label: 'Edit an address (sent documents keep their copy)',
      model: record('MODA-DEMO', { tab: 'people', dialog: { kind: 'address', addressId: by('MODA-DEMO').addresses[1]!.id } }),
    },
    {
      id: 'address-refused',
      label: 'An address refused by the API',
      model: record('MODA-DEMO', { tab: 'people', dialog: { kind: 'address', addressId: by('MODA-DEMO').addresses[0]!.id }, dialogProblem: 'problem.invalid', refused: ['postalCode'] }),
    },
    { id: 'contact-new', label: 'Add a contact', model: record('MODA-DEMO', { tab: 'people', dialog: { kind: 'contact' } }) },
    { id: 'tax', label: 'Terms & requirements: an Italian identity', model: record('MODA-DEMO', { tab: 'terms' }) },
    { id: 'tax-eu-valid', label: 'Terms & requirements: VIES valid, with its proof', model: record('DE-BEISPIEL', { tab: 'terms' }) },
    { id: 'tax-eu-invalid', label: 'Terms & requirements: VIES answered not valid', model: record('FR-EXEMPLE', { tab: 'terms' }) },
    { id: 'tax-eu-held', label: "Terms & requirements: VIES didn't answer (held, not a refusal)", model: record('AT-MUSTER', { tab: 'terms' }) },
    { id: 'tax-eu-unchecked', label: 'Terms & requirements: never checked', model: record('ES-PRUEBA', { tab: 'terms', history: loaded([]) }) },
    {
      id: 'tax-checking',
      label: 'Terms & requirements: a check running',
      model: record('ES-PRUEBA', { tab: 'terms', viesRunning: true, notice: { key: 'vies.checkingOne', tone: 'info', params: { name: 'Prueba Motos S.L.' } } }),
    },
    { id: 'identity-new', label: 'New tax identity from a date', model: record('MODA-DEMO', { tab: 'terms', dialog: { kind: 'identity', mode: 'new' } }) },
    { id: 'identity-correct', label: 'Correct the identity in force (add the SDI code)', model: record('MARCHIO-ESEMPIO', { tab: 'terms', dialog: { kind: 'identity', mode: 'correct' } }) },
    { id: 'identity-first', label: 'A first tax identity', model: record('NUOVO-PROVA', { tab: 'terms', dialog: { kind: 'identity', mode: 'new' } }) },
    // ---- F-SA-276: Work — the waiting strip and the Orders sheet locked to the customer. F-CP-101: All orders first (the default) ·
    // In production · Waiting on us · Late.
    { id: 'quotes-orders', label: 'F-CP-101 · Work opens on All orders: the strip (two groups and the tasks) and every order (Status shown)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO')) }) },
    // F-CP-107 (cp-fx16): the status once (Where it is says "Not in work yet"); the number and the status whole at 1440 beside the dock.
    { id: 'work-waiting-yes', label: 'F-CP-107 · Work: All orders — a waiting-for-a-yes row on a long number (SEED-SO-W39-01): its status once, "Not in work yet" under Where it is; number and status whole at 1440 beside the dock', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: waitingYesRows(by('MODA-DEMO')), unread: waitingYesUnread(by('MODA-DEMO')) }) },
    { id: 'quotes-orders-all', label: 'F-CP-101 · Work: the view In production (no Status column: every row is in production)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO'), () => ({ status: 'IN_PRODUCTION' })), view: 'IN_PRODUCTION' }) },
    {
      id: 'quotes-orders-no-price',
      label: 'F-SA-276 · Work without the price grain (no money column, never 0)',
      model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO'), () => ({ netAmount: undefined, grossAmount: undefined, paid: undefined, balance: undefined })), price: false }, { can: { ...RECORD_CAN, price: false }, quotes: loaded(withoutMoney(QUOTES)), orders: loaded(withoutMoney(ORDERS)) }),
    },
    { id: 'quotes-orders-empty', label: 'F-CP-101 · Work: All orders, none yet ("<customer> has no order yet.")', model: workCase('NUOVO-PROVA', { reads: STRIP_READY, rows: [] }) },
    // ---- F-CP-113: "Add the lines" — the New order page's own editor in a large centred window over the Work tab (one editor, two doors).
    { id: 'work-new-order-lines', label: 'F-CP-113 · Work: New order › Add the lines — the lines editor in a large window on this page (no page hop)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO')), linesWindow: 'lines' }) },
    { id: 'work-new-order-lines-no-price', label: 'F-CP-113 · Sales worker without prices: the same window, "Priced from <customer>\'s price list", no price typed', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO')), linesWindow: 'lines', price: false }) },
    // ---- F-CP-107 → F-CQ-303: the customer's portal drafts, read only, are Quotes & incoming's "Customer is writing" (the WRITING door;
    // a row docks its conversation; Open: its window) — no longer a view of the Work tab.
    { id: 'work-drafts', label: 'F-CQ-303 · Quotes & incoming › Customer is writing: two portal drafts, read only (one live update waiting)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: [], drafts: 'list' }, { tab: 'quotes', can: { ...RECORD_CAN, inquiries: true } }) },
    { id: 'work-drafts-no-price', label: 'F-CQ-303 · Customer is writing as a Sales worker without prices: no Value column, readiness counted of 6', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: [], drafts: 'list', price: false }, { tab: 'quotes', can: { ...RECORD_CAN, inquiries: true } }) },
    { id: 'work-drafts-empty', label: 'F-CQ-303 · Customer is writing: none in the portal yet', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: [], drafts: 'empty' }, { tab: 'quotes', can: { ...RECORD_CAN, inquiries: true } }) },
    { id: 'work-drafts-window', label: 'F-CQ-303 · A draft open in its window (from Customer is writing): read only, Accept and Refuse held with why, J / K between drafts', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: [], drafts: 'window' }, { tab: 'quotes', can: { ...RECORD_CAN, inquiries: true } }) },
    { id: 'work-new-order-discard', label: 'F-CP-113 · Discard asks first when something is typed', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO')), linesWindow: 'discard' }) },
    // ---- F-CP-114: "Set customer's price…" (row ⋯, or the Customer's price cell) — the ONE window, price holders only.
    { id: 'work-price-window', label: 'F-CP-114 · Work: Set customer\'s price… — per line a unit price or a line total, the PO file, an optional order total', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO')), priceWindow: 'edit' }) },
    { id: 'work-price-window-stale', label: 'F-CP-114 · Changed meanwhile (409): "Someone changed these prices meanwhile. Here they are now."', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO')), priceWindow: 'stale' }) },
    { id: 'work-price-window-closed', label: 'F-CP-114 · A closed order keeps its prices: read only, Save held with why', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO')), priceWindow: 'closed' }) },
    // ---- F-CP-105: "Columns: Work · Money" on All orders — as Owner (the money columns), as Sales worker and as Production manager
    // (the same address `cols=money`: no toggle, the Work columns, no money column).
    { id: 'work-cols-money', label: 'F-CP-105 · Work: Columns: Work · Money on Money — Number, Status, Our price, Customer\'s price, Price check, Balance (a person\'s Customise wins)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: notEqualRows(by('MODA-DEMO')), cols: 'money' }) },
    { id: 'work-cols-sales-worker', label: 'F-CP-105 · As Sales worker with cols=money in the address: no toggle, the Work columns, no money column', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO'), () => ({ netAmount: undefined, grossAmount: undefined, paid: undefined, balance: undefined })), price: false, cols: 'money' }, { can: { ...RECORD_CAN, price: false } }) },
    { id: 'work-cols-manager', label: 'F-CP-105 · As Production manager with cols=money in the address: no toggle, the Work columns, no money column', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO'), () => ({ netAmount: undefined, grossAmount: undefined, paid: undefined, balance: undefined })), price: false, role: 'manager', cols: 'money' }, { can: { ...RECORD_CAN, price: false, ordersManage: false } }) },
    // ---- F-CP-141: the Not equal view (price holders only), and the same address as a Sales worker.
    { id: 'work-not-equal', label: 'F-CP-141 · Work: Not equal — every order whose prices differ, on the money columns (Our price, Customer\'s price, Price check, Balance), its count in Views ▾', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: notEqualRows(by('MODA-DEMO')), notEqual: 'view' }) },
    { id: 'work-not-equal-no-price', label: 'F-CP-141 · As Sales worker: a shared view with the price term — one line, no rows, Show all orders; no Not equal in Views ▾, no count', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: [], price: false, notEqual: 'held' }, { can: { ...RECORD_CAN, price: false } }) },
    { id: 'work-price-window-no-price', label: 'F-CP-114 · As Sales worker (no price grain): no door, no window, no call', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO'), () => ({ netAmount: undefined, grossAmount: undefined })), price: false, priceWindow: 'edit' }, { can: { ...RECORD_CAN, price: false } }) },
    { id: 'quotes-orders-empty-production', label: 'F-CP-101 · Work: In production, nothing (the way to All orders)', model: workCase('NUOVO-PROVA', { reads: STRIP_READY, rows: [], view: 'IN_PRODUCTION' }) },
    // ---- F-CP-112 (SCR-033): New order in place, the row's Next steps window, the bulk window (light / dark; 375 / 1440 / 1920) ----
    { id: 'work-new-order', label: 'F-CP-112 · Work: New order from the band — the customer held (no Change), Add the lines opens the lines window here', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO')), newOrder: true }) },
    { id: 'work-new-order-no-price', label: 'F-CP-112 · As Sales worker (no price grain): the same window says "Priced from <customer>\'s price list"', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO'), () => ({ netAmount: undefined, grossAmount: undefined })), newOrder: true, price: false }, { can: { ...RECORD_CAN, price: false } }) },
    { id: 'work-command-ready', label: 'F-CP-112 · Work: row ⋯ Next steps › Mark ready… — the order page\'s own dialog on the order as read (a reason)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: commandRows(by('MODA-DEMO')), command: 'ready' }) },
    { id: 'work-command-close', label: 'F-CP-112 · Close order… on a shipped order not settled: "not settled" in words and a reason — never an amount', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: commandRows(by('MODA-DEMO')), command: 'close', price: false }, { can: { ...RECORD_CAN, price: false } }) },
    { id: 'work-command-held', label: 'F-CP-112 · Mark ready… held in the order page\'s words: the order moved since the row was read (not in production)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: commandRows(by('MODA-DEMO')), command: 'held' }) },
    { id: 'work-command-reading', label: 'F-CP-112 · The Next steps window while the order is read (its number in the title)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: commandRows(by('MODA-DEMO')), command: 'reading' }) },
    { id: 'work-bulk-bar', label: 'F-CW-202 · Three orders ticked: the bar — Ask ▾ · Set priority for 3 · Reply to Moda Demo on 3… with their words, then More ▾ (Assign supervisor · Add task · Note ‖ Mark 3 ready… · Close 3… · Confirm 3… ‖ Invoice shipped goods; held in words where none is in its state)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: commandRows(by('MODA-DEMO')), ticked: 3 }) },
    { id: 'work-bulk-bar-manager', label: 'F-CW-202 · As Production manager: Ask ▾ · Reply to Moda Demo on 3… · Assign supervisor…, then More ▾ (Add task · Note) — no Set priority, no Mark ready, no Close (no orders.manage: not drawn); no money anywhere', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: commandRows(by('MODA-DEMO')).map((row) => ({ ...row, netAmount: undefined, grossAmount: undefined, paid: undefined, balance: undefined })), ticked: 3, price: false, role: 'manager' }, { can: { ...RECORD_CAN, price: false, ordersManage: false } }) },
    { id: 'work-bulk-preview', label: 'F-CP-112 · Mark 3 ready…: the preview — "Runs on 2 · Not on 1", why beside it, each order by number, one reason', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: commandRows(by('MODA-DEMO')), ticked: 3, many: 'preview' }) },
    { id: 'work-bulk-result', label: 'F-CP-112 · Mark 3 ready…: the result — "1 done · 1 not done", the order changed meanwhile, Run the rest again', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: commandRows(by('MODA-DEMO')), ticked: 3, many: 'result' }) },
    // ---- end F-CP-112
    // ---- F-CP-148 (the money wall, Owner O1–O3): "Seen as" on the Work tab — Owner (work-cols-money, work-not-equal, work-price-window,
    // work-drafts), Sales worker (work-cols-sales-worker, work-not-equal-no-price, work-price-window-no-price, work-drafts-no-price) and
    // the Production manager below; Brand Alpha never reaches an office screen (its own cases are the portal's). ----
    { id: 'cp-148-work-manager', label: 'F-CP-148 · Seen as Production manager · Work on All orders: no toggle, no money column, no Set customer\'s price…, New order held', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO'), () => ({ netAmount: undefined, grossAmount: undefined, paid: undefined, balance: undefined })), price: false, role: 'manager' }, { can: { ...RECORD_CAN, price: false, ordersManage: false } }) },
    { id: 'cp-148-work-not-equal-manager', label: 'F-CP-148 · Seen as Production manager · a link with the price term: one line, no rows, Show all orders; no Not equal in Views ▾', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: [], price: false, notEqual: 'held', role: 'manager' }, { can: { ...RECORD_CAN, price: false, ordersManage: false } }) },
    { id: 'cp-148-price-window-manager', label: 'F-CP-148 · Seen as Production manager · no customer\'s-price door, no window, no call', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO'), () => ({ netAmount: undefined, grossAmount: undefined })), price: false, role: 'manager', priceWindow: 'edit' }, { can: { ...RECORD_CAN, price: false, ordersManage: false } }) },
    { id: 'cp-148-drafts-manager', label: 'F-CP-148 · Seen as Production manager · Customer is writing (F-CQ-303: on Quotes & incoming): no Value column, readiness counted of 6', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: [], drafts: 'list', price: false, role: 'manager' }, { tab: 'quotes', can: { ...RECORD_CAN, price: false, ordersManage: false, inquiries: true } }) },
    // ---- end F-CP-148
    { id: 'quotes-orders-reading', label: 'F-SA-276 · Work: the strip and the rows reading ("—", never 0)', model: workCase('MODA-DEMO', { reads: STRIP_READING, rows: null }) },
    { id: 'quotes-orders-error', label: "F-SA-276 · Work: the orders couldn't be read (the strip stays usable)", model: workCase('MODA-DEMO', { reads: { ...STRIP_READY, requests: { status: 'failed' } }, rows: [], problem: 'problem.read.unavailable' }) },
    // ---- cw T.1 (customer Work tab; 10-design §8, §9): the states the seed lacks, on the live tab's own options — made-up orders
    // SEED-SO-0001 … 0014 of a made-up customer. More ▾, a row's ⋯ and Sort ▾ open by a press in any of these cases.
    { id: 'cw-busy', label: 'cw · Work: a busy customer — 14 orders in all seven groups (2 · 1 · 4 · 1 · 2 · 3 · 1), "Most urgent first"; the customer\'s Urgent 1–3, one "Urgent – asked" (a door), one "Set to regular by us" (locked); our Top, High and Low; late, at risk, on hold, a request to answer, "Asked production"; shipped, done and cancelled rows with no stage; the foot line', model: liveCase() },
    { id: 'cw-busy-widest', label: 'cw · The same in the widest room (from 1765 px of sheet): Priority, Waiting on, Deposit, Pieces, Shipped, Ordered and Supervisor join', model: liveCase({ room: 'widest' }) },
    { id: 'cw-switch-off', label: 'cw · The customer\'s urgency switch OFF: no customer chip on any row; the foot says "Customer urgency is off for <customer> · Portal settings ›"; "Most urgent first" has no middle part', model: liveCase({ rows: busy().map((row) => ({ ...row, customerUrgency: null, customerUrgencyState: null })), urgencyFoot: { on: false, used: 0, max: 3, companies: [] } }) },
    { id: 'cw-two-companies', label: 'cw T.0 · Orders at two of our companies: the foot names each with its own numbers ("Seed A 2 of at most 3 · Seed B 1 of at most 3")', model: liveCase({ urgencyFoot: { on: true, used: 3, max: 6, companies: [{ name: 'Seed A', used: 2, max: 3 }, { name: 'Seed B', used: 1, max: 3 }] } }) },
    { id: 'cw-drafts-only', label: 'cw · No order yet, two drafts in the portal: seven zeros in the band, "Before an order: 2 drafts" (F-CQ-303: a door to Quotes & incoming › Customer is writing), the sheet\'s line with the same door', model: liveCase({ rows: [], reads: seedReads([], NO_PHASES), before: { drafts: 2, toAnswer: null, openQuotes: null, orderWaits: null }, urgencyFoot: { on: true, used: 0, max: 3, companies: [] } }) },
    { id: 'cw-no-order', label: 'cw · No order at all: the band keeps its shape with seven zeros, the chips are quiet, "<customer> has no order yet."', model: liveCase({ rows: [], reads: seedReads([], NO_PHASES), before: NO_BEFORE_ORDER, urgencyFoot: null }) },
    { id: 'cw-all-done', label: 'cw · Everything done: three orders delivered or closed and one cancelled — no stage, no chip, nothing waits', model: liveCase({ rows: busy().slice(10), reads: seedReads(busy().slice(10), { ...NO_PHASES, DONE: 3, CANCELLED: 1 }), before: NO_BEFORE_ORDER, urgencyFoot: { on: true, used: 0, max: 3, companies: [] } }) },
    { id: 'cw-door-not-sent', label: 'cw · Opened from the door "Not sent to the factory": its two orders ("2 of 14 orders"), the door pressed, why they wait (a yes · a deposit)', model: liveCase({ rows: busy().slice(0, 2), reads: seedReads(busy(), BUSY_PHASES, BUSY_WAITS), phase: 'NOT_SENT' }) },
    {
      id: 'cw-extra-deposit',
      label: 'cw · An extra deposit open on an order that needed none ("Extra deposit due …"), and an order that waits for the customer\'s new yes',
      model: liveCase({
        rows: [seedRow(by(SEED_CUSTOMER), 4, 'IN_PRODUCTION', { deposit: { state: 'NOT_NEEDED', dueDate: null, extraOpenDue: '2026-11-25' }, production: made({ stage: 'SEWING' }), progress: pieces(244, 152, 40, 244) }), seedRow(by(SEED_CUSTOMER), 5, 'IN_PRODUCTION', { reaccept: true, production: made({ stage: 'CUTTING' }), progress: pieces(120, 0, 0, 180), units: 180 })],
        reads: seedReads(busy().slice(3, 5), { ...NO_PHASES, IN_PRODUCTION: 2 }),
        urgencyFoot: { on: true, used: 0, max: 3, companies: [] },
      }),
    },
    // The row ticked, per reader: an act without its right is not drawn; the next allowed act moves up.
    { id: 'cw-ticked-owner', label: 'cw · Three ticked as Owner: Ship 3 together… · Ask ▾ · Set priority for 3, then More ▾ (Reply · Assign supervisor · Add task · Note ‖ Mark ready · Close · Confirm ‖ Customer urgency: Set to regular… · Unlock… ‖ Invoice shipped goods)', model: liveCase({ tickedIds: ROLE_TICKED }) },
    { id: 'cw-ticked-sales', label: 'cw · As Sales (no shipping right): Ask ▾ · Set priority for 3 · Reply to <customer> on 3…, then More ▾ — no Ship, no Assign supervisor, no urgency act, no amount', model: seenAs('sales', { tickedIds: ROLE_TICKED }) },
    { id: 'cw-ticked-warehouse', label: 'cw · As Warehouse: Ship 3 together… · Ask ▾ (one entry) · Reply to <customer> on 3…, then More ▾ (Add task · Note · Confirm) — no Set priority, no Mark ready, no Close', model: seenAs('warehouse', { tickedIds: ROLE_TICKED }) },
    { id: 'cw-ticked-manager', label: 'cw · As Production manager: Ask ▾ (one entry) · Reply to <customer> on 3… · Assign supervisor…, then More ▾ (Add task · Note ‖ Customer urgency: Set to regular… · Unlock…)', model: seenAs('manager', { tickedIds: ROLE_TICKED }) },
    { id: 'cw-ticked-reader', label: 'cw · As Read-only: no act — "Your role reads the orders and changes none: there is no act for the ticked rows."', model: seenAs('reader', { tickedIds: ROLE_TICKED }) },
    // Ship N together…: Warehouse's own New shipment window, mounted here.
    { id: 'cw-ship-step1', label: 'cw · Ship 6 together… step 1: "Runs on 4 · Not on 2: why is beside each" (nothing released to ship · another delivery address), the cap of 20, "<customer> wants SEED-SO-0009 all in one delivery", the draft that exists already', model: liveCase({ tickedIds: SHIP_TICKED, ship: 'step1' }) },
    { id: 'cw-ship-step2', label: 'cw · Ship 6 together… step 2: the garments per size of the four orders it carries', model: liveCase({ tickedIds: SHIP_TICKED, ship: 'step2' }) },
    { id: 'cw-ship-notice', label: 'cw · After Create: ONE notice — "Shipment SEED-SH-0012 created with 4 orders", each order a door to its thread, "a draft: <customer> is not told", the way to Warehouse', model: liveCase({ ship: 'notice' }) },
    // Ask ▾.
    { id: 'cw-ask-production', label: 'cw · Ask ▾ › Ask production about 3…: production\'s Note window — each record\'s supervisor, "Needs an answer" ticked, what the rows then say', model: liveCase({ tickedIds: ROLE_TICKED, note: 'ask' }) },
    { id: 'cw-ask-production-receipt', label: 'cw · Its receipt: "Written on 3 records" — each order\'s name is a button that shows its thread; the window stays open', model: liveCase({ tickedIds: ROLE_TICKED, note: 'receipt' }) },
    { id: 'cw-ask-customer', label: 'cw · Ask ▾ › Ask <customer> about 3…: Reply to N with the tick "Put it in their to-do list, answer by" ON and its day', model: liveCase({ tickedIds: ROLE_TICKED, reply: 'ask' }) },
    { id: 'cw-ask-customer-receipt', label: 'cw · Its receipt: posted on 3 orders, the to-do made on each; each order\'s name a button', model: liveCase({ tickedIds: ROLE_TICKED, reply: 'receipt' }) },
    // The customer's urgency as we steer it: the shared window (the work order's Customer card mounts the same).
    { id: 'cw-urgency-regular', label: 'cw · Row ⋯ › Customer urgency › Set to regular… on SEED-SO-0004: a reason the customer reads, Also lock, a fresh code', model: liveCase({ urgency: { act: 'regular', on: 'row' } }) },
    { id: 'cw-urgency-lock', label: 'cw · Row ⋯ › Lock… on SEED-SO-0004: the reason, "the customer cannot mark it urgent until we unlock it"', model: liveCase({ urgency: { act: 'lock', on: 'row' } }) },
    { id: 'cw-urgency-unlock', label: 'cw · Row ⋯ › Unlock… on SEED-SO-0003 (locked): no reason asked', model: liveCase({ urgency: { act: 'unlock', on: 'row' } }) },
    { id: 'cw-urgency-many', label: 'cw · More ▾ › Customer urgency: Set to regular… over three ticked: "Runs on 2 · Not on 1: why is beside each" (not marked urgent by the customer)', model: liveCase({ tickedIds: ROLE_TICKED, urgency: { act: 'regular', on: 'many' } }) },
    { id: 'cw-urgency-outcome', label: 'cw · After it: the outcome — the orders set back by number, one not changed with why', model: liveCase({ urgency: 'outcome' }) },
    { id: 'cw-urgency-as-sales', label: 'cw · As Sales: no urgency act anywhere (no right to decide for a customer) — the chips stay read-only, "Urgent – asked" is still a door', model: seenAs('sales') },
    { id: 'cw-customise', label: 'cw · Views ▾ › Customise columns…: the tab\'s own set ticked, the columns that wait for a wider sheet named so, the rest offered unticked', model: liveCase({ customise: true }) },
    { id: 'cw-dock-shipment-line', label: 'cw · The docked order\'s thread: the office-only line "On draft shipment SEED-SH-0012 with SEED-SO-0003, SEED-SO-0004." (the customer never reads it)', model: { ...liveCase(), shipmentLine: true } },
    // ---- end cw T.1
    // ---- F-SA-271: the seven tabs (R5), the landing tab, the band's primary and ⋯ lines.
    { id: 'tabs-landing', label: 'F-SA-271 · No tab asked: the first tab the reader sees (Work for Sales)', model: workCase('MODA-DEMO', { reads: STRIP_READY, rows: workRows(by('MODA-DEMO')) }) },
    { id: 'tabs-overview-first', label: 'F-SA-271 · A reader without orders.view lands on the Overview', model: record('MODA-DEMO', { tab: 'overview', can: { ...RECORD_CAN, orders: false } }) },
    { id: 'tab-quotes', label: 'F-SA-277 / cq W3 · Quotes & incoming on the page: the band, Requests & portal orders, Quotes, Customer is writing; the dock a third (F-CQ-301); the tab\'s badge = what waits on us there (F-CQ-302)', model: record('MODA-DEMO', { tab: 'quotes', can: { ...RECORD_CAN, inquiries: true } }), note: 'The whole tab\'s cases (every role, bar, window, width): its own screen SCR-033-quotes.' },
    // F-SA-273: the Money tab with every card's right (the made-up ageing, returns and open orders of money/_demo).
    { id: 'tab-money', label: 'F-CM-104 · Money (Finance): the answer line, Balance with What needs you, To collect by due day', model: { ...record('MODA-DEMO', { tab: 'money', can: { ...RECORD_CAN, money: true } }), money: moneyModel({ ...MONEY_CAN.finance, orders: true, credit: true, creditLimits: true }, { orders: loaded(OPEN_ORDER_MONEY) }) } }, // B-CP-011
    // F-CP-141: "Prices differ on {count} orders ›" — the door to the Work tab's Not equal view; nothing of it without the price grain.
    { id: 'tab-money-price-differ', label: 'F-CM-104 · Money: "Prices differ on 2 orders ›" in What needs you (opens Work › Not equal until Price check)', model: { ...record('MODA-DEMO', { tab: 'money', can: { ...RECORD_CAN, money: true } }), money: moneyModel({ ...MONEY_CAN.finance, orders: true, credit: true, creditLimits: true }, { orders: loaded(OPEN_ORDER_MONEY) }), priceDiffer: 2 } }, // B-CP-011
    { id: 'tab-money-price-differ-no-price', label: 'F-CM-104 · Money as Sales: words only — no line, no count, no amount, no act', model: { ...record('MODA-DEMO', { tab: 'money', can: { ...RECORD_CAN, money: true, price: false } }), money: moneyModel(MONEY_CAN.sales, { orders: loaded(OPEN_ORDER_MONEY.map((row) => ({ id: row.id, number: row.number, currency: row.currency, deposit: row.deposit }))) }), priceDiffer: 2 } }, // B-CP-011
    { id: 'tab-money-blind', label: 'F-CM-104 · Money without the price grain: the answer in words, no figures, no act (nothing held)', model: { ...record('MODA-DEMO', { tab: 'money', can: { ...RECORD_CAN, money: true, price: false } }), money: moneyModel(MONEY_CAN.sales, { orders: loaded(OPEN_ORDER_MONEY.map((row) => ({ id: row.id, number: row.number, currency: row.currency, deposit: row.deposit }))) }) } }, // B-CP-011
    // ---- F-CM T.1 (cm-t; 15-steps T.1): the Money tab's cm-* cases — the nine customers of the picture, reminders off, each read reading
    // and failed, no payments.view, the four roles (their template's REAL grant), the rooms 343 / 865 / 1314, each window in place.
    ...CM_CASES.map((item) => ({ id: item.id, label: item.label, model: { ...record('MODA-DEMO', { tab: 'money', can: recordCanOf(new Set(item.cm.held ?? cmHeld(item.cm.role))) }), cm: item.cm } })),
    // ---- end F-CM T.1
    { id: 'band-held', label: 'F-SA-271 · New order and Add task held with why (no orders.manage, no tasks.manage)', model: record('MODA-DEMO', { can: { ...RECORD_CAN, ordersManage: false, tasks: false, workorders: true } }) },
    { id: 'band-doors', label: 'F-SA-271 · ⋯ Check VIES, Add task for <customer>…, Import orders…, Open in Sales › Orders, Work orders of <customer> ›', model: record('MODA-DEMO', { can: { ...RECORD_CAN, ordersManage: true, tasks: true, workorders: true } }) },
    // ---- F-SA-272: the Overview — key numbers as doors, Also open, and who looks after the customer (moved from Portal settings).
    { id: 'overview-supervisor', label: 'F-SA-272 → F-CO-201 · People: Production supervisor Bea Esempio (Office only), Backup Carlo Prova; Change… opens ONE window', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved } },
    { id: 'overview-supervisor-new', label: 'F-SA-272 · The Change… window (its inside): a first supervisor picked — "moves 7 orders that have no supervisor of their own" before Save', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.first, supervisorOpen: true /* F-CO-201: the form's state, in People's Change… window */ } },
    { id: 'overview-supervisor-held', label: 'F-SA-272 · Without production.brand.manage: the supervisor\'s row, no Change… (never held for a right)', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.held } },
    { id: 'overview-supervisor-every-company', label: 'F-SA-272 · Change… held in words: the reader does not manage this customer at every company', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.everyCompany } },
    { id: 'overview-supervisor-nobody', label: 'F-SA-272 · The Change… window (its inside): nobody may supervise yet (what a supervisor needs, in words)', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.nobody, supervisorOpen: true /* F-CO-201: the form's state, in People's Change… window */ } },
    { id: 'overview-supervisor-refused', label: 'F-SA-272 · The Change… window (its inside): Save refused — the supervisor cannot open measurement sheets', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.refused, supervisorOpen: true /* F-CO-201: the form's state, in People's Change… window */ } },
    // ---- F-CP-155: the Factory designer + Backup under Supervisor / Backup (the only names of ours the customer sees) ----
    { id: 'overview-designer', label: 'F-CP-155 · Who looks after <customer>: Factory designer Giulia Verdi + Backup Elena Rossi — "<customer> sees this name"', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.set } },
    { id: 'overview-designer-change', label: 'F-CP-155 · The designer\'s Change… window (its inside): two pick lists (office people who read and answer its conversations), Apply with the version', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.change } },
    { id: 'overview-designer-refused', label: 'F-CP-155 · The designer\'s Change… window (its inside): Apply refused at the field — "This person does not work with <customer>…"', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.refused } },
    { id: 'overview-designer-lost', label: 'F-CP-155 · The designer no longer reaches the customer: the portal names the backup', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.lost } },
    { id: 'overview-designer-portal-off', label: 'F-CP-155 · Portal off: the name shows once the portal is on', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.portalOff } },
    { id: 'overview-designer-empty', label: 'F-CP-155 · No factory designer named yet', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.empty } },
    { id: 'overview-designer-held', label: 'F-CP-155 · Without partners.manage (nor production.brand.manage): both rows, no Change… (never held for a right)', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.held, designer: DESIGNER_CASES.held } },
    { id: 'overview-designer-every-company', label: 'F-CP-155 · Change… held: not at every company the customer works with', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.everyCompany } },
    { id: 'overview-designer-loading', label: 'F-CP-155 · The designer rows reading (the supervisor is drawn)', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.loading } },
    { id: 'overview-designer-error', label: "F-CP-155 · The designer couldn't be read: Try again (the supervisor stays)", model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.error } },
    // ---- F-CP-158 (customer page plan C7, D12): the factory designer rows' last states (picture 23) ----
    { id: 'cp158-designer-not-active', label: 'F-CP-158 · The factory designer is no longer active: "No longer active", the portal names the backup', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: designerModel({}, designerSlot({ designer: { id: DESIGNERS.giulia.id, name: DESIGNERS.giulia.name, state: 'NOT_ACTIVE' } })) } },
    { id: 'cp158-designer-alone', label: 'F-CP-158 · A factory designer without a backup: the portal names the designer', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: designerModel({}, designerSlot({ backup: null })) } },
    { id: 'cp158-designer-nobody', label: 'F-CP-158 · Both no longer reach the customer: the portal names nobody (the brand writes to our team)', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: designerModel({}, designerSlot({ designer: { id: DESIGNERS.giulia.id, name: DESIGNERS.giulia.name, state: 'NO_REACH' }, backup: { id: DESIGNERS.elena.id, name: DESIGNERS.elena.name, state: 'NOT_ACTIVE' } })) } },
    { id: 'cp158-designer-done', label: 'F-CP-158 · Applied: the receipt under the rows (no step-up for a name)', model: { ...record('MODA-DEMO', { tab: 'overview' }), supervisor: SUPERVISOR_CASES.saved, designer: designerModel({ notice: { key: 'customers.designer.done' } }) } },
    // ---- end F-CP-158
    // ---- F-SA-274: People & addresses — a contact with portal access is tagged (an exact e-mail match), the others offer Invite.
    // F-CA-120 (Z1): a contact and the portal person with its e-mail are ONE row (its portal state on it); a portal person who is no contact
    // is "Portal only"; ⋯ Invite to the portal… for the other contact (the portal's own window, in place).
    { id: 'people-portal', label: 'F-SA-274 → F-CA-120 · People & addresses: one row per person — the contact with portal access shows its portal state; a portal-only person; ⋯ Invite to the portal… for the others', model: { ...record('MODA-DEMO', { tab: 'people', can: { ...RECORD_CAN, partners: true } }), people: { portal: portalDemo('customers', { access: customerAccess({ people: PEOPLE_PORTAL }) }) } } },
    // ---- B-TH-260: the thread docked (the rule of picture 38); Activity and Documents are gone, their tools in the thread's "⋯" (R-ACT)
    // and its Files view.
    { id: 'thread-docked', label: 'TH-6 · The customer’s thread docked beside the Overview (40 %): Reply to this customer only', model: record('MODA-DEMO'), note: 'The band sits in the shell’s band row with ONE pill; "Projects (2)" opens this customer’s projects. The thread is docked at 40 %, sticky while the body scrolls, ⌘J hides it. Its "⋯" holds Activity’s tools (Add task, Ask a partner to approve, Share with a partner, Followers, Remind me); its Files view the old Documents tab’s files. An old ?tab=activity or ?tab=documents opens the thread; ?tab=tax and ?tab=requirements land on Terms & requirements.' },
    { id: 'thread-documents', label: 'TH-6 · An old ?tab=documents address: the Overview with the thread shown (its Files view holds the files)', model: record('MODA-DEMO', { threadOnArrival: true }) },
    { id: 'thread-no-right', label: 'TH-6 · Without threads.read: no thread beside the tabs (no Thread button)', model: record('MODA-DEMO', { can: { ...RECORD_CAN, threads: false } }) },
    { id: 'projects-none', label: 'TH-6 · Without threads.read the band has no Projects (n); without projects.manage Start a project is held', model: record('MODA-DEMO', { can: { ...RECORD_CAN, projects: false, projectsManage: false } }) },
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
    { id: 'notices', label: 'TH-6 · One notice: blocked shows, a refusal and the read-only notice wait behind "2 more notices"', model: record('BLOCCATO-DEMO', { tab: 'people' /* F-CO-103: the Overview's own notice area leaves the Blocked banner to its headline and strip; the shared notice area is whole on every other tab */, can: { ...RECORD_CAN, manage: false }, notice: { key: 'problem.conflict', tone: 'warning' }, asOf: NOW }) },
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
    { id: 'w2b-324-overview', label: 'W2b Customer 360 on the Overview: the Credit fact, the next promise, Sample rounds and Repairs in Linked records, the requirements in force', model: glanceCase('MODA-DEMO', ready(glanceOf('MODA-DEMO'))), note: 'One read for the screen\'s company; the W1 quotes and orders and the W2a money keep their own reads.' },
    { id: 'w2b-324-overview-hold', label: 'W2b Customer 360: on hold (a credit check and a quality dispute), over the credit limit', model: glanceCase('MODA-DEMO', ready(glanceOf('MODA-DEMO', HELD_GLANCE))) },
    { id: 'w2b-324-overview-team', label: 'W2b Customer 360: a team — its riders and their measurement profiles counted in Linked records', model: glanceCase('MARCHIO-ESEMPIO', ready(glanceOf('MARCHIO-ESEMPIO'))) },
    { id: 'w2b-324-overview-rider', label: 'W2b Customer 360: a rider (a person) — its team named in People', model: glanceCase('PILOTA-DEMO', ready(glanceOf('PILOTA-DEMO')), { quotes: loaded([]), orders: loaded([]) }) },
    { id: 'w2b-324-overview-no-price', label: 'W2b Customer 360 without the price grain: credit said in words, no amount', model: glanceCase('MODA-DEMO', ready(withoutPrices(glanceOf('MODA-DEMO', HELD_GLANCE))), { can: { ...DEPTH_CAN, price: false }, quotes: loaded(withoutMoney(QUOTES)), orders: loaded(withoutMoney(ORDERS)) }) },
    { id: 'w2b-324-overview-withheld', label: 'W2b Customer 360: the parts the role may not read are left out (never "Not shown")', model: glanceCase('MARCHIO-ESEMPIO', ready(glanceOf('MARCHIO-ESEMPIO', WITHHELD))) },
    { id: 'w2b-324-overview-nothing', label: 'W2b Customer 360: nothing open, no limit, no rule', model: glanceCase('PILOTA-DEMO', ready(glanceOf('PILOTA-DEMO', { team: null, profiles: { count: 0, rows: [] } })), { quotes: loaded([]), orders: loaded([]) }) },
    { id: 'w2b-324-overview-loading', label: 'W2b Customer 360 reading', model: glanceCase('MODA-DEMO', LOADING) },
    { id: 'w2b-324-overview-error', label: "W2b Customer 360 couldn't be read", model: glanceCase('MODA-DEMO', failedRead('problem.offline')) },
    { id: 'w2b-324-tax', label: 'W2b Terms & requirements: Hold (in force, history, an order waiting) and Customer PO number per company', model: taxCase() },
    { id: 'w2b-324-tax-none', label: 'W2b Terms & requirements: not on hold, no history', model: taxCase({ read: ready(NO_HOLDS) }) },
    { id: 'w2b-324-tax-many', label: 'W2b Terms & requirements: two holds in force (the toggle says to release each)', model: taxCase({ read: ready(TWO_HOLDS) }) },
    { id: 'w2b-324-tax-place', label: 'W2b Put on hold: company, reason, why', model: taxCase({ read: ready(NO_HOLDS), dialog: { kind: 'place', draft: { companyId: COMPANIES[0]!.id, reason: 'CREDIT', words: 'Two invoices overdue (made-up).' }, ...dialogState } }) },
    { id: 'w2b-324-tax-place-problem', label: 'W2b Put on hold: held until a reason is picked', model: taxCase({ read: ready(NO_HOLDS), dialog: { kind: 'place', draft: { companyId: null, reason: null, words: '' }, busy: false, failed: null, tried: true } }) },
    { id: 'w2b-324-tax-place-refused', label: 'W2b Put on hold refused: one for that reason is in force', model: taxCase({ dialog: { kind: 'place', draft: { companyId: null, reason: 'QUALITY_DISPUTE', words: 'Again (made-up).' }, busy: false, failed: 'hold.refused.same', tried: true } }) },
    { id: 'w2b-324-tax-release', label: 'W2b Release the hold, with why', model: taxCase({ dialog: { kind: 'release', hold: HOLDS.holds[0]!, draft: { holdId: HOLDS.holds[0]!.id, words: 'Answered and closed (made-up).' }, ...dialogState } }) },
    { id: 'w2b-324-tax-po-changed', label: 'W2b Customer PO number: one change waiting for Save (⌘S)', model: taxCase({}, { draft: { [COMPANIES[1]!.id]: true } }) },
    { id: 'w2b-324-tax-read-only', label: 'W2b Terms & requirements for a reader: Put on hold, Release and the switches held with why', model: taxCase({}, {}, READ_CAN, { can: { ...DEPTH_CAN, manage: false, block: false } }) },
    { id: 'w2b-324-tax-loading', label: 'W2b Terms & requirements: hold and PO number reading', model: taxCase({ read: LOADING }, { read: LOADING }) },
    { id: 'w2b-324-tax-error', label: "W2b Terms & requirements: hold and PO number couldn't be read", model: taxCase({ read: failedRead('problem.unavailable') }, { read: failedRead('problem.unavailable') }) },
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
