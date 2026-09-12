'use client'

/**
 * VP.4 — §4.4, the mapping dock. 420px, docked into the frame's track, explicit Save.
 *
 * ## How it docks, and why it is not the record drawer
 *
 * `StudioFrame` renders `<aside data-studio-dock>` as a FLEX SIBLING of the tab body, width
 * `var(--studio-dock-w, 0px)`, and publishes nothing into it. `drawer/StudioDock.tsx` is the
 * pattern: find the track, set the variable ON THE TRACK (scoped, so no global custom property is
 * written), portal into it.
 *
 * 🔴 **This one sets 420px where the record drawer sets 0px, and the difference is the point.** The
 * record panel became a SLIDE-OVER (layout v2 §5): it is `position: fixed`, it overlays the sheet,
 * and it publishes 0 so the sheet keeps its full width underneath. A mapping dock is the other
 * shape — §4.4 says "docks into the frame's track exactly like StudioDock … in-flow sibling, sheet
 * shrinks". So the panel here is an ordinary in-flow child of the track and the track carries the
 * width. Reading `StudioDock`'s `0px` as "the dock pattern publishes zero" would have produced a
 * panel that covers the grid it is describing.
 *
 * 🔴 **The track is `overflow: hidden`** (`studio.module.css`). Anything inside that is
 * `position: absolute` — a tooltip bubble, a listbox popup — is clipped BY THE TRACK: rendered,
 * invisible, un-hit-testable, with no error anywhere (PES.4.8, and
 * reference_gridcard_clips_dropdowns). Every popup this panel opens must be `position: fixed`. The
 * DS pieces used here are: `Listbox` (portals to `<body>` at `position: fixed` via
 * `usePopoverPosition`) and `Tooltip portal`. Verified on screen, not assumed — the reading is in
 * `docs/pes-claims.md`.
 *
 * ## Save
 *
 * Explicit, not autosave: one PATCH carrying `expectedVersion`, 409 → repaint + refetch exactly
 * like the sheet (`useProjection`). Unsaved changes arm the studio's navigation guard — the same
 * two mechanisms every explicit-save editor in this studio uses, `registerScopeChangeGuard` for a
 * scope/market change and `usePresentationNavigationGuard` for links, Back/Forward and unload.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { usePresentationNavigationGuard } from '@/app/products/ebay-flat-file/Presentation/usePresentationNavigationGuard'

import { useStudioScope } from '../../contracts'
import { dockSubtitle, dockTitle } from './copy'
import { LockBanner, SpecificsSection, SplitSection, ValuesSection } from './dock/sections'
import type { ProjectionDraft, ProjectionPage } from './types'

/** §2's measured width for the record/mapping dock. */
export const MAPPING_DOCK_W = 420

export interface MappingDockProps {
  page: ProjectionPage
  /** The family's SKU, for the sub-line. The projection read does not carry a parent row yet. */
  parentSku: string
  open: boolean
  saving: boolean
  /** A refusal or conflict from the last save, stated in the panel that caused it. */
  writeError: string | null
  onClose(): void
  onSave(draft: ProjectionDraft): Promise<boolean>
}

/** The draft the panel edits, derived from the page it opened on. */
function draftOf(page: ProjectionPage): ProjectionDraft {
  return {
    mapping: [...page.mapping].sort((a, b) => a.order - b.order).map((m, i) => ({ ...m, order: i })),
    split: { mode: page.split.mode, axisKey: page.split.axisKey },
  }
}

function sameDraft(a: ProjectionDraft, b: ProjectionDraft, page: ProjectionPage): boolean {
  // A drag followed by its inverse, or accepting the unchanged value order, is not an edit.
  const baseAxes = b.mapping.map(mapping => mapping.axisKey)
  if (JSON.stringify(a.presentationOrder?.change.axes ?? baseAxes) !== JSON.stringify(b.presentationOrder?.change.axes ?? baseAxes)) return false
  for (const axis of page.order?.resolvedAxes ?? []) {
    if (JSON.stringify(a.presentationOrder?.change.values?.[axis.key] ?? axis.values) !== JSON.stringify(b.presentationOrder?.change.values?.[axis.key] ?? axis.values)) return false
  }
  if (a.split.mode !== b.split.mode || a.split.axisKey !== b.split.axisKey) return false
  if (a.mapping.length !== b.mapping.length) return false
  return a.mapping.every((m, i) => m.axisKey === b.mapping[i].axisKey && m.target === b.mapping[i].target && m.order === b.mapping[i].order)
}

