'use client'

import { Printer } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { Employee } from '../../../_shared/api'
import { TIME_ZONE } from '../../../_shared/model'
import { PeopleMessages, useWords } from '../../../_shared/parts'
import { badgeWords } from '../../view/EmployeeDialogs'
import { badgeLayout } from '../badge'
import { BadgeQr } from './BadgeQr'

/** SCR-085-badges — the badge sheet on paper: one view model, nothing fetched. */
export interface BadgeSheetModel {
  readonly person: string
  readonly at: string
  /** How many people the address named. */
  readonly asked: number
  readonly people: { readonly value: readonly Employee[] | null; readonly problem: string | null }
  readonly origin: string
  readonly prefix: string
  readonly companyName: string
}

/**
 * People › Employees › Badge sheet (design people.employees tab:badge-pdf "Printed from PdfViewer; the browser's print
 * dialog needs its own tab"): one badge face per person (86 × 54 mm: the company, the name shown on the floor, the
 * employee code, site and team, a QR that opens the record in the Office). Printed from the browser on card stock (or
 * saved as a PDF). The badge's sign-in code is never printed here (Admin › Users issues it once).
 */
export function BadgeSheetView({ model }: { model: BadgeSheetModel }) {
  return (
    <PeopleMessages>
      <Sheet model={model} />
    </PeopleMessages>
  )
}

function Sheet({ model }: { model: BadgeSheetModel }) {
  const t = useWords()
  const locale = useLocale()
  const people = model.people.value
  const words = badgeWords(t, model.companyName)
  return (
    <article className="fw-pp-print">
      <header className="fw-pp-print-head">
        <h1 className="fw-pp-print-title">{t('sheet.title', { count: people?.length ?? 0 })}</h1>
        <p className="fw-pp-hint">{t('print.meta', { at: formatDateTime(model.at, { locale, timeZone: TIME_ZONE }), person: model.person })}</p>
        <Button className="fw-pp-print-button" variant="secondary" onClick={() => window.print()} heldReason={people && people.length > 0 ? null : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {model.people.problem ? (
        <Banner tone="danger" title={t('sheet.failed')}>
          {t(model.people.problem)}
        </Banner>
      ) : !people ? (
        <p className="fw-pp-hint" role="status">
          <Spinner size={14} /> {t('record.loading')}
        </p>
      ) : people.length === 0 ? (
        <p className="fw-pp-text">{t('sheet.none')}</p>
      ) : (
        <>
          {people.length < model.asked && <Banner tone="warning" title={t('sheet.missing', { count: model.asked - people.length })} />}
          <div className="fw-pp-sheet">
            {people.map((person) => (
              <LabelPreview
                key={person.id}
                layout={badgeLayout({ id: person.id, displayName: person.displayName, name: person.name, employeeCode: person.employeeCode, siteCode: person.site.code, team: person.team?.code ?? null }, words, `${model.origin}${model.prefix}/people/employees/${encodeURIComponent(person.id)}`)}
                scale={3}
                renderQr={(value) => <BadgeQr value={value} label={t('badge.qr', { name: person.displayName })} />}
                codeLabel={() => t('badge.qr', { name: person.displayName })}
              />
            ))}
          </div>
        </>
      )}
      <p className="fw-pp-hint">{t('sheet.foot')}</p>
    </article>
  )
}
