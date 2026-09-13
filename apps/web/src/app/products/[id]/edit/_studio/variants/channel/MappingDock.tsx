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
import { axesCellFromProjection, variationThemeChange } from '@/design-system/grid/editors'
import { Button } from '@/design-system/primitives'
import { usePresentationNavigationGuard } from '@/app/products/ebay-flat-file/Presentation/usePresentationNavigationGuard'

import { useStudioProduct, useStudioScope } from '../../contracts'
import { dockSubtitle, dockTitle } from './copy'
import { CollisionsSection, LockBanner, SpecificsSection, SplitSection, ValuesSection } from './dock/sections'
import { ThemeChangePlanModal, fetchThemeChangePlan, type ThemeChangePlan } from './ThemeChangePlanModal'
import type { ProjectionDraft, ProjectionPage } from './types'


/**
 * Is THIS save a SET change on a LIVE coordinate — i.e. an operation, not a write?
 *
 * Design §3.5 and VX §7's channel facts behind it: Amazon cannot re-theme a parent in place, eBay must
 * end and relist, Shopify needs the option mutations with a variant strategy. So the dock refuses to
 * send it and opens the dry-run plan instead. `page.locked` is the SERVER's statement that the
 * coordinate is live — a client inferring "live" from an external id being present would be asserting
 * a publish state it cannot see.
 *
 * 🔴 VT.2c — ONE definition of "did the SET move", shared with the sheet cell.
 *
 * This used to compare the axisKey SETS inline, and that rule and the server's disagreed on one real
 * case: RE-POINTING an axis at a different target (`Colore → Scollatura`) is a set change to
 * `variationThemeChange` (the delivered names are what a buyer picks from) and was NOT one to that
 * comparison — so the dock sent the PATCH, and VT.1b's route now answers **409 `axes_locked`**, which
 * `useProjection` reports as a conflict. A live set change is a PLAN, never a cell write (design VT.6
 * / §3.5), so the client must refuse it with the same rule the server refuses it with: re-deriving an
 * "equivalent" test one line away is `reference_write_predicate_must_match_its_readers`, and it cost
 * this exact branch a 409.
 *
 * 🔴 ORDER-only stays a normal save when the lock allows it (`orderChangeAllowed`, `true` on
 * eBay/Shopify) — the one change §3.5 lets through a lock, and the reason this is not `kind !== 'none'`.
 *
 * Exported because it decides the primary button's LABEL and whether a PATCH is issued at all, and a
 * browser can only show one arm of that at a time.
 */
export function lockedSetChangeOf(page: ProjectionPage, draft: ProjectionDraft): boolean {
  if (!page.locked) return false
  const moved = variationThemeChange(
    axesCellFromProjection(page, { mapping: page.mapping }),
    axesCellFromProjection(page, draft),
  )
  if (moved.kind === 'none') return false
  return !(moved.orderOnly && page.locked.orderChangeAllowed)
}

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
  /* The record the studio is open on — ONE source for the id (contracts.tsx's own rule). The projection
     read's `parent.id` is the same id, but it is typed optional ("absent today"), and a plan URL built on
     an empty string would 404 with nothing saying why. */
  const product = useStudioProduct()

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

  /** VT.4's rule, VT.2c's definition — see `lockedSetChangeOf` above. */
  const lockedSetChange = useMemo(() => lockedSetChangeOf(page, draft), [page, draft])

  const [plan, setPlan] = useState<ThemeChangePlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planOpen, setPlanOpen] = useState(false)

  const save = useCallback(async () => {
    if (lockedSetChange) {
      /* NOTHING is written on this path — not even an attempt. The plan is a read. */
      setPlan(null)
      setPlanError(null)
      setPlanOpen(true)
      try {
        setPlan(await fetchThemeChangePlan({
          coordinate: {
            productId: page.parent?.id ?? product.id,
            channel: page.coordinate.channel,
            market: page.coordinate.market,
            accountId: page.coordinate.accountId,
            aliasKey: page.coordinate.aliasKey,
          },
          expectedVersion: page.version,
          mapping: draft.mapping.filter(m => m.target !== null).map((m, order) => ({ axisKey: m.axisKey, target: m.target as string, order })),
          ...(page.theme ? { theme: page.theme.value } : {}),
        }))
      } catch (e) {
        /* The server's sentence, verbatim. A refusal here is something the operator can act on. */
        setPlanError(e instanceof Error ? e.message : String(e))
      }
      return
    }
    const ok = await onSave(draft)
    if (ok) onClose()
  }, [draft, onSave, onClose, lockedSetChange, page, product.id])

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
        {/* VT.4 — VX §6, in Appendix C's dock order: Values → Collisions → Listing split. It sits above
            Listing split because a split IS one of its three resolvers, so the problem is read first. */}
        <CollisionsSection page={page} draft={draft} />
        <SplitSection page={page} draft={draft} onDraft={setDraft} />
        <LockBanner page={page} />
      </div>

      <footer className="nds-vp-dock-footer">
        {/* The unsaved state is STATED, not only implied by an enabled button — the guard that will
            stop a navigation has to be visible before it fires. */}
        <span className="nds-vp-dock-state" role="status">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : ''}</span>
        <Button size="sm" disabled={saving} onClick={close}>Cancel</Button>
        {/* VT.4 — the label says which of the two the click does, BEFORE it is clicked. A button reading
            "Save mapping" that opened a plan instead would be the label/handler disagreement the DS rules
            exist to prevent. */}
        <Button size="sm" variant="primary" disabled={saving || !dirty} onClick={() => void save()}>
          {lockedSetChange ? 'Change variation theme…' : 'Save mapping'}
        </Button>
      </footer>
      {/* VT.4 — dry run only (D-VT6 / VX D8). Its primary action is `Copy plan`, never `Run`. */}
      <ThemeChangePlanModal open={planOpen} onClose={() => setPlanOpen(false)} plan={plan} error={planError} />
    </aside>,
    track,
  )
}
