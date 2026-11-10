import { defineDesignScreen } from '../../../lib/design/design-screen'
import { designScreen as publicDoc } from '../fixtures'
import type { PublicDocViewModel } from '../model'
import { PublicDocView } from '../view/PublicDocView'

/**
 * SCR-102-picture (B-W2b-236, SY3:03) — the public DoC page with the style's main picture in "This product" (the B-W2b-166
 * gap "no picture"): served by the API only as its copy stripped of camera and location data, never the office's file.
 * Made-up data only: SCR-102's own pages with a made-up picture drawn here as a plain shape.
 */

const caseOf = (id: string): PublicDocViewModel => publicDoc.cases.find((entry) => entry.id === id)!.model

/** A made-up jacket as an inline SVG (design cases only; the page itself always shows the API's stripped copy). */
const SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 300"><rect width="320" height="300" fill="#f4f4f4"/><path d="M120 40 L160 30 L200 40 L250 70 L280 160 L250 170 L235 120 L235 260 L85 260 L85 120 L70 170 L40 160 L70 70 Z" fill="#1F1F1F" stroke="#2b2b2b" stroke-width="3"/></svg>',
)
const PICTURE_SRC = `data:image/svg+xml;utf8,${SVG}`

function withPicture(model: PublicDocViewModel, caption: string | null): PublicDocViewModel {
  if (!model.page) return model
  return { ...model, pictureSrc: PICTURE_SRC, page: { ...model.page, picture: { fileId: '0190f0e2-7101-7000-8000-0000000000f1', contentType: 'image/jpeg', caption } } }
}

export const designScreen = defineDesignScreen<PublicDocViewModel>({
  screen: 'SCR-102-picture',
  title: 'Public DoC: the style’s main picture (stripped copy)',
  view: PublicDocView,
  cases: [
    { id: 'batch', label: 'A batch’s page with the style’s main picture', model: withPicture(caseOf('batch-current'), null), note: 'The picture the office marked main; the API serves only its stripped copy (no EXIF, GPS, XMP or IPTC).' },
    { id: 'style-caption', label: 'A style’s page, the picture with its caption', model: withPicture(caseOf('style-current'), 'Nero, davanti') },
    { id: 'no-picture', label: 'No main picture (or one that cannot be stripped): no picture drawn', model: caseOf('style-current') },
  ],
})
