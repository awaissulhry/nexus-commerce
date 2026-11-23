'use client'

import { MessageSquare } from 'lucide-react'
import './list-heads.css'

/**
 * cq fx2 W-05 (customer page › Quotes & incoming walk): a narrow column's header whole — never "N." or "Ac…". The New messages column
 * of a host's set (64 px) draws its icon; its words stay the column's name (the screen reader's label, the tooltip, Customise, the
 * file). The ⋯ column draws no word at all (`MORE_CELL`: its header text is kept for screen readers only, its button whole in 56 px).
 */
export function MessagesHeader({ displayName }: { readonly displayName: string }) {
  return (
    <span className="fw-list-iconhead" role="img" aria-label={displayName} title={displayName}>
      <MessageSquare size={14} aria-hidden />
    </span>
  )
}

/** The ⋯ column's cell and header class: no padding (its 44 px button whole in 56 px), the header's word for screen readers only. */
export const MORE_CELL = 'fw-list-more'
