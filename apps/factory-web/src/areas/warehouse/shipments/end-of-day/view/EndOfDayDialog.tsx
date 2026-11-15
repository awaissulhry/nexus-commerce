'use client'

import Link from 'next/link'
import { ExternalLink, FileSearch } from 'lucide-react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Checkbox, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, type Words } from '../../queue/shared/depth'
import { DepthDialog, PartRead } from '../../queue/shared/DepthDialog'
import { DISPATCH_NAMESPACES, DISPATCH_NS, kilograms } from '../../pickup/dispatch'
import type { CarrierDay, EndOfDay, SheetShipment } from '../api'
import { carrierHeld, carrierState, closableDays, closeHeld, manifestHref, outcomeWords, type EndOfDayActions, type EndOfDayModel } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'
import '../../pickup/dispatch.css'

const STATE_TONE = { closed: 'success', closedBySystem: 'success', toClose: 'warning', nothing: 'neutral' } as const

/**
 * SCR-651 — End of day (B-W2b-412 on B-W2b-395; LOG-049; design warehouse.shipments pop-up sh-eod, the band's action "End of
 * day (W2b manifest)"): the site's day per carrier — the parcels handed over (on the sheet, or what the close puts on it), a
 * late hand-over of an earlier day, what is still packed at the dock (hand it over first, or it waits for the next day's
 * sheet), what left after the sheet closed, what an open sheet lets go — each carrier's preview of its manifest (stored
 * nowhere), then "Close the day and print manifests": one sheet per carrier ticked, each printed on the site's A4 printer, the
 * outcome per carrier in words, and its manifest in a new tab for the driver to sign.
 */
export function EndOfDayDialog({ model, actions }: { model: EndOfDayModel; actions?: EndOfDayActions }) {
  return (
    <WithMessages namespaces={[...DISPATCH_NAMESPACES, 'shell']}>
      <Dialog model={model} actions={actions} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: EndOfDayModel; actions?: EndOfDayActions }) {
  const t = useT(DISPATCH_NS)
  const locale = useLocale()
  const say = (value: Words | null | undefined) => (value ? t(value.key, value.params) : null)
  const close = () => actions?.onClose?.()
  if (model.read.state !== 'ready') {
    return (
      <DepthDialog title={t('eod.title')} held={t('eod.held.reading')} onGo={() => undefined} goLabel={t('eod.go')} onClose={close} problem={null}>
        <PartRead problem={model.read.state === 'error' ? model.read.problem : null} onRetry={actions?.onRetry} label={t('eod.title')} />
      </DepthDialog>
    )
  }
  const day = model.read.value
  const days = closableDays(day.today)
  const dayWords = (value: string) => (value === day.today ? t('eod.today', { date: formatDate(dayInstant(value), { locale }) }) : formatDate(dayInstant(value), { locale }))
  const done = model.outcomes ? <Outcomes model={model} day={day} /> : undefined
  return (
    <>
      <DepthDialog
        title={t('eod.titleAt', { site: day.site.code })}
        subtitle={day.site.name}
        held={say(closeHeld(day, model.chosen, model.can, model.busy))}
        onGo={() => actions?.onGo?.()}
        goLabel={model.print ? t('eod.go') : t('eod.goNoPrint')}
        onClose={close}
        problem={say(model.problem)}
        done={done}
        size="xl"
      >
        <div className="fw-shd-today-head">
          <label className="fw-dsp-inline">
            <span className="fw-sh-hint">{t('eod.day')}</span>
            <Select size="sm" aria-label={t('eod.day')} value={day.day} onChange={(event) => actions?.onDay?.(event.target.value)}>
              {days.map((value) => (
                <option key={value} value={value}>
                  {dayWords(value)}
                </option>
              ))}
            </Select>
          </label>
          <span className="fw-sh-hint">{t('eod.lead')}</span>
        </div>
        {day.carriers.length === 0 ? (
          <EmptyState title={t('eod.none.title')} description={t('eod.none.body')} />
        ) : (
          day.carriers.map((carrier) => <CarrierPart key={carrier.carrierCode} carrier={carrier} day={day} model={model} actions={actions} />)
        )}
        {day.carriers.some((carrier) => carrier.may.close.allowed) && <Checkbox checked={model.print} disabled={!model.can.manage} onChange={(event) => actions?.onPrint?.(event.target.checked)} label={t('eod.print')} />}
        {day.day < day.today && <p className="fw-sh-hint">{t('eod.systemCloses')}</p>}
      </DepthDialog>
      {model.preview && <Preview model={model} day={day} actions={actions} />}
    </>
  )
}

