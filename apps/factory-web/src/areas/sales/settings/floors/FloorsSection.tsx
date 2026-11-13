'use client'

import { useCallback, useEffect, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, useStepUp } from '../../../quality/_shared/hooks'
import { readProblem } from '../../quotes/problems'
import { readFloors, saveFloors, type MarginFloors } from './api'
import { draftOf, floorsBody, floorsChanged, floorsHeld, rowOf, type FloorWords } from './model'
import { FloorsView, type FloorsModel } from './view/FloorsView'

/**
 * Sales settings › Margin floor % per role (B-W2b-343, the lead's decision 11-13: SCR-235's own block, beside B-W2b-316's
 * sections): reads the floors of the page's scope (this company's settings row, or the group's), saves the scope's row at
 * its version; a change that lowers a floor asks a fresh code (the API's 403 `stepUp` → the DS step-up, then the same save
 * once more). A scope without its own row is held with its reason (its quote rules' first save makes the row).
 */
export function MarginFloorsSection({ scope, companyId }: { scope: 'company' | 'group'; companyId: string | null }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = new Set(session.permissions)
  const margin = held.has('money.margin')
  const manage = held.has('sales.settings.manage')
  const [floors, setFloors] = useState<FloorsModel['floors']>({ status: 'loading' })
  const [edit, setEdit] = useState<Record<string, string> | null>(null)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<FloorWords | null>(null)
  const [notice, setNotice] = useState<FloorsModel['notice']>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const load = useCallback(async () => {
    try {
      setFloors({ status: 'ready', value: await readFloors(api, scope === 'company' ? companyId : null) })
    } catch (error) {
      setFloors({ status: 'error', problem: { key: readProblem(error) } })
    }
  }, [api, scope, companyId])
  useEffect(() => {
    if (!margin) return
    setEdit(null)
    setFloors({ status: 'loading' })
    void load()
  }, [load, margin])

  const save = async (value: MarginFloors) => {
    if (!edit || saving || floorsHeld(edit, value.roles) || !floorsChanged(edit, value, scope)) return
    const row = rowOf(value, scope)
    if (!row) return
    setSaving(true)
    setProblem(null)
    try {
      await guard('floors.stepUpSentence', () => saveFloors(api, { companyId: scope === 'company' ? companyId : null, version: row.version, floors: floorsBody(edit) }))
      setEdit(null)
      setNotice({ tone: 'success', words: { key: 'floors.done' } })
      await load()
    } catch (error) {
      if (isStepUpCancelled(error)) setProblem({ key: 'floors.stepUpCancelled' })
      else if (isApiError(error) && error.kind === 'conflict') {
        setProblem({ key: error.code === 'version_conflict' ? 'floors.refusedMoved' : 'floors.refusedNoRow' })
        await load()
      } else if (isApiError(error) && error.kind === 'invalid') setProblem({ key: 'floors.refusedRoles' })
      else setProblem({ key: 'floors.refused' })
    } finally {
      setSaving(false)
    }
  }

  const model: FloorsModel = {
    scope,
    companyCode: session.company?.code ?? null,
    floors,
    margin,
    manage,
    edit,
    saving,
    problem,
    notice,
    stepUp: { open: stepUp.open, busy: stepUp.busy, problem: stepUp.problem },
  }
  return (
    <FloorsView
      model={model}
      actions={{
        onEdit: (open) => {
          setProblem(null)
          setEdit(open && floors.status === 'ready' ? draftOf(floors.value, scope) : null)
        },
        onDraft: (roleKey, text) => setEdit((current) => (current ? { ...current, [roleKey]: text } : current)),
        onSave: () => floors.status === 'ready' && void save(floors.value),
        onRetry: () => void load(),
        onDismissNotice: () => setNotice(null),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
