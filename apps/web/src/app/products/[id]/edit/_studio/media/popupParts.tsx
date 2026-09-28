'use client'

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react'
import { X } from 'lucide-react'

import { FileDropzone, MediaCard, MediaPreview, mediaTypeLabel } from '@/design-system/components'
import { Button, Input, SegmentedControl, Spinner, Tag, ToolbarButton } from '@/design-system/primitives'

import styles from './media.module.css'

/**
 * Lane C — the pieces the two Product media pop-ups share (the photo plan's and the older gallery's), so both behave
 * EXACTLY the same: the press guards around `CellPanel`, the keys, the family's photos under "+ Add", the uploads, the
 * bigger photo and the checks list.
 */

/** Photos changed in the cells at once; `restore` puts them back when the save is refused, `done` ends "saving". */
export interface AppliedCells { restore(): void; done(): void }

/** Enter while an upload is still sending: the upload joins the list on Enter, so Enter waits. */
export const UPLOAD_RUNNING = 'Not saved yet: an upload is still running. Press Enter again when it shows “added”.'

export type Upload = { name: string; state: 'sending' | 'added' | 'exact' | 'similar' | 'failed'; message?: string; candidate?: { id: string; label: string }; file?: File }

/**
 * The guards around the panel's own "a press outside saves":
 * - a press inside a menu this pop-up opened (a photo's ⋯ menu draws outside it) is not "outside" (`menuPress`);
 * - a press outside that is held back (refused, or saving) must not also click what is under it — another cell's pencil
 *   would open a second pop-up over this one's answer (`holdClick`);
 * - `mounted`: a late answer after the pop-up closed must not touch it.
 * Registered on the window, so it runs before the panel's own listener on the document.
 */
export function usePopupGuards() {
  const menuPress = useRef(false)
  const press = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const onDown = (event: PointerEvent) => {
      menuPress.current = !!(event.target as Element | null)?.closest?.('.nds-menu')
      press.current = true
      window.setTimeout(() => { menuPress.current = false; press.current = false }, 0)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => { mounted.current = false; window.removeEventListener('pointerdown', onDown, true) }
  }, [])
  const holdClick = () => {
    if (!press.current) return
    const stop = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); done() }
    const done = () => { window.removeEventListener('click', stop, true); window.clearTimeout(timer) }
    const timer = window.setTimeout(done, 1000)
    window.addEventListener('click', stop, true)
  }
  return { menuPress, mounted, holdClick }
}

/** Focus the first photo (the panel focuses its first control first; a parent's effect runs after the panel's). */
export function useFirstPhotoFocus(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => { root.current?.querySelector<HTMLElement>('.nds-media-board-thumb[tabindex="0"]')?.focus({ preventScroll: true }) }, [root])
}

/**
 * Enter on a photo saves, like everywhere else in the pop-up (a click, or ⋯ → Open, shows the photo). Ctrl/⌘ + Enter
 * saves from anywhere, a text box included. While a photo is picked up, neither saves: Enter drops it. While a photo is
 * dragged with the pointer, Enter does nothing (the drop decides the order; a save now would lose it).
 */
export function photoKeys(root: RefObject<HTMLDivElement | null>, save: () => boolean) {
  return (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return
    const target = event.target as HTMLElement
    if (root.current?.querySelector('.nds-media-board-list.dragging')) { event.preventDefault(); event.stopPropagation(); return }
    // While a photo is picked up (keyboard move), Enter drops it; nothing saves until it is down.
    if (root.current?.querySelector('[data-picked]')) return
    if (event.metaKey || event.ctrlKey) { event.preventDefault(); event.stopPropagation(); save(); return }
    if (!target.closest('.nds-media-board-thumb')) return
    event.preventDefault(); event.stopPropagation()
    save()
  }
}

export function PopupHead({ context, title }: { context: string | null; title: string }) {
  return <div className={styles.popupHead}>
    <strong>Product media{context ? ` · ${context}` : ''}</strong>
    <span>{title}</span>
  </div>
}

export interface PopupCheckLine { severity: 'error' | 'warning'; message: string }
export function ChecksList({ checks, blocked }: { checks: readonly PopupCheckLine[]; blocked?: string | null }) {
  if (!checks.length) return null
  return <ul className={styles.checks} aria-label="Checks">
    {checks.map(c => <li key={c.message} data-severity={c.severity}><Tag tone={c.severity === 'error' ? 'danger' : 'warning'}>{c.severity === 'error' ? 'Refused' : 'Warning'}</Tag> {c.message}</li>)}
    {checks.some(c => c.severity === 'error') && blocked && <li className={styles.muted}>{blocked}</li>}
  </ul>
}

