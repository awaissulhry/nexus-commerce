'use client'

// RX.4 — Returns Automation (diff-then-apply).
//
// The preview is the diff: it lists exactly which REQUESTED returns the
// engine would auto-approve (resolved policy opts in, inside the return
// window, under the high-value threshold) plus returnless ("keep it")
// suggestions and a skip breakdown. Nothing changes until the operator
// confirms a selection and clicks Apply. Refunds are never automated —
// auto-approve advances REQUESTED → AUTHORIZED only.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Zap, CheckCircle2, ShieldCheck, AlertTriangle, PackageX, ArrowRight,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { CHANNEL_TONE } from '@/app/_shared/returns'

type AutoApproveCandidate = {
  id: string; rmaNumber: string | null; channel: string; marketplace: string | null
  refundCents: number | null; daysSinceDelivery: number | null; windowDays: number; reason: string
}
type ReturnlessCandidate = {
  id: string; rmaNumber: string | null; channel: string; refundCents: number | null; reason: string
}
type Preview = {
  autoApprove: AutoApproveCandidate[]
  returnless: ReturnlessCandidate[]
  skipped: { highValue: number; outOfWindow: number; policyManual: number; fba: number; noDeliveryDate: number }
  returnlessMaxCents: number
  generatedAt: string
}

function eur(cents: number | null): string {
  return cents == null ? '—' : `€${(cents / 100).toFixed(2)}`
}

