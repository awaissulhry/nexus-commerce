'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
// F-SA-271: the band's ⋯ "Add task for <customer>…" — the record's ONE New task dialog (the Party record's task).
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import type { PanelRead } from '../../../../record-panels/model'
import { createTask, listAssignees, taskReadProblem } from '../../../../record-panels/tasks/api'
import { createBody, type Assignable, type TaskDraft } from '../../../../record-panels/tasks/model'
import { TaskNewDialog } from '../../../../record-panels/tasks/view/TaskNewDialog'
import { WithMessages } from '../../../../record-panels/i18n'
import { usePartyRecord } from '../../../parties/_shared/PartyRecord'
import { useCustomerMoney } from '../money/hooks'
import { CUSTOMER_MONEY_NAMESPACE } from '../money/model'
import type { CustomerMoneyModel } from '../money/overview'
import { PortalAccess } from '../portal/PortalAccess'
import type { PortalPart } from '../portal/view/PortalAccessView' // F-SA-274
// B-W2b-324: Customer 360 and customers in depth (the glance, requirements, the hold, PO number, consent and personal data).
import { CustomerDepthProvider } from '../depth/CustomerDepth'
import { useCustomerGlance } from '../depth/CustomerDepth' // F-CM-104: the Money tab's credit standing (the hold, over the limit)
import { CustomerMoney } from './money/CustomerMoney' // F-CM-104: the Money tab's container
import { CustomerRecordView } from './view/CustomerRecordView'
import { partyName } from '../../../parties/_shared/model'
import { recordTabs, shownTab, SIDES } from '../../../parties/_shared/model' // F-CQ-301 (P0-B2)
// ---- F-SA-276: the Work tab (the strip's reads, the Orders sheet locked to the customer) and the dock that follows its rows ----
import { useCustomerWork, useReacceptOrders, type WorkCan } from './use-customer-work'
import { CustomerDock, WorkTab, type DockPick } from './view/WorkTab'
import { useCustomerDock } from './use-customer-work' // F-SA-279: the dock follows the row (`dock=`), All of <customer>
import { DepthDialogs } from '../../../../record-panels/files/view/DepthParts' // F-OF-301 (T): the docked order's Versions…
import { workAskAddress, type WorkAsk } from './use-customer-work' // F-CP-104: New order and Import orders in place
import { priceDifferOf } from './use-customer-work' // F-CP-141: the Money tab's "Prices differ on {count} orders ›"
import { useAllOfCustomer } from '../../../_shared/record-thread/all-of-customer/use-all-of-customer' // F-SA-279: All of <customer>, read by the page
import { readUnreadWith } from '../../../../lib/last-message-cell/api' // F-OP-213: whether the customer's thread may be read
import { useUnread } from '../../../../lib/last-message-cell/use-unread' // F-OP-213
import { useT } from '../../../../lib/i18n/provider' // F-SA-279: the band's "Thread · SO-…" below 1280 px
// ---- end F-SA-276
// ---- F-SA-278: the strip's two windows (Waiting for <customer>, Open tasks) ----
import { WaitingForCustomerDialog } from './view/WaitingForCustomerDialog'
import { OpenTasksDialog } from './view/OpenTasksDialog'
// ---- end F-SA-278
import { QuotesIncomingTab } from './QuotesIncomingTab' // F-SA-277: two lists stacked, each its own list locked to the customer
import { useUrgencyFoot } from './urgency-foot' // F-CW-302 (S35): the Work tab's foot — the customer's urgency state
import { beforeOrderFor, NO_BEFORE_ORDER } from './before-order' // F-CW-101 (S27): the band's "Before an order" line
import { useBeforeOrderCounts } from './quotes-tab/use-before-order-counts' // F-CQ-302: the page's one count read
// ---- F-CO-102 (customer page › Overview): the tab's container, and the ONE read that joins on it (the Customers list's own hook)
import { CustomerOverview } from './overview/CustomerOverview'
import { useCustomersWork } from '../list/use-customers-work'
// ---- end F-CO-102
// F-CA-118 (customer page › People & addresses, lane ca-; 13-backend §5.3): the tab's container (reads only on People), its view, its
// notices in the record's ONE notice area, the tab's count from the party read.
import { usePeopleTab } from './people/use-people-tab'
import { peopleBadge as peopleBadgeOf } from './people/answer'
import { PeopleTab } from './view/people/PeopleTab'
import { PeopleNotices } from './view/people/PeopleNotices'
import { useCustomerPrivacy } from '../depth/CustomerDepth'
// F-CA-118: end
// F-CT-405 (customer page › Terms & requirements, lane ct-; 13-backend §6.3): the tab's container (reads only on Terms), its view, its
// notices in the record's ONE notice area, the depth provider's part of it (its reads, its hold window, its notice of the acts here).
import { useTermsTab } from './terms/use-terms-tab'
import { TermsTab } from './view/terms/TermsTab'
import { TermsNotices } from './view/terms/TermsNotices'
import { useCustomerTerms } from '../depth/CustomerDepth'
// F-CT-405: end

