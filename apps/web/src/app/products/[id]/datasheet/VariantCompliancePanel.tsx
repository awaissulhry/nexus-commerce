/**
 * VR.7 — Variant-level compliance differentiation.
 *
 * One row per variant, columns for the compliance dimensions that
 * MIGHT differ between children:
 *
 *   - Country of origin   most often shared with parent
 *   - HS code             can differ for size-banded customs codes
 *                         in some regimes
 *   - PPE category        differs for material variants (carbon vs
 *                         polymer helmets, etc.)
 *   - Hazmat              rare; usually shared with parent
 *   - Certificates        per-child ProductCertificate count + the
 *                         nearest-expiring date; flagged amber when
 *                         a cert is within 90 days of expiry, red
 *                         when one is already expired
 *
 * Diff rendering: each cell carries a "same as parent" subtlety —
 * when the variant's value matches the parent's, the value renders
 * in muted slate with a small ✓. When the variant differs, the
 * value renders in normal text plus an explicit ≠ icon. This makes
 * deviations pop without forcing the operator to mentally compare
 * every row to the parent.
 *
 * Hidden when:
 *   - There's no parent compliance data AND no child carries any
 *     compliance fields. Empty panel adds noise, not insight.
 *
 * Bulk operator workflow this enables: scan a parent's variants
 * for compliance drift, spot the one carbon helmet variant whose
 * EN-1078 cert expires next month, click into its hub to update.
 */

import Link from 'next/link'
import { AlertTriangle, Check, FileText, ShieldCheck } from 'lucide-react'
import type { getServerT } from '@/lib/i18n/server'

export interface ComplianceParent {
  hsCode: string | null
  countryOfOrigin: string | null
  ppeCategory: string | null
  hazmatClass: string | null
  hazmatUnNumber: string | null
}

export interface ComplianceVariant {
  id: string
  sku: string
  name: string
  hsCode: string | null
  countryOfOrigin: string | null
  ppeCategory: string | null
  hazmatClass: string | null
  hazmatUnNumber: string | null
  /** Aggregate per-child certificate stats from VariantsTab. */
  certs: {
    total: number
    expired: number
    expiringSoonAt: Date | null
    types: string[]
  }
}

