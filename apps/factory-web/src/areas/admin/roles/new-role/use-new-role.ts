'use client'

import { useCallback, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { problemKey } from '../../shared/model'
import { isStepUpCancelled } from '../../shared/step-up'
import { useFreshCode } from '../../security/step-up/fresh'
import { createRole, roleTemplates } from './api'
import { createProblem, EMPTY_NEW_ROLE, newRoleErrors, offeredTemplates, slugOf } from './model'
import type { NewRoleModel } from './view/NewRoleDialog'

/**
 * New role (SCR-012, B-W2b-413): opening reads the ready-made roles (`GET /auth/roles/templates`, with `copyable`); picking one
 * names the copy after it until a name is typed (the view says the name); Create copy asks the fresh code FIRST (a new role
 * always asks one),
 * then `POST /auth/roles` with a slug from the name unique among `takenKeys`, and opens the copy's Permissions tab.
 */
export function useNewRole(api: ApiClient, args: { takenKeys: readonly string[]; onCreated: (roleId: string) => void }) {
  const [model, setModel] = useState<NewRoleModel | null>(null)
  const fresh = useFreshCode(api)

  const read = useCallback(() => {
    roleTemplates(api).then(
      (templates) => setModel((current) => (current ? { ...current, templates, readProblem: null } : current)),
      (error: unknown) => setModel((current) => (current ? { ...current, readProblem: problemKey(error) } : current)),
    )
  }, [api])

  const open = () => {
    setModel({ templates: null, readProblem: null, draft: EMPTY_NEW_ROLE, named: false, tried: false, busy: false, problem: null })
    read()
  }

  const create = async () => {
    if (!model || model.busy || !model.templates) return
    const templates = offeredTemplates(model.templates)
    if (Object.keys(newRoleErrors(model.draft, templates)).length > 0) return setModel({ ...model, tried: true })
    const body = { key: slugOf(model.draft.name, args.takenKeys), name: model.draft.name.trim(), basedOn: model.draft.basedOn! }
    setModel({ ...model, tried: true, busy: true, problem: null })
    try {
      await fresh.ensureFresh('newRole.freshSentence')
      const role = await fresh.guard('newRole.freshSentence', () => createRole(api, body))
      setModel(null)
      args.onCreated(role.id)
    } catch (error) {
      setModel((current) => (current ? { ...current, busy: false, problem: isStepUpCancelled(error) ? null : createProblem(error) } : current))
    }
  }

  return {
    model,
    stepUp: fresh.stepUp,
    actions: {
      onOpen: open,
      // A name typed is the person's; picking a ready-made role names the copy after it until then (the view's words).
      onName: (name: string) => setModel((current) => (current ? { ...current, draft: { ...current.draft, name }, named: name.trim() !== '', problem: null } : current)),
      onPick: (basedOn: string, suggested: string) =>
        setModel((current) => (current ? { ...current, draft: { basedOn, name: current.named ? current.draft.name : suggested }, problem: null } : current)),
      onCreate: () => void create(),
      onClose: () => setModel(null),
      onRetry: read,
      onStepUpSubmit: (code: string) => void fresh.submit(code),
      onStepUpClose: fresh.cancel,
    },
  }
}
