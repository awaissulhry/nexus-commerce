'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Ban, CheckCircle2, Printer, XCircle } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useScopedT, useT } from '../../../../lib/i18n/provider'
import { REPRINT_REASONS, type Phrase, type ReprintReason } from '../../_shared/model'
import type { ReprintRun } from '../list-model'
import { BUNDLES_NAMESPACE, reasonOk } from '../model'

const PDF = 'pdf'

/**
 * Reprint ticket (design pop:bd-reprint, W1; here for one bundle or the selection): why, then a label printer of the site,
 * or the PDF in the browser when the site has none. A new code each; the old one says "replaced" when scanned. The same
 * words as the work order's reprint (`production` catalogue).
 */
export function ReprintDialog({ run, prefix, reason: startReason, onRun, onClose }: { run: ReprintRun; prefix: string; reason?: string; onRun?: (reason: string, printerId: string | null) => void; onClose?: () => void }) {
  const t = useT('production')
  const tb = useT(BUNDLES_NAMESPACE)
  const scoped = useScopedT(BUNDLES_NAMESPACE)
  const printers = run.printers.value
  const [choice, setChoice] = useState<ReprintReason>(startReason ? 'other' : 'lost')
  const [other, setOther] = useState(startReason ?? '')
  const [printerId, setPrinterId] = useState('')
  useEffect(() => {
    if (!printerId && printers) setPrinterId(printers.defaultPrinterId ?? printers.printers[0]?.id ?? PDF)
  }, [printers, printerId])
  const reason = choice === 'other' ? other.trim() : t(`reprint.reason.${choice}`)
  const held = !printers && !run.printers.problem ? t('held.checking') : !reasonOk(reason) ? t('reprint.reasonShort') : run.running ? t('held.busy') : null
  const count = run.rows.length
  return (
    <Modal
      open
      onClose={() => (run.running ? undefined : onClose?.())}
      title={t('reprint.title', { count })}
      size="md"
      footer={
        run.done ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={() => onClose?.()}>
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => onClose?.()} heldReason={run.running ? t('held.busy') : null}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => onRun?.(reason, printerId === PDF || !printerId ? null : printerId)}>
              {run.running ? <Spinner size={12} /> : <Printer size={13} aria-hidden />} {t('reprint.go', { count })}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pr-dialog">
        <p>{t('reprint.body')}</p>
        {!run.done && (
          <>
            <fieldset className="fw-pr-list">
              <legend className="fw-pr-h3">{t('reprint.why')}</legend>
              {[...REPRINT_REASONS, 'other' as const].map((value) => (
                <RadioCard key={value} variant="row" name="fw-bd-reprint-reason" checked={choice === value} selected={choice === value} onChange={() => setChoice(value)} title={t(`reprint.reason.${value}`)} />
              ))}
            </fieldset>
            {choice === 'other' && (
              <Field label={t('reprint.otherLabel')} error={other.length > 0 && !reasonOk(other) ? t('reprint.reasonShort') : undefined}>
                <Textarea value={other} onChange={(event) => setOther(event.target.value)} rows={2} maxLength={200} />
              </Field>
            )}
            {run.printers.problem && <Banner tone="warning" title={tb('reprint.printersFailed')} />}
            <Field label={t('reprint.printer')}>
              <Select value={printerId} onChange={(event) => setPrinterId(event.target.value)}>
                {(printers?.printers ?? []).map((printer) => (
                  <option key={printer.id} value={printer.id}>
                    {printer.code} · {printer.name}
                  </option>
                ))}
                <option value={PDF}>{tb('reprint.asPdf')}</option>
              </Select>
            </Field>
          </>
        )}
        <ul className="fw-pr-checks" aria-live="polite">
          {run.rows.map((row) => {
            const result = run.results[row.id]
            return (
              <li key={row.id} className="fw-pr-check">
                {result?.state === 'done' ? <CheckCircle2 size={16} className="fw-pr-ico is-ok" aria-hidden /> : result ? <XCircle size={16} className="fw-pr-ico is-blocked" aria-hidden /> : <Printer size={16} className="fw-pr-ico" aria-hidden />}
                <span className="fw-pr-check-body">
                  <span className="fw-pr-code">{row.code}</span>
                  {result?.state === 'done' && <span>{t('reprint.done', { code: result.code })}</span>}
                  {result?.state === 'done' && result.pdf && (
                    <Link className="fw-pr-link" href={`${prefix}/production/bundles/${row.id}/ticket`} target="_blank">
                      {tb('ticket.pdf')}
                    </Link>
                  )}
                  {result?.state === 'failed' && <span>{scoped(result.words.key, result.words.params)}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}

/** Void bundle (design pop:bd-void, from the Bundle's ⋯): a reason; scans no longer take it. */
export function VoidDialog({ code, problem, busy, reason: startReason, onVoid, onClose }: { code: string; problem: Phrase | null; busy: boolean; reason?: string; onVoid?: (reason: string) => void; onClose?: () => void }) {
  const t = useT(BUNDLES_NAMESPACE)
  const scoped = useScopedT(BUNDLES_NAMESPACE)
  const [reason, setReason] = useState(startReason ?? '')
  const held = !reasonOk(reason) ? t('void.reasonShort') : busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => (busy ? undefined : onClose?.())}
      title={t('void.title', { code })}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => onClose?.()} heldReason={busy ? t('held.busy') : null}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held} onClick={() => onVoid?.(reason.trim())}>
            {busy ? <Spinner size={12} /> : <Ban size={13} aria-hidden />} {t('void.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pr-dialog">
        <p>{t('void.body')}</p>
        {problem && <Banner tone="danger" title={scoped(problem.key, problem.params)} />}
        <Field label={t('void.reason')} error={reason.length > 0 && !reasonOk(reason) ? t('void.reasonShort') : undefined}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={200} />
        </Field>
      </div>
    </Modal>
  )
}
