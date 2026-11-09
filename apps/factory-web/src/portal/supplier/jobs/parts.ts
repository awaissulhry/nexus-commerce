'use client'

import { useMemo } from 'react'
import { dayIn } from '../../../lib/po-answer/quantities'
import { usePortalFrame } from '../../shell/frame'

/**
 * Small hooks of the Jobs pages (B-W2b-181): the person's capabilities as the API checks them (B-W2b-162: accept, decline
 * and the kit check take `portal.approve`, reports and send-backs `portal.comment`, a photo `portal.upload`) — known once
 * the frame read My access; until then not held (the API refuses in words anyway) —, and today in Europe/Rome.
 */
export function usePortalCapabilities(): { approve: boolean; comment: boolean; upload: boolean } {
  const frame = usePortalFrame()
  return useMemo(() => {
    const has = (capability: string) => frame.me.permissions.includes(capability) || (frame.access ? frame.access.capabilities.includes(capability) : true)
    return { approve: has('portal.approve'), comment: has('portal.comment'), upload: has('portal.upload') }
  }, [frame.me.permissions, frame.access])
}

/** Today's calendar day where the factory works (Europe/Rome). */
export function useToday(): string {
  return useMemo(() => dayIn(new Date()), [])
}
