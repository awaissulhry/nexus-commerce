import { ClipboardCheck, Hand, ListTree } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Quality (design 01 area 8 "Quality / Qualità"): checking what we make — final inspections, their release by
 * an inspector who made none of the garments, the release reversals and the goods on hold (Owner answer Q3: reached
 * from Inspections before the Holds page of W2a). Labels are message keys (`shell:` = messages/<locale>/shell.json).
 * B-W1-34/43/45 part 2 build Inspections (SCR-075, the record SCR-076); B-W2a-67 Holds (SCR-078, Main) and Settings ›
 * Defects & dispositions (SCR-079); Nonconformances and the quality system join with their own steps.
 */
export const officeArea: OfficeAreaNav = {
  order: 8,
  area: {
    id: 'quality',
    label: 'shell:nav.quality.area',
    href: '/quality',
    icon: ClipboardCheck,
    phone: 'more',
    sections: [
      {
        id: 'quality-main',
        label: 'shell:nav.quality.main',
        hideLabel: true,
        noCrumb: true,
        items: [
          // SCR-075 / SCR-076: final inspections, releases, reversals and what is on hold (quality.inspections.view).
          { id: 'quality-inspections', label: 'shell:nav.quality.inspections', href: '/quality/inspections', icon: ClipboardCheck, permission: 'quality.inspections.view' },
          // B-W2a-67 SCR-078: everything on hold — lots, hides, work orders, bundles, garments, shipments (quality.holds.view).
          { id: 'quality-holds', label: 'shell:nav.quality.holds', href: '/quality/holds', icon: Hand, permission: 'quality.holds.view' },
        ],
      },
      {
        // B-W2a-67 SCR-079: Settings › Defects & dispositions (the defect library and the disposition codes).
        id: 'quality-settings',
        label: 'shell:nav.quality.settings',
        items: [{ id: 'quality-defects', label: 'shell:nav.quality.defects', href: '/quality/defects', icon: ListTree, permission: 'quality.defects.view' }],
      },
    ],
  },
}
