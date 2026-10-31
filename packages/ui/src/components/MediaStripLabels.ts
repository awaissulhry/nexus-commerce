import { mediaTypeLabel } from './MediaPreview'

/** `MediaStrip`'s words (B-W2b-04). English by default; `emptyLabel` still wins over `add`. */
export interface MediaStripLabels {
  /** The strip's name: "Photos, 3 media items". */
  items: (label: string, count: number) => string
  /** A media type's name: "Image", "Video", "3D model" (types IMAGE, VIDEO, EXTERNAL_VIDEO, MODEL_3D, AUDIO, DOC). */
  type: (type: string) => string
  /** Added to a muted item's tooltip: "Image · shared". */
  shared: string
  /** Added to the tooltip when the strip can be reordered. */
  reorderHint: string
  /** A reorderable item's name: "Front, position 1 of 3". */
  position: (name: string, place: number, count: number) => string
  /** Shown with no media (when no `emptyLabel` is passed). */
  add: string
}

export const MEDIA_STRIP_LABELS: MediaStripLabels = {
  items: (label, count) => `${label}, ${count} media items`,
  type: (type) => mediaTypeLabel(type),
  shared: 'shared',
  reorderHint: 'Drag to reorder. Enter or F2 opens all media and position controls.',
  position: (name, place, count) => `${name}, position ${place} of ${count}`,
  add: 'Add media',
}