export default function AutomationClient() {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [data, setData] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)

  const fetchPreview = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/automation/preview`, { cache: 'no-store' })
      if (res.ok) {
        const d = (await res.json()) as Preview
        setData(d)
        // Default-select every candidate so Apply is one click.
        setSelected(new Set(d.autoApprove.map((c) => c.id)))
      }
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void fetchPreview() }, [fetchPreview])

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const allSelected = !!data && data.autoApprove.length > 0 && data.autoApprove.every((c) => selected.has(c.id))
  const toggleAll = () => {
    if (!data) return
    setSelected(allSelected ? new Set() : new Set(data.autoApprove.map((c) => c.id)))
  }

  const apply = async () => {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    const ok = await askConfirm({
      title: `Auto-approve ${ids.length} return${ids.length === 1 ? '' : 's'}?`,
      description: 'These move REQUESTED → AUTHORIZED. No refunds are issued. You can still inspect and refund each one as normal.',
      confirmLabel: `Approve ${ids.length}`,
      tone: 'info',
    })
    if (!ok) return
    setApplying(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/automation/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d.error ?? 'Apply failed'); return }
      toast.success(`${d.ok ?? 0} auto-approved${d.failed ? ` · ${d.failed} skipped` : ''}`)
      void fetchPreview()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Apply failed')
    } finally { setApplying(false) }
  }

  const skippedTotal = useMemo(() => {
    if (!data) return 0
    const s = data.skipped
    return s.highValue + s.outOfWindow + s.policyManual + s.fba + s.noDeliveryDate
  }, [data])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Returns Automation"
        description="Guardrailed auto-approve. The engine flags REQUESTED returns whose policy opts in, that are inside the return window and under the high-value threshold. You confirm before anything changes — refunds are never automated."
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Returns', href: '/fulfillment/returns' },
          { label: 'Automation' },
        ]}
      />

      {loading && !data ? (
        <Card><div className="py-8 text-center text-slate-500 dark:text-slate-400">Computing automation preview…</div></Card>
      ) : !data ? null : (
        <>
          {/* Auto-approve diff. */}
          <Card noPadding>
            <div className="flex items-center justify-between px-4 py-3 border-b border-default dark:border-slate-700">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-2">
                <Zap size={15} className="text-amber-500" /> Auto-approve candidates
                <span className="text-tertiary font-normal">({data.autoApprove.length})</span>
              </h2>
              <div className="flex items-center gap-2">
                {data.autoApprove.length > 0 && (
                  <button onClick={toggleAll} className="text-xs text-blue-700 dark:text-blue-300 hover:underline">
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                )}
                <button
                  onClick={apply}
                  disabled={applying || selected.size === 0}
                  className="h-8 px-3 text-sm font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded inline-flex items-center gap-1.5 hover:bg-slate-700 disabled:opacity-50"
                >
                  <CheckCircle2 size={14} /> {applying ? 'Applying…' : `Approve ${selected.size}`}
                </button>
              </div>
            </div>
            {data.autoApprove.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400 inline-flex items-center justify-center gap-2 w-full">
                <ShieldCheck size={15} className="text-emerald-500" /> Nothing pending auto-approval right now.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-default dark:border-slate-700 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    <th className="px-3 py-2 w-8"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></th>
                    <th className="px-3 py-2 font-semibold">RMA</th>
                    <th className="px-3 py-2 font-semibold">Channel</th>
                    <th className="px-3 py-2 font-semibold text-right">Refund</th>
                    <th className="px-3 py-2 font-semibold">Why eligible</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.autoApprove.map((c) => (
                    <tr key={c.id} className="border-b border-subtle dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="px-3 py-2"><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.rmaNumber ?? c.id}`} /></td>
                      <td className="px-3 py-2 font-mono text-xs">{c.rmaNumber ?? c.id.slice(-6)}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[c.channel] ?? ''}`}>{c.channel}</span>
                        {c.marketplace && <span className="ml-1 text-xs text-tertiary">{c.marketplace}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{eur(c.refundCents)}</td>
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-400 text-xs">{c.reason}</td>
                      <td className="px-3 py-2 text-right">
                        <a href={`/fulfillment/returns?drawer=${c.id}`} className="text-xs text-blue-700 dark:text-blue-300 hover:underline inline-flex items-center gap-0.5">
                          Open <ArrowRight size={11} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Returnless suggestions (informational — never auto-applied). */}
            <Card>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-2 mb-2">
                <PackageX size={14} className="text-violet-500" /> Returnless candidates
                <span className="text-tertiary font-normal">({data.returnless.length})</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                Low-value returns (≤ {eur(data.returnlessMaxCents)}) where the return-leg cost may exceed recovery.
                Suggestion only — issue a refund-and-keep from the drawer if it makes sense.
              </p>
              {data.returnless.length === 0 ? (
                <p className="text-sm text-tertiary">None.</p>
              ) : (
                <ul className="space-y-1">
                  {data.returnless.map((r) => (
                    <li key={r.id}>
                      <a href={`/fulfillment/returns?drawer=${r.id}`} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-violet-50 dark:hover:bg-violet-950/30">
                        <span className="inline-flex items-center gap-2 min-w-0">
                          <span className={`text-[10px] font-semibold uppercase tracking-wider px-1 py-0.5 border rounded shrink-0 ${CHANNEL_TONE[r.channel] ?? ''}`}>{r.channel}</span>
                          <span className="font-mono text-xs text-slate-700 dark:text-slate-300 truncate">{r.rmaNumber ?? r.id.slice(-6)}</span>
                        </span>
                        <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400 shrink-0">{eur(r.refundCents)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Skip breakdown — why other REQUESTED returns weren't flagged. */}
            <Card>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-2 mb-2">
                <AlertTriangle size={14} className="text-tertiary" /> Not auto-approved ({skippedTotal})
              </h3>
              <dl className="space-y-1.5 text-sm">
                <SkipRow label="Policy is manual (autoApprove off)" value={data.skipped.policyManual} hint="Enable auto-approve on the policy to include these." />
                <SkipRow label="Outside return window" value={data.skipped.outOfWindow} />
                <SkipRow label="Over high-value threshold" value={data.skipped.highValue} hint="Kept for human review by policy." />
                <SkipRow label="No delivery date" value={data.skipped.noDeliveryDate} hint="Window can't be confirmed." />
                <SkipRow label="FBA (Amazon-managed)" value={data.skipped.fba} />
              </dl>
              <p className="mt-3 text-xs text-tertiary">
                Tune eligibility on the{' '}
                <a href="/fulfillment/returns/policies" className="text-blue-700 dark:text-blue-300 hover:underline">Return Policies</a> page.
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

function SkipRow({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-600 dark:text-slate-300">{label}{hint && <span className="block text-xs text-tertiary">{hint}</span>}</dt>
      <dd className="tabular-nums font-semibold text-slate-700 dark:text-slate-300">{value}</dd>
    </div>
  )
}
