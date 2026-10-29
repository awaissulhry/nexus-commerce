import { ScrollText, FlaskConical, ShieldCheck } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Compliance (A2 §1.3 row 9; design 01 "Compliance / Conformità", Owner answer T1: its own area): what proves a garment
 * may be sold — here the material tests of each lot with the chromium VI release (SCR-054) and the PPE register of
 * complaints, non-conformities and recalls (SCR-113). Certificates, declarations and labels join with their own steps.
 * Labels are message keys (`shell:` = messages/<locale>/shell.json).
 */
export const officeArea: OfficeAreaNav = {
  order: 9,
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
