/**
 * VR.10 — Print-friendly variant matrix for the single-SKU spec sheet.
 *
 * The W5.48 printable already carried a one-row-per-variant table.
 * That works when the parent has < 6 children, but for a Color ×
 * Size matrix (15+ variants), an operator handing the print to a
 * distributor wants the 2-D view — "what colors / sizes do you
 * have?" — not a 15-row list.
 *
 * Renders only when:
 *   - product.isParent === true
 *   - axes were detected (variantAxes.detectVariantAxes returned ≥1 axis)
 *   - children.length > 0
 *
 * Falls back to the existing variations table when no clean axes
 * exist (axis-less parents are usually parent-only groupings or
 * legacy multipacks — a flat list reads better there).
 *
 * Each cell carries the minimum information a distributor needs:
 * SKU + price + stock chip. No hero image (would dominate the
 * matrix on a single A4 page), no channel IDs (those live in the
 * audit hub, not the customer handout), no compliance icons
 * (compliance gets its own section above this).
 */

import {
  cellKey,
  detectVariantAxes,
  type VariantChild,
} from '../variantAxes'

export interface PrintVariantChild {
  id: string
  sku: string
  name: string
  basePrice: { toString(): string } | null
  totalStock: number
  status: string
  categoryAttributes: unknown
  channelListings: Array<{
    variationTheme: string | null
    variationMapping: unknown
  }>
}

interface PrintVariantMatrixProps {
  children: PrintVariantChild[]
  locale: 'en' | 'it'
  /** Optional title — defaults to "{count} variants" via i18n. */
  title?: string
  /** Section label for the variants header. */
  sectionLabel: string
}

/**
 * Returns null when the matrix wouldn't be useful (no axes, no
 * children). Caller falls back to the legacy variations table.
 */
export default function PrintVariantMatrix({
  children,
  locale,
  sectionLabel,
}: PrintVariantMatrixProps) {
  if (children.length === 0) return null

  const axes = detectVariantAxes(
    children.map<VariantChild>((c) => ({
      id: c.id,
      categoryAttributes: c.categoryAttributes,
      channelListings: c.channelListings,
    })),
  )

  // No axes → caller should render the flat variations table.
  if (axes.axes.length === 0) return null

  const currencyLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const fmtCurrency = (v: number | null) =>
    v == null
      ? '—'
      : new Intl.NumberFormat(currencyLocale, {
          style: 'currency',
          currency: 'EUR',
          minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
          maximumFractionDigits: 2,
        }).format(v)
  const fmtNum = (v: number) =>
    new Intl.NumberFormat(currencyLocale).format(v)

  const childById = new Map(children.map((c) => [c.id, c]))
  const primary = axes.axes[0]
  const secondary = axes.axes[1] ?? null
  const primaryValues = axes.values[primary] ?? []
  const secondaryValues = secondary != null ? axes.values[secondary] : []

  return (
    <section className="mt-6 print:break-inside-avoid">
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
        {sectionLabel}
      </div>
      <div className="overflow-x-auto">
        <table className="border-collapse text-sm">
          <thead className="border-b-2 border-slate-200">
            <tr className="text-left">
              <th className="py-1.5 pr-3 font-semibold text-slate-600 align-bottom">
                {primary}
                {secondary ? ` \\ ${secondary}` : ''}
              </th>
              {secondary != null ? (
                secondaryValues.map((sv) => (
                  <th
                    key={sv}
                    className="py-1.5 px-2 font-semibold text-slate-600 text-center align-bottom"
                  >
                    {sv}
                  </th>
                ))
              ) : (
                <th className="py-1.5 px-2 font-semibold text-slate-600 text-left align-bottom">
                  SKU
                </th>
              )}
            </tr>
          </thead>
          <tbody className="[&>tr]:border-b [&>tr]:border-slate-100">
            {primaryValues.map((pv) => (
              <tr key={pv}>
                <th
                  scope="row"
                  className="py-1.5 pr-3 text-left text-slate-700 font-medium align-top"
                >
                  {pv}
                </th>
                {secondary != null ? (
                  secondaryValues.map((sv) => {
                    const ax = axes.cellByKey.get(cellKey([pv, sv]))
                    const data = ax ? childById.get(ax.id) : null
                    return (
                      <td
                        key={sv}
                        className="py-1.5 px-2 align-top text-center"
                      >
                        {data ? (
                          <PrintCell
                            data={data}
                            fmtCurrency={fmtCurrency}
                            fmtNum={fmtNum}
                          />
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    )
                  })
                ) : (
                  <td className="py-1.5 px-2 align-top">
                    {(() => {
                      const ax = axes.cellByKey.get(cellKey([pv]))
                      const data = ax ? childById.get(ax.id) : null
                      if (!data) {
                        return <span className="text-slate-300">—</span>
                      }
                      return (
                        <PrintCell
                          data={data}
                          fmtCurrency={fmtCurrency}
                          fmtNum={fmtNum}
                        />
                      )
                    })()}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PrintCell({
  data,
  fmtCurrency,
  fmtNum,
}: {
  data: PrintVariantChild
  fmtCurrency: (v: number | null) => string
  fmtNum: (v: number) => string
}) {
  return (
    <div className="text-left">
      <div className="font-mono text-[10px] text-slate-700 truncate">
        {data.sku}
      </div>
      <div className="text-xs text-slate-900 tabular-nums">
        {fmtCurrency(
          data.basePrice == null ? null : Number(data.basePrice),
        )}
      </div>
      <div
        className={
          'text-[10px] tabular-nums ' +
          (data.totalStock > 0 ? 'text-emerald-700' : 'text-amber-700')
        }
      >
        {fmtNum(data.totalStock)}
      </div>
    </div>
  )
}
