import { CalendarRange, ListChecks } from 'lucide-react'
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
        items: [{ id: 'planning-mrp', label: 'shell:nav.planning.mrp', href: '/planning/mrp', icon: ListChecks, permission: 'planning.view' }],
      },
    ],
  },
}