export function MappingDock({ page, parentSku, open, saving, writeError, onClose, onSave }: MappingDockProps) {
  const [track, setTrack] = useState<HTMLElement | null>(null)
  const { registerScopeChangeGuard } = useStudioScope()

  /**
   * The draft is keyed on the version the panel opened at. A 409 repaint bumps `page.version`, and
   * re-deriving the draft then is the whole 409 contract: the operator's stale edits are replaced
   * by the server's current mapping, with the reason beside them. Re-deriving on every `page`
   * identity instead would also discard an edit every time an unrelated include/exclude landed.
   */
  const [draft, setDraft] = useState<ProjectionDraft>(() => draftOf(page))
  const openedAt = useRef<number>(page.version)
  useEffect(() => {
    if (page.version === openedAt.current) return
    openedAt.current = page.version
    setDraft(draftOf(page))
  }, [page])
  useEffect(() => { if (open) { setDraft(draftOf(page)); openedAt.current = page.version } }, [open])

  const baseline = useMemo(() => draftOf(page), [page])
  const dirty = !sameDraft(draft, baseline, page)

  useEffect(() => {
    setTrack(document.querySelector<HTMLElement>('[data-studio-dock]'))
  }, [open])

  /**
   * Publish the width — and give the track back exactly as it was found.
   *
   * The record drawer writes `border-left-width: 0px` on the track when it portals (its panel is
   * fixed, so the frame's `.dock:not(:empty)` seam would be a 1px line belonging to nothing). A
   * true dock WANTS that seam, so this clears the override while it owns the track and restores
   * nothing it did not set. `data-vp-dock` marks ownership so two panels cannot fight over one
   * inline style without it being visible in the DOM.
   */
  useEffect(() => {
    if (!track) return
    if (!open) return
    track.style.setProperty('--studio-dock-w', `${MAPPING_DOCK_W}px`)
    track.style.removeProperty('border-left-width')
    track.dataset.vpDock = 'mapping'
    return () => {
      if (track.dataset.vpDock !== 'mapping') return
      track.style.setProperty('--studio-dock-w', '0px')
      delete track.dataset.vpDock
    }
  }, [track, open])

  const close = useCallback(() => {
    /* An explicit-save panel does not throw away an edit on a stray click. The confirm is the
       browser's on navigation (below); here the operator is told, and the panel stays. */
    onClose()
  }, [onClose])

  const save = useCallback(async () => {
    const ok = await onSave(draft)
    if (ok) onClose()
  }, [draft, onSave, onClose])

  /* The studio's navigation guard, both halves — a scope/market change (the frame asks), and
     links / Back / Forward / unload (the shared installer every explicit-save editor here uses). */
  const blocking = open && (dirty || saving)
  useEffect(() => registerScopeChangeGuard(() => !blocking), [registerScopeChangeGuard, blocking])
  usePresentationNavigationGuard(blocking, async () => false)

  if (!track || !open) return null

  return createPortal(
    <aside className="nds-vp-dock" role="dialog" aria-label={dockTitle(page.coordinate.label)}>
      <header className="nds-vp-dock-header">
        <div className="nds-vp-dock-identity">
          <h2 className="nds-vp-dock-name">{dockTitle(page.coordinate.label)}</h2>
          <p className="nds-vp-dock-sub">
            {dockSubtitle(parentSku, page.children.length, page.split.listings.length, page.coordinate.accountLabel)}
          </p>
        </div>
        <Button size="sm" variant="ghost" aria-label="Close the mapping panel" onClick={close}>
          <X size={14} aria-hidden />
        </Button>
      </header>

      <div className="nds-vp-dock-body">
        {writeError && <Banner tone="danger">{writeError}</Banner>}
        <SpecificsSection page={page} draft={draft} onDraft={setDraft} />
        <ValuesSection page={page} draft={draft} onDraft={setDraft} />
        <SplitSection page={page} draft={draft} onDraft={setDraft} />
        <LockBanner page={page} />
      </div>

      <footer className="nds-vp-dock-footer">
        {/* The unsaved state is STATED, not only implied by an enabled button — the guard that will
            stop a navigation has to be visible before it fires. */}
        <span className="nds-vp-dock-state" role="status">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : ''}</span>
        <Button size="sm" disabled={saving} onClick={close}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={saving || !dirty} onClick={() => void save()}>Save mapping</Button>
      </footer>
    </aside>,
    track,
  )
}
