'use client'

import { useEffect, useState, type MouseEvent } from 'react'
import { Building2, ChevronDown } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { useT } from '../../../lib/i18n/provider'
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
  // Opened after the first paint: the DS Menu draws its list into <body>, which a server render does not have.
  useEffect(() => setOpen(model.open ?? false), [model.open])
  const company = currentCompany(model)
  const site = currentSite(model)
  const companyName = company?.name ?? t('switcher.noCompany')
  const siteName = site?.name ?? t('switcher.allSites')

  const items: MenuItemDef[] = [
    { id: 'heading-companies', heading: true, label: t('switcher.companies') },
    ...model.companies.map((option) => ({
      id: `company:${option.code}`,
      label: option.name,
      description: option.code,
      href: companySwitchHref(option.code, model.path),
    })),
  ]
  if (model.sites.length > 0) {
    items.push(
      { id: 'sep-sites', separator: true },
      { id: 'heading-sites', heading: true, label: t('switcher.sites') },
      { id: 'site:all', label: t('switcher.allSites'), checked: model.site === null, onSelect: () => onSiteChange?.(null) },
      ...model.sites.map((option) => ({ id: `site:${option.id}`, label: option.name, checked: model.site === option.id, onSelect: () => onSiteChange?.(option.id) })),
    )
  }

  return (
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
  )
}
