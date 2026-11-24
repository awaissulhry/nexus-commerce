'use client'

import { useMemo, type ReactNode } from 'react' // F-CL-301: + ReactNode
import Link from 'next/link'
import { AlertTriangle, ClipboardCheck, MessageSquare, UserCheck } from 'lucide-react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import type { MenuItemDef } from '@nexus/ui/components'
import type { CardFieldOverride } from '@nexus/ui/grid/card-list/index'
import { Button } from '@nexus/ui/primitives'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { formatDate } from '../../../../lib/i18n/format'
import type { ReadPictures } from '../../../../lib/record-picture/cache'
import { unreadValue, type UnreadMap } from '../../../../lib/last-message-cell/model'
import { LAST_MESSAGE_NS, LastMessageCell } from '../../../../lib/last-message-cell/view/LastMessageCell'
import type { PartyRow } from '../../../parties/_shared/api'
import type { BarAct } from '../../../parties/_shared/bar'
import { partyName, recordHref, SIDES } from '../../../parties/_shared/model'
import { StatusPill } from '../../../parties/_shared/view/parts'
import { CARD_NEEDS_MAX, CARD_ROLES, customerActsOf, CUSTOMER_HIDDEN_COLUMNS, CUSTOMERS_LIST_NS, needsChipsOf, officeDataOf, WIDE_ONLY_COLUMNS, workChipsOf, type CustomerRights, type CustomersWorkModel } from './model'
import { ChipsCell, factsState, MessagesHeader, NextPromiseCell, PictureCell, type CellWords } from './view/cells' // F-CL-202; F-CL-301: + MessagesHeader
import './list.css'

/**
 * F-CL-102 (customers list plan §1, 10-design §3 / §4, 13-backend §8.1): the customers' own columns on the shared list — the
 * Customer cell in place of Name (the name as the record's link; a quiet second line: the code, the status only when not Active,
 * ONE chip "Needs office data" whose hint lists what and whose door is the record's Terms & requirements), New messages (the
 * reader's own new messages in the customer's own conversation, a door to its thread), the identity columns hidden at first, and
 * the phone card (the Customer cell as its title, the thread door beside it, the row's ⋯ as its actions). Draws what it is given:
 * the host reads (use-customers-depth.tsx), the design view passes fixtures.
 */

export interface CustomerColumnsInput {
  readonly prefix: string
  /** The reader's new messages per customer; null: the reader may not read threads (no column, no door). */
  readonly unread: UnreadMap | null
  /** The Overdue column (price grain + receivables.view), when the reader has it. */
  readonly overdue?: readonly ColDef<PartyRow>[] | undefined
  // ---- F-CL-202: where each customer's work stands (orders.view) ----
  /** The work facts; null / absent: the reader has no orders.view (no work column at all). */
  readonly work?: CustomersWorkModel | null
  /** Today in the site's zone (YYYY-MM-DD): the next promise's days. */
  readonly today?: string
  readonly locale?: Locale
  /** The page's batch picture read (the newest orders' pictures); none: placeholders. */
  readonly read?: ReadPictures | null
  /** The picture large (the one viewer). */
  readonly onPicture?: ((order: { readonly id: string; readonly number: string }) => void) | null
  /** The list room is wide (1920): Last order and Overdue show at first (else in Customise: settle T15). */
  readonly wide?: boolean
  /** Design cases: the words of the other catalogues (default: the list's own translator). */
  readonly cellWords?: Omit<CellWords, 'c'> | null
  // ---- end F-CL-202
}

export interface CustomerColumns {
  /** F-CL-202: before the name — the newest order's picture. */
  readonly beforeName: readonly ColDef<PartyRow>[]
  readonly nameColumn: ColDef<PartyRow>
  readonly leadingColumns: readonly ColDef<PartyRow>[]
  readonly hiddenColumns: readonly string[]
  readonly card: Readonly<Record<string, CardFieldOverride<PartyRow>>>
}

/** A customer's page with its conversation shown at the first new message (the record frame takes `?thread=new` on arrival). */
export const threadHref = (prefix: string, partyId: string): string => `${recordHref(prefix, SIDES.customers, partyId)}?thread=new`

