'use client'
import { useEffect, useRef, useState } from 'react'
import { Banner, Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { pendingProfileChanges } from '@/lib/workspaces/unsaved-changes'
const afterRender = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
export function ProfileNavigationGuard() {
  const [href, setHref] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  useEffect(() => {
    const handle = (event: Event) => { if (!inFlight.current) { setHref((event as CustomEvent<{ href: string }>).detail.href); setError(null) } }
    window.addEventListener('nexus:profile-navigation', handle)
    return () => window.removeEventListener('nexus:profile-navigation', handle)
  }, [])
  async function proceed(save: boolean) {
    if (inFlight.current || !href) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      for (const form of pendingProfileChanges()) { if (save) await form.save(); else form.discard() }
      await afterRender()
      if (pendingProfileChanges().length) throw new Error('Some changes still need attention. Finish saving them before switching profiles.')
      window.location.assign(href)
    } catch (err) { setError(err instanceof Error ? err.message : 'Your changes could not be saved.'); setBusy(false); inFlight.current = false }
  }
  const canDiscard = pendingProfileChanges().every(form => form.canDiscard?.() !== false)
  return <Modal open={href !== null} onClose={() => { if (!busy) setHref(null) }} title="Save changes before switching?" subtitle="Your changes belong to the current business profile." footer={<><Button disabled={busy} onClick={() => setHref(null)}>Stay here</Button><Button disabled={busy || !canDiscard} onClick={() => { void proceed(false) }}>Discard and switch</Button><Button variant="primary" disabled={busy} onClick={() => { void proceed(true) }}>{busy ? 'Finishing…' : 'Save and switch'}</Button></>}>
    {error ? <Banner tone="danger">{error}</Banner> : <p>Save your changes or discard them before opening another profile.</p>}
  </Modal>
}
