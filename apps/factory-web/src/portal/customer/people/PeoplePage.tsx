'use client'

import { useEffect, useState } from 'react'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { usePortalBand, usePortalFrame } from '../../shell/frame'
import { usePortalPeople } from '../../shared/account/usePortalPeople'
import { fetchFactoryPeople, type FactoryPeople } from './api'
import { factoryRowsOf } from './model'
import { PeopleView, type PeopleViewModel } from './view/PeopleView'

/**
 * The live Your people page (owb-po4.3): the colleagues and every admin act are the shared account work (usePortalPeople, the team
 * only: no e-mail settings, no sessions here); the factory's people for the brand come from their own read, drawn only when it
 * answers. The band: Your people, Invite a colleague (the admin's; held for others with who can), ⋯ Ask a question.
 */
export function PeoplePage() {
  const frame = usePortalFrame()
  const t = useT('portal-account')
  const locale = useLocale()
  const [receipt, setReceipt] = useState<PeopleViewModel['receipt']>(null)
  const people = usePortalPeople({ onReceipt: setReceipt, unsavedId: 'people-emails', parts: 'team' })

  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [])

  // The factory's people: no answer (not built yet, refused, failed) = no card, never an empty one.
  const [factory, setFactory] = useState<FactoryPeople | null>(null)
  useEffect(() => {
    const control = new AbortController()
    fetchFactoryPeople(frame.api, control.signal).then(setFactory, () => setFactory(null))
    return () => control.abort()
  }, [frame.api])

  usePortalBand({
    title: t('people.title'),
    actions: [{ id: 'invite', label: t('users.invite'), variant: 'primary', onClick: people.openInvite, heldReason: people.inviteHeld }],
  })

  return (
    <PeopleView
      model={{ slow, colleagues: people.colleagues, inviteHeld: people.inviteHeld, factory: factoryRowsOf(factory, locale), receipt, dialog: people.dialog }}
      actions={{ colleagues: people.colleaguesActions, dialogs: people.dialogActions, onHideReceipt: () => setReceipt(null) }}
    />
  )
}
