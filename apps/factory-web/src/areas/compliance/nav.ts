import { BadgeCheck, FlaskConical, ScrollText, ShieldCheck, Tag } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Compliance (A2 §1.3 row 9; design 01 "Compliance / Conformità", Owner answer T1: its own area): what proves a garment
 * may be sold — here the material tests of each lot with the chromium VI release (SCR-054) and the PPE register of
 * complaints, non-conformities and recalls (SCR-113); the product screens step adds the EN 17092 / protector certificate
 * register (SCR-050/051) and the PPE garment labels (SCR-053), in the approved tree's order. Declarations join later.
 * Labels are message keys (`shell:` = messages/<locale>/shell.json).
 */
export const officeArea: OfficeAreaNav = {
  order: 10,
  area: {
    id: 'compliance',
    label: 'shell:nav.compliance.area',
    href: '/compliance',
    icon: ShieldCheck,
    phone: 'more',
    sections: [
      {
        id: 'compliance-main',
        label: 'shell:nav.compliance.main',
        hideLabel: true,
        noCrumb: true,
        items: [
          // SCR-050/051: EN 17092 garment and EN 1621 protector certificates with their coverage (compliance.certificates.view).
          { id: 'compliance-certificates', label: 'shell:nav.compliance.certificates', href: '/compliance/certificates', icon: BadgeCheck, permission: 'compliance.certificates.view' },
          // SCR-053: the PPE garment label builder, preview and activation (reading labels is compliance.certificates.view).
          { id: 'compliance-labels', label: 'shell:nav.compliance.labels', href: '/compliance/labels', icon: Tag, permission: 'compliance.certificates.view' },
          // SCR-054: lots with their Cr VI results, supplier documents and the lot release (quality.lots.view).
          { id: 'compliance-tests', label: 'shell:nav.compliance.tests', href: '/compliance/tests', icon: FlaskConical, permission: 'quality.lots.view' },
        ],
      },
      {
        id: 'compliance-safety',
        label: 'shell:nav.compliance.safety',
        items: [
          // SCR-113: the legal register of complaints, non-conformities and recalls (Reg. 2016/425 art. 8).
          { id: 'compliance-register', label: 'shell:nav.compliance.register', href: '/compliance/register', icon: ScrollText, permission: 'compliance.register.view' },
        ],
      },
    ],
  },
}
