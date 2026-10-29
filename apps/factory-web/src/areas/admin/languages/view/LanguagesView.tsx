'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Card, KeyValue, SummaryTable } from '@nexus/ui/components'
import { EditModeBar } from '@nexus/ui/patterns'
import { Pill, Select } from '@nexus/ui/primitives'
import { LOCALE_NAMES, LOCALES, type Locale } from '../../../../lib/i18n/locales'
import { useT } from '../../../../lib/i18n/provider'
import { AdminPageMessages } from '../../kit/messages'
import { PageNotice } from '../../kit/parts'
import { adminHref } from '../../shared/model'
import { ListState, PageHead } from '../../shared/view/parts'
import { changedLanguages, dateSample, FLOOR_ENDONYMS, FLOOR_LANGUAGES, localeCounts, numberSample, zonesInUse, type CompanyLanguage, type LanguagesViewModel } from '../model'
import '../languages.css'

export type { LanguagesViewModel } from '../model'

export interface LanguagesActions {
  onSave?: (changes: Array<{ company: CompanyLanguage; locale: string }>) => Promise<void> | void
  onDismissNotice?: () => void
  onRetry?: () => void
}

/**
 * SCR-016 — Admin › Languages & formats (design 02 admin.languages): the office languages with how much of each is
 * written, the documents' languages and each company's own (saved with the EditModeBar, ⌘S), how numbers and dates
 * are written, how time is kept with the zones in use, and the floor workers' languages. A section the person may not
 * read is absent. Fetches nothing (LanguagesPage.tsx reads the API).
 */
export function LanguagesView({ model, actions }: { model: LanguagesViewModel; actions?: LanguagesActions }) {
  return (
    <AdminPageMessages namespace="admin-languages">
      <Languages model={model} actions={actions} />
    </AdminPageMessages>
  )
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children?: ReactNode }) {
  return (
    <Card padded>
      <section className="fw-adm-langs-section" aria-labelledby={`langs-${id}`}>
        <div className="fw-adm-head-text">
          <h2 id={`langs-${id}`} className="fw-adm-langs-h2">
            {title}
          </h2>
          {intro && <p className="fw-adm-intro">{intro}</p>}
        </div>
        {children}
      </section>
    </Card>
  )
}