/**
 * `/w/<company>/sales/customers/<id>` (SCR-033): the customer's record. F-SA-270: its own view (./view/CustomerRecordView), split
 * from the supplier's; the reads, writes, live stream and docked thread are the shared hook's (areas/parties/_shared/PartyRecord.tsx
 * usePartyRecord), with the customer's Commercial terms card on Terms & requirements (B-W2a-49; SAL-012): it reads and saves the
 * terms itself and has the record read the party again after a save (the terms are the party's columns: its version moved).
 * B-W2a-81: the Overview's Overdue and Returns this year tiles and the open returns and claims under Now (money/: three reads beside
 * the party, each with its permission). B-W2b-324: the customer in depth through the record's `depth` slot (depth/): the glance on
 * the Overview (free credit, promises, samples in progress, measurement profiles, riders, repairs, the hold and its reason, a rider's
 * team, the requirements in force), Terms & requirements (B-TH-260: `?tab=terms`, the old Tax & terms and Requirements) › Hold and
 * Customer PO number required, and the contacts' consent, lawful basis and personal-data actions on Addresses & contacts.
 */
export function CustomerRecord({ partyId }: { partyId: string }) {
  return (
    <WithMessages namespaces={['parties', CUSTOMER_MONEY_NAMESPACE]}>
      <Customer partyId={partyId} />
    </WithMessages>
  )
}

function Customer({ partyId }: { partyId: string }) {
  const pathname = usePathname()
  const prefix = pathname.replace(/\/sales\/customers\/.*$/, '')
  const money = useCustomerMoney(partyId, prefix)
  return (
    <CustomerDepthProvider partyId={partyId}>
      <CustomerPage partyId={partyId} prefix={prefix} money={money} />
    </CustomerDepthProvider>
  )
}

/** F-SA-274: what Portal settings draws (People & addresses draws the people). */
const PORTAL_SETTINGS_PARTS: readonly PortalPart[] = ['settings', 'preview', 'limits', 'requests']

