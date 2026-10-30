'use client'

import { Printer } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { MaintenanceRequest } from '../../../_shared/api'
import { ageWords, labelOf, personWords, TIME_ZONE } from '../../../_shared/model'
import { PlantMessages, useWords } from '../../../_shared/parts'

/** SCR-148-print — the open machine requests on paper for the technician's shift: one view model, nothing fetched. */
export interface RequestsPrintModel {
  /** Who printed it (said at the top with the time). */
  readonly person: string
  /** The site written at the top ("all sites" when none). */
  readonly site: string | null
  readonly at: string
  readonly requests: { readonly value: readonly MaintenanceRequest[] | null; readonly problem: string | null }
}

/**
 * Plant › Machine requests › Print (design plant.requests/tab:print "Open requests (print)"): the open requests in the
 * queue's order (unsafe first, then the oldest) with the machine, the symptom and the words, the station, who reported
 * it (an office user, else the station: no worker named on paper) and how long it waits; the site and the time written
 * at the top. Opened in a new tab from the queue's ⋯; the print stylesheet hides the Office frame.
 */
export function RequestsPrintView({ model }: { model: RequestsPrintModel }) {
  return (
    <PlantMessages>
      <RequestsPrint model={model} />
    </PlantMessages>
  )
}

function RequestsPrint({ model }: { model: RequestsPrintModel }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  const rows = model.requests.value
  return (
    <article className="fw-pl-print">
      <header className="fw-pl-print-head">
        <h1 className="fw-pl-print-title">{t('print.requestsTitle', { site: model.site ?? t('common.allSites') })}</h1>
        <p className="fw-pl-hint">{t('print.meta', { at: formatDateTime(model.at, place), person: model.person })}</p>
        <Button className="fw-pl-print-button" variant="secondary" onClick={() => window.print()} heldReason={rows ? null : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {model.requests.problem ? (
        <Banner tone="danger" title={t('requests.failed')}>
          {t(model.requests.problem)}
        </Banner>
      ) : !rows ? (
        <p className="fw-pl-hint" role="status">
          <Spinner size={14} /> {t('record.loading')}
        </p>
      ) : rows.length === 0 ? (
        <p className="fw-pl-text">{t('print.none')}</p>
      ) : (
        <SummaryTable
          label={t('print.requestsTable')}
          columns={[t('col.age'), t('col.machine'), t('col.symptom'), t('col.unsafe'), t('col.station'), t('col.reporter'), t('col.state'), t('print.done')]}
          rows={rows.map((row) => ({
            id: row.id,
            cells: [
              ageWords(t, row.ageMinutes),
              `${row.machine.assetNumber} · ${labelOf(row.machine.class, locale)}`,
              [row.symptom ? labelOf(row.symptom, locale) : null, row.description].filter(Boolean).join(' — ') || '—',
              row.unsafe ? (row.locking ? t('unsafe.tag') : t('unsafe.signed')) : t('unsafe.no'),
              row.station ? `${row.station.code} · ${row.station.name}` : t('list.noStation'),
              personWords(t, row.reportedBy),
              t(`requestStatus.${row.status}`),
              '',
            ],
          }))}
        />
      )}
      <p className="fw-pl-hint">{t('print.requestsFoot')}</p>
    </article>
  )
}
