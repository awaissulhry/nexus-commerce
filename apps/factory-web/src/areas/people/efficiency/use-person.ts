'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { openPersonFigures, peopleOfSite, type OpenReason, type PersonChoice, type PersonFigures } from './api'
import { efficiencyProblem, EMPTY_PERSON, type EfficiencyProblem, type PersonDraft } from './model'

export type PeopleRead = { status: 'loading' } | { status: 'noRegister' } | { status: 'ready'; people: readonly PersonChoice[] } | { status: 'error'; problem: EfficiencyProblem }

export interface PersonDialogState {
  people: PeopleRead
  draft: PersonDraft
  busy: boolean
  problem: EfficiencyProblem | null
  /** One person's figures: HERE ONLY, gone when the dialog closes or the site changes. */
  figures: PersonFigures | null
}

export interface PersonDialogActions {
  onOpen: () => void
  onClose: () => void
  onDraft: (change: Partial<PersonDraft>) => void
  onShow: () => void
  onBack: () => void
}

/**
 * One person's figures (design people.efficiency pop:individual; Owner answer H3: the worker and HR; Statuto dei Lavoratori
 * art. 4 c.1). The container offers the dialog only when the API says `individual.available`, so no person is looked up
 * behind a closed gate. The figures stay in this state: nothing writes them to the address, a store, a print or a file;
 * closing the dialog forgets them. Each "Show figures" is one opening with its own key, recorded by the API: a refused
 * answer re-reads the page, because the gate may just have closed.
 */
export function usePersonDialog(api: ApiClient, siteId: string | null, range: { from: string | null; to: string | null }, register: boolean, onRefused: () => void) {
  const [state, setState] = useState<PersonDialogState | null>(null)

  useEffect(() => setState(null), [siteId])

  const show = useCallback(async () => {
    const current = state
    if (!current || !siteId || !current.draft.personId || !current.draft.reason) return
    setState({ ...current, busy: true, problem: null })
    try {
      const figures = await openPersonFigures(api, current.draft.personId, { siteId, from: range.from, to: range.to, reason: current.draft.reason as OpenReason, note: current.draft.note.trim() || null })
      setState((now) => now && { ...now, busy: false, figures })
    } catch (error) {
      setState((now) => now && { ...now, busy: false, problem: efficiencyProblem(error) })
      onRefused()
    }
  }, [api, onRefused, range.from, range.to, siteId, state])

  const actions = useMemo<PersonDialogActions>(
    () => ({
      onOpen: () => {
        if (!siteId) return
        if (!register) return setState({ people: { status: 'noRegister' }, draft: EMPTY_PERSON, busy: false, problem: null, figures: null })
        setState({ people: { status: 'loading' }, draft: EMPTY_PERSON, busy: false, problem: null, figures: null })
        peopleOfSite(api, siteId)
          .then((people) => setState((now) => now && { ...now, people: { status: 'ready', people } }))
          .catch((error: unknown) => setState((now) => now && { ...now, people: { status: 'error', problem: efficiencyProblem(error) } }))
      },
      onClose: () => setState(null),
      onDraft: (change) => setState((now) => now && { ...now, draft: { ...now.draft, ...change }, problem: null }),
      onShow: () => void show(),
      onBack: () => setState((now) => now && { ...now, figures: null, draft: { ...now.draft, reason: '', note: '' } }),
    }),
    [api, register, show, siteId],
  )

  return { state, actions }
}
