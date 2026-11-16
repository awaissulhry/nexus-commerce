import { defineDesignScreen } from '../design-screen'
import { ProductionPartsLab, type ProductionPartsLabModel } from './view/ProductionPartsLab'

/**
 * The shared production parts lab (`/design/production-parts`, F-PR-01): the five plain stages (full form, row form,
 * blocked, unknown), who the work waits on, the health chip and its "why", pieces by stage and size, request cards, the
 * hold banner, the freshness line and the one rule "a bar shows the figure its words name" — for the office and for one
 * customer's portal. Light and dark, 1440 / 1920 / 390, Italian and English are the gallery's own switches. Made-up data.
 */
export const designScreen = defineDesignScreen<ProductionPartsLabModel>({
  screen: 'production-parts',
  title: 'Shared production parts (F-PR-01)',
  view: ProductionPartsLab,
  cases: [
    { id: 'office', label: 'Every part: the office', model: { face: 'office' }, note: 'Waiting on us / customer / supplier / workshop with ages, amber when overdue; the health chip opens its why with the office-only note; the bar and its words from one figure.' },
    { id: 'customer', label: 'Every part: a customer', model: { face: 'customer' }, note: 'Comfortable density. Only "Waiting on you" or "Waiting on us"; health with the curated reason, never the note; holds in curated words; "Being reviewed".' },
    { id: 'stages-office', label: 'Stages: the office', model: { face: 'office', show: 'stages' }, note: 'Full form with planned dates and the ex-factory history; blocked; the row form for a list cell, sewing not counted.' },
    { id: 'stages-customer', label: 'Stages: a customer', model: { face: 'customer', show: 'stages' }, note: '"Expected by" — never "promised". Best at 390: the full form goes down.' },
    { id: 'pieces', label: 'Pieces by stage and size', model: { face: 'customer', show: 'pieces' }, note: 'At 390 the size grid turns: rows = sizes. Red is not counted at sewing: "—" and "Not counted here", never 0.' },
    { id: 'requests-office', label: 'Requests: the office', model: { face: 'office', show: 'requests' } },
    { id: 'requests-customer', label: 'Requests: a customer', model: { face: 'customer', show: 'requests' } },
    { id: 'holds-customer', label: 'Holds: a customer', model: { face: 'customer', show: 'holds' }, note: 'The office reason never reaches the customer: curated words only.' },
    { id: 'unknown', label: 'Not known yet', model: { face: 'office', state: 'unknown' }, note: '"—" for an unknown stage, wait and health; no hold: no banner; not read yet.' },
    { id: 'loading', label: 'Loading', model: { face: 'office', state: 'loading' } },
    { id: 'problem', label: 'Could not load', model: { face: 'customer', state: 'problem' }, note: 'Only that part says so, with Try again; the rest of the page works.' },
  ],
})
