'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { checkTypedNumber, previewNumber, type DocumentKind, type OverrideCode } from './api'
import { emptyDraft, mayOverride, overrideHeld, typedOf, wellFormed, type NumberFieldActions, type NumberFieldModel, type OverrideDraft, type PreviewRead } from './model'

/** How long the popup waits after the last key before it asks whether the number clashes. */
export const CHECK_AFTER_MS = 300

/**
 * The container side of a create dialog's number (B-W2b-24; PLT-125): reads the preview for the company and kind, keeps
 * the popup's draft and asks the API about the typed number as the person types (one answer at a time: a later key wins),
 * and gives the host the typed number to send with the document (`typed`), or null for the series' next one.
 */
export function useNumberField(api: ApiClient, input: { readonly kind: DocumentKind; readonly companyId: string | null; readonly mayType: boolean; readonly open: boolean }) {
  const { kind, companyId, mayType, open } = input
  const [preview, setPreview] = useState<PreviewRead>({ state: 'loading' })
  const [typed, setTyped] = useState<NumberFieldModel['typed']>(null)
  const [dialog, setDialog] = useState<OverrideDraft | null>(null)
  const asked = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open || !companyId) return
    let live = true
    setPreview({ state: 'loading' })
    previewNumber(api, { companyId, kind })
      .then((value) => live && setPreview({ state: 'ready', value }))
      .catch(() => live && setPreview({ state: 'failed' }))
    return () => {
      live = false
    }
  }, [api, companyId, kind, open])

  useEffect(() => {
    if (!open) {
      setTyped(null)
      setDialog(null)
    }
  }, [open])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const check = useCallback(
    (number: string) => {
      if (timer.current) clearTimeout(timer.current)
      const id = ++asked.current
      if (!companyId || !wellFormed(number)) return
      timer.current = setTimeout(() => {
        setDialog((current) => (current ? { ...current, check: 'checking', refusal: null } : current))
        checkTypedNumber(api, { companyId, kind, number: typedOf(number) })
          .then((answer) => {
            if (id !== asked.current) return
            setDialog((current) => (current ? { ...current, check: answer.ok ? 'ok' : 'refused', refusal: answer.refusal?.code ?? null } : current))
          })
          .catch(() => id === asked.current && setDialog((current) => (current ? { ...current, check: 'failed', refusal: null } : current)))
      }, CHECK_AFTER_MS)
    },
    [api, companyId, kind],
  )

  const actions: NumberFieldActions = {
    onOpen: () => {
      const draft = emptyDraft(kind, typed)
      setDialog(draft)
      if (draft.number) check(draft.number)
    },
    onClose: () => setDialog(null),
    onNumber: (text) => {
      setDialog((current) => (current ? { ...current, number: text, check: 'idle', refusal: null } : current))
      check(text)
    },
    onReason: (text) => setDialog((current) => (current ? { ...current, reason: text } : current)),
    onUse: () => {
      if (!dialog || overrideHeld(dialog)) return
      setTyped({ number: typedOf(dialog.number), reason: dialog.reason.trim() })
      setDialog(null)
    },
    onClear: () => setTyped(null),
  }

  /** A create refused for the typed number: the popup opens again on it, saying why. */
  const refused = useCallback(
    (code: OverrideCode) => {
      setDialog({ ...emptyDraft(kind, typed), check: 'refused', refusal: code })
    },
    [kind, typed],
  )

  const model: NumberFieldModel = { kind, preview, canOverride: mayOverride(kind, mayType), typed, dialog }
  return { model, actions, typed, refused }
}