/** The columns, pure (the words come in: `c` = customers-list, `l` = last-message). The hook below keeps them between renders. */
export function customerColumnsOf(input: CustomerColumnsInput, c: Translate, l: Translate): CustomerColumns {
  const { prefix, unread } = input
  const CustomerCell = ({ data }: ICellRendererParams<PartyRow>) => (data ? <CustomerName row={data} prefix={prefix} c={c} /> : null)
  const nameColumn: ColDef<PartyRow> = {
    colId: 'name',
    headerName: c('col.customer'),
    sortable: false,
    flex: input.work ? 1.5 : 2.2,
    minWidth: input.work ? 220 : 240,
    autoHeight: true, // a code, a status and the office chip may wrap to a third line: nothing is cut (settle T26)
    valueGetter: ({ data }) => (data ? partyName(data) : ''),
    cellRenderer: CustomerCell,
  }
  const MessagesCell = ({ data }: ICellRendererParams<PartyRow>) => (data ? <LastMessageCell unread={unread?.[data.id]} href={threadHref(prefix, data.id)} record={partyName(data)} /> : null)
  const messages: ColDef<PartyRow>[] = unread
    ? [
        {
          colId: 'messages',
          headerName: l('column'),
          headerTooltip: c('col.messagesHint'),
          // F-CL-301 (walk W-2): the message mark for a header (the name was cut at 1440: "New messa…"); the name stays its words.
          headerComponentParams: { innerHeaderComponent: MessagesHeader },
          suppressHeaderMenuButton: true,
          sortable: false,
          flex: 0.8,
          minWidth: 132,
          valueGetter: ({ data }) => unreadValue(data ? unread[data.id] : undefined),
          cellRenderer: MessagesCell,
        },
      ]
    : []
  // ---- F-CL-202: Picture · Needs us · Work · Next promise · Last order (orders.view only; T13: no facts for a customer → "—") ----
  const work = input.work ?? null
  const words: CellWords = { c, ...(input.cellWords ?? { p: c, ord: c, sheet: c, levels: c, more: c }) }
  const today = input.today ?? ''
  const locale: Locale = input.locale ?? 'en'
  const factsOf = (id: string) => work?.byParty?.get(id)
  const stateOf = (id: string) => (work ? factsState({ work: factsOf(id), reading: work.byParty === null && !work.problem, problem: work.problem, words }) : null)
  const PictureCellR = ({ data }: ICellRendererParams<PartyRow>) => (data ? <PictureCell work={factsOf(data.id)} read={input.read ?? null} size="cell" words={words} onOpen={input.onPicture ?? null} /> : null)
  const NeedsCell = ({ data }: ICellRendererParams<PartyRow>) => {
    if (!data) return null
    const facts = factsOf(data.id)
    return <>{stateOf(data.id) ?? (facts ? <ChipsCell chips={needsChipsOf(facts)} prefix={prefix} partyId={data.id} customer={partyName(data)} words={words} /> : null)}</>
  }
  const WorkCell = ({ data }: ICellRendererParams<PartyRow>) => {
    if (!data) return null
    const facts = factsOf(data.id)
    return <>{stateOf(data.id) ?? (facts ? <ChipsCell chips={workChipsOf(facts)} prefix={prefix} partyId={data.id} customer={partyName(data)} words={words} empty={<span className="fw-cl-quiet">{c('work.noOrder')}</span>} /> : null)}</>
  }
  const PromiseCell = ({ data }: ICellRendererParams<PartyRow>) => {
    if (!data) return null
    const facts = factsOf(data.id)
    return <>{stateOf(data.id) ?? (facts ? <NextPromiseCell work={facts} today={today} locale={locale} words={words} /> : null)}</>
  }
  const LastOrderCell = ({ data }: ICellRendererParams<PartyRow>) => {
    if (!data) return null
    const date = factsOf(data.id)?.lastOrderDate ?? null
    return <>{stateOf(data.id) ?? <span className={date ? undefined : 'fw-cl-quiet'}>{date ? formatDate(`${date}T12:00:00Z`, { locale }) : '—'}</span>}</>
  }
  const beforeName: ColDef<PartyRow>[] = work
    ? // F-CL-301 (walk W-2): the header whole ("Picture", not "Pic…"): a little wider, with less side padding (the thumbnail is 32 px).
      // F-CL-301 (walk W-13): a leading column — the name stays the row's first (Freeze “Customer”); the picture freezes with it.
      [{ colId: 'picture', headerName: words.sheet('col.picture'), headerTooltip: c('col.pictureHint'), sortable: false, width: 80, minWidth: 80, maxWidth: 88, suppressHeaderMenuButton: true, headerClass: 'fw-cl-tight', cellClass: 'fw-cl-tight', context: { leading: true }, cellRenderer: PictureCellR }]
    : []
  const workColumns: ColDef<PartyRow>[] = work
    ? [
        { colId: 'needs', headerName: c('col.needs'), headerTooltip: c('col.needsHint'), sortable: false, flex: 2, minWidth: 220, autoHeight: true, valueGetter: ({ data }) => {
            const facts = data ? factsOf(data.id) : undefined
            return facts ? needsChipsOf(facts).reduce((sum, chip) => sum + chip.count, 0) : null
          },
          cellRenderer: NeedsCell,
        },
        { colId: 'work', headerName: words.p('customers.tab.work'), headerTooltip: c('col.workHint'), sortable: false, flex: 2.24, minWidth: 240, autoHeight: true, valueGetter: ({ data }) => factsOf(data?.id ?? '')?.orders ?? null, cellRenderer: WorkCell },
        { colId: 'nextPromise', headerName: c('col.nextPromise'), headerTooltip: c('col.nextPromiseHint'), sortable: false, width: 148, minWidth: 148, valueGetter: ({ data }) => factsOf(data?.id ?? '')?.nextPromise ?? null, cellRenderer: PromiseCell },
        { colId: 'lastOrder', headerName: c('col.lastOrder'), sortable: false, width: 116, minWidth: 116, valueGetter: ({ data }) => factsOf(data?.id ?? '')?.lastOrderDate ?? null, cellRenderer: LastOrderCell },
      ]
    : []
  const card: Record<string, CardFieldOverride<PartyRow>> = {}
  for (const [id, role] of Object.entries(CARD_ROLES)) card[id] = { role }
  if (unread) card.messages = { role: 'aside', draw: (row) => <CardThread row={row} prefix={prefix} unread={unread} c={c} /> }
  // ---- F-CL-203: the card's head (the picture beside the Customer cell), ≤ 2 Needs us chips, ONE line of Work, the next promise ----
  if (work) {
    card.name = { role: 'title', draw: (row) => <span className="fw-cl-card-head"><PictureCell work={factsOf(row.id)} read={input.read ?? null} size="phone" words={words} onOpen={input.onPicture ?? null} /><CustomerName row={row} prefix={prefix} c={c} /></span> }
    card.needs = { role: 'subtitle', draw: (row) => { const facts = factsOf(row.id); return stateOf(row.id) ?? (facts ? <ChipsCell chips={needsChipsOf(facts)} prefix={prefix} partyId={row.id} customer={partyName(row)} words={words} max={CARD_NEEDS_MAX} /> : null) } }
    card.work = { role: 'subtitle', draw: (row) => { const facts = factsOf(row.id); return facts && !stateOf(row.id) ? <ChipsCell chips={workChipsOf(facts)} prefix={prefix} partyId={row.id} customer={partyName(row)} words={words} lines={1} empty={<span className="fw-cl-quiet">{c('work.noOrder')}</span>} /> : null } }
    card.nextPromise = { role: 'subtitle', draw: (row) => { const facts = factsOf(row.id); return facts && facts.orders > 0 && !stateOf(row.id) ? <span className="fw-cl-card-promise">{c('col.nextPromise')} <NextPromiseCell work={facts} today={today} locale={locale} words={words} inline /></span> : null } }
  }
  return {
    beforeName,
    nameColumn,
    leadingColumns: [...workColumns, ...(input.overdue ?? []), ...messages],
    hiddenColumns: input.wide ? CUSTOMER_HIDDEN_COLUMNS : [...CUSTOMER_HIDDEN_COLUMNS, ...WIDE_ONLY_COLUMNS],
    card,
  }
}

