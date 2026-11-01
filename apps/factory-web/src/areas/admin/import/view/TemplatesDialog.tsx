'use client'

import type { ReactNode } from 'react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Importer, NumberFormat } from '../api'
import { NUMBER_SAMPLES, templateHref } from '../model'
import { useImporterWords } from './ImportWizard'

/**
 * Templates (design 02 admin.import, the page's More menu "Templates", B-W2a-41, PLT-177): every importer this person
 * may use with its template as Excel (the sheet and a "Columns" sheet that explains each column) or CSV, written in the
 * person's number format. A template holds made-up examples only; money columns appear only for a person who sees
 * that money. Fetches nothing: the links are plain GETs through `/api`.
 */

interface TemplatesParts {
  title: string
  body: ReactNode
  footer: ReactNode
}

function useTemplatesParts(importers: readonly Importer[], onClose?: () => void): TemplatesParts {
  const t = useT('admin-import')
  const locale = useLocale() as NumberFormat
  const words = useImporterWords()
  return {
    title: t('imp.templates.title'),
    body: (
      <div className="fw-adm-modal-body">
        <p className="fw-adm-intro">{t('imp.templates.intro', { sample: NUMBER_SAMPLES[locale] })}</p>
        {importers.length === 0 ? (
          <p className="fw-adm-hint">{t('imp.templates.none')}</p>
        ) : (
          <ul className="fw-adm-imp-templates">
            {importers.map((importer) => {
              const name = words.name(importer.key, importer.label)
              return (
                <li key={importer.key} className="fw-adm-imp-template">
                  <span className="fw-adm-imp-template-name">{name}</span>
                  <span className="fw-adm-imp-links">
                    <a className="fw-adm-link" href={templateHref(importer.key, 'xlsx', locale)} download>
                      {t('imp.template.xlsx')}
                      <span className="fw-adm-sr"> {name}</span>
                    </a>
                    <a className="fw-adm-link" href={templateHref(importer.key, 'csv', locale)} download>
                      {t('imp.template.csv')}
                      <span className="fw-adm-sr"> {name}</span>
                    </a>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <p className="fw-adm-hint">{t('imp.templates.money')}</p>
      </div>
    ),
    footer: <Button onClick={() => onClose?.()}>{t('imp.templates.close')}</Button>,
  }
}

export function TemplatesDialog({ open, importers, onClose }: { open: boolean; importers: readonly Importer[]; onClose?: () => void }) {
  const parts = useTemplatesParts(importers, onClose)
  if (!open) return null
  return (
    <Modal open onClose={() => onClose?.()} title={parts.title} size="md" footer={parts.footer}>
      {parts.body}
    </Modal>
  )
}

/** The same list drawn in place (the DS Modal opens only in a browser: the tests draw this). */
export function TemplatesInline({ importers }: { importers: readonly Importer[] }) {
  const parts = useTemplatesParts(importers)
  return (
    <section aria-label={parts.title}>
      <h2>{parts.title}</h2>
      {parts.body}
    </section>
  )
}
