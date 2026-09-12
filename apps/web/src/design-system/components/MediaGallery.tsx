'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, GripVertical, ImageOff, MoreHorizontal, Star, Trash2 } from 'lucide-react'
import { Checkbox } from '../primitives/Checkbox'
import { ToolbarButton } from '../primitives/ToolbarButton'
import { Menu } from './Menu'
import { Select } from '../primitives/Select'
import { cdnFit } from '../lib/cdn-image'
import { MediaTypeIcon, mediaTypeLabel, mediaImageUrl } from './MediaPreview'

export interface MediaCardProps {
  src?: string | null
  /** A file-type or processing placeholder when the source has no image preview. */
  placeholder?: ReactNode
  mediaType?: string
  label: string
  detail?: ReactNode
  marker?: ReactNode
  onPreview(): void
  selected?: boolean
  onSelectedChange?(selected: boolean): void
  disabled?: boolean
  actions?: ReactNode
}

/** Uncropped image, explicit failure, independent preview/selection/actions. */
export function MediaCard({ src, placeholder, mediaType, label, detail, marker, onPreview, selected, onSelectedChange, disabled, actions }: MediaCardProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const preview = mediaImageUrl(src)
  return <article className={`nds-media-card${selected ? ' is-selected' : ''}`}>
    <div className="nds-media-card-head">
      {onSelectedChange ? <Checkbox label={label} checked={selected ?? false} disabled={disabled} onChange={event => onSelectedChange(event.target.checked)} /> : <span>{label}</span>}
      {marker != null && <span className="nds-media-card-marker">{marker}</span>}
    </div>
    <button type="button" className="nds-media-card-preview" onClick={onPreview} aria-label={`Inspect ${label}`}>
      {!preview ? <span className="nds-media-card-failure">{placeholder ?? (mediaType ? <MediaTypeIcon type={mediaType} size={24} /> : <><ImageOff size={24} aria-hidden />No preview available</>)}</span>
        : failedSrc === src ? <span className="nds-media-card-failure"><ImageOff size={24} aria-hidden />Image unavailable</span>
        : <img src={cdnFit(preview, 640)} alt={label} loading="lazy" decoding="async" onError={() => setFailedSrc(src ?? null)} />}
      {mediaType && mediaType !== 'IMAGE' && <span className="nds-media-card-type"><MediaTypeIcon type={mediaType} size={12} />{mediaTypeLabel(mediaType)}</span>}
    </button>
    {detail != null && <div className="nds-media-card-detail">{detail}</div>}
    {actions != null && <div className="nds-media-card-actions">{actions}</div>}
  </article>
}

export interface MediaGalleryItem { id: string; src?: string | null; label: string; detail?: ReactNode; mediaType?: string; placeholder?: ReactNode }
export interface MediaGalleryProps {
  label: string
  items: readonly MediaGalleryItem[]
  onChange(ids: string[]): void
  onRemove?(id: string): void
  onPreview(id: string): void
  disabled?: boolean
  firstLabel?: string
  /** Expose an explicit one-based position selector when arbitrary moves are needed. */
  positionControls?: boolean
  /** Featured first tile and compact contextual actions for an anchored editor. */
  compact?: boolean
}

