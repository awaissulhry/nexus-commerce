'use client'

import { Plus } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { withRequestsAddress } from '../model'
import { DepthMessages } from './RequestsView'

/**
 * The page head's primary "New data request" (design admin.privacy h.act, W2b): opens Data requests with its form (`?view=
 * requests&new=1`), from whichever list is open. The page mounts it only with privacy.requests.manage (never a dead button).
 */
export function NewRequestButton() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  return <NewRequestButtonView onClick={() => router.replace(`${pathname}?${withRequestsAddress(params?.toString() ?? '', { creating: true, request: null })}`, { scroll: false })} />
}

export function NewRequestButtonView({ onClick }: { onClick?: () => void }) {
  return (
    <DepthMessages>
      <Label onClick={onClick} />
    </DepthMessages>
  )
}

function Label({ onClick }: { onClick?: () => void }) {
  const t = useT('admin-privacy-depth')
  return (
    <Button size="sm" variant="primary" onClick={onClick}>
      <Plus size={14} aria-hidden /> {t('dp.req.new')}
    </Button>
  )
}
