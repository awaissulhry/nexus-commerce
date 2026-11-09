'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import type { ClaimActions } from '../model'

/**
 * "Scan the label" (design sec:item "serial: scan the label (camera) or type"; "Scan fills the serial"): the rear camera in
 * a sheet reads the label's code and fills the serial field, then closes. The DS ScanInput is the floor's always-listening
 * scan field (no keyboard, focus kept): a form field on a phone needs the camera alone, so this sheet composes it over the
 * same `CameraScanner` (named in the step's notes). No camera, or none allowed: it says so; typing the serial still works.
 */
export function ScanDialog({ actions }: { actions?: ClaimActions }) {
  const t = useT('link-claim')
  const video = useRef<HTMLVideoElement>(null)
  const latest = useRef(actions)
  latest.current = actions
  const scanner = actions?.scanner ?? null
  const [state, setState] = useState<'starting' | 'on' | 'failed' | 'none'>(scanner ? 'starting' : 'none')

  useEffect(() => {
    const element = video.current
    if (!scanner || !element) return
    let stop: (() => void) | null = null
    let done = false
    scanner
      .start(element, (code) => {
        if (done || code.trim() === '') return
        done = true
        stop?.()
        latest.current?.onScanned?.(code)
      })
      .then((stopper) => {
        if (done) stopper()
        else {
          stop = stopper
          setState('on')
        }
      })
      .catch(() => {
        if (!done) setState('failed')
      })
    return () => {
      done = true
      stop?.()
    }
  }, [scanner])

  const close = () => actions?.onScanClose?.()
  return (
    <Modal open sheet size="md" onClose={close} title={t('scan.title')} footer={<Button onClick={close}>{t('scan.cancel')}</Button>}>
      <div className="fw-cl-stack">
        <p className="fw-cl-hint">{t('scan.intro')}</p>
        {scanner && (
          <div className="fw-cl-video" data-state={state}>
            <video ref={video} muted playsInline aria-label={t('scan.video')} />
          </div>
        )}
        <p className="fw-cl-hint" role="status">
          {state === 'starting' && <Spinner size={14} />} {t(`scan.state.${state}`)}
        </p>
      </div>
    </Modal>
  )
}
