'use client'

import { Checkbox, RadioCard } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { EVERYWHERE, type ScopeChoice, type ScopeOption } from '../model'

export { EVERYWHERE, scopeReady, scopeWords, type ScopeChoice, type ScopeOption } from '../model'

/**
 * ScopePicker — the design's new DS part (02 "New DS parts": choose where a role applies, All companies or companies ›
 * sites), built here from DS RadioCard and Checkbox until the DS adds it (DS gap). Sites are optional per company:
 * none ticked means every site of that company.
 */
export function ScopePicker({ value, companies, onChange, name }: { value: ScopeChoice; companies: readonly ScopeOption[]; onChange: (next: ScopeChoice) => void; name: string }) {
  const t = useT('admin')
  const toggleCompany = (id: string, on: boolean) => {
    const companyIds = on ? [...value.companyIds, id] : value.companyIds.filter((item) => item !== id)
    const gone = new Set(companies.find((company) => company.id === id)?.sites.map((site) => site.id) ?? [])
    onChange({ allCompanies: false, companyIds, siteIds: on ? value.siteIds : value.siteIds.filter((site) => !gone.has(site)) })
  }
  const toggleSite = (id: string, on: boolean) => onChange({ ...value, siteIds: on ? [...value.siteIds, id] : value.siteIds.filter((item) => item !== id) })
  return (
    <div className="fw-adm-scope" role="group" aria-label={t('scope.label')}>
      <RadioCard name={name} variant="row" title={t('scope.all')} description={t('scope.allHint')} selected={value.allCompanies} checked={value.allCompanies} onChange={() => onChange(EVERYWHERE)} />
      <RadioCard
        name={name}
        variant="row"
        title={t('scope.some')}
        description={t('scope.someHint')}
        selected={!value.allCompanies}
        checked={!value.allCompanies}
        onChange={() => onChange({ allCompanies: false, companyIds: value.companyIds, siteIds: value.siteIds })}
      />
      {!value.allCompanies && (
        <ul className="fw-adm-scope-list">
          {companies.map((company) => {
            const on = value.companyIds.includes(company.id)
            return (
              <li key={company.id}>
                <Checkbox checked={on} onChange={(event) => toggleCompany(company.id, event.target.checked)} label={company.name} />
                {on && company.sites.length > 0 && (
                  <ul className="fw-adm-scope-sites" aria-label={t('scope.sitesOf', { company: company.name })}>
                    {company.sites.map((site) => (
                      <li key={site.id}>
                        <Checkbox checked={value.siteIds.includes(site.id)} onChange={(event) => toggleSite(site.id, event.target.checked)} label={site.name} />
                      </li>
                    ))}
                    <li className="fw-adm-hint">{t('scope.sitesHint')}</li>
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
