'use client'

import { MapPin } from 'lucide-react'
import { Tag } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import { scopeChip, type OfficeScope } from '../scope-model'
import '../scope.css'

/**
 * B-W2b-05 (PLT-008): what a list says about the top bar's site in its filter row — "North plant" or "All sites" (with
 * "All sites" the list also has a Site column), followed by "Site from the top bar": it is not a filter of the list's
 * own, it is changed in the top bar. Nothing when the company has one site or none.
 */
export function ScopeSiteChip({ model }: { model: OfficeScope }) {
  const t = useT('shell')
  const chip = scopeChip(model)
  if (!chip) return null
  const text = chip.kind === 'site' ? chip.name : t(chip.limited ? 'scope.chip.allMySites' : 'scope.chip.allSites')
  return (
    <span className="fw-scope-chip">
      <Tag tone="info" truncate title={text}>
        <MapPin size={12} aria-hidden /> {text}
      </Tag>
      <span className="fw-scope-chip-note">{t('scope.fromTopBar')}</span>
    </span>
  )
}
