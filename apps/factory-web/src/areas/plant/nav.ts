import { BellRing, Cog, HardHat, Wrench } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Plant (design 01 area 12 "Plant / Stabilimento", Owner answer T2: maintenance and health & safety in one area): the
 * building, its machines and the people's safety. W2a builds its Maintenance pages (B-W2a-53): Machine requests
 * (SCR-148, the breakdowns reported from the stations), Maintenance jobs (SCR-149) and Machines & tools (SCR-150); the
 * preventive checks, spare parts, downtime and every Health & safety page join with their waves. Labels are message keys
 * (`shell:` = messages/<locale>/shell.json); each row's permission is the one its page's API needs (plant.view).
 */
export const officeArea: OfficeAreaNav = {
  order: 12,
  area: {
    id: 'plant',
    label: 'shell:nav.plant.area',
    href: '/plant',
    icon: HardHat,
    phone: 'more',
    sections: [
      {
        id: 'plant-maintenance',
        label: 'shell:nav.plant.maintenance',
        items: [
          // SCR-148: breakdowns reported from the stations, triaged in order (GET /plant/requests, plant.view).
          { id: 'plant-requests', label: 'shell:nav.plant.requests', href: '/plant/requests', icon: BellRing, permission: 'plant.view' },
          // SCR-149: maintenance jobs and their hand-back (GET /plant/jobs, plant.view).
          { id: 'plant-jobs', label: 'shell:nav.plant.jobs', href: '/plant/jobs', icon: Wrench, permission: 'plant.view' },
          // SCR-150: the machine and equipment register (GET /plant/machines, plant.view).
          { id: 'plant-machines', label: 'shell:nav.plant.machines', href: '/plant/machines', icon: Cog, permission: 'plant.view' },
        ],
      },
    ],
  },
}
