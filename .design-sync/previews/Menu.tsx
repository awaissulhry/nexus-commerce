import { useEffect, useRef, type ReactNode } from 'react'
import { Archive, ChevronDown, Copy, Download, ExternalLink, Pause, Pencil, Trash2 } from 'lucide-react'
import { Button, Menu } from '@nexus/design-system'



/**
 * Preview harness — NOT part of the component API.
 *
 * Menu owns `open` internally and exposes no prop for it, so the dropdown is
 * opened the way an operator opens it: one click on the trigger, on mount.
 * The close-on-outside-click listener watches `mousedown`, which a
 * programmatic `.click()` never fires, so the menu stays put for the capture.
 * `room` reserves layout height so the absolutely-positioned panel is not
 * clipped by the card cell's `overflow:hidden`.
 */
const Opened = ({ room, align, children }: { room: number; align?: 'right'; children: ReactNode }) => {
  const host = useRef<HTMLDivElement>(null)
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    host.current?.querySelector('button')?.click()
  }, [])
  return (
    <div
      ref={host}
      style={{
        paddingBottom: room,
        display: 'flex',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        width: align === 'right' ? 380 : undefined,
      }}
    >
      {children}
    </div>
  )
}

const chev = <ChevronDown size={14} aria-hidden />

const ROW_ACTIONS = [
  { id: 'edit', label: 'Edit campaign', icon: <Pencil size={14} aria-hidden /> },
  { id: 'dup', label: 'Duplicate', icon: <Copy size={14} aria-hidden /> },
  { id: 'pause', label: 'Set bids to €0.02', icon: <Pause size={14} aria-hidden /> },
  { id: 'seller', label: 'Open in Seller Central', icon: <ExternalLink size={14} aria-hidden /> },
  { id: 'archive', label: 'Archive', icon: <Archive size={14} aria-hidden />, disabled: true },
]

/** The resting trigger is the DS secondary button; `triggerProps` re-classes it `sm` to line up in a toolbar. */
export const Trigger = () => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
    <Button variant="primary" size="sm">Apply 41 bids</Button>
    <Menu
      label={<>Actions {chev}</>}
      triggerProps={{ className: 'h10-ds-btn sm' }}
      items={[
        { id: 'edit', label: 'Edit campaign' },
        { id: 'dup', label: 'Duplicate' },
        { id: 'arch', label: 'Archive', disabled: true },
      ]}
    />
    <Menu
      label={<>Export {chev}</>}
      triggerProps={{ className: 'h10-ds-btn sm' }}
      items={[
        { id: 'csv', label: 'Download CSV' },
        { id: 'bulk', label: 'Bulksheet' },
      ]}
    />
  </div>
)

/** Open: 13px/500 items, a lucide glyph in each icon slot, and a `disabled` item in disabled ink. */
export const OpenMenu = () => (
  <Opened room={210}>
    <Menu label={<>Actions {chev}</>} items={ROW_ACTIONS} />
  </Opened>
)

/**
 * `align="right"` pins the panel's right edge to the trigger — the idiom for a menu at the end
 * of a toolbar. The panel shrink-to-fits against the trigger's own box at a 180px floor, so item
 * labels past roughly twenty characters wrap: keep them short.
 */
export const AlignRight = () => (
  <Opened room={160} align="right">
    <Menu
      label={<>Export {chev}</>}
      align="right"
      items={[
        { id: 'csv', label: 'Download CSV', icon: <Download size={14} aria-hidden /> },
        { id: 'bulk', label: 'Amazon bulksheet', icon: <Download size={14} aria-hidden /> },
        { id: 'sched', label: 'Schedule weekly', icon: <Copy size={14} aria-hidden /> },
        { id: 'clear', label: 'Clear exports', icon: <Trash2 size={14} aria-hidden />, disabled: true },
      ]}
    />
  </Opened>
)