/**
 * F-CL-301 (walk W-13; 10-design §8): Customise's own lines — these are the list's own columns (what is on screen is ticked, the
 * identity columns hidden at first and always in the file), and, for a reader who does not see prices, that Overdue is not offered.
 */
export function customiseAboutOf(c: Translate, prices: boolean): ReactNode {
  return (
    <>
      <p>{c('customise.truth')}</p>
      {!prices && <p>{c('customise.noOverdue')}</p>}
    </>
  )
}

/** The customers' columns for a list in the page's language, rebuilt only when a fact they draw changes. */
export function useCustomerColumns(input: CustomerColumnsInput): CustomerColumns {
  const c = useT(CUSTOMERS_LIST_NS)
  const l = useT(LAST_MESSAGE_NS)
  // F-CL-202: the words the work cells reuse (one word per thing).
  const p = useT('parties')
  const ord = useT('orders')
  const sheet = useT('orders-sheet')
  const levels = useT('sales-orders-depth')
  const more = useT('home-tasks')
  const locale = useLocale()
  const { prefix, unread, overdue, work, today, read, onPicture, wide } = input
  return useMemo(
    () => customerColumnsOf({ prefix, unread, overdue, work: work ?? null, today: today ?? '', locale, read: read ?? null, onPicture: onPicture ?? null, wide: wide === true, cellWords: { p, ord, sheet, levels, more } }, c, l),
    [prefix, unread, overdue, work, today, locale, read, onPicture, wide, c, l, p, ord, sheet, levels, more],
  )
}

