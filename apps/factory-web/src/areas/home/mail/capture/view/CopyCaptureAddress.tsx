'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, Copy } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { captureSetupHref, copyHeld, type CaptureState } from '../model'
import '../capture.css'

/**
 * Home › Mail's "Copy capture address" (design home.mail page head; COL-021): one press copies the company's capture address
 * (`c-…@<the receiving domain>`) and says so; held with its reason while it is read or while there is none, with a link to
 * set it up in Admin › Connections for whoever may.
 */
export function CopyCaptureAddress({ state, prefix }: { state: CaptureState; prefix: string }) {
  return (
    <WithMessages namespaces={['mail-depth']}>
      <Inner state={state} prefix={prefix} />
    </WithMessages>
  )
}

function Inner({ state, prefix }: { state: CaptureState; prefix: string }) {
  const t = useT('mail-depth')
  const [said, setSaid] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const held = copyHeld(state)
  const address = state.status === 'ready' ? state.address : null
  const copy = async () => {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setSaid('copied')
    } catch {
      setSaid('failed')
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaid(null), 4000)
  }
  return (
    <span className="fw-cap">
      <Button size="sm" heldReason={held ? t(held) : null} onClick={() => void copy()} title={address ?? undefined}>
        {said === 'copied' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {said === 'copied' ? t('capture.copied') : t('capture.copy')}
      </Button>
      {state.status === 'ready' && !address && state.mayManage && (
        <Link className="fw-cap-link" href={captureSetupHref(prefix)}>
          {t('capture.setUp')}
        </Link>
      )}
      <span className="nds-vh" role="status" aria-live="polite">
        {said === 'copied' && address ? t('capture.copiedSaid', { address }) : said === 'failed' ? t('capture.copyFailed') : ''}
      </span>
    </span>
  )
}
