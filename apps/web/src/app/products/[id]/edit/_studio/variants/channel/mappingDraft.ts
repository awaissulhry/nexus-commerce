/**
 * The mapping dock's draft, and the page it was made on — pure, so the rule is testable without a renderer.
 *
 * 🔴 2.4 — the dock keeps an UNSAVED mapping through every refresh: a tick on the grid, a pin, a Reload, a read that
 * brings the version up. It used to start again from the page whenever the version moved, so one tick threw the
 * edits away. Now:
 *   - an untouched draft follows each new page (there is nothing of the operator's to keep);
 *   - an edited draft stays, with the page it was made on (`base`). Its save is sent at THAT version, moved along
 *     this page's own writes only (`useProjection`), so a mapping someone else saved meanwhile answers 409 instead
 *     of being overwritten unseen;
 *   - that real 409 is the one reset: the draft starts again from the server's mapping, and the dock says so.
 */
import type { ProjectionDraft, ProjectionPage } from './types'

export interface HeldDraft {
  draft: ProjectionDraft
  /** The page the draft was made on. Its `version` is what the save is sent at. */
  base: ProjectionPage
}

/** The draft the panel edits, derived from the page it opened on. */
export function draftOf(page: ProjectionPage): ProjectionDraft {
  return {
    mapping: [...page.mapping].sort((a, b) => a.order - b.order).map((m, i) => ({ ...m, order: i })),
    split: { mode: page.split.mode, axisKey: page.split.axisKey },
  }
}

export function sameDraft(a: ProjectionDraft, b: ProjectionDraft, page: ProjectionPage): boolean {
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

/** A fresh draft from `page` — on open, and after a real conflict. */
export const startDraft = (page: ProjectionPage): HeldDraft => ({ draft: draftOf(page), base: page })

/** Has the operator changed anything since the draft was made? Measured against the page it was made on. */
export const draftDirty = (held: HeldDraft): boolean => !sameDraft(held.draft, draftOf(held.base), held.base)

/**
 * A new page reached the dock. `conflicted`: a Save mapping just answered a real 409 — start again from the server's
 * mapping. Otherwise an edited draft is kept as it is, and an untouched one follows the page.
 */
export function heldAfter(held: HeldDraft, page: ProjectionPage, conflicted: boolean): HeldDraft {
  if (conflicted) return startDraft(page)
  if (held.base === page) return held
  return draftDirty(held) ? held : startDraft(page)
}