function CarrierPart({ carrier, day, model, actions }: { carrier: CarrierDay; day: EndOfDay; model: EndOfDayModel; actions?: EndOfDayActions }) {
  const t = useT(DISPATCH_NS)
  const locale = useLocale()
  const state = carrierState(carrier)
  const held = carrierHeld(carrier)
  const weight = kilograms(carrier.totals.weightKg, locale) ?? '0'
  const closedAt = carrier.sheet?.closedAt ? formatTime(carrier.sheet.closedAt, { locale, timeZone: day.site.timeZone }) : ''
  return (
    <section className="fw-shd-hold" aria-label={carrier.carrierName}>
      <div className="fw-shd-hold-head">
        <span className="fw-shd-actions">
          {state === 'toClose' ? (
            <Checkbox checked={model.chosen.includes(carrier.carrierCode)} disabled={!model.can.manage} onChange={(event) => actions?.onChoose?.(carrier.carrierCode, event.target.checked)} label={<strong>{carrier.carrierName}</strong>} />
          ) : (
            <strong>{carrier.carrierName}</strong>
          )}
          <Pill tone={STATE_TONE[state]}>{t(`eod.state.${state}`, { time: closedAt })}</Pill>
        </span>
        <span className="fw-sh-hint">{t('eod.totals', { shipments: carrier.totals.shipments, parcels: carrier.totals.parcels, weight })}</span>
      </div>
      {carrier.shipments.length > 0 ? <SheetTable rows={carrier.shipments} prefix={model.prefix} /> : <p className="fw-sh-hint">{held ? t(held.key, held.params) : t('eod.noneHanded')}</p>}
      {carrier.stillPacked.length > 0 && (
        <Banner tone="warning" title={t('eod.stillPacked', { count: carrier.stillPacked.length, numbers: carrier.stillPacked.map((row) => row.number).join(', ') })}>
          {t('eod.stillPackedBody')}
        </Banner>
      )}
      {carrier.waiting.length > 0 && <p className="fw-sh-hint">{t('eod.waiting', { count: carrier.waiting.length, numbers: carrier.waiting.map((row) => row.number).join(', ') })}</p>}
      {carrier.letGo.length > 0 && <p className="fw-sh-hint">{t('eod.letGo', { count: carrier.letGo.length, numbers: carrier.letGo.map((row) => row.number).join(', ') })}</p>}
      <span className="fw-shd-actions">
        {carrier.sheet?.state === 'CLOSED' ? (
          <Button size="sm" asChild>
            <Link href={manifestHref(model.prefix, carrier.sheet.id)} target="_blank" rel="noopener">
              <ExternalLink size={13} aria-hidden /> {t('eod.openManifest')}
            </Link>
          </Button>
        ) : (
          <Button size="sm" heldReason={carrier.shipments.length === 0 ? t('eod.held.nothingToPreview') : null} onClick={() => actions?.onPreview?.(carrier.carrierCode)}>
            <FileSearch size={13} aria-hidden /> {t('eod.preview')}
          </Button>
        )}
      </span>
    </section>
  )
}

