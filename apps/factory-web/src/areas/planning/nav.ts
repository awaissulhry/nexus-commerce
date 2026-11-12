import { CalendarClock, CalendarRange, ChartGantt, Gauge, Layers, ListChecks, Network, Scissors, Siren, SlidersHorizontal, TrendingUp } from 'lucide-react'
// B-W2b-349: the Reports group's icon.
import { BarChart3 } from 'lucide-react'
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
          // B-W2b-132: Leather & cut plan (SCR-252), right after What to buy & make (the design's order).
          { id: 'planning-leather', label: 'shell:nav.planning.leather', href: '/planning/leather', icon: Scissors, permission: 'planning.view' },
          // B-W2a-45: Planning board (SCR-122; the design opens it in a window of its own) and Lines & subcontractors (SCR-126).
          { id: 'planning-board', label: 'shell:nav.planning.board', href: '/planning/board', icon: ChartGantt, permission: 'planning.view' },
          // B-W2a-70: Capacity & load (SCR-123), between the board and the allocation (the approved tree's order).
          { id: 'planning-capacity', label: 'shell:nav.planning.capacity', href: '/planning/capacity', icon: Gauge, permission: 'planning.view' },
          { id: 'planning-allocation', label: 'shell:nav.planning.allocation', href: '/planning/allocation', icon: Network, permission: 'planning.view' },
          // B-W2a-70: Exceptions (SCR-125), after the allocation.
          { id: 'planning-exceptions', label: 'shell:nav.planning.exceptions', href: '/planning/exceptions', icon: Siren, permission: 'planning.view' },
        ],
      },
      // B-W2b-263: Dates › Time & action (SCR-253; the design's group "Planning › Dates").
      {
        id: 'planning-dates',
        label: 'shell:nav.planning.dates',
        items: [{ id: 'planning-milestones', label: 'shell:nav.planning.milestones', href: '/planning/milestones', icon: CalendarClock, permission: 'planning.view' }],
      },
      // B-W2b-339: Long range › Demand & forecast (SCR-374) and Master schedule & S&OP (SCR-202; its W2b part, the production
      // strategy per item), the design's group "Planning › Long range" (Scenarios is W3).
      {
        id: 'planning-long-range',
        label: 'shell:nav.planning.longRange',
        items: [
          { id: 'planning-demand', label: 'shell:nav.planning.demand', href: '/planning/demand', icon: TrendingUp, permission: 'planning.view' },
          { id: 'planning-mps', label: 'shell:nav.planning.mps', href: '/planning/mps', icon: Layers, permission: 'planning.view' },
        ],
      },
      // B-W2b-349: Reports › Planning reports (SCR-254; GET /planning/reports/adherence, /utilisation, /cover), the design's group
      // "Planning › Reports", before Settings.
      {
        id: 'planning-reports',
        label: 'shell:nav.planning.reportsGroup',
        items: [{ id: 'planning-reports', label: 'shell:nav.planning.reports', href: '/planning/reports', icon: BarChart3, permission: 'planning.reports.view' }],
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
