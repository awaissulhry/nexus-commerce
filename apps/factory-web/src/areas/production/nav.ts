import { Activity, BarChart3, ClipboardList, Factory, Recycle, Scissors, SlidersHorizontal } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Production (design 01 area 7 "Production / Produzione"; A2 §1.4 "Production": Main › Floor now, Work orders). Labels are message
 * keys (`shell:` = messages/<locale>/shell.json). Each row's permission is the one its page's API needs: workorders.view
 * (planner, production manager, sales, warehouse, quality inspector, floor supervisor, read-only; the owner). The later
 * pages (Dispatch, Cutting, Bundles, Labour & corrections, Scrap & rework …, Floor rules) join with their steps.
 */
export const officeArea: OfficeAreaNav = {
  order: 7,
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
      {
        // B-W2a-60: Cutting room › Cutting (SCR-238, design production.cutting): one cut per work order, the tiles, yield.
        id: 'production-cutting-room',
        label: 'shell:nav.production.cuttingRoom',
        items: [{ id: 'production-cutting', label: 'shell:nav.production.cutting', href: '/production/cutting', icon: Scissors, permission: 'production.cutting.view' }],
      },
      {
        // B-W2a-60: Floor control › Scrap & rework (SCR-140, design production.scrap): pareto, rows, replacements.
        id: 'production-floor-control',
        label: 'shell:nav.production.floorControl',
        items: [{ id: 'production-scrap', label: 'shell:nav.production.scrap', href: '/production/scrap', icon: Recycle, permission: 'production.scrap.view' }],
      },
      {
        // B-W2a-38: Reports (design production.reports): the daily production report, per line, style and size.
        id: 'production-reports',
        label: 'shell:nav.production.reports',
        items: [{ id: 'production-reports-page', label: 'shell:nav.production.reportsPage', href: '/production/reports', icon: BarChart3, permission: 'production.reports.view' }],
      },
      {
        id: 'production-settings',
        label: 'shell:nav.production.settings',
        // SCR-074: per site, who floor records name (the monitoring switch with its legal basis) and the floor's codes.
        items: [{ id: 'production-floor-rules', label: 'shell:nav.production.floorRules', href: '/production/settings', icon: SlidersHorizontal, permission: 'production.settings.view' }],
      },
    ],
  },
}
