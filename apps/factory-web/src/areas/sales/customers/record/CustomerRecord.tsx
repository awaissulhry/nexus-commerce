'use client'

import { useCallback, useMemo, useState } from 'react'
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
import { CommercialTerms } from '../terms/CommercialTerms'
// B-W2b-324: Customer 360 and customers in depth (the glance, requirements, the hold, PO number, consent and personal data).
import { CustomerDepthProvider, customerDepthSlot } from '../depth/CustomerDepth'
import { CustomerRecordView } from './view/CustomerRecordView'
import { CustomerSupervisor } from '../portal/CustomerSupervisor' // F-SA-272
import { partyName } from '../../../parties/_shared/model'
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
import { quotesGroupDoor, useBeforeOrder } from './before-order' // F-CW-101 (S27, S29): the band's "Before an order" line; the Open quotes door

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
  const record = usePartyRecord('customers', partyId, {
    terms: (party, reload) => <CommercialTerms party={party} onChanged={reload} />,
    // B-W2b-180: Portal access (`?tab=portal`).
    // F-SA-274: Portal settings draws its settings, preview, limits and requests; the people with access are People & addresses'.
    portal: (party) => <PortalAccess side="customers" party={{ id: party.id, name: party.tradeName ?? party.legalName, companyId: party.companyId }} parts={PORTAL_SETTINGS_PARTS} />,
    depth: (party, reload) => customerDepthSlot(party, reload, prefix),
  })
  const task = useCustomerTask(partyId, record.party?.code ?? null)
  // ---- F-SA-276: the Work tab's reads (its strip and the tab's count, on every tab), the row the dock follows on Work (and on Quotes &
  // incoming): leaving those tabs drops it (the other tabs are about the account).
  const can = record.model.can
  const workCan: WorkCan = { orders: can.orders, workorders: can.workorders === true, threads: can.threads, partners: can.partners, price: can.price /* F-CP-141 */ }
  const work = useCustomerWork(partyId, workCan)
  const tab = record.model.tab
  // ---- F-SA-279: the dock follows the row — a click at once, the keys after 300 ms of rest; `dock=` in the address (a replace: Back
  // leaves the page); the record any row (or a window's row, or a line of All of <customer>) picks, checked against this customer.
  const customerDock = useCustomerDock(partyId, tab, record.party ? partyName(record.party) : null /* F-OF-303: Who can see… names the customer */)
  const api = useOfficeApi()
  const session = useOfficeSession()
  // F-CW-101 (S27, S27b): the band's "Before an order" line — ONE read, only while the Work tab is shown (the API leaves a part out
  // for a reader without its right).
  const before = useBeforeOrder(partyId, tab === 'work' && can.orders)
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
  // F-SA-277: Quotes & incoming — a row's click docks its quote's or request's thread.
  const quotesTab = named && tab === 'quotes' ? <QuotesIncomingTab party={named} onPick={onPick} onFocus={customerDock.onFocus} shown={customerDock.shown} /> : null
  const workTab = named && tab === 'work' && can.orders ? <WorkTab party={named} prefix={prefix} work={work} can={workCan} picked={customerDock.shown /* F-SA-279: the row marked = the record docked */} onPick={onPick} onFocus={customerDock.onFocus} onWindow={setWin /* F-SA-278 */} ask={ask} onAsked={() => setAsk(null) /* F-CP-104 */} before={before /* F-CW-101 */} /> : null
  // ---- end F-SA-276
  // ---- F-SA-274: People & addresses — the people with portal access (Portal access's people part), tagged against the contacts.
  const [portalEmails, setPortalEmails] = useState<ReadonlySet<string>>(new Set())
  const contactEmails = useMemo(() => new Set((record.party?.contacts ?? []).filter((contact) => contact.status === 'ACTIVE' && contact.email).map((contact) => contact.email!.trim().toLowerCase())), [record.party])
  const party = record.party
  const portalPeople =
    party && record.model.tab === 'people' && record.model.can.partners ? (
      <PortalAccess side="customers" party={{ id: party.id, name: party.tradeName ?? party.legalName, companyId: party.companyId }} parts={['people']} contactEmails={contactEmails} onPeople={setPortalEmails} />
    ) : null
  // ---- end F-SA-274
  return (
    <>
      {windows /* F-SA-278 */}
      {/* F-OF-301 (T): the docked order's Versions… — the page's ONE depth window (as on the order page). */}
      <DepthDialogs depth={customerDock.fileDepth.model} actions={customerDock.fileDepth.actions} />
      <CustomerRecordView model={record.model} actions={record.actions} thread={dock /* F-SA-276 */} threadButton={threadButton /* F-SA-279 */} work={workTab} workCount={work.attention} quotesIncoming={quotesTab /* F-SA-277 */} printThread={record.printThread} fields={record.fields} terms={record.terms} portal={record.portal} money={money} depth={record.depth} onAddTask={task.open} taskDialog={task.dialog} supervisor={record.party && record.model.tab === 'overview' ? <CustomerSupervisor partyId={partyId} name={partyName(record.party)} /> : null} portalPeople={portalPeople} portalEmails={portalEmails} {...doors /* F-CP-104 */} priceDiffer={priceDifferOf(work.prices) /* F-CP-141 */} workBoard={work.reads.board /* F-CW-101: the Overview's In production and Late */} openQuotesHref={quotesGroupDoor(`${prefix}/sales/customers/${encodeURIComponent(partyId)}`, 'OPEN_QUOTES') /* F-CW-101 (S29) */} />
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
