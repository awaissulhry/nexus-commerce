'use client'

import { useId } from 'react'
import { AlertTriangle, Download, PackageCheck } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill, Tag } from '@nexus/ui/primitives'
import { DateTimeField, FileDropzone, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NAMESPACES } from '../../queue/shared/depth'
import { DepthDialog, PartRead, useDepthWords } from '../../queue/shared/DepthDialog'
import type { Pod, ShipmentProblems } from '../api'
import { downloadHeld, NOTE_MAX, openParts, POD_MAX_BYTES, POD_TYPES, podProblem, PROBLEM_TONE, recordHeld, resolveHeld, type DeliveryActions, type DeliveryModel } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'

/**
 * SCR-597 — Tracking & delivery › Proof of delivery and Tracking problems (design sh-pod "W2b stores signer, time and image
 * (LOG-065)", sh-track "no event for 3 days: a warning line (W2b task, LOG-063)"; B-W2b-398). When it arrived and how we know
 * (from the carrier, or typed by the office), who signed and when (the customer's person, inside this one record), the
 * image to download for a dispute; Record the proof sets what is still missing, each part once (then it never changes);
 * the problems the carrier's news or the daily check raised (delayed, an address problem, a failed delivery, no news for
 * N days), each with its task, and Resolve with a note.
 */
export function DeliveryView({ model, actions }: { model: DeliveryModel; actions?: DeliveryActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Delivery model={model} actions={actions} />
    </WithMessages>
  )
}

function Delivery({ model, actions }: { model: DeliveryModel; actions?: DeliveryActions }) {
  return (
    <>
      <PodCard model={model} actions={actions} />
      <ProblemsCard model={model} actions={actions} />
    </>
  )
}

function PodCard({ model, actions }: { model: DeliveryModel; actions?: DeliveryActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const head = (
    <h2 className="fw-sh-h2">
      <PackageCheck size={16} aria-hidden /> {t('pod.title')}
    </h2>
  )
  if (model.pod.state !== 'ready') {
    return (
      <Card padded>
        {head}
        <PartRead problem={model.pod.state === 'error' ? model.pod.problem : null} onRetry={actions?.onRetry} label={t('pod.title')} />
      </Card>
    )
  }
  const pod = model.pod.value
  const proof = pod.pod
  const blocked = recordHeld(pod, model.can, model.busy)
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        {head}
        {pod.deliveredVia && <Pill tone="success">{t(`pod.via.${pod.deliveredVia}`)}</Pill>}
      </div>
      {model.done?.key.startsWith('pod.') && (
        <p className="fw-sh-hint" role="status">
          {say(model.done)}
        </p>
      )}
      {model.problem && !model.dialog && <Banner tone="danger" title={say(model.problem) ?? ''} />}
      <KeyValue
        labelCase="sentence"
        items={[
          { label: t('pod.shippedAt'), value: pod.shipment.shippedAt ? formatDateTime(pod.shipment.shippedAt, { locale }) : t('pod.notYet') },
          ...(model.facts.expectedAt && !pod.deliveredAt && !model.facts.returnedAt ? [{ label: t('pod.expectedAt'), value: formatDateTime(model.facts.expectedAt, { locale }) }] : []),
          { label: t('pod.deliveredAt'), value: pod.deliveredAt ? formatDateTime(pod.deliveredAt, { locale }) : t('pod.notDelivered') },
          ...(model.facts.returnedAt ? [{ label: t('pod.returnedAt'), value: formatDateTime(model.facts.returnedAt, { locale }) }] : []),
          { label: t('pod.signedBy'), value: proof?.signedBy ?? '—' },
          { label: t('pod.signedAt'), value: proof?.signedAt ? formatDateTime(proof.signedAt, { locale }) : '—' },
          { label: t('pod.image'), value: proof?.file ? proof.file.name : t('pod.noImage') },
        ]}
      />
      {!pod.deliveredAt ? <p className="fw-sh-hint">{t('pod.notDeliveredHint')}</p> : !proof && pod.carrierAsked ? <p className="fw-sh-hint">{t('pod.carrierAsked')}</p> : null}
      <span className="fw-shd-actions">
        {pod.recordHeld !== 'KEPT' && (
          <Button size="sm" heldReason={say(blocked)} onClick={() => actions?.onDialog?.({ kind: 'pod', signedBy: '', signedAt: null, file: null })}>
            {t('pod.record')}
          </Button>
        )}
        <Button size="sm" variant="quiet" heldReason={say(downloadHeld(pod, model.can, model.busy))} onClick={() => actions?.onDownload?.()}>
          <Download size={14} aria-hidden /> {t('pod.download')}
        </Button>
      </span>
      {pod.recordHeld === 'KEPT' && <p className="fw-sh-hint">{t('pod.keptNote')}</p>}
      {model.dialog?.kind === 'pod' && <PodDialog pod={pod} model={model} actions={actions} />}
    </Card>
  )
}

