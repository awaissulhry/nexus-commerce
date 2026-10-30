'use client'

import { Printer } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { QrCode } from '@nexus/ui/components/QrCode/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { Machine } from '../../../_shared/api'
import { labelOf, TIME_ZONE } from '../../../_shared/model'
import { PlantMessages, useWords } from '../../../_shared/parts'

/** SCR-150-tags — the machines' QR tags on paper: one view model, nothing fetched. */
export interface TagsModel {
  readonly person: string
  readonly at: string
  readonly machines: { readonly value: readonly Machine[] | null; readonly problem: string | null }
}

/**
 * Plant › Machines & tools › Tag sheet (design plant.machines/tab:tags-pdf "Tag sheet (PDF)"): one tag per machine — its
 * QR (the asset number, which a station's scan opens: "Report a problem"), the asset number big, its type and where it
 * stands. Printed from the browser on label paper (it saves it as a PDF; the label printer's tag layout and print states
 * come with W2b "Print QR tags").
 */
export function TagsView({ model }: { model: TagsModel }) {
  return (
    <PlantMessages>
      <Tags model={model} />
    </PlantMessages>
  )
}

function Tags({ model }: { model: TagsModel }) {
  const t = useWords()
  const locale = useLocale()
  const machines = model.machines.value
  const labels = { copy: t('sheet.copy'), copied: t('sheet.copied'), copyFailed: t('sheet.copyFailed'), loading: t('record.loading'), tooLong: t('sheet.tooLong') }
  return (
    <article className="fw-pl-print">
      <header className="fw-pl-print-head">
        <h1 className="fw-pl-print-title">{t('tags.title', { count: machines?.length ?? 0 })}</h1>
        <p className="fw-pl-hint">{t('print.meta', { at: formatDateTime(model.at, { locale, timeZone: TIME_ZONE }), person: model.person })}</p>
        <Button className="fw-pl-print-button" variant="secondary" onClick={() => window.print()} heldReason={machines && machines.length > 0 ? null : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {model.machines.problem ? (
        <Banner tone="danger" title={t('machines.failed')}>
          {t(model.machines.problem)}
        </Banner>
      ) : !machines ? (
        <p className="fw-pl-hint" role="status">
          <Spinner size={14} /> {t('record.loading')}
        </p>
      ) : machines.length === 0 ? (
        <p className="fw-pl-text">{t('tags.none')}</p>
      ) : (
        <div className="fw-pl-tags">
          {machines.map((machine) => (
            <div key={machine.id} className="fw-pl-tag">
              <QrCode value={machine.assetNumber} label={t('tags.qr', { machine: machine.assetNumber })} size={104} labels={labels} />
              <span className="fw-pl-tag-text">
                <span className="fw-pl-tag-asset">{machine.assetNumber}</span>
                <span>{labelOf(machine.class, locale)}</span>
                <span className="fw-pl-hint">{[machine.siteCode, machine.station?.code].filter(Boolean).join(' · ')}</span>
                <span className="fw-pl-hint">{t('tags.scan')}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="fw-pl-hint">{t('tags.foot')}</p>
    </article>
  )
}
