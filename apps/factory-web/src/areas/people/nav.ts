import { BarChart3, CalendarCheck, CalendarClock, FileOutput, Gauge, GraduationCap, HandCoins, SlidersHorizontal, UserRound, Users } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * People (design 01 area 11 "People / Persone", W2b): the people who work here — employees, attendance, shifts, skills and
 * training, piece rates, the payroll export, efficiency, People reports and settings. Every People page is declared here
 * once (B-W2b-55), in the tree's groups and order; a row shows only once its page is built (`OFFICE_PAGES` in
 * shell/nav/office-nav.ts), so each page step only fills its own route. Labels are message keys (`shell:` =
 * messages/<locale>/shell.json); each row's permission is the one its page's API reads first — the page step that builds
 * a row confirms it (the navigation test's PAGE_PERMISSION).
 */
export const officeArea: OfficeAreaNav = {
  order: 11,
  // B-W2b-73: Attendance opens for whoever `seesThePage` lets in (attendance/model.ts): a floor supervisor has the roll call, an
  // emergency tool, and their teams' timesheets, without people.attendance.view; the row gives them nothing more than those.
  alsoOpens: {
    'people-attendance': ['people.attendance.rollcall', 'people.timesheets.team', 'people.timesheets.lead', 'people.timesheets.hr'],
    // B-W2b-146: the safety readers (the safety officer: no people.skills.view) open Skills & training for its training lenses.
    'people-skills': ['safety.view'],
  },
  area: {
    id: 'people',
    label: 'shell:nav.people.area',
    href: '/people',
    icon: Users,
    phone: 'more',
    sections: [
      {
        id: 'people-main',
        label: 'shell:nav.people.main',
        hideLabel: true,
        items: [
          // SCR-084 (B-W2b-55): the HR register, teams with today's loans, leavers in progress (GET /people/employees, people.view).
          { id: 'people-employees', label: 'shell:nav.people.employees', href: '/people/employees', icon: UserRound, permission: 'people.view' },
          // SCR-157 (B-W2b-61): days, anomalies, the month close (behind the ATTENDANCE gate).
          { id: 'people-attendance', label: 'shell:nav.people.attendance', href: '/people/attendance', icon: CalendarCheck, permission: 'people.attendance.view' },
          // SCR-263 (B-W2b-60): the roster sheet (GET /people/shifts/roster, people.shifts.view).
          { id: 'people-shifts', label: 'shell:nav.people.shifts', href: '/people/shifts', icon: CalendarClock, permission: 'people.shifts.view' },
        ],
      },
      {
        id: 'people-skills-pay',
        label: 'shell:nav.people.skillsPay',
        items: [
          // SCR-160 (B-W2b-65): skills and machine authorisations (GET /people/skills/matrix, people.skills.view).
          { id: 'people-skills', label: 'shell:nav.people.skills', href: '/people/skills', icon: GraduationCap, permission: 'people.skills.view' },
          // SCR-158 (B-W2b-62): piece rates behind the legal switch.
          { id: 'people-piecerates', label: 'shell:nav.people.piecerates', href: '/people/piecerates', icon: HandCoins, permission: 'people.piecerates.view' },
          // SCR-159 (B-W2b-63): the payroll export wizard.
          { id: 'people-payroll', label: 'shell:nav.people.payroll', href: '/people/payroll', icon: FileOutput, permission: 'people.payroll.view' },
          // SCR-161 (B-W2b-64): lines and operations (GET /people/efficiency, people.efficiency.view), one person's figures behind the gate.
          { id: 'people-efficiency', label: 'shell:nav.people.efficiency', href: '/people/efficiency', icon: Gauge, permission: 'people.efficiency.view' },
        ],
      },
      {
        id: 'people-reports',
        label: 'shell:nav.people.reportsGroup',
        // SCR-264 (B-W2b-64): attendance and earnings reports (GET /people/reports/attendance, people.attendance.view).
        items: [{ id: 'people-reports', label: 'shell:nav.people.reports', href: '/people/reports', icon: BarChart3, permission: 'people.attendance.view' }],
      },
      {
        id: 'people-settings',
        label: 'shell:nav.people.settingsGroup',
        // SCR-265 (B-W2b-65): rounding and grace, absence codes, working-time limits, privacy of people data.
        items: [{ id: 'people-settings', label: 'shell:nav.people.settings', href: '/people/settings', icon: SlidersHorizontal, permission: 'people.privacy.view' }],
      },
    ],
  },
}
