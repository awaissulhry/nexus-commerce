import { COMPANY_ID, uid } from '../../library/demo'
import type { TemplateRef } from './api'

/**
 * Made-up measurement templates for SCR-251's `w2b-283-*` cases (B-W2b-283, FU1:03): demo codes and names only. No
 * `designScreen` here: SCR-251's fixtures file uses these.
 */

const template = (n: number, code: string, name: string, productType: TemplateRef['productType'], points: number, extra: Partial<TemplateRef> = {}): TemplateRef => ({
  id: uid('2394', n),
  code,
  name,
  nameI18n: {},
  productType,
  companyId: null,
  status: 'ACTIVE',
  rulesOn: false,
  points,
  ...extra,
})

export const DEMO_TEMPLATES: TemplateRef[] = [
  // The same id as the settings demo's DEMO-MTM-SUIT (the one DEMO-SUIT names).
  template(1, 'DEMO-MTM-SUIT', 'Suit body measures', 'SUIT', 14),
  template(2, 'DEMO-MTM-JKT', 'Jacket body measures', 'JACKET', 9, { rulesOn: true }),
  template(3, 'DEMO-MTM-JKT-A', 'Jacket measures (this company)', 'JACKET', 11, { companyId: COMPANY_ID }),
  template(4, 'DEMO-MTM-JKT-OLD', 'Jacket measures (old)', 'JACKET', 8, { status: 'ARCHIVED' }),
  template(5, 'DEMO-MTM-TRS', 'Trouser body measures', 'TROUSERS', 7),
]
export const JACKET_TEMPLATE_A = DEMO_TEMPLATES[2]!
export const OLD_JACKET_TEMPLATE = DEMO_TEMPLATES[3]!
