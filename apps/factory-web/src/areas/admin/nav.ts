import { Building2, FileClock, FileLock, Hash, HeartPulse, Languages, ListChecks, PlugZap, Settings, ShieldCheck, Tablet, Upload, Users, Workflow } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Admin (design 01 area 13 "Admin / Sistema", at the foot of the rail; A2 §1.4 "Admin"; owner and administrator). Every W0 page, written once here (PLAN §2.1); the
 * steps B-W0-26 to B-W0-31 build the pages. Labels are message keys (`shell:` = messages/<locale>/shell.json).
 *
 * A row's `permission` is the one its page's API route needs.
 *
 * B-W0-27 (design 02 admin.overview, admin.org): All settings is Admin's first page (W0: the "Get the factory ready"
 * checklist, read from the companies); Companies & sites is ONE page (a tree of companies and their sites; a site's
 * lines, work centres and stations live on the site's record), so there is no separate Sites row.
 *
 * B-W0-28 (design 02 admin.documents, admin.languages, admin.connections, admin.import, admin.audit; the tree's groups):
 * Platform = Documents & numbering (ONE page: number series and the document layouts), Languages & formats (company
 * data: companies.view), Connections & API (the rented services, with the mail domain inside: no separate Email row);
 * Data = Import & export, Audit log.
 */
export const officeArea: OfficeAreaNav = {
  order: 13,
  area: {
    id: 'admin',
    label: 'shell:nav.admin.area',
    href: '/admin',
    icon: Settings,
    phone: 'more',
    sections: [
      {
        id: 'admin-top',
        label: 'shell:nav.admin.main',
        hideLabel: true,
        noCrumb: true,
        // All settings is the tree's W3 page, shipped early as the "Get the factory ready" checklist (Owner answer O2).
        // `exact`: it is the area's own address, so it never claims the pages under /admin.
        items: [{ id: 'admin-overview', label: 'shell:nav.admin.overview', href: '/admin', exact: true, icon: ListChecks, permission: 'companies.view' }],
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
          // B-W2a-36 (SCR-166): status, sign-in rules with two-factor per role, backups and restore drills, protection.
          { id: 'admin-security', label: 'shell:nav.admin.security', href: '/admin/security', icon: HeartPulse, permission: 'security.view' },
        ],
      },
      {
        id: 'admin-platform',
        label: 'shell:nav.admin.platform',
        noCrumb: true,
        items: [
          { id: 'admin-documents', label: 'shell:nav.admin.documents', href: '/admin/documents', icon: Hash, permission: 'numbering.view' },
          { id: 'admin-languages', label: 'shell:nav.admin.languages', href: '/admin/languages', icon: Languages, permission: 'companies.view' },
          // B-W2a-78 (SCR-167): Approvals, automation & AI — W2a: Reminders & timers (the date rules and their timers).
          { id: 'admin-automation', label: 'shell:nav.admin.automation', href: '/admin/automation', icon: Workflow, permission: 'alerts.rules.manage' },
          { id: 'admin-connections', label: 'shell:nav.admin.connections', href: '/admin/connections', icon: PlugZap, permission: 'integrations.view' },
        ],
      },
      {
        id: 'admin-data',
        label: 'shell:nav.admin.data',
        noCrumb: true,
        items: [
          { id: 'admin-import', label: 'shell:nav.admin.import', href: '/admin/import', icon: Upload, permission: 'imports.view' },
          { id: 'admin-audit', label: 'shell:nav.admin.audit', href: '/admin/audit', icon: FileClock, permission: 'audit.read' },
          // SCR-086: the privacy duties, worker / staff / public notices and acknowledgements, the DPIA and the register.
          { id: 'admin-privacy', label: 'shell:nav.admin.privacy', href: '/admin/privacy', icon: FileLock, permission: 'privacy.view' },
        ],
      },
    ],
  },
}
