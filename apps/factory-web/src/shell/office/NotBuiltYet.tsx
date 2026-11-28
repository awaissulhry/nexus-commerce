'use client'

import { Construction } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { useT } from '../../lib/i18n/provider'

/**
 * owb- (order workflow, base settle 7): what a DECLARED office page shows until its session builds it — a route stub that
 * holds its address (shell/nav/office-nav.ts DECLARED_PAGES), its nav row and its place in the approved tree. No row leads
 * here (the row shows only once the address joins OFFICE_PAGES); a typed address lands on this calm state, never a 404.
 */
export function NotBuiltYet() {
  const t = useT('shell')
  return <EmptyState icon={<Construction size={28} aria-hidden />} title={t('unavailable.notBuilt.title')} description={t('unavailable.notBuilt.body')} />
}
