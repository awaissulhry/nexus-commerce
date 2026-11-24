'use client'

import type { MouseEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { useT } from '../../../i18n/provider'
import type { CardAction } from '../model'

/** The words of each row (record-thread-card); Answer… keeps the ask's own word. */
const ROW_KEY: Readonly<Record<CardAction, string>> = {
  answerThere: 'menu.answerThere', // tw- W2.5: All of <Customer>
  reply: 'menu.reply',
  replyPrivately: 'menu.replyPrivately',
  copyText: 'menu.copyText',
  link: 'menu.link',
  pin: 'menu.pin',
  unpin: 'menu.unpin',
  remind: 'menu.remind',
  task: 'menu.task',
  answer: 'ask.answer',
  correct: 'menu.correct',
  emailDetails: 'menu.emailDetails',
  useOn: 'menu.useOn',
}

/**
 * tw- W2.2 (THE THREAD REBUILD; 10-design §9, S8; W-060, W-061): a message's ONE menu — the arrow inside the bubble's top-right corner
 * (shown on hover and on keyboard focus, always on a touch screen) or a right-click on the message opens it; the rows in ONE order
 * (`cardActions`), one line each, never a hint under a row. Answer… is a real link when the page has an address for it: ⌘ / Ctrl /
 * Shift or the middle button open a new tab, a plain click stays on the page (the window opens over it). Draws its rows only.
 */
export function MessageMenu({
  rows,
  label,
  open,
  onOpenChange,
  onPick,
  answerHref,
}: {
  rows: readonly CardAction[]
  /** The arrow's name for a screen reader ("More for the message of Alma Alfieri at 10:41"). */
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (action: CardAction) => void
  /** Answer…'s own address (null: a plain row). */
  answerHref?: string | null
}) {
  const t = useT('record-thread-card')
  if (rows.length === 0) return null
  const items: MenuItemDef[] = rows.map((action) =>
    action === 'answer' && answerHref ? { id: action, label: t(ROW_KEY[action]), href: answerHref } : { id: action, label: t(ROW_KEY[action]), onSelect: () => onPick(action) },
  )
  return (
    <Menu
      align="right"
      className="fw-rt-msg-menu"
      label={<ChevronDown size={16} aria-hidden />}
      items={items}
      open={open}
      onOpenChange={onOpenChange}
      triggerProps={{ 'aria-label': label, className: 'fw-rt-msg-more' }}
      onNavigate={(event: MouseEvent<HTMLAnchorElement>, item) => {
        if (item.id !== 'answer') return
        // A plain click stays on the page (the window opens over it); ⌘ / Ctrl / Shift / Alt or another button open a new tab.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
        event.preventDefault()
        onPick('answer')
      }}
    />
  )
}

/** A right-click on the message opens its menu — unless the person right-clicks a link or text they selected (the browser's own then). */
export function opensOnRightClick(event: Pick<MouseEvent<HTMLElement>, 'target'>, selection: string): boolean {
  if (selection.trim() !== '') return false
  const target = event.target as { closest?: (selector: string) => unknown } | null
  return !(target && typeof target.closest === 'function' && target.closest('a[href]'))
}
