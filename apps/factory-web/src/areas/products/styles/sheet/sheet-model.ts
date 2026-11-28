import type { StylePicturesView } from '@nexus/factory-domain/product/images/contracts'
import type { MeasurementSpecView } from '@nexus/factory-domain/product/measures/contracts'
import type { ProtectorPlacementView } from '@nexus/factory-domain/product/protectors/contracts'
import type { StyleView } from '../api'
import { pictureSrc } from '../record/gallery/gallery-model'
import { howToOf, madeForOf, mainPicturesOf, type HowToRow } from '../record/product-model'
import { revisionInView } from '../model'

/**
 * owb-pd4 step 4.2 (design § 5q "the product sheet never has a price"; prototype prod.js prodSheet / prodSheetSvg) — the Product
 * sheet: ONE A4 page of a product for the browser to print or save as PDF — the design pictures (front and back), the facts, the size
 * table, how to measure and the protectors. Built only from reads that carry no money (the product, its pictures, its measurement
 * spec, its protector placement): the sheet has no price, cost or margin key, whoever opens it.
 */

/** A key of the products-overview catalogue and its params. */
export interface SheetWords {
  key: string
  params?: Record<string, string | number>
}

export interface ProductSheet {
  name: string
  code: string
  /** "Revision 2 · Released" of the revision shown; null: the product has none yet. */
  revision: { revision: number; status: StyleView['revisions'][number]['status'] } | null
  facts: Array<{ label: string; value: SheetWords | { text: string } }>
  pictures: Array<{ src: string; caption: string | null }>
  /** The size table of the revision (points × sizes, the base marked); null: no spec, or not in the person's reads. */
  sizes: { columns: string[]; base: string | null; rows: Array<{ code: string; name: string; values: Array<string | null>; tolerance: string | null }> } | null
  howTo: HowToRow[]
  protectors: Array<{ pocket: string; level: string; sizes: string[] }>
}

export interface SheetInput {
  style: StyleView
  revisionId: string | null
  gallery: StylePicturesView | null
  /** The measurement spec of the revision shown (the BOM's read); null: not read. */
  spec: MeasurementSpecView | null
  /** The protector placement of the revision shown (the BOM's read); null: not read. */
  protectors: ProtectorPlacementView | null
  locale: 'it' | 'en'
}

const tolerance = (minus: string, plus: string): string => (Number(minus) === Number(plus) ? `± ${Number(minus)}` : `−${Number(minus)} / +${Number(plus)}`)

export function productSheetOf(input: SheetInput): ProductSheet {
  const { style, locale } = input
  const revision = revisionInView(style.revisions, input.revisionId)
  const sizes: SheetWords | { text: string } =
    style.sizes.length > 0 ? { key: style.baseSize ? 'sheet.sizesBase' : 'sheet.sizesOnly', params: { sizes: style.sizes.join(' · '), base: style.baseSize ?? '' } } : style.mtmAllowed ? { key: 'sheet.mtm' } : { key: 'sheet.noSizes' }
  const protection: SheetWords | { text: string } =
    style.ppeCategory === 'NOT_PPE' ? { key: 'sheet.notPpe' } : { text: [style.ppeStandard, style.ppeClass ? `CE ${style.ppeClass}` : null].filter(Boolean).join(' · ') || '—' }
  const spec = input.spec && input.spec.spec && input.spec.revision.id === revision?.id ? input.spec : null
  const columns = spec ? spec.sizes.map((size) => size.code) : []
  const points = spec ? [...spec.points].filter((point) => point.status !== 'ARCHIVED').sort((a, b) => a.seq - b.seq) : []
  return {
    name: style.nameI18n?.[locale]?.trim() || style.name,
    code: style.code,
    revision: revision ? { revision: revision.revision, status: revision.status } : null,
    facts: [
      { label: 'sheet.type', value: { key: `productType.${style.productType}` } },
      { label: 'sheet.family', value: madeForOf(style) },
      ...(style.season ? [{ label: 'sheet.season', value: { text: style.season } }] : []),
      { label: 'sheet.sizes', value: sizes },
      { label: 'sheet.protection', value: protection },
    ],
    pictures: mainPicturesOf(input.gallery).flatMap((picture) => {
      const src = pictureSrc(picture)
      return src ? [{ src, caption: picture.caption }] : []
    }),
    sizes:
      spec && points.length > 0
        ? {
            columns,
            base: spec.spec?.baseSize ?? null,
            rows: points.map((point) => {
              const values = columns.map((size) => point.cells.find((cell) => cell.size === size)?.value?.nominal ?? null)
              const first = point.cells.find((cell) => cell.size === spec.spec?.baseSize)?.value ?? point.cells.find((cell) => cell.value)?.value ?? null
              return { code: point.code, name: point.nameI18n?.[locale]?.trim() || point.name, values, tolerance: first ? tolerance(first.toleranceMinus, first.tolerancePlus) : null }
            }),
          }
        : null,
    howTo: spec ? howToOf(spec.points, locale) : [],
    protectors:
      input.protectors && input.protectors.revision.id === revision?.id
        ? [...input.protectors.placements].sort((a, b) => a.seq - b.seq).map((placement) => ({ pocket: placement.pocket, level: placement.level, sizes: placement.sizes }))
        : [],
  }
}
