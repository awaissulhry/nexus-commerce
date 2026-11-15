'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { recipientLanguage } from './api'
import { preselected, type SendLanguageCode, type SendLanguageModel } from './model'

/**
 * The send panel's language for a host (B-W2b-432): while the dialog is open (`input` not null) it reads the contact's
 * language once per party and contact (`GET /templates/language`, only with parties.view: `mayRead`), preselects it, and
 * keeps the person's own pick after that. The host re-renders its preview with `model.picked` and holds Send with
 * `languageHeld(model)`.
 */
export function useSendLanguage(api: ApiClient, input: { partyId: string; contactId: string | null; documentLanguage: SendLanguageCode; mayRead: boolean; fix?: SendLanguageModel['fix'] } | null): { model: SendLanguageModel | null; pick: (language: SendLanguageCode) => void } {
  const [state, setState] = useState<Omit<SendLanguageModel, 'documentLanguage' | 'fix'> & { key: string } | null>(null)
  const key = input ? `${input.partyId}|${input.contactId ?? ''}` : null
  const documentLanguage = input?.documentLanguage ?? 'it'
  const mayRead = input?.mayRead ?? false

  useEffect(() => {
    if (!key || !input) {
      setState(null)
      return
    }
    if (!mayRead) {
      setState({ key, picked: documentLanguage, recipient: null, status: 'none' })
      return
    }
    const controller = new AbortController()
    setState({ key, picked: documentLanguage, recipient: null, status: 'loading' })
    recipientLanguage(api, { partyId: input.partyId, contactId: input.contactId }, controller.signal).then(
      (answer) => setState((now) => (now && now.key === key ? { key, picked: now.status === 'loading' && now.picked === documentLanguage ? preselected(answer, documentLanguage) : now.picked, recipient: { language: answer.language, source: answer.source, notOffered: answer.notOffered }, status: 'ready' } : now)),
      () => !controller.signal.aborted && setState((now) => (now && now.key === key ? { ...now, status: 'failed' } : now)),
    )
    return () => controller.abort()
    // The read follows the party and contact (and the right), not the input object's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, mayRead])

  const pick = useCallback((language: SendLanguageCode) => setState((now) => (now ? { ...now, picked: language } : now)), [])
  const model: SendLanguageModel | null = state && input ? { picked: state.picked, recipient: state.recipient, status: state.status, documentLanguage, fix: input.fix ?? null } : null
  return { model, pick }
}
