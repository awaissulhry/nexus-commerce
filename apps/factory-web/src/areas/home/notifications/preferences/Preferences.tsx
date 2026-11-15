'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Cadence, EventKind, PreferenceChannel } from '@nexus/factory-domain/notifications/preferences/preferences'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { fetchMatrix, fetchRoleDefaults, preferencesProblem, resetMatrix, saveCell, saveRoleDefault } from './api'
import { cellKey, type CellSave, type Matrix, type PreferencesModel, type RoleDefaults } from './model'
import { PreferencesDialog } from './view/PreferencesDialog'

/**
 * Notification preferences, the container (B-W2b-388): reads my matrix when it opens, saves a cell at once (the answer is the
 * whole matrix: every source mark stays true), resets my choices, and — for an admin — reads and saves the office roles'
 * defaults. Home › Notifications opens it from its band ("Preferences").
 */
export function Preferences({ onClose, onDigest, onPush }: { onClose: () => void; onDigest?: () => void; onPush?: () => void }) {
  const api = useOfficeApi()
  const [matrix, setMatrix] = useState<PreferencesModel['matrix']>({ status: 'loading' })
  const [saving, setSaving] = useState<Readonly<Record<string, CellSave>>>({})
  const [defaults, setDefaults] = useState<PreferencesModel['defaults']>(null)
  const [defaultsSaving, setDefaultsSaving] = useState<Readonly<Record<string, CellSave>>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<PreferencesModel['notice']>(null)
  const live = useLiveBus({})
  const offline = live === 'offline'

  const load = useCallback(async () => {
    try {
      setMatrix({ status: 'ready', data: await fetchMatrix(api) })
    } catch (error) {
      setMatrix({ status: 'error', problem: preferencesProblem(error) })
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])

  const without = (current: Readonly<Record<string, CellSave>>, key: string) => Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key))
  const onCell = (event: EventKind, channel: PreferenceChannel, cadence: Cadence) => {
    const key = cellKey(event, channel)
    if (offline) return setSaving((current) => ({ ...current, [key]: { state: 'failed', problem: 'held.offline' } }))
    setSaving((current) => ({ ...current, [key]: { state: 'saving' } }))
    saveCell(api, { event, channel, cadence })
      .then((answer: Matrix) => {
        setMatrix({ status: 'ready', data: answer })
        setSaving((current) => without(current, key))
      })
      .catch((error: unknown) => setSaving((current) => ({ ...current, [key]: { state: 'failed', problem: preferencesProblem(error) } })))
  }
  const onRole = (roleId: string | null) => {
    setDefaults({ status: 'loading' })
    fetchRoleDefaults(api, roleId)
      .then((answer: RoleDefaults) => setDefaults({ status: 'ready', data: answer }))
      .catch((error: unknown) => setDefaults({ status: 'error', problem: preferencesProblem(error) }))
  }
  const onDefault = (roleId: string, event: EventKind, channel: PreferenceChannel, cadence: Cadence | null) => {
    const key = cellKey(event, channel)
    if (offline) return setDefaultsSaving((current) => ({ ...current, [key]: { state: 'failed', problem: 'held.offline' } }))
    setDefaultsSaving((current) => ({ ...current, [key]: { state: 'saving' } }))
    saveRoleDefault(api, { roleId, event, channel, cadence })
      .then((answer) => {
        setDefaults({ status: 'ready', data: answer })
        setDefaultsSaving((current) => without(current, key))
        // My own matrix may follow this role's default.
        void load()
      })
      .catch((error: unknown) => setDefaultsSaving((current) => ({ ...current, [key]: { state: 'failed', problem: preferencesProblem(error) } })))
  }

  const model = useMemo<PreferencesModel>(() => ({ matrix, saving, defaults, defaultsSaving, held: offline ? 'held.offline' : busy ? 'held.busy' : null, notice }), [matrix, saving, defaults, defaultsSaving, offline, busy, notice])
  return (
    <PreferencesDialog
      model={model}
      actions={{
        onCell,
        onReset: () => {
          setBusy(true)
          resetMatrix(api)
            .then((answer) => {
              setMatrix({ status: 'ready', data: answer })
              setSaving({})
              setNotice({ key: 'prefs.notice.reset', tone: 'success' })
            })
            .catch((error: unknown) => setNotice({ key: preferencesProblem(error), tone: 'danger' }))
            .finally(() => setBusy(false))
        },
        onRole,
        onDefault,
        onRetry: () => void load(),
        ...(onDigest ? { onDigest } : {}),
        ...(onPush ? { onPush } : {}),
        onClose,
      }}
    />
  )
}
