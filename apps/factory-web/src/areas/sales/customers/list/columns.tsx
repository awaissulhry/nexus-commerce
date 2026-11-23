'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { AlertTriangle, MessageSquare } from 'lucide-react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import type { CardFieldOverride } from '@nexus/ui/grid/card-list/index'
import { Button } from '@nexus/ui/primitives'
import type { Translate } from '../../../../lib/i18n/messages'
import { useT } from '../../../../lib/i18n/provider'
import { unreadValue, type UnreadMap } from '../../../../lib/last-message-cell/model'
import { LAST_MESSAGE_NS, LastMessageCell } from '../../../../lib/last-message-cell/view/LastMessageCell'
import type { PartyRow } from '../../../parties/_shared/api'
import { partyName, recordHref, SIDES } from '../../../parties/_shared/model'
import { StatusPill } from '../../../parties/_shared/view/parts'
import { CARD_ROLES, CUSTOMER_HIDDEN_COLUMNS, CUSTOMERS_LIST_NS, officeDataOf } from './model'
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
}

export interface CustomerColumns {
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
    flex: 2.2,
    minWidth: 240,
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
          sortable: false,
          flex: 0.8,
          minWidth: 132,
          valueGetter: ({ data }) => unreadValue(data ? unread[data.id] : undefined),
          cellRenderer: MessagesCell,
        },
      ]
    : []
  const card: Record<string, CardFieldOverride<PartyRow>> = {}
  for (const [id, role] of Object.entries(CARD_ROLES)) card[id] = { role }
  if (unread) card.messages = { role: 'aside', draw: (row) => <CardThread row={row} prefix={prefix} unread={unread} c={c} /> }
  return { nameColumn, leadingColumns: [...(input.overdue ?? []), ...messages], hiddenColumns: CUSTOMER_HIDDEN_COLUMNS, card }
}

/** The customers' columns for a list in the page's language, rebuilt only when a fact they draw changes. */
export function useCustomerColumns(input: CustomerColumnsInput): CustomerColumns {
  const c = useT(CUSTOMERS_LIST_NS)
  const l = useT(LAST_MESSAGE_NS)
  const { prefix, unread, overdue } = input
  return useMemo(() => customerColumnsOf({ prefix, unread, overdue }, c, l), [prefix, unread, overdue, c, l])
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
          <Link className="fw-cl-office" href={recordHref(prefix, SIDES.customers, row.id, 'terms')} title={c('office.hint', { what })} aria-label={c('office.hint', { what })}>
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
