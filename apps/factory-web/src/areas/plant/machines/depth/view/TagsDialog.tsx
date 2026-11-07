'use client'

import Link from 'next/link'
import { Printer, QrCode as QrIcon } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { Button, NumberStepper, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { TIME_ZONE, type Words } from '../../../_shared/model'
import type { LabelPrinter, RefusedTag, TagJob } from '../api'
import { printStateOf, tagLayout } from '../model'
import { TagQr, useDepthWords, useSay } from '../parts'

/** A machine as its tag prints it. */
export interface TagMachine {
  id: string
  assetNumber: string
  typeWords: string
  placeWords: string
  siteId: string
  retired: boolean
}

export type PrintersState = { status: 'loading' } | { status: 'ready'; value: LabelPrinter[] } | { status: 'error'; problem: Words } | { status: 'forbidden' }

export interface TagsDialogState {
  machines: TagMachine[]
  printers: PrintersState
  printerId: string | null
  copies: number
  busy: boolean
  problem: Words | null
  /** What the last Print answered: one job per machine sent, the others refused in words. */
  result: { jobs: TagJob[]; refused: RefusedTag[] } | null
  retrying: string | null
}

/** Previews drawn at once (the rest are said). */
const SHOWN = 6

/** The machines of the list that may print on this printer (in use, at its site). */
export function printable(state: Pick<TagsDialogState, 'machines' | 'printers' | 'printerId'>): TagMachine[] {
  const printer = state.printers.status === 'ready' ? (state.printers.value.find((entry) => entry.id === state.printerId) ?? null) : null
  return state.machines.filter((machine) => !machine.retired && (!printer || machine.siteId === printer.siteId))
}

export function tagsHeld(state: TagsDialogState, canPrint: boolean): string | null {
  if (!canPrint) return 'tags.held.noRight'
  if (state.printers.status === 'loading') return 'tags.held.reading'
  if (state.printers.status !== 'ready' || state.printers.value.length === 0) return 'tags.held.noPrinter'
  if (!state.printerId) return 'tags.held.pickPrinter'
  if (printable(state).length === 0) return 'tags.held.none'
  if (state.busy) return 'tags.held.busy'
  return null
}

/**
 * Print QR tags (design plant.machines pop:tags, from the band, the bulk bar and a machine's Tag tab): the tag of each machine
 * to scale (DS LabelPreview with its QR: the asset number a station's scan opens), a label printer of the machines' site,
 * the copies, then one print job each — queued, sent, printed or failed with Retry. A retired machine or one of another
 * site is said and left out. With no label printer the tag sheet prints from the browser ("Print on paper").
 */
export function TagsDialog({
  state,
  canPrint,
  sheetHref,
  onPrinter,
  onCopies,
  onPrint,
  onRetry,
  onClose,
}: {
  state: TagsDialogState
  canPrint: boolean
  sheetHref: string
  onPrinter?: (id: string) => void
  onCopies?: (copies: number) => void
  onPrint?: () => void
  onRetry?: (job: TagJob) => void
  onClose?: () => void
}) {
  const t = useDepthWords()
  const say = useSay()
  const locale = useLocale()
  const printers = state.printers.status === 'ready' ? state.printers.value : []
  const printer = printers.find((entry) => entry.id === state.printerId) ?? null
  const ready = printable(state)
  const held = tagsHeld(state, canPrint)
  const jobOf = (id: string) => state.result?.jobs.find((job) => job.machineId === id) ?? null
  const stock = printer ? { widthMm: printer.labelWidthMm, heightMm: printer.labelHeightMm } : undefined
  const left = state.machines.filter((machine) => !ready.includes(machine))
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('tags.title', { count: state.machines.length })}
      size="lg"
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t('common.close')}</Button>
          <Button asChild>
            <Link href={sheetHref} target="_blank">
              <QrIcon size={14} aria-hidden /> {t('tags.paper')}
            </Link>
          </Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => onPrint?.()}>
            {state.busy ? <Spinner size={12} /> : <Printer size={14} aria-hidden />} {t('tags.print', { count: ready.length })}
          </Button>
        </>
      }
    >
      <div className="fw-md-stack">
        {state.problem && <Banner tone="danger" title={say(state.problem) ?? ''} />}
        {state.result && (
          <Banner tone={state.result.refused.length > 0 ? 'warning' : 'success'} title={t('tags.sent', { count: state.result.jobs.length })}>
            {state.result.refused.length > 0 ? (
              <ul className="fw-md-plain">
                {state.result.refused.map((entry) => (
                  <li key={entry.machineId}>{t('tags.refusedLine', { machine: entry.assetNumber, why: t(`refusal.${entry.code}`) })}</li>
                ))}
              </ul>
            ) : (
              t('tags.sentBody')
            )}
          </Banner>
        )}
        <div className="fw-md-form fw-md-grid2">
          <Field label={t('tags.printer')} hint={printer ? t('tags.stock', { width: printer.labelWidthMm, height: printer.labelHeightMm, dpi: printer.dpi }) : t('tags.printerHint')}>
            {state.printers.status === 'loading' ? (
              <Skeleton height={32} />
            ) : (
              <Select value={state.printerId ?? ''} disabled={!canPrint || printers.length === 0} onChange={(event) => onPrinter?.(event.target.value)}>
                <option value="">{printers.length === 0 ? t('tags.noPrinter') : t('tags.pickPrinter')}</option>
                {printers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {`${entry.code} · ${entry.name} · ${entry.siteCode}`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('tags.copies')} hint={t('tags.copiesHint')}>
            <NumberStepper value={state.copies} min={1} max={5} onChange={(value: number) => onCopies?.(value)} aria-label={t('tags.copies')} decrementLabel={t('tags.fewer')} incrementLabel={t('tags.moreCopies')} />
          </Field>
        </div>
        {!canPrint && <p className="fw-md-muted">{t('tags.noRightBody')}</p>}
        {state.printers.status === 'error' && <Banner tone="warning" title={t('tags.printersFailed')}>{say(state.printers.problem)}</Banner>}
        {state.printers.status === 'ready' && printers.length === 0 && <Banner tone="info" title={t('tags.noPrinterTitle')}>{t('tags.noPrinterBody')}</Banner>}
        {left.length > 0 && (
          <p className="fw-md-muted">
            {t('tags.leftOut', { count: left.length, machines: left.map((machine) => machine.assetNumber).join(', ') })}
          </p>
        )}
        {state.machines.length === 0 ? (
          <EmptyState title={t('tags.noneTitle')} description={t('tags.noneBody')} />
        ) : (
          <div className="fw-md-labels">
            {state.machines.slice(0, SHOWN).map((machine) => {
              const job = jobOf(machine.id)
              return (
                <LabelPreview
                  key={machine.id}
                  layout={tagLayout(t, machine, stock)}
                  scale={3}
                  renderQr={(value) => <TagQr value={value} label={t('tags.qrLabel', { machine: machine.assetNumber })} />}
                  codeLabel={() => t('tags.qrLabel', { machine: machine.assetNumber })}
                  {...(job ? { print: printStateOf(t, job, formatTime(job.at, { locale, timeZone: TIME_ZONE })) } : {})}
                  {...(job?.state === 'FAILED' ? { onRetry: () => onRetry?.(job), retryLabel: t('tags.retry'), retryHeldReason: state.retrying === job.jobId ? t('tags.held.busy') : canPrint ? null : t('tags.held.noRight') } : {})}
                />
              )
            })}
          </div>
        )}
        {state.machines.length > SHOWN && <p className="fw-md-muted">{t('tags.more', { count: state.machines.length - SHOWN })}</p>}
        <p className="fw-md-muted">{t('tags.how')}</p>
      </div>
    </Modal>
  )
}
