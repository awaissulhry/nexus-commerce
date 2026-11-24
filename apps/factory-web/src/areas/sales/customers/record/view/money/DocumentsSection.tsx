'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, FilterChip } from '@nexus/ui/primitives'
import { InvoiceList, type InvoiceListRow } from '../../../../orders/record/money/view/parts'
import { word } from '../../../../orders/record/money/word'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Quiet, Section } from '../../../../orders/record/view/production/Kit'
import { DOCUMENT_CHIPS, DOCUMENTS_SHOWN, type DocumentChip, type DocumentRow, type DocumentsModel } from '../../money/documents'
import { kitId } from '../../money/sections'
import type { CustomerSay } from '../../money/say'
import type { DockPick } from '../WorkTab'

/**
 * F-CM-202 (customer page › MONEY tab, cm-w2 W2.2; 10-design §5.3) — section 3, Invoices & credit notes (#invoices): the shared
 * `InvoiceList` part with this customer's documents (the order's Money draws the same part; its sixth column here is each document's
 * ORDER, a door), the chips All · Credit notes · Drafts, the first 5 rows then "Show n more documents", the read's next page. Head:
 * "Invoice shipped goods…" (Finance's own window with the DDTs chosen; invoices.manage) · ⋯ Open in Finance › Invoices › · Copy link.
 * Draws its model (money/documents.ts); reads nothing.
 */
export interface DocumentsSectionProps {
  readonly model: DocumentsModel
  readonly price: boolean
  readonly chip: DocumentChip
  readonly onChip: (chip: DocumentChip) => void
  readonly onMore: () => void
  readonly sayIn: (currency: string) => CustomerSay
  readonly unit: string
  readonly companyId: string | null
  readonly menu: readonly MenuItemDef[]
  readonly onRetry: () => void
  readonly onPick?: (pick: DockPick) => void
}

export function DocumentsSection({ model, price, chip, onChip, onMore, sayIn, unit, companyId, menu, onRetry, onPick }: DocumentsSectionProps) {
  const say = sayIn(unit)
  const [all, setAll] = useState(false)
  const title = say(word('orders:moneyTab.invoices.title'))
  const items: MenuItemDef[] = [...menu, { id: 'link', label: say(word('cm.linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('invoices') }]
  const info = (
    <>
      <p>{say(word('cm.invoices.info'))}</p>
      <p>{say(word('cm.keys'))}</p>
    </>
  )
  const buttons = model.invoiceShipped
    ? [
        <Button key="shipped" size="sm" asChild>
          <Link href={model.invoiceShipped}>{say(word('orders:moneyTab.invoices.shipped'))}</Link>
        </Button>,
      ]
    : []
  const chips = (
    <div className="fw-cm-filters" role="group" aria-label={say(word('cm.invoices.chips'))}>
      {DOCUMENT_CHIPS.map((entry) => (
        <FilterChip key={entry} pressed={entry === chip} onClick={() => onChip(entry)}>
          {say(word(`cm.invoices.chip.${entry}`))}
        </FilterChip>
      ))}
    </div>
  )
  const shipped = model.shipped ? (
    <p className="fw-cm-foot">
      {model.invoiceShipped ? (
        <Link className="fw-pt-link" href={model.invoiceShipped}>
          {say(model.shipped)} ›
        </Link>
      ) : (
        <span>{say(model.shipped)}</span>
      )}
    </p>
  ) : null
  const head = { id: kitId('invoices'), title, info, buttons, more: <LineMenuButton label={say(word('cm.invoices.more'))} items={items} /> }
  if (model.reading)
    return (
      <Section {...head} answer={say(model.answer[0] ?? word('cm.invoices.reading'))}>
        {chips}
        <PartReading rows={3} height={34} />
      </Section>
    )
  if (model.problem)
    return (
      <Section {...head}>
        {chips}
        <PartFailed part={say(word('cm.invoices.part'))} problem={model.problem} onRetry={onRetry} />
      </Section>
    )
  const shown = all ? model.rows : model.rows.slice(0, DOCUMENTS_SHOWN)
  const hidden = model.rows.length - shown.length
  const rows: InvoiceListRow[] = shown.map((row) => ({
    ...row.list,
    extra: row.order ? (
      <Link className="fw-pt-link" href={row.order.href}>
        {row.order.number ? `${row.order.number} ›` : say(word('cm.invoices.orderDoor'))}
      </Link>
    ) : null,
  }))
  const menuOf = (listRow: InvoiceListRow): MenuItemDef[] => {
    const row = model.rows.find((entry) => entry.list.id === listRow.id)
    return row ? rowMenuOf(row, sayIn(row.list.currency), companyId, onPick) : []
  }
  return (
    <Section {...head} answer={model.answer.map(say).join(' · ')}>
      {chips}
      {rows.length > 0 ? <InvoiceList rows={rows} price={price} extraHead={say(word('cm.invoices.order'))} menuOf={menuOf} /> : <Quiet>{say(word('cm.invoices.noneChip'))}</Quiet>}
      {hidden > 0 ? (
        <Button size="sm" variant="quiet" className="fw-cm-more" onClick={() => setAll(true)}>
          {say(word('cm.more.documents', { params: { count: hidden } }))}
        </Button>
      ) : all && model.more ? (
        <Button size="sm" variant="quiet" className="fw-cm-more" onClick={onMore}>
          {say(word('cm.more.documentsNext'))}
        </Button>
      ) : all && model.rows.length > DOCUMENTS_SHOWN ? (
        <Button size="sm" variant="quiet" className="fw-cm-more" onClick={() => setAll(false)}>
          {say(word('cm.more.fewer'))}
        </Button>
      ) : null}
      {shipped}
    </Section>
  )
}

/** A document's ⋯: the order page's five doors into Finance (each with its right; held only by state), Show in the thread, Copy number. */
function rowMenuOf(row: DocumentRow, say: CustomerSay, companyId: string | null, onPick?: (pick: DockPick) => void): MenuItemDef[] {
  const items: MenuItemDef[] = row.doors.map((door) => (door.held ? { id: door.id, label: say(door.label), disabled: true, description: say(door.held) } : { id: door.id, label: say(door.label), href: door.href ?? undefined }))
  const order = row.order
  if (onPick && order) items.push({ id: 'show', label: say(word('record-frame:discuss.showInThread')), onSelect: () => onPick({ type: 'SalesOrder', id: order.id, label: order.number ?? '', companyId }) })
  const number = row.list.number
  if (number) items.push({ id: 'copy', label: say(word('orders:moneyTab.invoices.copyNumber')), onSelect: () => void navigator.clipboard?.writeText(number) })
  return items
}
