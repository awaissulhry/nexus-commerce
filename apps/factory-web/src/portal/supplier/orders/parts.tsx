'use client'

import { useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { usePortalFrame, usePortalLive } from '../../shell/frame'
import { WithMessages } from '../../../record-panels/i18n'
import { NS } from './model'
import { useOrderWords } from './words'

/**
 * Small parts the supplier pages share (B-W2b-179): whether the page is offline (the browser's own state or the portal's
 * live channel), a file saved from the page, and the "not part of your access" panel of a typed or old address (design
 * noPermission: "This page is not part of your access" with the name of their own admin to ask).
 */

/** The person may answer an order (the capability `portal.approve`); unknown until My access is read: not held then. */
export function mayApprove(frame: Pick<ReturnType<typeof usePortalFrame>, 'me' | 'access'>): boolean {
  if (frame.me.permissions.includes('portal.approve')) return true
  return frame.access ? frame.access.capabilities.includes('portal.approve') : true
}

/** No connection: the browser says so, or the tab's one live channel lost its stream. */
export function useOffline(): boolean {
  const live = usePortalLive({})
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return !online || live === 'offline'
}

/** Saves text as a file (the CSV of a view): built in the browser, nothing sent anywhere. */
export function saveText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function NotInAccess({ admins, homeHref }: { admins: readonly string[]; homeHref: string }) {
  const { t } = useOrderWords()
  return (
    <div className="fw-pso-record">
      <EmptyState
        icon={<Lock size={24} aria-hidden />}
        title={t('noAccess.title')}
        description={admins.length > 0 ? t('noAccess.ask', { names: admins.join(', ') }) : t('noAccess.askAdmin')}
        action={
          <Button asChild>
            <a href={homeHref}>{t('noAccess.home')}</a>
          </Button>
        }
      />
    </div>
  )
}

/** The frame's admins and Home, for the panel above (with its own words: a route may draw it outside the pages). */
export function NotInAccessHere() {
  const frame = usePortalFrame()
  return (
    <WithMessages namespaces={[NS]}>
      <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />
    </WithMessages>
  )
}
