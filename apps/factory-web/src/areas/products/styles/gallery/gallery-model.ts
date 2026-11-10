import type { GalleryLooksView } from '@nexus/factory-domain/product/images/contracts'
import { isApiError } from '../../../../lib/api/errors'
import { storeUrl } from '../../../../record-panels/store'
import type { StyleRow } from '../api'

/**
 * Styles › Gallery (B-W2b-236; design products.styles sec:styles.view "SegmentedControl: List · Gallery (W2b)" and
 * sec:styles.gallery "Card: main picture, code, name, colourway swatches, status, revision"; "Card is a link; x selects; the
 * same filter chips apply"), pure: the view in the list's address (`?mode=gallery`, kept by a saved view like every other
 * term), each card from its row and its look, and the selection a key or a click makes.
 */

export type StyleLook = GalleryLooksView['looks'][number]

export const GALLERY_TERM = 'mode'
export const GALLERY_VALUE = 'gallery'

/** Whether the address asks for the gallery. */
export const galleryOn = (params: { get(name: string): string | null } | null | undefined): boolean => params?.get(GALLERY_TERM) === GALLERY_VALUE

/** The address terms (`?view=…&q=…` or empty) with the gallery on or off. */
export function withGallery(search: string, on: boolean): string {
  const params = new URLSearchParams(search.replace(/^\?/, ''))
  if (on) params.set(GALLERY_TERM, GALLERY_VALUE)
  else params.delete(GALLERY_TERM)
  const text = params.toString()
  return text ? `?${text}` : ''
}

export type LooksState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; byStyle: Record<string, StyleLook>; at: string } | { status: 'error'; problem: string }

export interface StylesGalleryModel {
  on: boolean
  looks: LooksState
}

export const GALLERY_OFF: StylesGalleryModel = { on: false, looks: { status: 'idle' } }

/** A card of the gallery: its row, its picture's address (null: none or not shown), its swatches. */
export interface GalleryCard {
  row: StyleRow
  src: string | null
  /** The picture is still being read (the card keeps its frame). */
  waiting: boolean
  caption: string | null
  pictures: number | null
  swatches: { code: string; name: string; hex: string | null }[]
}

export function cardsOf(rows: readonly StyleRow[], looks: LooksState): GalleryCard[] {
  return rows.map((row) => {
    const look = looks.status === 'ready' ? looks.byStyle[row.id] : undefined
    let src: string | null = null
    if (look?.picture?.look?.url.startsWith('data:image/')) src = look.picture.look.url
    else if (look?.picture?.look) {
      try {
        src = storeUrl(look.picture.look.url)
      } catch {
        src = null
      }
    }
    return { row, src, waiting: looks.status === 'loading', caption: look?.picture?.caption ?? null, pictures: look ? look.pictures : null, swatches: look ? look.colourways : [] }
  })
}

/** The ids asked for the cards on screen, in pages the route takes (60 at most). */
export function lookPages(ids: readonly string[], size = 60): string[][] {
  const pages: string[][] = []
  for (let at = 0; at < ids.length; at += size) pages.push(ids.slice(at, at + size))
  return pages
}

/** A swatch's colour when it is a plain hex the page may draw; else none (the swatch shows the code). */
export const swatchColour = (hex: string | null): string | null => (hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : null)

/** The selection after a click on a card's box: shift extends from the last one clicked. */
export function selectionAfter(ids: readonly string[], selected: readonly string[], id: string, shift: boolean, anchor: string | null): string[] {
  if (shift && anchor && ids.includes(anchor)) {
    const [from, to] = [ids.indexOf(anchor), ids.indexOf(id)].sort((a, b) => a - b)
    return [...new Set([...selected, ...ids.slice(from!, to! + 1)])]
  }
  return selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]
}

export function looksProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'forbidden') return 'styles.gallery.looksForbidden'
  return 'styles.gallery.looksFailed'
}
