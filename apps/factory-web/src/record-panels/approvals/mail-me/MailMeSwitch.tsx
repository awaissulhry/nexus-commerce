'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { readMailMe, setMailMe } from './api'
import { MailMeView, type MailMeViewModel } from './view/MailMeView'

/**
 * The PLT-089 switch as a page mounts it (Home › Approvals): reads the person's own setting, turns it on or off
 * (`PUT /approvals/mail-me`, an idempotent write), and says when the last mail went.
 */
export function MailMeSwitch({ api }: { api: ApiClient }) {
  const [model, setModel] = useState<MailMeViewModel>({ read: 'loading', on: false, since: null, lastSentAt: null, busy: false, problem: null })

  const load = useCallback(async () => {
    setModel((current) => ({ ...current, read: 'loading' }))
    try {
      const read = await readMailMe(api)
      setModel((current) => ({ ...current, read: 'ready', on: read.on, since: read.since, lastSentAt: read.lastSentAt, problem: null }))
    } catch {
      setModel((current) => ({ ...current, read: 'failed' }))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <MailMeView
      model={model}
      onRetry={() => void load()}
      onToggle={(on) => {
        setModel((current) => ({ ...current, busy: true, problem: null }))
        setMailMe(api, on)
          .then((read) => setModel((current) => ({ ...current, busy: false, on: read.on, since: read.since, lastSentAt: read.lastSentAt })))
          .catch(() => setModel((current) => ({ ...current, busy: false, problem: 'mailMe.refused' })))
      }}
    />
  )
}
