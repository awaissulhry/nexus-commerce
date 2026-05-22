// L-RT.4 — cross-tab wizard.submitted toast.
//
// The list-wizard fires wizard.submitted exactly once per submission
// (DR-C.3 — server-side emit on the DRAFT → SUBMITTED/LIVE/FAILED
// transition, mirrored by Step9Submit's BroadcastChannel broadcast
// to same-browser tabs). Other workspaces already feed it into their
// invalidationTypes for grid refresh, but nothing surfaces the
// terminal status to an operator who's on /listings while a colleague
// (or themselves in a closed-source-tab scenario) submits a wizard.
//
// This component subscribes to lastEvent from useListingEvents and
// toasts a one-shot when wizard.submitted arrives:
//   LIVE      → success toast ("✓ Listing live on channel")
//   SUBMITTED → info toast    ("Listing submitted, awaiting channel ack")
//   FAILED    → error toast   ("⚠ Listing submission failed — open /products/drafts")
//
// Deduped by wizardId+ts so a re-render or StrictMode double-invoke
// doesn't double-toast. 100-entry rolling set bounds memory.

'use client'

import { useEffect, useRef } from 'react'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'

export function WizardActivityToast() {
  const { lastEvent } = useListingEvents()
  const { toast } = useToast()
  const { t } = useTranslations()
  const toastedKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!lastEvent) return
    if (lastEvent.type !== 'wizard.submitted') return
    const wizardId = lastEvent.wizardId
    if (!wizardId) return
    const dedupKey = `${wizardId}:${lastEvent.ts ?? 0}`
    if (toastedKeysRef.current.has(dedupKey)) return
    toastedKeysRef.current.add(dedupKey)
    if (toastedKeysRef.current.size > 100) {
      const first = toastedKeysRef.current.values().next().value
      if (first) toastedKeysRef.current.delete(first)
    }
    const status = lastEvent.status
    if (status === 'LIVE') {
      toast.success(t('listings.wizard.toast.live'))
    } else if (status === 'SUBMITTED') {
      toast.info(t('listings.wizard.toast.submitted'))
    } else if (status === 'FAILED') {
      toast.error(t('listings.wizard.toast.failed'))
    }
  }, [lastEvent, toast, t])

  // No render — pure side-effect component.
  return null
}
