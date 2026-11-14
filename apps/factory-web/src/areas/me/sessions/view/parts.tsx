'use client'

import { useEffect, useState } from 'react'
import { Monitor, Smartphone } from 'lucide-react'
import { Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import type { LiveSession } from '../api'
import { deviceWords } from '../model'

const HANDHELD: ReadonlySet<string> = new Set(['IPHONE', 'ANDROID_PHONE', 'IPAD', 'ANDROID_TABLET'])

/** A session's device and browser, with "This browser" and the surface when it is not the office (words `admin-security-depth`). */
export function DeviceCell({ session }: { session: LiveSession }) {
  const t = useT('admin-security-depth')
  const Icon = session.deviceKind && HANDHELD.has(session.deviceKind) ? Smartphone : Monitor
  return (
    <span className="fw-ses-device">
      <Icon size={15} aria-hidden />
      <span className="fw-ses-device-text">
        <span>{deviceWords(session, t)}</span>
        {session.current && <Tag tone="info">{t('session.thisBrowser')}</Tag>}
        {session.surface !== 'OFFICE' && <Tag>{t(`session.surface.${session.surface}`)}</Tag>}
      </span>
    </span>
  )
}

/** A sessions section's own skeleton; "Still loading…" after about a second. */
export function SessionsLoading() {
  const t = useT('admin-security-depth')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-ses-stack" aria-busy="true">
      {slow && (
        <p className="fw-ses-hint" role="status">
          {t('session.stillLoading')}
        </p>
      )}
      <Skeleton height={20} />
      <Skeleton height={20} />
      <Skeleton height={20} />
    </div>
  )
}