function SheetTable({ rows, prefix }: { rows: readonly SheetShipment[]; prefix: string }) {
  const t = useT(DISPATCH_NS)
  const locale = useLocale()
  return (
    <SummaryTable
      label={t('eod.sheetLabel')}
      columns={[t('eod.col.shipment'), t('eod.col.consignee'), t('eod.col.parcels'), t('eod.col.weight'), t('eod.col.tracking'), t('eod.col.ddt')]}
      rows={rows.map((row) => ({
        id: row.id,
        cells: [
          <span key="n" className="fw-sh-cell">
            <Link className="fw-sh-link" href={`${prefix}/warehouse/shipments/${row.id}`}>
              {row.number}
            </Link>
            {row.earlier && <Tag tone="info">{t('eod.earlier')}</Tag>}
          </span>,
          <span key="c" className="fw-sh-cell">
            <span className="fw-sh-ellipsis">{row.consignee}</span>
            <span className="fw-sh-cell-sub">{[row.city, row.country].filter(Boolean).join(', ')}</span>
          </span>,
          <span key="p">{row.parcels}</span>,
          <span key="w">{kilograms(row.weightKg, locale) ?? '—'}</span>,
          <span key="t" className="fw-sh-mono fw-shd-break">
            {row.trackingNumbers.length > 0 ? row.trackingNumbers.join(', ') : '—'}
          </span>,
          <span key="d" className="fw-sh-mono">
            {row.ddtNumber ?? '—'}
          </span>,
        ],
      }))}
      density="compact"
      stackOnPhone
      align={['left', 'left', 'right', 'right', 'left', 'left']}
    />
  )
}

function Preview({ model, day, actions }: { model: EndOfDayModel; day: EndOfDay; actions?: EndOfDayActions }) {
  const t = useT(DISPATCH_NS)
  const shell = useT('shell')
  const preview = model.preview!
  const carrier = day.carriers.find((entry) => entry.carrierCode === preview.carrierCode)
  const title = t('eod.previewTitle', { carrier: carrier?.carrierName ?? preview.carrierCode })
  return (
    <Modal open size="xl" title={title} subtitle={t('eod.previewNote')} onClose={() => actions?.onPreview?.(null)}>
      {preview.pdf.state === 'ready' ? (
        <PdfViewer src={preview.pdf.value} title={title} fileName={`manifest-${day.site.code}-${preview.carrierCode}-${day.day}-preview.pdf`} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" />
      ) : preview.pdf.state === 'error' ? (
        <PartRead problem={preview.pdf.problem} onRetry={() => actions?.onPreview?.(preview.carrierCode)} label={title} />
      ) : (
        <p className="fw-sh-hint" role="status">
          <Spinner size={12} /> {t('eod.previewLoading')}
        </p>
      )}
    </Modal>
  )
}

function Outcomes({ model, day }: { model: EndOfDayModel; day: EndOfDay }) {
  const t = useT(DISPATCH_NS)
  const locale = useLocale()
  return (
    <div className="fw-shd-stack" role="status">
      <p>{t('eod.doneTitle', { date: formatDate(dayInstant(day.day), { locale }) })}</p>
      <ul className="fw-shd-hold-list">
        {(model.outcomes ?? []).map((outcome) => {
          const said = outcomeWords(outcome)
          const name = day.carriers.find((carrier) => carrier.carrierCode === outcome.carrierCode)?.carrierName ?? outcome.carrierCode
          return (
            <li key={outcome.carrierCode} className="fw-shd-hold">
              <span className="fw-shd-hold-head">
                <strong>{name}</strong>
                <Pill tone={said.tone}>{t(outcome.closed ? 'eod.outcome.closedPill' : 'eod.outcome.refusedPill')}</Pill>
              </span>
              <span className="fw-shd-hold-words">{t(said.words.key, said.words.params)}</span>
              {outcome.closed && outcome.manifestId && (
                <span className="fw-shd-actions">
                  <Button size="sm" asChild>
                    <Link href={manifestHref(model.prefix, outcome.manifestId)} target="_blank" rel="noopener">
                      <ExternalLink size={13} aria-hidden /> {t('eod.openManifest')}
                    </Link>
                  </Button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