interface VariantCompliancePanelProps {
  parent: ComplianceParent | null
  variants: ComplianceVariant[]
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

export default function VariantCompliancePanel({
  parent,
  variants,
  locale,
  t,
}: VariantCompliancePanelProps) {
  // No compliance data anywhere → don't render. Adds noise on
  // catalogs that don't carry regulated SKUs.
  const anyCompliance =
    (parent &&
      (parent.hsCode ||
        parent.countryOfOrigin ||
        parent.ppeCategory ||
        parent.hazmatClass)) ||
    variants.some(
      (v) =>
        v.hsCode ||
        v.countryOfOrigin ||
        v.ppeCategory ||
        v.hazmatClass ||
        v.certs.total > 0,
    )
  if (!anyCompliance) return null

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'

  const countryName = (() => {
    try {
      return new Intl.DisplayNames([locale === 'it' ? 'it' : 'en'], {
        type: 'region',
      })
    } catch {
      return null
    }
  })()
  const fmtCountry = (code: string | null) => {
    if (!code) return null
    if (!countryName) return code
    try {
      return countryName.of(code.toUpperCase()) ?? code
    } catch {
      return code
    }
  }

  const dateFmt = new Intl.DateTimeFormat(numLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

  // Bucket counts for the summary line.
  let withCerts = 0
  let withExpired = 0
  let withExpiringSoon = 0
  for (const v of variants) {
    if (v.certs.total > 0) withCerts++
    if (v.certs.expired > 0) withExpired++
    if (v.certs.expiringSoonAt) withExpiringSoon++
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
          <ShieldCheck className="w-4 h-4 text-slate-500" />
          <span>{t('products.datasheetHub.compliance.title')}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>
            {t('products.datasheetHub.compliance.summary.withCerts', {
              count: withCerts,
            })}
          </span>
          {withExpired > 0 && (
            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
              <AlertTriangle className="w-3 h-3" />
              {t('products.datasheetHub.compliance.summary.expired', {
                count: withExpired,
              })}
            </span>
          )}
          {withExpiringSoon > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {t('products.datasheetHub.compliance.summary.expiringSoon', {
                count: withExpiringSoon,
              })}
            </span>
          )}
        </div>
      </div>
      <div className="border border-default dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/40 border-b border-default dark:border-slate-800">
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="py-2 px-3 font-medium sticky left-0 z-10 bg-slate-50 dark:bg-slate-800/40">
                {t('products.col.sku')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheet.specs.countryOfOrigin')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheet.specs.hsCode')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheet.specs.ppeCategory')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheet.specs.hazmat')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheetHub.compliance.col.certs')}
              </th>
            </tr>
          </thead>
          <tbody>
            {parent && (
              <tr className="border-b border-default dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/30">
                <td className="py-2 px-3 sticky left-0 z-10 bg-slate-50/60 dark:bg-slate-800/30 align-middle">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    {t('products.datasheetHub.compliance.parentRow')}
                  </span>
                </td>
                <ParentCell value={fmtCountry(parent.countryOfOrigin)} />
                <ParentCell value={parent.hsCode} />
                <ParentCell value={parent.ppeCategory} />
                <ParentCell value={fmtHazmat(parent)} />
                <td className="py-2 px-3 align-middle text-tertiary" />
              </tr>
            )}
            {variants.map((v) => (
              <tr
                key={v.id}
                className="border-b border-subtle dark:border-slate-800 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-800/30"
              >
                <td className="py-2 px-3 sticky left-0 z-10 bg-white dark:bg-slate-900 align-middle">
                  <Link
                    href={`/products/${v.id}/datasheet`}
                    className="font-mono text-xs text-slate-700 dark:text-slate-200 hover:underline"
                    title={v.name}
                  >
                    {v.sku}
                  </Link>
                </td>
                <DiffCell
                  value={fmtCountry(v.countryOfOrigin)}
                  parentValue={parent ? fmtCountry(parent.countryOfOrigin) : null}
                />
                <DiffCell
                  value={v.hsCode}
                  parentValue={parent?.hsCode ?? null}
                />
                <DiffCell
                  value={v.ppeCategory}
                  parentValue={parent?.ppeCategory ?? null}
                />
                <DiffCell
                  value={fmtHazmat(v)}
                  parentValue={parent ? fmtHazmat(parent) : null}
                />
                <td className="py-2 px-3 align-middle">
                  <CertCell certs={v.certs} dateFmt={dateFmt} t={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ParentCell({ value }: { value: string | null }) {
  return (
    <td className="py-2 px-3 align-middle text-slate-700 dark:text-slate-200 font-medium">
      {value ?? <span className="text-slate-300 dark:text-slate-600">—</span>}
    </td>
  )
}

/**
 * Cell that highlights when a variant value differs from parent.
 * Three cases:
 *   1. value === parentValue          muted slate + tiny ✓
 *   2. value != null && != parentValue   normal text + ≠ icon
 *   3. value == null && parentValue != null   "—" + ≠ icon
 *   4. both null                       muted "—"
 */
function DiffCell({
  value,
  parentValue,
}: {
  value: string | null
  parentValue: string | null
}) {
  const same = value === parentValue
  const bothEmpty = value == null && parentValue == null
  if (bothEmpty) {
    return (
      <td className="py-2 px-3 align-middle text-slate-300 dark:text-slate-600">
        —
      </td>
    )
  }
  if (same) {
    return (
      <td className="py-2 px-3 align-middle">
        <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
          <Check className="w-3 h-3 text-emerald-500/70" aria-hidden />
          <span>{value}</span>
        </span>
      </td>
    )
  }
  return (
    <td className="py-2 px-3 align-middle">
      <span className="inline-flex items-center gap-1 text-slate-900 dark:text-slate-100 font-medium">
        <span className="text-amber-500" aria-hidden>
          ≠
        </span>
        <span>
          {value ?? (
            <span className="italic text-tertiary">
              (parent: {parentValue})
            </span>
          )}
        </span>
      </span>
    </td>
  )
}

function CertCell({
  certs,
  dateFmt,
  t,
}: {
  certs: ComplianceVariant['certs']
  dateFmt: Intl.DateTimeFormat
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  if (certs.total === 0) {
    return <span className="text-slate-300">—</span>
  }
  const allValid = certs.expired === 0
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span
        className={
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ' +
          (allValid
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
            : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300')
        }
      >
        <FileText className="w-3 h-3" />
        <span>{certs.total}</span>
        {certs.types.length > 0 && (
          <span
            className="opacity-70"
            title={certs.types.join(', ')}
          >
            {certs.types.slice(0, 2).join(' · ')}
          </span>
        )}
      </span>
      {certs.expired > 0 && (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300 text-[10px] font-medium">
          <AlertTriangle className="w-3 h-3" />
          {t('products.datasheetHub.compliance.certs.expired', {
            count: certs.expired,
          })}
        </span>
      )}
      {certs.expiringSoonAt && (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-[10px]">
          <AlertTriangle className="w-3 h-3" />
          {t('products.datasheetHub.compliance.certs.expiringSoon', {
            date: dateFmt.format(certs.expiringSoonAt),
          })}
        </span>
      )}
    </div>
  )
}

function fmtHazmat(p: {
  hazmatClass: string | null
  hazmatUnNumber: string | null
}): string | null {
  if (!p.hazmatClass && !p.hazmatUnNumber) return null
  const parts = []
  if (p.hazmatUnNumber) parts.push(p.hazmatUnNumber)
  if (p.hazmatClass) parts.push(`Class ${p.hazmatClass}`)
  return parts.join(' · ')
}