function PodDialog({ pod, model, actions }: { pod: Pod; model: DeliveryModel; actions?: DeliveryActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const whenId = useId()
  if (model.dialog?.kind !== 'pod') return null
  const dialog = model.dialog
  const parts = openParts(pod)
  return (
    <DepthDialog
      title={t('pod.recordTitle', { number: pod.shipment.number })}
      held={model.busy ? t('pod.held.busy') : say(podProblem(dialog, pod, model.can))}
      onGo={() => actions?.onRecord?.()}
      goLabel={t('pod.recordGo')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
    >
      <p className="fw-sh-hint">{t('pod.onceNote')}</p>
      <div className="fw-shd-fields">
        {parts.signer ? (
          <Field label={t('pod.signedBy')} hint={t('pod.signerHint')}>
            <Input size="sm" value={dialog.signedBy} onChange={(event) => actions?.onDialog?.({ ...dialog, signedBy: event.target.value })} />
          </Field>
        ) : (
          <p className="fw-sh-hint">{t('pod.keptSigner', { name: pod.pod?.signedBy ?? '' })}</p>
        )}
        {parts.time ? (
          <Field label={t('pod.signedAt')} htmlFor={whenId}>
            <DateTimeField id={whenId} value={dialog.signedAt ?? ''} onChange={(value) => actions?.onDialog?.({ ...dialog, signedAt: value || null })} min={pod.shipment.shippedAt ?? undefined} max={new Date().toISOString()} locale={INTL_LOCALE[locale]} ariaLabel={t('pod.signedAt')} />
          </Field>
        ) : (
          <p className="fw-sh-hint">{t('pod.keptTime', { when: pod.pod?.signedAt ? formatDateTime(pod.pod.signedAt, { locale }) : '' })}</p>
        )}
        {parts.image ? (
          <div className="fw-shd-stack">
            <span className="fw-sh-h3">{t('pod.image')}</span>
            <FileDropzone accept={POD_TYPES.join(',')} maxBytes={POD_MAX_BYTES} hint={t('pod.imageHint')} onFiles={(files) => actions?.onPick?.(files[0] ?? null)} />
            {dialog.file && <p className="fw-sh-hint">{t('pod.picked', { name: dialog.file.name })}</p>}
          </div>
        ) : (
          <p className="fw-sh-hint">{t('pod.keptImage', { name: pod.pod?.file?.name ?? '' })}</p>
        )}
      </div>
    </DepthDialog>
  )
}

function ProblemsCard({ model, actions }: { model: DeliveryModel; actions?: DeliveryActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const head = (
    <h2 className="fw-sh-h2">
      <AlertTriangle size={16} aria-hidden /> {t('problems.title')}
    </h2>
  )
  if (model.problems.state !== 'ready') {
    return (
      <Card padded>
        {head}
        <PartRead problem={model.problems.state === 'error' ? model.problems.problem : null} onRetry={actions?.onRetry} label={t('problems.title')} />
      </Card>
    )
  }
  const read: ShipmentProblems = model.problems.value
  const open = read.problems.filter((problem) => !problem.resolvedAt)
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        {head}
        {open.length > 0 && <Tag tone="warning">{t('problems.open', { count: open.length })}</Tag>}
      </div>
      {model.done?.key.startsWith('problems.') && (
        <p className="fw-sh-hint" role="status">
          {say(model.done)}
        </p>
      )}
      {read.problems.length === 0 ? (
        <p className="fw-sh-hint">{t('problems.none', { days: read.noScanDays })}</p>
      ) : (
        <ul className="fw-shd-hold-list" aria-label={t('problems.title')}>
          {read.problems.map((problem) => (
            <li key={problem.id} className="fw-shd-hold">
              <span className="fw-shd-hold-head">
                <Pill tone={problem.resolvedAt ? 'neutral' : PROBLEM_TONE[problem.kind]}>{t(`problemKind.${problem.kind}`, { days: read.noScanDays })}</Pill>
                <span className="fw-sh-cell-sub">{problem.raisedBySystem ? t('problems.bySystem') : t('problems.byCarrier')}</span>
              </span>
              <span className="fw-sh-cell-sub">
                {t('problems.raised', { when: formatDateTime(problem.raisedAt, { locale }) })}
                {problem.taskStatus ? ` · ${t('problems.task', { state: t(`taskState.${problem.taskStatus}`) })}` : ''}
              </span>
              {problem.resolvedAt ? (
                <span className="fw-sh-cell-sub">{t('problems.resolved', { when: formatDateTime(problem.resolvedAt, { locale }) })}</span>
              ) : (
                <span className="fw-shd-hold-foot">
                  <span className="fw-sh-cell-sub">{t(`problems.what.${problem.kind}`)}</span>
                  <Button size="sm" variant="quiet" heldReason={say(resolveHeld(problem, model.can, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'resolve', problemId: problem.id, note: '' })} aria-label={t('problems.resolveOf', { kind: t(`problemKind.${problem.kind}`, { days: read.noScanDays }) })}>
                    {t('problems.resolve')}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {model.dialog?.kind === 'resolve' && <ResolveDialog read={read} model={model} actions={actions} />}
    </Card>
  )
}

function ResolveDialog({ read, model, actions }: { read: ShipmentProblems; model: DeliveryModel; actions?: DeliveryActions }) {
  const { t, say } = useDepthWords()
  if (model.dialog?.kind !== 'resolve') return null
  const dialog = model.dialog
  const problem = read.problems.find((entry) => entry.id === dialog.problemId)
  if (!problem) return null
  return (
    <DepthDialog
      title={t('problems.resolveTitle', { kind: t(`problemKind.${problem.kind}`, { days: read.noScanDays }) })}
      subtitle={read.shipment.number}
      held={model.busy ? t('pod.held.busy') : dialog.note.trim().length > NOTE_MAX ? t('problems.noteLong', { max: NOTE_MAX }) : null}
      onGo={() => actions?.onResolve?.()}
      goLabel={t('problems.resolve')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
      size="sm"
    >
      <p className="fw-sh-hint">{problem.taskId ? t('problems.taskDone') : t('problems.noTask')}</p>
      <Field label={t('problems.note')} hint={t('problems.noteHint')}>
        <Textarea rows={3} limit={NOTE_MAX} value={dialog.note} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} />
      </Field>
    </DepthDialog>
  )
}
