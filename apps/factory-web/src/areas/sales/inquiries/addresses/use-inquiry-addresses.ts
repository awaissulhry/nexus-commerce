'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { readProblem } from '../model'
import { readAddresses, receivingDomains, receivingLive, saveAddresses } from './api'
import { savedList, saveProblem, scopeOf, type AddressesModel } from './model'

/**
 * B-TH-285: the container of Incoming's "Inquiry addresses" (the dialog of ⋯) and of the band's door line. It reads the list in force
 * (the company's own, else the tenant-wide one it shares), the receiving domains and whether mail is received live — each only for
 * who may read it (a read the person may not make leaves its fact unknown: the API still checks) — and saves at the version read
 * with one Idempotency-Key per attempt; a version clash reads again and says so.
 */
export function useInquiryAddresses(options: { readonly api: ApiClient; readonly companyId: string | null; readonly open: boolean; readonly may: { readonly view: boolean; readonly identities: boolean; readonly integrations: boolean }; readonly offline: boolean }) {
  const { api, companyId, open, may, offline } = options
  const [model, setModel] = useState<AddressesModel>({ loaded: { status: 'loading' }, draft: [], adding: '', domains: null, live: null, busy: false, problem: null, saved: false, offline })
  const keyRef = useRef<string | null>(null)
  const readId = useRef(0)

  const load = useCallback(async () => {
    if (!may.view) return
    const id = ++readId.current
    try {
      const company = await readAddresses(api, companyId)
      const tenant = company.hasOwnSettings ? null : await readAddresses(api, null).catch(() => null)
      if (id !== readId.current) return
      const scope = scopeOf(company, tenant, companyId)
      setModel((now) => ({ ...now, loaded: { status: 'ready', value: scope }, draft: scope.answer.addresses, adding: '', problem: null }))
    } catch (error) {
      if (id === readId.current) setModel((now) => ({ ...now, loaded: { status: 'error', problem: readProblem(error) } }))
    }
  }, [api, companyId, may.view])

  // The band's facts are read once per company (cheap reads; each only with its right).
  useEffect(() => {
    if (!may.view) return
    const controller = new AbortController()
    void load()
    if (may.identities) receivingDomains(api, companyId, controller.signal).then((domains) => setModel((now) => ({ ...now, domains }))).catch(() => undefined)
    if (may.integrations) receivingLive(api, controller.signal).then((live) => setModel((now) => ({ ...now, live }))).catch(() => undefined)
    return () => controller.abort()
  }, [api, companyId, may.view, may.identities, may.integrations, load])

  // Opening the dialog starts from the list as read (a reopen after Cancel drops what was typed).
  useEffect(() => {
    if (!open) return
    keyRef.current = null
    setModel((now) => ({ ...now, draft: now.loaded.status === 'ready' ? now.loaded.value.answer.addresses : now.draft, adding: '', problem: null, saved: false }))
  }, [open])

  const save = async () => {
    if (model.loaded.status !== 'ready' || model.busy) return
    const scope = model.loaded.value
    setModel((now) => ({ ...now, busy: true, problem: null, saved: false }))
    keyRef.current ??= newIdempotencyKey()
    try {
      const answer = await saveAddresses(api, { companyId: scope.companyId, version: scope.answer.version, addresses: savedList(model.draft) }, keyRef.current)
      keyRef.current = null
      setModel((now) => ({ ...now, busy: false, saved: true, loaded: { status: 'ready', value: { companyId: scope.companyId, answer } }, draft: answer.addresses }))
    } catch (error) {
      keyRef.current = null
      const problem = saveProblem(error)
      setModel((now) => ({ ...now, busy: false, problem: { phrase: problem.phrase, rows: problem.rows } }))
      if (problem.stale) void load()
    }
  }

  return {
    model: { ...model, offline },
    actions: {
      onAdding: (adding: string) => setModel((now) => ({ ...now, adding, saved: false })),
      onAdd: () => setModel((now) => ({ ...now, draft: [...now.draft, now.adding.trim()], adding: '', saved: false })),
      onChange: (index: number, value: string) => setModel((now) => ({ ...now, draft: now.draft.map((one, at) => (at === index ? value : one)), saved: false })),
      onRemove: (index: number) => setModel((now) => ({ ...now, draft: now.draft.filter((_, at) => at !== index), saved: false })),
      onSave: () => void save(),
      onRetry: () => void load(),
    },
  }
}
