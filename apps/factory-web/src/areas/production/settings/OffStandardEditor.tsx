'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi } from '../../../lib/session/context'
import { useLive } from '../../_shared/buying/hooks'
import { useCellSaves } from './use-cell-saves'
import { OffStandardView, type OffDialog, type OffStandardModel } from './view/OffStandardView'
import { createOffCode, editOffCode, listOffCodes, type OffCode, type OffCodeEdit } from './w2b-api'
import { offWithEdit, offWordEdit, w2bProblem } from './w2b-model'

const OWN_ECHO_MS = 5000

/**
 * Floor rules & codes › Off-standard codes (B-W2b-58 over B-W2b-29's API): reads the company's codes
 * (production.offstandard.view), saves each cell on its own at the version read (production.offstandard.codes), sets many
 * inactive or active again, adds a code. Live `production.off_standard_code_changed` from someone else → "Changed by
 * someone else · Reload".
 */
export function OffStandardEditor({ companyId }: { companyId: string | null }) {
  const api = useOfficeApi()
  const [load, setLoad] = useState<OffStandardModel['load']>({ status: 'loading' })
  const [codes, setCodes] = useState<OffCode[] | null>(null)
  const [languages, setLanguages] = useState<readonly string[]>([])
  const [canManage, setCanManage] = useState(false)
  const [notice, setNotice] = useState<OffStandardModel['notice']>(null)
  const [dialog, setDialog] = useState<OffDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const codesRef = useRef<OffCode[] | null>(null)
  codesRef.current = codes
  const ownUntil = useRef(0)
  const createKey = useRef(newIdempotencyKey())

  const read = useCallback(async () => {
    try {
      const answer = await listOffCodes(api, companyId)
      setCodes([...answer.codes].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)))
      setLanguages(answer.languages)
      setCanManage(answer.canManage)
      setLoad({ status: 'ready' })
      setChangedElsewhere(false)
    } catch (error) {
      setLoad({ status: 'error', problem: w2bProblem(error).key })
    }
  }, [api, companyId])

  useEffect(() => {
    void read()
  }, [read])

  useLive(
    (change) => {
      if (change.type !== 'production.off_standard_code_changed' || Date.now() < ownUntil.current) return
      setChangedElsewhere(true)
    },
    () => void read(),
  )

  const rowNow = useCallback((id: string) => codesRef.current?.find((row) => row.id === id), [])
  const putRow = useCallback((row: OffCode) => setCodes((current) => (current ? current.map((entry) => (entry.id === row.id ? row : entry)) : current)), [])
  const cells = useCellSaves<OffCode>(rowNow, putRow, () => setChangedElsewhere(true))

  const save = (row: OffCode, field: string, edit: OffCodeEdit) => {
    ownUntil.current = Date.now() + OWN_ECHO_MS
    cells.save(row.id, field, (current) => offWithEdit(current, edit), (version, key) => editOffCode(api, row.id, { ...edit, version }, key))
  }

  const model: OffStandardModel = { load, codes, languages, canManage, marks: cells.marks, notice, busy, dialog, changedElsewhere }

  return (
    <OffStandardView
      model={model}
      actions={{
        onRetry: () => {
          setLoad({ status: 'loading' })
          void read()
        },
        onReload: () => {
          cells.clear()
          void read()
        },
        onCell: (row, field, value) => {
          const outcome = offWordEdit(rowNow(row.id) ?? row, field, value)
          if (!outcome) return
          if ('problem' in outcome) cells.refuse(row.id, field, outcome.problem)
          else save(row, field, outcome.edit)
        },
        onPayRule: (row, payRule) => {
          if (row.payRule !== payRule) save(row, 'payRule', { payRule })
        },
        onSwitch: (row, field, next) => save(row, field, { [field]: next }),
        onActiveMany: (ids, active) => {
          for (const id of ids) {
            const row = rowNow(id)
            if (row && row.active !== active) save(row, 'active', { active })
          }
        },
        onDialog: (next) => {
          if (next?.kind === 'new' && dialog?.kind !== 'new') createKey.current = newIdempotencyKey()
          setDialog(next)
        },
        onCreate: () => {
          if (dialog?.kind !== 'new' || busy || !companyId) return
          const draft = dialog.draft
          setBusy(true)
          ownUntil.current = Date.now() + OWN_ECHO_MS
          createOffCode(api, { companyId, code: draft.code, kind: draft.kind, payRule: draft.payRule, needsApproval: draft.needsApproval, labelIt: draft.labelIt.trim(), labelEn: draft.labelEn.trim() }, createKey.current)
            .then((code) => {
              setCodes((current) => [...(current ?? []), code])
              setDialog(null)
              setNotice({ tone: 'success', key: 'fr.off.new.done', params: { code: code.code } })
            })
            .catch((error: unknown) => setDialog({ ...dialog, problem: w2bProblem(error).key }))
            .finally(() => setBusy(false))
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
