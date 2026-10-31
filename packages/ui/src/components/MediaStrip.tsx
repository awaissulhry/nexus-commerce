'use client'

import { useRef, useState } from 'react'
import { Tooltip } from '../primitives/Tooltip'
import { cdnFit } from '../lib/cdn-image'
import { MediaTypeIcon, mediaImageUrl } from './MediaPreview'
import { mergeLabels } from '../lib/labels'
import { MEDIA_STRIP_LABELS, type MediaStripLabels } from './MediaStripLabels'

export interface MediaStripItem {
  id: string; type: string; preview?: string | null; alt?: string
  /** Shown for context, not part of this cell's own list (e.g. a variant's shared photos after its own). */
  muted?: boolean
}
export interface MediaStripProps {
  items: readonly MediaStripItem[]; label: string; limit?: number; emptyLabel?: string
  /** Optional in-cell reorder. The cell's Enter/F2 editor supplies the keyboard equivalent. */
  onReorder?(ids: string[]): void
  onFocusCell?(): void
  onOpen?(): void
  /** Its words in the person's language (B-W2b-04): names, tooltips, media types. Default English; `emptyLabel` wins. */
  labels?: Partial<MediaStripLabels>
}

/** Non-interactive cell content. The grid supplies its own edit trigger and keyboard contract. */
export function MediaStrip({ items, label, limit = 5, emptyLabel, onReorder, onFocusCell, onOpen, labels }: MediaStripProps) {
  const words = mergeLabels(MEDIA_STRIP_LABELS, labels)
  const count = Math.max(1, Math.floor(limit))
  const dragged = useRef<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  return <span className="nds-media-strip" role={onReorder ? 'group' : 'img'} aria-label={words.items(label, items.length)}>
    {items.slice(0, count).map((item, index) => <Tooltip portal className="nds-tooltip--light" key={`${item.id}:${item.preview}`} label={`${words.type(item.type)}${item.alt ? ` · ${item.alt}` : ''}${item.muted ? ` · ${words.shared}` : ''}${onReorder ? ` · ${words.reorderHint}` : ''}`}>
      {onReorder ? <button type="button" className="nds-media-strip-move" tabIndex={-1} draggable data-nds-media-drag data-drop-target={target === item.id || undefined}
        aria-label={words.position(item.alt || words.type(item.type), index + 1, items.length)}
        onMouseDownCapture={event => { if (event.button === 0) { event.stopPropagation(); onFocusCell?.() } }}
        onClick={event => { event.stopPropagation(); onFocusCell?.() }}
        onDoubleClick={event => { event.stopPropagation(); onOpen?.() }}
        onDragStart={event => { dragged.current = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-nexus-media-reorder', item.id) }}
        onDragOver={event => { if (dragged.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTarget(item.id) } }}
        onDragLeave={() => setTarget(null)}
        onDragEnd={() => { dragged.current = null; setTarget(null); onFocusCell?.() }}
        onDrop={event => {
          if (!dragged.current) return
          event.preventDefault(); event.stopPropagation()
          const ids = items.map(item => item.id), from = ids.indexOf(dragged.current)
          if (from >= 0 && from !== index) { const [id] = ids.splice(from, 1); ids.splice(index, 0, id); onReorder(ids) }
          dragged.current = null; setTarget(null)
        }}><StripThumbnail item={item} /></button> : <StripThumbnail item={item} />}
    </Tooltip>)}
    {items.length > count && <span className="nds-media-strip-count" aria-hidden>+{items.length - count}</span>}
    {!items.length && <span>{emptyLabel === undefined ? words.add : emptyLabel}</span>}
  </span>
}

function StripThumbnail({ item }: { item: MediaStripItem }) {
  const [failed, setFailed] = useState(false)
  const src = mediaImageUrl(item.preview)
  return <span className={`nds-media-strip-thumbnail${item.muted ? ' is-muted' : ''}`} aria-hidden>
    {src && !failed ? <img src={cdnFit(src, 96)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} /> : <MediaTypeIcon type={item.type} size={16} />}
    {src && !failed && item.type !== 'IMAGE' && <span className="nds-media-strip-kind"><MediaTypeIcon type={item.type} size={12} /></span>}
  </span>
}
