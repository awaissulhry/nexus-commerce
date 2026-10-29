import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { navPages, officeNavFor, OFFICE_NAV } from './nav/office-nav'
import type { PalettePage } from './palette/palette-model'

/**
 * Made-up data shared by the shell's design fixtures (each `fixtures.ts` of a shell part). Nothing here is a real
 * company, person, address or number: "Demo" names, example.com addresses, a fixed made-up tenant id.
 */

export const DEMO_TENANT_ID = '0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10'
export const DEMO_TAG = tenantTag(DEMO_TENANT_ID)
/** Another made-up tenant, for "this label belongs to another factory". */
export const OTHER_TAG = tenantTag('0190f0e2-0000-7000-8000-000000000001')

export const DEMO_COMPANIES = [
  { id: '0190f0e2-1111-7000-8000-000000000001', code: 'DEMO', name: 'Officina Demo S.r.l.' },
  { id: '0190f0e2-1111-7000-8000-000000000002', code: 'ESEMPIO', name: 'Pelletteria Esempio S.p.A.' },
]

export const MANY_COMPANIES = [
  ...DEMO_COMPANIES,
  ...['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa'].map((name, i) => ({
    id: `0190f0e2-1111-7000-8000-0000000001${String(i).padStart(2, '0')}`,
    code: name.toUpperCase(),
    name: `${name} Demo Manifattura S.r.l.`,
  })),
]

export const DEMO_SITES = [
  { id: '0190f0e2-2222-7000-8000-000000000001', name: 'Stabilimento Demo Nord' },
  { id: '0190f0e2-2222-7000-8000-000000000002', name: 'Magazzino Demo Sud' },
]

export const DEMO_USER = { id: '0190f0e2-3333-7000-8000-000000000001', email: 'alex.demo@example.com', displayName: 'Alex Demo', locale: 'en' }

/** Every W0 office permission, Today (W1), and the four that later steps declare: the owner's view of the navigation. */
export const OWNER_PERMISSIONS = [
  'home.view',
  'email.triage',
  'companies.view',
  'sites.view',
  'devices.view',
  'users.view',
  'roles.view',
  'numbering.view',
  'email.manage',
  'settings.view',
  'imports.view',
  'audit.read',
  'integrations.view',
]

/** A sales person: Home's Today and mail to sort, nothing of Admin. */
export const SALES_PERMISSIONS = ['home.view', 'email.triage', 'threads.read', 'threads.post', 'email.send']

/** The palette's pages for a permission list, addressed under `/w/DEMO` (labels stay message keys). */
export function demoPages(permissions: readonly string[], company = 'DEMO'): PalettePage[] {
  const held = new Set(permissions)
  return navPages(officeNavFor((p) => held.has(p), OFFICE_NAV)).map((page) => ({ ...page, href: `/w/${company}${page.href}` }))
}

/** Label codes as a printer would print them. */
export const DEMO_LABELS = {
  hide: formatScanId({ type: 'HIDE', tenantTag: DEMO_TAG, ref: 4215 }),
  bundle: formatScanId({ type: 'BUNDLE', tenantTag: DEMO_TAG, ref: 1_048_577 }),
  otherFactory: formatScanId({ type: 'LOT', tenantTag: OTHER_TAG, ref: 77 }),
}

/**
 * A one-page PDF with a few lines of text (ASCII), built here so the design fixtures show the PDF viewer with the
 * app's lazily loaded pdf.js without shipping a file.
 */
export function demoPdf(lines: readonly string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?')
  const content = lines.map((line, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 56 ${780 - i * 28} Td (${escape(line)}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

/** A hide label with its check symbol changed: one wrong character, as a smudged label reads. */
export function typo(code: string): string {
  const last = code.slice(-1)
  return `${code.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`
}
