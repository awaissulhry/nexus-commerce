'use client'

import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { progressListKey, type ProgressDetailItem, type ProgressDetailModel } from './progress'

export interface ProgressDetailCardProps {
  model: ProgressDetailModel
  /** A `goto` item was chosen: the caller puts the cursor in that cell (`landOnCell`). The card has closed by then. */
  onGoTo: (field: string) => void
  /** The popover's `close`. */
  close: (options?: { returnFocus?: boolean }) => void
  /** One link under the list — "All products for Amazon · IT" → the listings readiness page. */
  footerLink?: { label: string; href: string } | null
}

/**
 * The card behind a progress cell (2026-09-26). It draws `progressDetailModel` and decides nothing.
 *
 * What the Owner asked of it, on the preview:
 *  - **Stronger, not light.** Title and field names in `--nds-text-strong` at the body size; each group headed in
 *    its own tone's text colour with the tone's swatch; the tone said in words beside the title.
 *  - **Like a dropdown.** Every field is a full-width row, the whole row is the action (hover wash, focus ring),
 *    the list scrolls between a fixed header and footer, ↑ ↓ Home End move through it and Enter goes. The panel
 *    is capped to the room under (or over) the cell (`nds-detailpop-scroll`), so a long list never runs off screen.
 *  - Nothing is capped at "+ N more": a list that scrolls can show every field.
 */
export function ProgressDetailCard({ model, onGoTo, close, footerLink }: ProgressDetailCardProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-progress-item]') ?? [])]
    const next = progressListKey(event.key, items.indexOf(document.activeElement as HTMLElement), items.length)
    if (next < 0) return
    event.preventDefault()
    event.stopPropagation()
    items[next]?.focus()
  }
  return (
    <div className="nds-progress-card">
      <div className="nds-progress-card-head">
        <span className={`nds-progress-card-swatch tone-${model.tone}`} aria-hidden="true" />
        <span className="nds-progress-card-title">{model.title}</span>
        <span className={`nds-progress-card-word tone-${model.tone}`}>{model.toneWord}</span>
      </div>
      {(model.subject || model.summary) && (
        <p className="nds-progress-card-summary">
          {model.subject && <span className="nds-progress-card-subject">{model.subject}</span>}
          {model.subject && model.summary && ' · '}
          {model.summary}
        </p>
      )}
      {model.groups.length > 0 && (
        <div ref={listRef} className="nds-progress-card-list" onKeyDown={onListKeyDown}>
          {model.groups.map(group => (
            <section key={group.id} className="nds-progress-card-group" aria-label={group.heading}>
              <div className={`nds-progress-card-gh tone-${group.tone}`}>
                <span className={`nds-progress-card-dot tone-${group.tone}`} aria-hidden="true" />
                {group.heading}
              </div>
              <ul className="nds-progress-card-items">
                {group.items.map(item => (
                  <li key={`${group.id}:${item.field}`}>
                    <ProgressItem item={item} inlineReason={group.id === 'other'} onGoTo={field => { close(); onGoTo(field) }} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {model.allFilled && <p className="nds-progress-card-done">{model.allFilled}</p>}
      {model.notes.map(note => <p key={note} className="nds-progress-card-note">{note}</p>)}
      <div className="nds-progress-card-foot">
        {footerLink && (
          <a className="nds-progress-card-link" href={footerLink.href}>
            {footerLink.label}
            <ArrowRight size={13} aria-hidden="true" />
          </a>
        )}
        <span>{model.footer}</span>
      </div>
    </div>
  )
}

/**
 * One field. In the two EMPTY groups the row is just the field's name — the group heading already says why it is
 * listed, and a per-field sentence like "Required by the category's condition for this product: Manufacturer" turned
 * one row into three and the list into a wall (measured on Amazon · IT: 17 required rows, 3 lines each). That sentence
 * stays one hover away (`title`). In "Other issues" the sentence IS the content, so it is printed.
 */
function ProgressItem({ item, inlineReason, onGoTo }: { item: ProgressDetailItem; inlineReason: boolean; onGoTo: (field: string) => void }) {
  const text = (
    <span className="nds-progress-card-what">
      <span className="nds-progress-card-label">{item.label}</span>
      {inlineReason && item.reason && <span className="nds-progress-card-reason">{item.reason}</span>}
    </span>
  )
  const title = !inlineReason && item.reason ? item.reason : undefined
  if (item.action.kind === 'goto') {
    return (
      <button type="button" className="nds-progress-card-item" data-progress-item="" title={title} onClick={() => onGoTo(item.field)}>
        {text}
        <span className="nds-progress-card-act">{item.action.label}<ArrowRight size={13} aria-hidden="true" /></span>
      </button>
    )
  }
  if (item.action.kind === 'link') {
    return (
      <a className="nds-progress-card-item" data-progress-item="" title={title} href={item.action.href}>
        {text}
        <span className="nds-progress-card-act">{item.action.label}<ExternalLink size={12} aria-hidden="true" /></span>
      </a>
    )
  }
  return (
    <div className="nds-progress-card-item is-static" title={title}>
      {text}
      <span className="nds-progress-card-reason">{item.action.text}</span>
    </div>
  )
}