/** The Customer cell: the name (the record's link), then its code · the status when not Active · "Needs office data". */
function CustomerName({ row, prefix, c }: { row: PartyRow; prefix: string; c: Translate }) {
  const office = officeDataOf(row)
  const name = partyName(row)
  const what = office.map((code) => c(`office.${code}`)).join(' · ')
  return (
    <span className="fw-cl-customer">
      <Link className="fw-cl-name" href={recordHref(prefix, SIDES.customers, row.id)} tabIndex={-1} title={row.tradeName && row.tradeName !== row.legalName ? `${name} · ${row.legalName}` : name}>
        {name}
      </Link>
      <span className="fw-cl-sub">
        <span className="fw-pty-code">{row.code}</span>
        {row.status !== 'ACTIVE' && <StatusPill status={row.status} />}
        {office.length > 0 && (
          <Link className="fw-cl-office" href={`${recordHref(prefix, SIDES.customers, row.id, 'terms')}#party-identity` /* F-CT-537 (ct-w2 W2.4): VIES, SDI / PEC and tax data are Tax identity & e-invoice's */} title={c('office.hint', { what })} aria-label={c('office.hint', { what })}>
            <AlertTriangle size={11} aria-hidden />
            {c('office.chip')}
          </Link>
        )}
      </span>
    </span>
  )
}

/** The card's door to the customer's conversation: its new messages ("3 new"), else "Thread". */
function CardThread({ row, prefix, unread, c }: { row: PartyRow; prefix: string; unread: UnreadMap; c: Translate }) {
  const href = threadHref(prefix, row.id)
  if (unreadValue(unread[row.id]) > 0) return <LastMessageCell unread={unread[row.id]} href={href} record={partyName(row)} />
  return (
    <Button asChild size="sm" variant="tonal">
      <Link href={href}>
        <MessageSquare size={13} aria-hidden /> {c('card.thread')}
      </Link>
    </Button>
  )
}

/**
 * The customers' own acts of the bar for the ticked rows (F-CL-104): Add task (10) and Set supervisor (20), each left out without
 * its right and held only by the cap, in words. Shared with the design view (no-op runs there).
 */
export function customerBarActs(rights: CustomerRights, ticked: readonly PartyRow[], c: Translate, run: { readonly onTask: (rows: readonly PartyRow[]) => void; readonly onSupervisor: (rows: readonly PartyRow[]) => void }): BarAct[] {
  const count = ticked.length
  return customerActsOf(rights, count).map((act) =>
    act.id === 'task'
      ? { id: act.id, order: act.order, label: c('bar.task', { count }), icon: <ClipboardCheck size={13} aria-hidden />, held: act.held ? c('bar.tooMany', act.held) : null, run: () => run.onTask(ticked) }
      : { id: act.id, order: act.order, label: c('bar.supervisor', { count }), icon: <UserCheck size={13} aria-hidden />, held: act.held ? c('bar.tooMany', act.held) : null, run: () => run.onSupervisor(ticked) },
  )
}

/** The row's doors in its ⋯ (after "Open in new tab"), each with its own right: Open thread · Open Work tab · Add task… (F-CL-104). */
export function customerRowItems(rights: CustomerRights, prefix: string, row: PartyRow, c: Translate, onTask: (rows: readonly PartyRow[]) => void): MenuItemDef[] {
  return [
    ...(rights.threads ? [{ id: 'thread', label: c('door.openThread'), href: threadHref(prefix, row.id) }] : []),
    ...(rights.orders ? [{ id: 'work', label: c('door.openWork'), href: recordHref(prefix, SIDES.customers, row.id, 'work') }] : []),
    ...(rights.tasks ? [{ id: 'task', label: c('door.addTask'), onSelect: () => onTask([row]) }] : []),
  ]
}
