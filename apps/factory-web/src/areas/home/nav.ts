import { CheckCheck, Home, Inbox } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Home (A2 §1.3 row 1, §1.4 "Home"). Labels are message keys (`shell:` = messages/<locale>/shell.json).
 * W0 holds the one W0 page of Home; B-W1-21 adds Approvals (SCR-030, W1: quote approvals); B-W1-08 adds My work and
 * Overview (W1).
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
        label: 'shell:nav.home.area',
        hideLabel: true,
        noCrumb: true,
        items: [
          // SCR-030 (B-W1-21): the requests that wait for my yes, my own requests, recent decisions (quotes in W1).
          { id: 'home-approvals', label: 'shell:nav.home.approvals', href: '/home/approvals', icon: CheckCheck, permission: 'quotes.view' },
          // SCR-019 (B-W0-31): received mail no record took. Sales, buyers and the owner.
          { id: 'home-mail-to-sort', label: 'shell:nav.home.mailToSort', href: '/home/mail-to-sort', icon: Inbox, permission: 'email.triage' },
        ],
      },
    ],
  },
}
