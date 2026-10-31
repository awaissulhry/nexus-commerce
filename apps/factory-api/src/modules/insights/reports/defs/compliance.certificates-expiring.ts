import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { periodFilter } from '@nexus/factory-domain/insights/reports/definition'
import { listCertificates } from '../../../compliance/certificates/certificates'
import { defineReport } from '../report'

/**
 * Compliance › Certificates expiring (design home.reports library "Compliance: Certificate gaps"; Today's "Certificates
 * expiring in 90 days"): valid certificates that end soon and how many styles they cover, through the certificate
 * register as the person (compliance.certificates.view: their companies and holders). No money.
 */

const DAYS = { NEXT_7_DAYS: 7, NEXT_30_DAYS: 30, NEXT_90_DAYS: 90 } as const

export default defineReport({
  key: 'compliance.certificates-expiring',
  area: 'compliance',
  title: 'Certificates expiring',
  question: 'Which certificates expire soon, and how many styles do they cover?',
  permission: CERTIFICATES_VIEW,
  needs: null,
  columns: [
    { key: 'certificate', label: 'Certificate', kind: 'text' },
    { key: 'standard', label: 'Standard', kind: 'text', group: true },
    { key: 'ppeClass', label: 'PPE class', kind: 'text', group: true },
    { key: 'notifiedBody', label: 'Notified body', kind: 'text', group: true },
    { key: 'validTo', label: 'Valid to', kind: 'day' },
    { key: 'daysToExpiry', label: 'Days left', kind: 'number' },
    { key: 'coverage', label: 'Styles covered', kind: 'number', sum: true },
  ],
  filters: [periodFilter(['NEXT_7_DAYS', 'NEXT_30_DAYS', 'NEXT_90_DAYS'], 'NEXT_90_DAYS', 'Expires', 'within')],
  groupBy: null,
  sources: 'Certificates and what they cover',
  definition: 'Every valid certificate whose last valid day is from today to the end of the period, soonest first. Days left is 0 on the last valid day.',
  numbers: ['compliance.certificatesExpiring'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const within = DAYS[(run.filters.within ?? 'NEXT_90_DAYS') as keyof typeof DAYS] ?? 90
    const answer = await listCertificates(run.caller, { expiringWithinDays: within })
    return {
      // The register reads at most 500 certificates.
      complete: answer.certificates.length < 500,
      range: { from: answer.today, to: answer.today },
      rows: answer.certificates.slice(0, run.limit).map((row) => ({
        id: row.id,
        record: { type: 'Certificate', id: row.id, label: row.number },
        currency: null,
        cells: {
          certificate: row.number,
          standard: row.standard,
          ppeClass: row.ppeClass,
          notifiedBody: `${row.notifiedBodyName} (${row.notifiedBodyNumber})`,
          validTo: row.validTo,
          daysToExpiry: row.daysToExpiry,
          coverage: row.coverageCount,
        },
      })),
    }
  },
})