/** Controlled gallery; drag and labelled move buttons perform the identical reorder. */
export function MediaGallery({ label, items, onChange, onRemove, onPreview, disabled = false, firstLabel = 'Cover', positionControls = false, compact = false }: MediaGalleryProps) {
  const dragged = useRef<string | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const focusAfterRemove = useRef<string | false | null>(false)
  const [announcement, setAnnouncement] = useState('')
  const [keyboardMove, setKeyboardMove] = useState<{ id: string; position: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (focusAfterRemove.current === false) return
    const next = focusAfterRemove.current
    const target = next ? list.current?.querySelector<HTMLButtonElement>(`[data-media-id="${CSS.escape(next)}"] .nds-media-card-preview`) : null
    ;(target ?? list.current)?.focus()
    focusAfterRemove.current = false
  }, [items])
  function move(from: number, to: number) {
    if (disabled || from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return
    const ids = items.map(item => item.id)
    const [id] = ids.splice(from, 1); ids.splice(to, 0, id)
    onChange(ids); setAnnouncement(`${items[from].label}, position ${to + 1} of ${items.length}.`)
  }
  function remove(index: number) {
    if (disabled || !onRemove) return
    const item = items[index]
    focusAfterRemove.current = items[index + 1]?.id ?? items[index - 1]?.id ?? null
    onRemove(item.id); setAnnouncement(`${item.label} removed from this gallery. The source file is retained.`)
  }
  return <>
    <ol ref={list} tabIndex={-1} className={`nds-media-gallery${compact ? ' compact' : ''}`} aria-label={label}>
      {items.map((item, index) => <li key={item.id} data-media-id={item.id} data-drop-target={dropTarget === item.id || keyboardMove?.position === index || undefined}
        onDragOver={event => { if (dragged.current && !disabled) { event.preventDefault(); setDropTarget(item.id) } }}
        onDrop={event => { event.preventDefault(); if (dragged.current) move(items.findIndex(x => x.id === dragged.current), index); dragged.current = null; setDropTarget(null) }}>
        <MediaCard src={item.src} mediaType={item.mediaType} placeholder={item.placeholder} label={item.label} detail={item.detail}
          marker={index === 0 ? firstLabel : `${index + 1}`} onPreview={() => onPreview(item.id)} actions={<>
            <ToolbarButton icon={<GripVertical size={16} />} label={`Move ${item.label}`} description="Space to pick up, arrow keys to choose a position, Space to drop, Escape to cancel." disabled={disabled}
              onKeyDown={event => {
                if (disabled) return
                if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (keyboardMove?.id === item.id) { move(index, keyboardMove.position); setKeyboardMove(null) } else { setKeyboardMove({ id: item.id, position: index }); setAnnouncement(`${item.label} picked up. Choose a position with arrow keys.`) } }
                else if (keyboardMove?.id === item.id && ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); const position = Math.max(0, Math.min(items.length - 1, keyboardMove.position + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1))); setKeyboardMove({ id: item.id, position }); setAnnouncement(`Target position ${position + 1} of ${items.length}.`) }
                else if (event.key === 'Escape' && keyboardMove) { event.preventDefault(); event.stopPropagation(); setKeyboardMove(null); setAnnouncement('Move cancelled. The original order is unchanged.') }
              }}
              onBlur={() => setKeyboardMove(null)} draggable={!disabled} onDragStart={event => { dragged.current = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id) }} onDragEnd={() => { dragged.current = null; setDropTarget(null) }} />
            {compact ? <Menu label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': `Actions for ${item.label}`, title: `Actions for ${item.label}`, disabled, className: 'nds-btn xs' }} items={[
              { id: 'earlier', label: 'Move earlier', disabled: disabled || index === 0, onSelect: () => move(index, index - 1) },
              { id: 'later', label: 'Move later', disabled: disabled || index === items.length - 1, onSelect: () => move(index, index + 1) },
              { id: 'first', label: 'Make first', disabled: disabled || index === 0, onSelect: () => move(index, 0) },
              ...(positionControls ? [{ id: 'positions', separator: true }, ...items.map((_, position) => ({ id: `position-${position}`, label: `Move to position ${position + 1}`, disabled: disabled || position === index, onSelect: () => move(index, position) }))] : []),
              ...(onRemove ? [{ id: 'remove-separator', separator: true }, { id: 'remove', label: 'Remove from gallery', disabled, onSelect: () => remove(index) }] : []),
            ]} /> : <>
            <ToolbarButton icon={<ArrowLeft size={16} />} label={`Move ${item.label} earlier`} disabled={disabled || index === 0} onClick={() => move(index, index - 1)} />
            <ToolbarButton icon={<ArrowRight size={16} />} label={`Move ${item.label} later`} disabled={disabled || index === items.length - 1} onClick={() => move(index, index + 1)} />
            <ToolbarButton icon={<Star size={16} />} label={`Make ${item.label} first`} disabled={disabled || index === 0} onClick={() => move(index, 0)} />
            {positionControls && <Select size="sm" aria-label={`Position of ${item.label}`} value={String(index)} disabled={disabled} onChange={event => move(index, Number(event.target.value))}>{items.map((_, position) => <option key={position} value={position}>Position {position + 1}</option>)}</Select>}
            </>}
            {onRemove && !compact && <ToolbarButton icon={<Trash2 size={16} />} label={`Remove ${item.label} from this gallery`} disabled={disabled} onClick={() => remove(index)} />}
          </>} />
      </li>)}
    </ol>
    <span className="nds-media-gallery-status" role="status">{announcement}</span>
  </>
}
