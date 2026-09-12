/**
 * PES.7 — the images belonging to ONE record, for PES.4's drawer (audit 4.12). Pure, tested.
 *
 * 🔴 **A child SKU almost never has images of its own, and that is not the same as having none.**
 * Measured on GALE-JACKET: 24 images on the parent, **0 on every one of its 20 children**. A read
 * that returned only the record's own rows would make the drawer say *"No images on this record.
 * Every channel that requires one will refuse the listing"* for twenty SKUs that are perfectly
 * well illustrated by their parent's gallery. That is a false alarm, and a loud one.
 *
 * So a record with no images of its own INHERITS its parent's, and says so. The distinction is
 * carried in the return value rather than flattened away, because "these are its own" and "these
 * come from the family" are different facts an operator acts on differently.
 */

/** The shape PES.4's `GalleryStrip` consumes, plus the provenance it needs to be honest. */
export interface RecordImage {
  id: string
  url: string
  alt?: string
  isMain?: boolean
  /** True when this picture belongs to the parent, not to the record being read. */
  inherited?: boolean
}

export interface ProductImageRow {
  id: string
  url: string
  alt: string | null
  type: string
  sortOrder: number
  isPrimary: boolean
  mediaType?: string
}

export interface RecordImages {
  images: RecordImage[]
  /** null when the images are the record's own; otherwise where they came from. */
  inheritedFrom: string | null
}

/**
 * Which single image is this record's FACE.
 *
 * The same order the catalog thumbnail picker uses, and written down here because "which image
 * represents this product" is exactly the rule that gets re-derived differently in three places:
 *   1. the operator's explicit hero (`isPrimary`) — a deliberate choice always wins
 *   2. an image typed MAIN
 *   3. otherwise the first by sort order
 */
export function pickFaceImage(rows: readonly ProductImageRow[]): ProductImageRow | null {
  const images = rows.filter((r) => (r.mediaType ?? 'IMAGE') === 'IMAGE')
  if (images.length === 0) return null
  return (
    images.find((r) => r.isPrimary)
    ?? images.find((r) => r.type === 'MAIN')
    ?? [...images].sort((a, b) => a.sortOrder - b.sortOrder)[0]
  )
}

function toRecordImages(rows: readonly ProductImageRow[], inherited: boolean): RecordImage[] {
  const face = pickFaceImage(rows)
  return rows
    .filter((r) => (r.mediaType ?? 'IMAGE') === 'IMAGE')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({
      id: r.id,
      url: r.url,
      alt: r.alt ?? undefined,
      isMain: face?.id === r.id,
      ...(inherited ? { inherited: true } : {}),
    }))
}

/**
 * Resolve what the drawer should show for a record.
 *
 * `parentRows` is only consulted when the record has none of its own — a record with even one image
 * of its own is showing ITS gallery, not a mixture, because a half-inherited strip cannot be read.
 */
export function resolveRecordImages(args: {
  ownRows: readonly ProductImageRow[]
  parentRows?: readonly ProductImageRow[]
  parentLabel?: string | null
}): RecordImages {
  const { ownRows, parentRows = [], parentLabel = null } = args
  const own = toRecordImages(ownRows, false)
  if (own.length > 0) return { images: own, inheritedFrom: null }
  const inherited = toRecordImages(parentRows, true)
  if (inherited.length === 0) return { images: [], inheritedFrom: null }
  return { images: inherited, inheritedFrom: parentLabel ?? 'the parent product' }
}
