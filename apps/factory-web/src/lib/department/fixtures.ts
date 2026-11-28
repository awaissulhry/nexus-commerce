import { defineDesignScreen } from '../design/design-screen'
import { DepartmentLab, type DepartmentLabModel } from './view/DepartmentLab'

/**
 * owb-b4 w4.2 — the department parts on the design index (`/design/department-parts`): the chip, the route bar, the strip. The
 * departments are the fixed table of the nine in the page's language (no read). Made-up data only.
 */
export const designScreen = defineDesignScreen<DepartmentLabModel>({
  screen: 'department-parts',
  title: 'Department parts — chip, route bar, strip (owb-)',
  view: DepartmentLab,
  cases: [
    { id: 'chips', label: 'The chip of each of the nine, and one with an unknown icon', model: { show: 'chips' }, note: 'Number dot, icon, ONE short name; the long name is the hint. An icon id the map does not know draws a plain dot.' },
    { id: 'bar', label: 'The route bar: not started, at a step, every step done, a short route', model: { show: 'bar' }, note: 'Done: quiet with a check. Now: strong (ring, bold, aria-current). To come: plain.' },
    { id: 'strip', label: 'The strip: six departments, baskets', model: { show: 'strip' }, note: 'Two a row in a narrow room, three + three in a middle one, one row in a wide one.' },
    { id: 'strip-pieces', label: 'The strip: the customer counts pieces', model: { show: 'strip-pieces' } },
    { id: 'strip-nine', label: 'The strip: nine departments', model: { show: 'strip-nine' } },
  ],
})
