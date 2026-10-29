import { Activity, ClipboardList, Factory } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Production (A2 §1.3 row 8, §1.4 "Production"; design 01 production: Main › Floor now, Work orders). Labels are message
 * keys (`shell:` = messages/<locale>/shell.json). Each row's permission is the one its page's API needs: workorders.view
 * (planner, production manager, sales, warehouse, quality inspector, floor supervisor, read-only; the owner). The later
 * pages (Dispatch, Cutting, Bundles, Labour & corrections, Scrap & rework …, Floor rules) join with their steps.
 */
export const officeArea: OfficeAreaNav = {
  order: 8,
  area: {
    id: 'production',
    label: 'shell:nav.production.area',
    href: '/production',
    icon: Factory,
    phone: 'more',
    sections: [
      {
        id: 'production-main',
        label: 'shell:nav.production.main',
        hideLabel: true,
        noCrumb: true,
        items: [
          // SCR-073: the floor at a glance (WIP per operation, late work orders), live from the scans.
          { id: 'production-floor', label: 'shell:nav.production.floor', href: '/production/floor', icon: Activity, permission: 'workorders.view' },
          // SCR-069 … SCR-072: the list and the work order studio.
          { id: 'production-work-orders', label: 'shell:nav.production.workOrders', href: '/production/work-orders', icon: ClipboardList, permission: 'workorders.view' },
        ],
      },
    ],
  },
}