/** Inside the depth provider (its slot reads it). */
function CustomerPage({ partyId, prefix, money }: { partyId: string; prefix: string; money: CustomerMoneyModel }) {
  // F-CT-405: the Commercial terms card left the `terms` slot — the Terms & requirements tab's container reads and saves the terms.
  const record = usePartyRecord('customers', partyId, {
    // B-W2b-180: Portal access (`?tab=portal`).
    // F-SA-274: Portal settings draws its settings, preview, limits and requests; the people with access are People & addresses'.
    portal: (party) => <PortalAccess side="customers" party={{ id: party.id, name: party.tradeName ?? party.legalName, companyId: party.companyId }} parts={PORTAL_SETTINGS_PARTS} />,
  })
  const task = useCustomerTask(partyId, record.party?.code ?? null)
  // ---- F-SA-276: the Work tab's reads (its strip and the tab's count, on every tab), the row the dock follows on Work (and on Quotes &
  // incoming): leaving those tabs drops it (the other tabs are about the account).
  const can = record.model.can
  const workCan: WorkCan = { orders: can.orders, workorders: can.workorders === true, threads: can.threads, partners: can.partners, price: can.price /* F-CP-141 */ }
  const work = useCustomerWork(partyId, workCan)
  // ---- F-CQ-301 (P0-B2): the tab the page SHOWS (the asked one when the reader sees it, else the first) — the view marks the same tab,
  // so the slots below are built for it (a Warehouse reader asking ?tab=quotes gets the Work tab and its body).
  const tab = shownTab(recordTabs(SIDES.customers, can), record.model.tab)
  // ---- end F-CQ-301
  // ---- F-CQ-306 (cq fx3 W2-1b): asked for Quotes & incoming without its right — the Work tab shows (its entry rewrites the address to
  // tab=work), and one line says why until the reader leaves Work.
  const [quotesTabNote, setQuotesTabNote] = useState(false)
  useEffect(() => {
    if (record.model.tab === 'quotes' && tab !== 'quotes') setQuotesTabNote(true)
    else if (tab !== 'work') setQuotesTabNote(false)
  }, [record.model.tab, tab])
  // ---- end F-CQ-306
  // ---- F-CM-104 (cm-w1 W1.4; Z27): asked for Money without its right (Production manager, Warehouse) — the Work tab shows, and one line
  // says why until the reader leaves Work (the Quotes line's pattern).
  const [moneyTabNote, setMoneyTabNote] = useState(false)
  useEffect(() => {
    if (record.model.tab === 'money' && tab !== 'money') setMoneyTabNote(true)
    else if (tab !== 'work') setMoneyTabNote(false)
  }, [record.model.tab, tab])
  const glance = useCustomerGlance()
  // ---- end F-CM-104
  // ---- F-SA-279: the dock follows the row — a click at once, the keys after 300 ms of rest; `dock=` in the address (a replace: Back
  // leaves the page); the record any row (or a window's row, or a line of All of <customer>) picks, checked against this customer.
  const customerDock = useCustomerDock(partyId, tab, record.party ? partyName(record.party) : null /* F-OF-303: Who can see… names the customer */)
  const api = useOfficeApi()
  const session = useOfficeSession()
  // F-CW-101 (S27, S27b): the band's "Before an order" line — ONE read, only while the Work tab is shown (the API leaves a part out
  // for a reader without its right).
  // ---- F-CQ-302 (13-backend R13): the page's ONE count read, on every tab — Quotes & incoming's badge (what waits on us there), its
  // band and doors, and the Work line's four parts (the same answer: no second read of the route).
  const pageCounts = useBeforeOrderCounts(partyId, record.party !== null && record.party !== undefined)
  // F-CQ-306 (W2-1): only for a reader who can open Quotes & incoming (every part is a door there).
  const opensQuotesTab = can.quotes || can.inquiries === true
  // F-CO-102: the Overview draws the same band (its card 2), so the line is built on Work AND on Overview.
  const before = useMemo(() => ((tab === 'work' || tab === 'overview') && can.orders ? beforeOrderFor(pageCounts.counts, opensQuotesTab) : NO_BEFORE_ORDER), [tab, can.orders, pageCounts.counts, opensQuotesTab])
  const quotesBadge = pageCounts.counts ? { count: pageCounts.counts.waitsOnUs, attention: (pageCounts.counts.waitsOnUs ?? 0) > 0 } : null
  // ---- end F-CQ-302
  // ---- F-CO-102 (13-backend §1.2; lead settle S11): the ONE read that joins — THIS customer's row of GET
  // /sales/orders/customers/work (the next promise over every company, the last order, Priority Top / High, the customer-urgent
  // count), through the Customers list's own hook with ONE id: only on the Overview, only with orders.view (without it the route
  // answers 403: never asked, its facts left out).
  const standingRows = useMemo(() => [{ id: partyId }], [partyId])
  const standing = useCustomersWork(api, standingRows, tab === 'overview' && can.orders)
  // ---- end F-CO-102
  // F-CW-302 (S35): the customer's urgency for the Work tab's foot — ONE read, only while the Work tab is shown AND with workorders.view.
  const urgencyFoot = useUrgencyFoot(partyId, tab === 'work' && can.orders && workCan.workorders)
  const onPick = customerDock.onRow
  const t = useT('parties')
  const named = record.party ? { id: record.party.id, name: partyName(record.party) } : null
  const docked = named !== null && record.thread !== null && record.thread !== undefined
  // All of <customer>: read here while the dock shows it (the dock draws the feed it is given).
  const feed = useAllOfCustomer(api, { partyId: named?.id ?? null, customerName: named?.name ?? '', enabled: docked && customerDock.scope === 'all', prefix, canReadFiles: session.permissions.includes('files.read') })
  // F-OP-213 (11-dock §5, D4; B-OP-061): All of <customer> only when the customer's own thread may be read (the API's `readable`;
  // until it says, threads.read decides, as before) — asked for this page's own customer only.
  const readsThreads = session.permissions.includes('threads.read')
  const readParty = useMemo(() => (readsThreads ? readUnreadWith(api, { readable: true }) : null), [api, readsThreads]) // B-OP-061: opt-in
  const partyRows = useMemo(() => (named ? [{ recordType: 'Party', id: named.id }] : []), [named?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const partyUnread = useUnread(readParty, partyRows)
  const allOffered = readsThreads && (named ? partyUnread[named.id]?.readable !== false : false)
  const dock = named && docked ? <CustomerDock customer={named} general={record.thread} dock={customerDock} feed={feed} prefix={prefix} allOffered={allOffered} /> : record.thread
  const threadButton = customerDock.shown ? t('customers.work.dock.button', { record: customerDock.shown.label }) : null
  // ---- end F-SA-279
  // ---- F-SA-278: the strip's windows — each row picks its record in the dock (the customer's own record: its thread).
  const [win, setWin] = useState<'customer' | 'tasks' | null>(null)
  const reaccept = useReacceptOrders(partyId, win === 'customer', can.orders)
  const pickOrGeneral = (next: DockPick | null) => (next ? onPick(next) : customerDock.onScope('general'))
  const windows =
    named && win === 'customer' ? (
      <WaitingForCustomerDialog party={{ ...named, companyId: record.party?.companyId ?? null }} can={{ partners: can.partners }} requests={work.reads.requests} reaccept={reaccept} onPick={onPick} onClose={() => setWin(null)} />
    ) : named && win === 'tasks' ? (
      <OpenTasksDialog customer={named.name} tasks={work.reads.tasks} onPick={pickOrGeneral} onClose={() => setWin(null)} />
    ) : null
  // ---- end F-SA-278
  // ---- F-CP-104 (C2a): the band's New order and ⋯ Import orders for <customer>… open on this page — the ask is kept in memory (never an
  // address term: nothing to loop on, a reload does not reopen it); on another tab the page writes `tab=work` first (one replace), the
  // Work sheet serves the ask once it is here. Without the Work tab (no orders.view) the old doors stay.
  const router = useRouter()
  const [ask, setAsk] = useState<WorkAsk | null>(null)
  const askWork = (what: WorkAsk) => {
    setAsk(what)
    const address = workAskAddress(`${prefix}/sales/customers/${encodeURIComponent(partyId)}`, tab)
    if (address) router.replace(address, { scroll: false })
  }
  const doors = can.orders ? { onNewOrder: () => askWork('new'), onImport: () => askWork('import') } : {}
  // ---- end F-CP-104
  // ---- F-CO-102 (10-design §5, §6; fixes V3-B9): from the Overview a window of the Work tab opens ON the Work tab — the page goes
  // there first (the ask's own pattern: one replace, nothing in the address), so a row's pick docks its record as on Work.
  const windowOnWork = (which: 'customer' | 'tasks') => {
    setWin(which)
    const address = workAskAddress(`${prefix}/sales/customers/${encodeURIComponent(partyId)}`, tab)
    if (address) router.replace(address, { scroll: false })
  }
  // The Overview tab, built here like Work and Quotes & incoming (a view fetches nothing): the reads the page already holds, the
  // custom fields (its last pair's second card). F-CO-201: "Who looks after" is the Overview container's own read (People's rows).
  const overviewTab =
    named && record.party && tab === 'overview' ? (
      <CustomerOverview party={record.party} model={record.model} actions={record.actions} reads={work.reads} counts={pageCounts} before={before} money={money} standing={standing} onWindow={windowOnWork} onRetry={work.reload} fields={record.fields} />
    ) : null
  // ---- end F-CO-102
  // ---- F-CM-104 (cm-w1 W1.4; 13-backend §5.3): the Money tab, built here like Work, Quotes and the Overview (a view fetches nothing) —
  // only on `?tab=money`: the page's money reads, the price counts, the glance; a row's "Show in the thread" docks its order.
  const moneyTab = named && record.party && tab === 'money' ? <CustomerMoney party={record.party} prefix={prefix} money={money} priceDiffer={priceDifferOf(work.prices)} priceMissing={work.prices.status === 'ready' ? work.prices.value.priceMissingCount : null /* F-CM-303 */} glance={glance.read} onPick={onPick} /> : null
  // ---- end F-CM-104
  // F-SA-277: Quotes & incoming — a row's click docks its quote's or request's thread.
  const quotesTab = named && tab === 'quotes' ? <QuotesIncomingTab party={named} counts={pageCounts /* F-CQ-302 */} onPick={onPick} onFocus={customerDock.onFocus} shown={customerDock.shown} /> : null
  const workTab = named && tab === 'work' && can.orders ? <WorkTab party={named} prefix={prefix} work={work} can={workCan} picked={customerDock.shown /* F-SA-279: the row marked = the record docked */} onPick={onPick} onFocus={customerDock.onFocus} onWindow={setWin /* F-SA-278 */} ask={ask} onAsked={() => setAsk(null) /* F-CP-104 */} before={before /* F-CW-101 */} urgencyFoot={urgencyFoot /* F-CW-302 */} mayPortal={session.permissions.includes('partners.production.manage') /* F-CW-302: may change the switch */} mayIncoming={session.permissions.includes('sales.inquiries.view') /* cw fx5 (W-10): may open Sales › Incoming */} /> : null
  // ---- end F-SA-276
  // F-CA-118 (customer page › People & addresses, lane ca-; 13-backend §5.3; Z13, Z15): the tab's container, built on every tab (it reads
  // only while People shows), its view only on `?tab=people`; today's riders / profiles and personal-data cards stand under the new
  // sections until ca-w2. "Add as a contact…" starts the record's own Add contact window with the portal person's name and e-mail.
  const privacy = useCustomerPrivacy(record.reload) // F-CA-224: an erase reads the party again
  const people = usePeopleTab({ partyId, party: record.party, model: record.model, actions: record.actions, reload: record.reload, privacy: privacy.state.read, openPrivacy: privacy.state.onOpen /* F-CA-224 */, retryPrivacy: privacy.state.onRetry, enabled: tab === 'people' }) // F-CA-204: Riders read the riders and profiles, no longer the glance
  const peopleTab =
    named && record.party && tab === 'people' ? (
      <PeopleTab
        model={people.model}
        actions={people.actions}
        portal={people.portal}
        recordHref={`${prefix}/sales/customers/${encodeURIComponent(partyId)}`}
        mtm={people.mtm /* F-CA-209 */}
        // F-CA-224 (W2.4; Z14): the personal-data windows, opened from each person's ⋯ (the old card and its table left the tab)
        privacy={{ model: { read: privacy.state.read, can: privacy.can, status: record.party.status, today: privacy.today, dialog: privacy.state.dialog, stepUp: privacy.state.stepUp, portalHref: `${prefix}/sales/customers/${encodeURIComponent(partyId)}?tab=people#people` }, actions: privacy.state }}
      />
    ) : null
  const peopleNotice = <PeopleNotices notices={{ ...people.notices, depth: privacy.notice, onDismissDepth: privacy.onDismissNotice } /* F-CA-224: + the personal-data windows' notice */} />
  const peopleBadge = record.party ? peopleBadgeOf(record.party) : null
  const recordModel = people.contactDraft ? { ...record.model, contactDraft: people.contactDraft } : record.model
  // F-CA-118: end
  // F-CT-405 (customer page › Terms & requirements, lane ct-; 13-backend §6.3; Z5): the tab's container, built on every tab (it reads only
  // while Terms shows), its view only on `?tab=terms`; today's Requirements and Tax identity cards stand under it until ct-w2.
  const termsDepth = useCustomerTerms(record.party)
  const terms = useTermsTab({ partyId, party: record.party, model: record.model, reload: record.reload, actions: record.actions /* F-CT-516 */, moreHistory: record.moreHistory, retryHistory: record.retryHistory /* ct-fx3 G-W08 */, depth: termsDepth, enabled: tab === 'terms' })
  const termsTab = named && record.party && tab === 'terms' ? <TermsTab model={terms.model} actions={terms.actions} hold={terms.hold} requirements={terms.requirementsWindow /* F-CT-508 */} /> : null
  const termsNotice = <TermsNotices notices={terms.notices} />
  // F-CT-405: end
  return (
    <>
      {windows /* F-SA-278 */}
      {/* F-OF-301 (T): the docked order's Versions… — the page's ONE depth window (as on the order page). */}
      <DepthDialogs depth={customerDock.fileDepth.model} actions={customerDock.fileDepth.actions} />
      <CustomerRecordView model={recordModel /* F-CA-118 */} actions={record.actions} thread={dock /* F-SA-276 */} threadButton={threadButton /* F-SA-279 */} work={workTab} workCount={work.attention} quotesIncoming={quotesTab /* F-SA-277 */} overviewTab={overviewTab /* F-CO-102 */} printThread={record.printThread} termsTab={termsTab /* F-CT-405 */} termsNotice={termsNotice /* F-CT-405 */} portal={record.portal} money={money} onAddTask={task.open} taskDialog={task.dialog} peopleTab={peopleTab /* F-CA-118 */} peopleBadge={peopleBadge /* F-CA-118 */} peopleNotice={peopleNotice /* F-CA-118 */} {...doors /* F-CP-104 */} priceDiffer={priceDifferOf(work.prices) /* F-CP-141 */} quotesBadge={quotesBadge /* F-CQ-302 */} quotesTabNote={quotesTabNote && tab === 'work' /* F-CQ-306 */} moneyTab={moneyTab /* F-CM-104 */} moneyTabNote={moneyTabNote && tab === 'work' /* F-CM-104 */} />
    </>
  )
}

/** F-SA-271: a task on the customer itself (the Party record), as every record's "+ Add task" makes one (POST /tasks). */
function useCustomerTask(partyId: string, label: string | null) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const record = { type: 'Party', id: partyId } as const
  const [state, setState] = useState<{ people: PanelRead<readonly Assignable[]>; busy: boolean } | null>(null)
  const readPeople = useCallback(async () => {
    setState((now) => (now ? { ...now, people: { status: 'loading' } } : now))
    try {
      const people = await listAssignees(api, { type: 'Party', id: partyId })
      setState((now) => (now ? { ...now, people: { status: 'ready', data: people } } : now))
    } catch (error) {
      setState((now) => (now ? { ...now, people: { status: 'error', problem: taskReadProblem(error) } } : now))
    }
  }, [api, partyId])
  const open = () => {
    setState({ people: { status: 'loading' }, busy: false })
    void readPeople()
  }
  const onCreate = async (draft: TaskDraft): Promise<boolean> => {
    setState((now) => (now ? { ...now, busy: true } : now))
    try {
      await createTask(api, createBody(draft, record))
      setState(null)
      return true
    } catch {
      setState((now) => (now ? { ...now, busy: false } : now))
      return false
    }
  }
  const dialog = state ? <TaskNewDialog recordLabel={label} people={state.people} me={session.user.id} busy={state.busy} onRetryPeople={() => void readPeople()} onCreate={onCreate} onClose={() => setState(null)} /> : null
  return { open, dialog }
}
