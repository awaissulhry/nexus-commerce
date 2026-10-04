'use client'

/**
 * Cell details — the ONE window both scopes of the product sheet open (2026-10-04, shared Cell details).
 *
 * Moved as is from the channel adapter: the title `{field}: {SKU}`, the value, the notes, the action's description, and
 * a footer with Close and at most one primary action (the cell menu's own action for that cell). The shared control
 * (`useSheetControl`) opens it from the cell menu and the toolbar ⋯, and puts the focus back on the cell when it closes;
 * a scope supplies only the content (`CellDetailsSource`). The Modal portals, so the body and the footer are exported
 * for tests that render without a document.
 */
import { Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { CELL_DETAILS_COPY, type CellDetailsContent } from './cellDetails'

export function CellDetailsBody({ content }: { content: CellDetailsContent }) {
  return (
    <div className="ps-cell-details">
      <p>{content.value}</p>
      <p>{content.notes}</p>
      {content.action && <p>{content.action.description}</p>}
    </div>
  )
}

/** Close, then the cell's one action (it runs its writer, then the window closes). */
export function CellDetailsFooter({ content, onClose }: { content: CellDetailsContent; onClose: () => void }) {
  return <>
    <Button size="sm" onClick={onClose}>{CELL_DETAILS_COPY.close}</Button>
    {content.action && <Button size="sm" variant="primary" onClick={() => { content.action?.run(); onClose() }}>{content.action.label}</Button>}
  </>
}

export function CellDetailsDialog({ content, onClose }: { content: CellDetailsContent | null; onClose: () => void }) {
  if (!content) return null
  return (
    <Modal open readable size="md" title={content.title} onClose={onClose} footer={<CellDetailsFooter content={content} onClose={onClose} />}>
      <CellDetailsBody content={content} />
    </Modal>
  )
}
