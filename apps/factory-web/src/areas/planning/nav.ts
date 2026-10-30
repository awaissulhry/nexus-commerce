import { CalendarRange, ChartGantt, ListChecks, Network, SlidersHorizontal } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Planning (design 01 area 4 "Planning / Pianificazione", group Main with no label). Labels are message keys (`shell:` =
 * messages/<locale>/shell.json). B-W1-29 part 2 builds What to buy & make (SCR-055, planning.view: planner, buyer,
 * production manager, read-only, the owner); the later pages (Leather & cut plan, Planning board, Capacity, Exceptions …)
 * join with their steps.
 */
export const officeArea: OfficeAreaNav = {
  order: 4,
  area: {
    id: 'planning',
    label: 'shell:nav.planning.area',
    href: '/planning',
    icon: CalendarRange,
    phone: 'more',
    sections: [
      {
        id: 'planning-main',
        label: 'shell:nav.planning.main',
        hideLabel: true,
        noCrumb: true,
        items: [
          { id: 'planning-mrp', label: 'shell:nav.planning.mrp', href: '/planning/mrp', icon: ListChecks, permission: 'planning.view' },
          // B-W2a-45: Planning board (SCR-122; the design opens it in a window of its own) and Lines & subcontractors (SCR-126).
          { id: 'planning-board', label: 'shell:nav.planning.board', href: '/planning/board', icon: ChartGantt, permission: 'planning.view' },
          { id: 'planning-allocation', label: 'shell:nav.planning.allocation', href: '/planning/allocation', icon: Network, permission: 'planning.view' },
        ],
      },
      // B-W2a-59: Settings › Planning settings (SCR-124 calendars & shifts, SCR-127 item planning settings).
      {
        id: 'planning-settings',
        label: 'shell:nav.planning.settingsGroup',
        items: [{ id: 'planning-settings-page', label: 'shell:nav.planning.settings', href: '/planning/settings', icon: SlidersHorizontal, permission: 'planning.view' }],
      },
    ],
  },
}