export interface ViewedPhoto { type: string; url: string; poster?: string | null; label: string; width?: number | null; height?: number | null; fileSize?: number | null; language?: string | null }
/** The bigger photo, in the panel (no dialog on a dialog); `children` = the fields the list keeps per photo. */
export function PhotoViewer({ photo, onClose, children }: { photo: ViewedPhoto; onClose(): void; children?: ReactNode }) {
  const facts = [mediaTypeLabel(photo.type), photo.width && photo.height ? `${photo.width} × ${photo.height}` : null,
    photo.fileSize ? `${(photo.fileSize / 1024 / 1024).toFixed(1)} MB` : null, photo.language === undefined ? null : photo.language === null || photo.language === 'zxx' ? 'no text' : photo.language.toUpperCase()].filter(Boolean).join(' · ')
  return <section className={styles.viewer} aria-label={`Photo: ${photo.label}`}>
    <div className={styles.viewerHead}>
      <span>{facts}</span>
      <ToolbarButton label="Close the photo" icon={<X size={14} />} onClick={onClose} />
    </div>
    <MediaPreview type={photo.type} url={photo.url} poster={photo.poster} label={photo.label} />
    <p className={styles.muted}>{photo.label}</p>
    {children}
  </section>
}

export interface LibraryCard { id: string; src: string | null; mediaType: string; label: string; width: number | null; height: number | null; tags: ReactNode }
export type LibraryShow = 'not-in-set' | 'all'
/**
 * "+ Add": the photos the row may use, each ticked when the list holds it; a tick adds at the end, an untick removes.
 * The caller chooses the list when it opens (not on every tick), so a ticked photo stays under the pointer.
 */
export function PhotoLibrary(props: {
  target: string; cards: readonly LibraryCard[]; picked(id: string): boolean; onToggle(id: string, on: boolean): void; onPreview(id: string): void
  search: string; onSearch(value: string): void; show: LibraryShow; onShow(value: LibraryShow): void; searchInput: Ref<HTMLInputElement>
  disabled: boolean; noun: string; accept: string; maxBytes: number; uploadHint: string; onFiles(files: File[]): void
  uploads: readonly Upload[]; onUseCandidate(upload: Upload): void; onUploadAnyway(upload: Upload): void
}) {
  const { target, cards, search, show, disabled, noun } = props
  return <section className={styles.library} aria-label={`Add to ${target}`}>
    <p className={styles.muted}>Add to {target} · tick {noun}, they join the end.</p>
    <div className={styles.libraryTools}>
      <Input ref={props.searchInput} size="sm" placeholder={`Search the ${noun}`} aria-label={`Search the ${noun}`} value={search} onChange={event => props.onSearch(event.target.value)} />
      <SegmentedControl size="sm" ariaLabel="Show" value={show} onChange={value => props.onShow(value as LibraryShow)}
        options={[{ value: 'not-in-set', label: 'Not in this list' }, { value: 'all', label: 'All' }]} />
    </div>
    {cards.length ? <ul className={styles.libraryGrid} aria-label={`The ${noun}`}>
      {cards.map(card => <li key={card.id}>
        <MediaCard compact src={card.src} mediaType={card.mediaType} label={card.label} selected={props.picked(card.id)} disabled={disabled}
          onSelectedChange={on => props.onToggle(card.id, on)} onPreview={() => props.onPreview(card.id)}
          detail={<span className={styles.facts}>{card.width && card.height ? <span>{card.width}×{card.height}</span> : null}{card.tags}</span>} />
      </li>)}
    </ul> : <p className={styles.muted}>{search ? 'Nothing matches.' : show === 'not-in-set' ? 'Everything is already in this list.' : 'Nothing here yet.'}</p>}
    <FileDropzone className={styles.upload} multiple accept={props.accept} maxBytes={props.maxBytes} disabled={disabled} hint={props.uploadHint} onFiles={props.onFiles} />
    {props.uploads.length > 0 && <ul className={styles.uploads} aria-label="Uploads">
      {props.uploads.map(u => <li key={u.name} role="status">
        {u.state === 'sending' && <><Spinner size={12} /> Uploading {u.name}…</>}
        {u.state === 'added' && <>✓ {u.name} — added.</>}
        {u.state === 'exact' && <>= {u.name} — already in the library; that one is added.</>}
        {u.state === 'failed' && <>✕ {u.name} — {u.message}</>}
        {u.state === 'similar' && u.candidate && <>≈ {u.name} looks like “{u.candidate.label}” in the library.{' '}
          <Button size="xs" variant="secondary" onClick={() => props.onUseCandidate(u)}>Use “{u.candidate.label}”</Button>{' '}
          <Button size="xs" variant="ghost" onClick={() => props.onUploadAnyway(u)}>Upload anyway</Button></>}
      </li>)}
    </ul>}
  </section>
}

export function MediaPageLink({ disabled, onOpen }: { disabled: boolean; onOpen(): void }) {
  return <div className={styles.popupFoot}>
    <Button size="xs" variant="link" disabled={disabled} onClick={() => { if (!disabled) onOpen() }}>All sets and channels: Media page</Button>
  </div>
}
