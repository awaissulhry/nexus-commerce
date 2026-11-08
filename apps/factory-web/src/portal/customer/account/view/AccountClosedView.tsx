'use client'

import { Lock } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'

/** SCR-188 for a person whose portal or role does not open the Account page: why, who can, and the way Home. */
export interface AccountClosedModel {
  homeHref: string
  admins: readonly string[]
}

export function AccountClosedView({ model }: { model: AccountClosedModel }) {
  const t = useT('portal-account')
  return (
    <EmptyState
      icon={<Lock size={22} aria-hidden />}
      title={t('closed.title')}
      description={model.admins.length > 0 ? t('closed.askAdmin', { names: model.admins.join(', ') }) : t('closed.askUs')}
      action={
        <Button size="sm" asChild>
          <a href={model.homeHref}>{t('closed.home')}</a>
        </Button>
      }
    />
  )
}
