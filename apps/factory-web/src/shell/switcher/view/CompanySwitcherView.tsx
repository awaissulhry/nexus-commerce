'use client'

import { useEffect, useState, type MouseEvent } from 'react'
import { Building2, ChevronDown, Search } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { useT } from '../../../lib/i18n/provider'
import { needsCompanySearch } from '../../scope/switcher-search'
import { CompanyFinder } from '../../scope/view/CompanyFinder'
import { companySwitchHref, currentCompany, currentSite, type SwitcherState } from '../switcher-model'
import '../switcher.css'

/**
 * SCR-002 — the company and site switcher in the top bar: ONE DS Menu (as Commerce's business switcher). Companies are
 * links (a company is part of the address: ⌘-click opens it in a new tab); sites are on/off items (the site is a
 * remembered narrowing, not an address). The trigger names both, so the person always sees where they work.
 */

export type CompanySwitcherViewModel = SwitcherState

export interface CompanySwitcherViewProps {
  model: CompanySwitcherViewModel
  /** A company link was followed (the live shell keeps plain clicks in the app). */
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void
  /** A site was chosen; null = all sites. */
  onSiteChange?: (site: string | null) => void
}

export function CompanySwitcherView({ model, onNavigate, onSiteChange }: CompanySwitcherViewProps) {
  const t = useT('shell')
  const [open, setOpen] = useState(false)
  const [finder, setFinder] = useState(false)
  // Opened after the first paint: the DS Menu draws its list into <body>, which a server render does not have.
  useEffect(() => setOpen(model.open ?? false), [model.open])
  useEffect(() => setFinder(model.finderQuery !== undefined), [model.finderQuery])
  const company = currentCompany(model)
  const site = currentSite(model)
  const companyName = company?.name ?? t('switcher.noCompany')
  // B-W2b-05: a person whose roles reach only some sites chooses among THEIR sites ("All my sites").
  const allSitesWord = t(model.limited ? 'switcher.allMySites' : 'switcher.allSites')
  const siteName = site?.name ?? allSitesWord
  // B-W2b-05 (design: "search when more than 7"): past 7 companies the menu shows the current one and the finder.
  const many = needsCompanySearch(model.companies)
  const listed = many ? model.companies.filter((option) => option.code === model.company) : model.companies

  const items: MenuItemDef[] = [
    { id: 'heading-companies', heading: true, label: t('switcher.companies') },
    ...listed.map((option) => ({
      id: `company:${option.code}`,
      label: option.name,
      description: option.code,
      href: companySwitchHref(option.code, model.path),
    })),
    ...(many
      ? [{ id: 'company:find', label: t('switcher.findCompany', { count: model.companies.length }), icon: <Search size={14} aria-hidden />, onSelect: () => setFinder(true) }]
      : []),
  ]
  // One site is the site the person works in: the trigger names it, there is nothing to choose here.
  if (model.sites.length > 1) {
    items.push(
      { id: 'sep-sites', separator: true },
      { id: 'heading-sites', heading: true, label: t('switcher.sites') },
      { id: 'site:all', label: allSitesWord, checked: model.site === null, onSelect: () => onSiteChange?.(null) },
      ...model.sites.map((option) => ({ id: `site:${option.id}`, label: option.name, checked: model.site === option.id, onSelect: () => onSiteChange?.(option.id) })),
    )
  }

  return (
    <>
      <Menu
        className="fw-switcher"
        label={
          <>
            <Building2 size={15} aria-hidden />
            <span className="fw-switcher-name">{companyName}</span>
            {model.sites.length > 0 && <span className="fw-switcher-site">{siteName}</span>}
            <ChevronDown size={14} aria-hidden />
          </>
        }
        items={items}
        open={open}
        onOpenChange={setOpen}
        selectedId={company ? `company:${company.code}` : undefined}
        onNavigate={(event, item) => item.href && onNavigate?.(event, item.href)}
        triggerProps={{ 'aria-label': t('switcher.label', { company: companyName, site: siteName }) }}
      />
      {many && (
        <CompanyFinder
          open={finder}
          companies={model.companies}
          current={model.company}
          hrefOf={(code) => companySwitchHref(code, model.path)}
          onClose={() => setFinder(false)}
          onNavigate={onNavigate}
          query={model.finderQuery}
        />
      )}
    </>
  )
}
