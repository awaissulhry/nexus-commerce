'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { failed, LOADING, ready, words, writeWords } from '../../shipments/queue/shared/depth'
import type { DispatchAbilities } from '../../shipments/pickup/dispatch'
import { changeDefault, changeType, createDefault, createType, listDefaults, listScalesToPick, listStylesToPick, listTypes } from './api'
import { defaultProblem, manageHeld, typeBody, typeProblems, type PackagingModel } from './model'
import { PackagingView } from './view/PackagingView'

/**
 * Carriers & shipping › Packaging (SCR-657; B-W2b-412 on B-W2b-384): reads the company's types and defaults, and makes each
 * write ONE call with its own Idempotency-Key at the row's version (Switch off N: one call per row, each its own key and
 * outcome). The styles and size scales a new default may name are read when its dialog opens.
 */
export function Packaging({ companyId, can }: { companyId: string; can: Pick<DispatchAbilities, 'packaging' | 'cost'> }) {
  const api = useOfficeApi()
  const [state, setState] = useState<Omit<PackagingModel, 'can'>>({ types: LOADING, defaults: LOADING, dialog: null, picks: null, busy: false, problem: null, done: null })
  const latest = useRef(state)
  latest.current = state
  const keys = useRef<Record<string, string>>({})
  const keyOf = (name: string) => (keys.current[name] ??= newIdempotencyKey())

  const load = useCallback(
    async (quiet: boolean) => {
      if (!quiet) setState((current) => ({ ...current, types: current.types.state === 'ready' ? current.types : LOADING, defaults: current.defaults.state === 'ready' ? current.defaults : LOADING }))
      await Promise.all([
        listTypes(api, companyId).then(
          (types) => setState((current) => ({ ...current, types: ready(types) })),
          (error: unknown) => setState((current) => (quiet && current.types.state === 'ready' ? current : { ...current, types: failed(error) })),
        ),
        listDefaults(api, companyId).then(
          (defaults) => setState((current) => ({ ...current, defaults: ready(defaults) })),
          (error: unknown) => setState((current) => (quiet && current.defaults.state === 'ready' ? current : { ...current, defaults: failed(error) })),
        ),
      ])
    },
    [api, companyId],
  )
  useEffect(() => {
    void load(false)
  }, [load])

  const fail = (error: unknown, kind: string) => {
    const problem = writeWords(error, 'packaging.refusal', [])
    const said = problem.key === 'problem.write.state' ? words(`packaging.refused.${kind === 'type' ? 'name' : 'live'}`) : problem.key === 'problem.write.invalid' ? words('packaging.refused.invalid') : { key: problem.key, params: problem.params }
    setState((now) => ({ ...now, busy: false, problem: said }))
    if (problem.reload) void load(true)
  }

  const go = async () => {
    const current = latest.current
    const dialog = current.dialog
    if (!dialog || current.busy || manageHeld(can, false)) return
    if (dialog.kind === 'type' && Object.keys(typeProblems(dialog.form, can.cost)).length > 0) return setState({ ...current, dialog: { ...dialog, tried: true } })
    if (dialog.kind === 'default' && defaultProblem(dialog.form)) return
    setState({ ...current, busy: true, problem: null })
    try {
      let done
      switch (dialog.kind) {
        case 'type': {
          const body = typeBody(dialog.form, can.cost)
          const existing = dialog.typeId && current.types.state === 'ready' ? current.types.value.find((type) => type.id === dialog.typeId) : null
          const saved = existing ? await changeType(api, existing.id, { ...body, version: existing.version }, keyOf('type')) : await createType(api, { ...body, companyId, kind: dialog.form.kind, name: dialog.form.name.trim() }, keyOf('type'))
          done = words(existing ? 'packaging.done.saved' : 'packaging.done.added', { name: saved.name })
          break
        }
        case 'default': {
          const form = dialog.form
          await createDefault(api, { companyId, packagingTypeId: form.packagingTypeId, styleId: form.styleId || null, sizeScaleId: form.sizeScaleId || null, fromSize: form.fromSize.trim() || null, toSize: form.toSize.trim() || null }, keyOf('default'))
          done = words('packaging.done.defaultAdded')
          break
        }
        case 'defaultType': {
          const row = current.defaults.state === 'ready' ? current.defaults.value.find((entry) => entry.id === dialog.defaultId) : null
          if (!row) return
          await changeDefault(api, row.id, { version: row.version, packagingTypeId: dialog.packagingTypeId }, keyOf('defaultType'))
          done = words('packaging.done.defaultChanged')
          break
        }
        case 'active': {
          // One change per row, each its own key: a row that moved meanwhile is said, the others go.
          let changed = 0
          let refused = 0
          for (const id of dialog.ids) {
            try {
              if (dialog.target === 'types') {
                const type = current.types.state === 'ready' ? current.types.value.find((entry) => entry.id === id) : null
                if (!type) continue
                await changeType(api, id, { version: type.version, active: dialog.active }, keyOf(`active:${id}`))
              } else {
                const row = current.defaults.state === 'ready' ? current.defaults.value.find((entry) => entry.id === id) : null
                if (!row) continue
                await changeDefault(api, id, { version: row.version, active: dialog.active }, keyOf(`active:${id}`))
              }
              changed += 1
            } catch {
              refused += 1
            }
          }
          done = words(refused > 0 ? 'packaging.done.activePartly' : dialog.active ? 'packaging.done.on' : 'packaging.done.off', { count: changed, refused })
          break
        }
      }
      keys.current = {}
      setState((now) => ({ ...now, busy: false, dialog: null, done }))
      void load(true)
    } catch (error) {
      fail(error, dialog.kind)
    }
  }

  return (
    <PackagingView
      model={{ ...state, can }}
      actions={{
        onDialog: (dialog) => {
          const current = latest.current
          if (current.busy) return
          keys.current = {}
          setState({ ...current, dialog, problem: null })
          if (dialog?.kind === 'default' && !current.picks) {
            setState((now) => ({ ...now, picks: LOADING }))
            // Each list on its own: a person who may not list styles still names a size run.
            void Promise.allSettled([listStylesToPick(api), listScalesToPick(api)]).then(([styles, scales]) =>
              setState((now) => ({
                ...now,
                picks: styles.status === 'rejected' && scales.status === 'rejected' ? failed(styles.reason) : ready({ styles: styles.status === 'fulfilled' ? styles.value : [], scales: scales.status === 'fulfilled' ? scales.value : [] }),
              })),
            )
          }
        },
        onGo: () => void go(),
        onRetry: () => void load(false),
        onDismiss: () => setState((current) => ({ ...current, done: null, problem: null })),
      }}
    />
  )
}
