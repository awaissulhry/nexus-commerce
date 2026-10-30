import { Bell, CheckCheck, Home, Inbox, ListTodo, Sun } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Home (design 01 area 1 "Home"; A2 §1.4 "Home"). Labels are message keys (`shell:` = messages/<locale>/shell.json).
 * Main (no label on screen), in the tree's order: Today (SCR-029, B-W1-52), Approvals (SCR-030, B-W1-21: quote approvals in
 * W1), My tasks (SCR-233, B-W2a-40), Notifications (SCR-005, B-W2a-40), Mail to sort (SCR-019, B-W0-31). The Insights
 * group comes with its pages (W2a/W2b).
 */
export const officeArea: OfficeAreaNav = {
  order: 1,
  area: {
    id: 'home',
    label: 'shell:nav.home.area',
    href: '/home',
    icon: Home,
    phone: 'tab',
    sections: [
      {
        id: 'home-top',
        label: 'shell:nav.home.main',
        hideLabel: true,
        noCrumb: true,
        items: [
          // SCR-029 (B-W1-52): what needs me now, my flow and my lists. Every office role holds home.view.
          { id: 'home-today', label: 'shell:nav.home.today', href: '/home/today', icon: Sun, permission: 'home.view' },
          // SCR-030 (B-W1-21): the requests that wait for my yes, my own requests, recent decisions (quotes in W1).
          { id: 'home-approvals', label: 'shell:nav.home.approvals', href: '/home/approvals', icon: CheckCheck, permission: 'quotes.view' },
          // SCR-233 (B-W2a-40): my tasks on any record (or of their own); reading them is reaching Home.
          { id: 'home-tasks', label: 'shell:nav.home.tasks', href: '/home/tasks', icon: ListTodo, permission: 'home.view' },
          // SCR-005 (B-W2a-40): everything the system told me (each person their own), with done and snooze.
          { id: 'home-notifications', label: 'shell:nav.home.notifications', href: '/home/notifications', icon: Bell, permission: 'home.view' },
          // SCR-019 (B-W0-31): received mail no record took. Sales, buyers and the owner.
          { id: 'home-mail-to-sort', label: 'shell:nav.home.mailToSort', href: '/home/mail-to-sort', icon: Inbox, permission: 'email.triage' },
        ],
      },
    ],
  },
}
