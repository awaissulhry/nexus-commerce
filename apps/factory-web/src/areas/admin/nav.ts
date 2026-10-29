import { Building2, FileClock, Hash, Languages, ListChecks, Mail, PlugZap, Settings, ShieldCheck, Tablet, Upload, Users } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Admin (A2 §1.3 row 14, §1.4 "Admin"; owner and administrator). Every W0 page, written once here (PLAN §2.1); the
 * steps B-W0-26 to B-W0-31 build the pages. Labels are message keys (`shell:` = messages/<locale>/shell.json).
 *
 * A row's `permission` is the one its page's API route needs. Two are not declared yet: `settings.view` and
 * `integrations.view` (B-W0-28, Languages & formats and Connections). A permission nobody holds hides its row for
 * everyone, so those rows appear only once their step declares them (shell/nav/office-nav.ts `PENDING_PERMISSIONS`).
 *
 * B-W0-27 (design 02 admin.overview, admin.org): All settings is Admin's first page (W0: the "Get the factory ready"
 * checklist, read from the companies); Companies & sites is ONE page (a tree of companies and their sites; a site's
 * lines, work centres and stations live on the site's record), so there is no separate Sites row.
 */
export const officeArea: OfficeAreaNav = {
  order: 14,
  area: {
    id: 'admin',
    label: 'shell:nav.admin.area',
    href: '/admin',
    icon: Settings,
    phone: 'more',
    sections: [
      {
        id: 'admin-top',
        label: 'shell:nav.admin.area',
        hideLabel: true,
        noCrumb: true,
        items: [{ id: 'admin-overview', label: 'shell:nav.admin.overview', href: '/admin', icon: ListChecks, permission: 'companies.view' }],
      },
      {
        id: 'admin-organisation',
        label: 'shell:nav.admin.organisation',
        noCrumb: true,
        items: [
          { id: 'admin-companies', label: 'shell:nav.admin.companies', href: '/admin/companies', icon: Building2, permission: 'companies.view' },
          { id: 'admin-devices', label: 'shell:nav.admin.devices', href: '/admin/devices', icon: Tablet, permission: 'devices.view' },
        ],
      },
      {
        id: 'admin-access',
        label: 'shell:nav.admin.access',
        noCrumb: true,
        items: [
          { id: 'admin-users', label: 'shell:nav.admin.users', href: '/admin/users', icon: Users, permission: 'users.view' },
          { id: 'admin-roles', label: 'shell:nav.admin.roles', href: '/admin/roles', icon: ShieldCheck, permission: 'roles.view' },
        ],
      },
      {
        id: 'admin-platform',
        label: 'shell:nav.admin.platform',
        noCrumb: true,
        items: [
          { id: 'admin-numbering', label: 'shell:nav.admin.numbering', href: '/admin/numbering', icon: Hash, permission: 'numbering.view' },
          { id: 'admin-email', label: 'shell:nav.admin.email', href: '/admin/email', icon: Mail, permission: 'email.manage' },
          { id: 'admin-languages', label: 'shell:nav.admin.languages', href: '/admin/languages', icon: Languages, permission: 'settings.view' },
          { id: 'admin-imports', label: 'shell:nav.admin.imports', href: '/admin/imports', icon: Upload, permission: 'imports.view' },
          { id: 'admin-audit', label: 'shell:nav.admin.audit', href: '/admin/audit', icon: FileClock, permission: 'audit.read' },
          { id: 'admin-connections', label: 'shell:nav.admin.connections', href: '/admin/connections', icon: PlugZap, permission: 'integrations.view' },
        ],
      },
    ],
  },
}
