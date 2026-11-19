'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { partnerProblem } from '../../../../admin/users/partners/model'
import { readDesignerChoices, readFactoryDesigner, setFactoryDesigner } from './api'
import { applyHeldOf, designerDraftOf, designerRefusalOf, type DesignerActions, type DesignerDialog, type DesignerModel, type DesignerRead } from './model'

/**
 * F-CP-155 (customer page plan C7, D12; the API's B-CP-078) — the container of the factory designer rows: one read of the slot
 * (partners.view), the pick list read when Change… opens (partners.manage over every company of the customer), Apply with the stored
 * version (one Idempotency-Key per window; no step-up: a name, no money, no access), a refusal at its field, a 409 reads again.
 * No live event exists for a slot change (B-CP-078: nothing listens), so the card reads it again after its own Apply.
 */
export function useFactoryDesigner(input: { readonly api: ApiClient; readonly partyId: string; readonly enabled: boolean; readonly manage: boolean }): { model: DesignerModel | null; actions: DesignerActions } {
  const { api, partyId, enabled, manage } = input
  const [read, setRead] = useState<DesignerRead>({ status: 'loading' })
  const [dialog, setDialog] = useState<DesignerDialog | null>(null)
  const [notice, setNotice] = useState<DesignerModel['notice']>(null)
  const key = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      setRead({ status: 'ready', slot: await readFactoryDesigner(api, partyId) })
    } catch (error) {
      setRead({ status: 'error', key: partnerProblem(error) })
    }
  }, [api, enabled, partyId])
  useEffect(() => {
    void load()
  }, [load])

  const loadChoices = useCallback(async () => {
    setDialog((current) => (current ? { ...current, choices: { status: 'loading' } } : current))
    try {
      const choices = await readDesignerChoices(api, partyId)
      setDialog((current) => (current ? { ...current, choices: { status: 'ready', choices } } : current))
    } catch (error) {
      setDialog((current) => (current ? { ...current, choices: { status: 'error', key: partnerProblem(error) } } : current))
    }
  }, [api, partyId])

  const latest = useRef({ read, dialog })
  latest.current = { read, dialog }

  const actions = useMemo<DesignerActions>(
    () => ({
      onChange: () => {
        const current = latest.current.read
        if (!manage || current.status !== 'ready' || !current.slot.mayManage) return
        key.current = newIdempotencyKey()
        setNotice(null)
        setDialog({ draft: designerDraftOf(current.slot), choices: { status: 'loading' }, busy: false, fields: {}, problem: null })
        void loadChoices()
      },
      // Clearing the designer clears the backup too (a backup only beside a designer).
      onDraft: (patch) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, ...patch, ...(patch.designerId === null ? { backupId: null } : {}) }, fields: {}, problem: null } : current)),
      onApply: async () => {
        const { read: now, dialog: open } = latest.current
        // Held (saving, the list still read, nothing changes, a field to fix: the window shows each in words): nothing is sent.
        if (now.status !== 'ready' || !open || applyHeldOf(open, now.slot)) return
        setDialog({ ...open, busy: true, fields: {}, problem: null })
        try {
          const slot = await setFactoryDesigner(api, partyId, { ...open.draft, version: now.slot.version }, key.current ?? newIdempotencyKey())
          setRead({ status: 'ready', slot })
          setDialog(null)
          setNotice({ key: 'customers.designer.done' })
        } catch (error) {
          const refusal = designerRefusalOf(error)
          key.current = newIdempotencyKey()
          if (refusal.reread) {
            try {
              const slot = await readFactoryDesigner(api, partyId)
              setRead({ status: 'ready', slot })
              setDialog((current) => (current ? { ...current, draft: designerDraftOf(slot), busy: false, fields: {}, problem: refusal.problem } : current))
            } catch (again) {
              setDialog((current) => (current ? { ...current, busy: false, problem: { key: partnerProblem(again), ns: 'portal-access' } } : current))
            }
            return
          }
          setDialog((current) => (current ? { ...current, busy: false, fields: refusal.fields, problem: refusal.problem } : current))
        }
      },
      onClose: () => setDialog((current) => (current?.busy ? current : null)),
      onRetry: () => {
        setRead({ status: 'loading' })
        void load()
      },
      onRetryChoices: () => void loadChoices(),
      onDismissNotice: () => setNotice(null),
    }),
    [api, partyId, manage, load, loadChoices],
  )

  const model = useMemo<DesignerModel | null>(() => (enabled ? { read, manage, dialog, notice } : null), [enabled, read, manage, dialog, notice])
  return { model, actions }
}
