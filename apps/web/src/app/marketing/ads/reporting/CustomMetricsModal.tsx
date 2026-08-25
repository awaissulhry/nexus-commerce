'use client'

/**
 * RPT.12 — manage operator-defined metrics for a report.
 *
 * The formula is checked against the server as it is typed, so an invalid one is
 * refused with the exact reason and character position BEFORE it is saved rather
 * than becoming a column that silently returns nothing.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Trash2 } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Pill } from '@/design-system/primitives/Pill'
import { Input } from '@/design-system/primitives/Input'
import { Select } from '@/design-system/primitives/Select'
import { ToolbarButton } from '@/design-system/primitives/ToolbarButton'
import {
  createCustomMetric, deleteCustomMetric, listCustomMetrics, previewFormula,
  type CustomMetric,
} from './custom-metrics-api'
import type { ColumnMeta } from './report-api'

export function CustomMetricsModal({
  open, onClose, reportId, available, onChanged,
}: {
  open: boolean
  onClose: () => void
  reportId: string
  /** The report's built-in metrics — the vocabulary a formula may reference. */
  available: ColumnMeta[]
  onChanged: () => void
}) {
  const [items, setItems] = useState<CustomMetric[]>([])
  const [name, setName] = useState('')
  const [formula, setFormula] = useState('')
  const [format, setFormat] = useState('money')
  const [betterWhen, setBetterWhen] = useState<'higher' | 'lower' | ''>('higher')
  const [check, setCheck] = useState<{ ok: boolean; error: string | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    listCustomMetrics(reportId).then(setItems).catch((e: unknown) => setErr((e as Error).message))
  }, [reportId])
  useEffect(() => { if (open) reload() }, [open, reload])

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    if (!formula.trim()) { setCheck(null); return }
    const t = window.setTimeout(() => {
      previewFormula(reportId, formula)
        .then((r) => setCheck({ ok: r.ok, error: r.error }))
        .catch(() => setCheck(null))
    }, 300)
    return () => window.clearTimeout(t)
  }, [formula, reportId])

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      await createCustomMetric({ reportId, name, formula, format, betterWhen: betterWhen || null })
      setName(''); setFormula(''); setCheck(null)
      reload(); onChanged()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try { await deleteCustomMetric(id); reload(); onChanged() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const metricIds = available.filter((c) => c.kind === 'metric').map((c) => c.id)

  return (
    <Modal open={open} onClose={onClose} title="Custom metrics" size="lg"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <p className="rpt-modal-p">
        A formula over this report&rsquo;s own metrics. It is aggregated in SQL, so it stays
        correct at every grouping and in the totals row, and it appears in the grid, the
        column chooser, the KPI tiles and every export.
      </p>

      {items.length > 0 && (
        <ul className="rpt-cm-list">
          {items.map((m) => (
            <li key={m.id}>
              <div className="hd">
                <b>{m.name}</b>
                <code>{m.formula}</code>
                {m.brokenReason
                  ? <Pill tone="danger">Broken</Pill>
                  : <Pill tone="neutral">{m.format}</Pill>}
                <ToolbarButton
                  icon={<Trash2 size={13} />}
                  label={`Delete ${m.name}`}
                  disabled={busy}
                  onClick={() => remove(m.id)}
                  className="rpt-row-act"
                />
              </div>
              {m.brokenReason && <div className="broken">{m.brokenReason}</div>}
            </li>
          ))}
        </ul>
      )}

      <div className="rpt-form">
        <label className="rpt-field">
          <span>Name</span>
          <Input value={name} placeholder="e.g. Contribution after ads"
            onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="rpt-field">
          <span>Formula</span>
          <Input value={formula} placeholder="sales - cost"
            onChange={(e) => setFormula(e.target.value)} spellCheck={false} />
        </label>
        <label className="rpt-field">
          <span>Format</span>
          <Select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="money">Money</option>
            <option value="pct">Percentage</option>
            <option value="ratio">Ratio</option>
            <option value="int">Whole number</option>
          </Select>
        </label>
        <label className="rpt-field">
          <span>Better when</span>
          <Select value={betterWhen}
            onChange={(e) => setBetterWhen(e.target.value as 'higher' | 'lower' | '')}>
            <option value="higher">Higher</option>
            <option value="lower">Lower</option>
            <option value="">Neither</option>
          </Select>
        </label>
      </div>

      {check && (
        <p className={`rpt-cm-check ${check.ok ? 'ok' : 'bad'}`}>
          {check.ok ? <><Check size={12} aria-hidden /> Formula is valid.</>
                    : <><AlertTriangle size={12} aria-hidden /> {check.error}</>}
        </p>
      )}
      {err && <p className="rpt-cm-check bad"><AlertTriangle size={12} aria-hidden /> {err}</p>}

      <p className="rpt-cm-avail">
        Available metrics: {metricIds.map((id) => <code key={id}>{id}</code>)}
        <br />Operators: <code>+</code> <code>-</code> <code>*</code> <code>/</code> and brackets.
        Division by zero yields no value rather than an error.
      </p>

      <div style={{ marginTop: 12 }}>
        <Button disabled={busy || !name.trim() || !check?.ok} onClick={submit}>Add metric</Button>
      </div>
    </Modal>
  )
}