function Languages({ model, actions }: { model: LanguagesViewModel; actions?: LanguagesActions }) {
  const t = useT('admin-languages')
  const ta = useT('admin')
  const companies = (model.companies.items ?? []).filter((company) => company.status === 'ACTIVE')
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...(model.draft ?? {}) }))
  useEffect(() => setDraft({ ...(model.draft ?? {}) }), [model.draft, model.companies])
  const changes = changedLanguages(companies, draft)
  const people = model.people?.items ? localeCounts(model.people.items) : null
  const workers = model.workers?.items ? localeCounts(model.workers.items) : null
  return (
    <form
      className="fw-adm fw-adm-langs"
      onSubmit={(event) => {
        event.preventDefault()
        if (changes.length > 0) void actions?.onSave?.(changes)
      }}
    >
      <PageHead intro={t('langs.intro')} asOf={model.asOf} />
      <PageNotice namespace="admin-languages" notice={model.notice} onDismiss={actions?.onDismissNotice} />

      <Section id="office" title={t('langs.office.title')} intro={t('langs.office.intro')}>
        <ul className="fw-adm-list">
          {LOCALES.map((locale) => (
            <li key={locale} className="fw-adm-langs-row">
              <span className="fw-adm-name" lang={locale}>
                {LOCALE_NAMES[locale]}
              </span>
              <Pill tone="success">{t('langs.on')}</Pill>
              <span className="fw-adm-hint">{t('langs.office.written', { percent: model.completeness[locale] })}</span>
              {people && <span className="fw-adm-hint">{t('langs.office.people', { count: people[locale] ?? 0 })}</span>}
            </li>
          ))}
        </ul>
        <p className="fw-adm-hint">
          {t('langs.office.pick')}{' '}
          <Link className="fw-adm-langs-link" href={`${model.prefix}/me`}>
            {t('langs.office.profile')}
          </Link>
        </p>
      </Section>

      <Section id="documents" title={t('langs.documents.title')} intro={t('langs.documents.intro')}>
        {model.companies.problem || model.companies.items === null ? (
          <ListState problem={model.companies.problem} loading={model.companies.items === null} onRetry={actions?.onRetry} rows={2} />
        ) : companies.length === 0 ? (
          <p className="fw-adm-hint">{t('langs.documents.noCompany')}</p>
        ) : (
          <div className="fw-adm-table">
            <SummaryTable
              label={t('langs.documents.label')}
              density="roomy"
              stackOnPhone
              columns={[t('langs.col.company'), t('langs.col.language')]}
              widths={['55%', '45%']}
              align={['left', 'left']}
              rows={companies.map((company) => ({
                id: company.id,
                cells: [
                  <Link key="name" className="fw-adm-name" href={adminHref(model.prefix, `/companies/${company.id}?tab=defaults`)}>
                    {company.legalName}
                  </Link>,
                  model.can.manage ? (
                    <Select
                      key="language"
                      size="sm"
                      aria-label={t('langs.documents.pickFor', { name: company.legalName })}
                      value={draft[company.id] ?? company.locale}
                      onChange={(event) => setDraft((current) => ({ ...current, [company.id]: event.target.value }))}
                    >
                      {LOCALES.map((locale) => (
                        <option key={locale} value={locale}>
                          {LOCALE_NAMES[locale]}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span key="language">{LOCALE_NAMES[company.locale as Locale] ?? company.locale}</span>
                  ),
                ],
              }))}
            />
          </div>
        )}
        {!model.can.manage && companies.length > 0 && <p className="fw-adm-hint">{ta('held.needs', { right: ta('right.companies_manage') })}</p>}
      </Section>

      <Section id="formats" title={t('langs.formats.title')} intro={t('langs.formats.intro')}>
        <div className="fw-adm-langs-formats">
          {LOCALES.map((locale) => (
            <div key={locale} className="fw-adm-langs-format">
              <span className="fw-adm-name">{LOCALE_NAMES[locale]}</span>
              <KeyValue
                dense
                labelCase="sentence"
                items={[
                  { label: t('langs.formats.number'), value: <code className="fw-adm-code">{numberSample(locale)}</code> },
                  { label: t('langs.formats.date'), value: <code className="fw-adm-code">{dateSample(locale)}</code> },
                  { label: t('langs.formats.week'), value: t('langs.formats.monday') },
                ]}
              />
            </div>
          ))}
        </div>
        <p className="fw-adm-hint">
          {t('langs.formats.imports')}{' '}
          <Link className="fw-adm-langs-link" href={adminHref(model.prefix, '/import')}>
            {t('langs.formats.importLink')}
          </Link>
        </p>
      </Section>

      <Section id="time" title={t('langs.time.title')} intro={t('langs.time.intro')}>
        <KeyValue
          columns={3}
          labelCase="sentence"
          items={[
            { label: t('langs.time.stored'), value: t('langs.time.storedValue') },
            { label: t('langs.time.shown'), value: t('langs.time.shownValue') },
            { label: t('langs.time.site'), value: t('langs.time.siteValue') },
          ]}
        />
        {companies.length > 0 && (
          <div className="fw-adm-table">
            <SummaryTable
              label={t('langs.time.label')}
              density="roomy"
              stackOnPhone
              columns={[t('langs.col.where'), t('langs.col.zone')]}
              widths={['60%', '40%']}
              align={['left', 'left']}
              rows={companies.flatMap((company) => [
                {
                  id: company.id,
                  cells: [
                    <Link key="c" className="fw-adm-name" href={adminHref(model.prefix, `/companies/${company.id}?tab=defaults`)}>
                      {company.legalName}
                    </Link>,
                    <code key="z" className="fw-adm-code">
                      {company.timezone}
                    </code>,
                  ],
                },
                ...company.sites
                  .filter((site) => site.status === 'ACTIVE')
                  .map((site) => ({
                    id: site.id,
                    cells: [
                      <Link key="s" className="fw-adm-langs-site" href={adminHref(model.prefix, `/companies/${company.id}/sites/${site.id}`)}>
                        {company.code} › {site.name}
                      </Link>,
                      <code key="z" className="fw-adm-code">
                        {site.timezone}
                      </code>,
                    ],
                  })),
              ])}
            />
          </div>
        )}
        {zonesInUse(companies).length > 1 && <p className="fw-adm-hint">{t('langs.time.several', { count: zonesInUse(companies).length })}</p>}
      </Section>

      {model.workers && (
        <Section id="floor" title={t('langs.floor.title')} intro={t('langs.floor.intro')}>
          {model.workers.problem || model.workers.items === null ? (
            <ListState problem={model.workers.problem} loading={model.workers.items === null} onRetry={actions?.onRetry} rows={2} />
          ) : (
            <ul className="fw-adm-list">
              {FLOOR_LANGUAGES.map((code) => {
                const count = workers?.[code] ?? 0
                const spoken = (LOCALES as readonly string[]).includes(code)
                return (
                  <li key={code} className="fw-adm-langs-row">
                    <span className="fw-adm-name" lang={code}>
                      {FLOOR_ENDONYMS[code]}
                    </span>
                    <span className="fw-adm-hint">{ta(`common.language.${code}`)}</span>
                    <Pill tone={spoken ? 'success' : 'neutral'}>{t(spoken ? 'langs.floor.screens' : 'langs.floor.notYet')}</Pill>
                    <span className="fw-adm-hint">{t('langs.floor.workers', { count })}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      )}

      <p className="fw-adm-hint">{t('langs.later')}</p>

      {changes.length > 0 && (
        <EditModeBar
          count={changes.length}
          message={ta('form.unsaved', { count: changes.length })}
          applyLabel={ta('common.save')}
          busy={model.busy}
          saveShortcut
          onDiscard={() => setDraft({})}
          onApply={() => void actions?.onSave?.(changes)}
        />
      )}
    </form>
  )
}
