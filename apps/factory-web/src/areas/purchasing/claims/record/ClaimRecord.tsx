'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { storeUrl } from '../../../../record-panels/store'
import { useCoalesced, useLive, useThreadDock } from '../../../_shared/buying/hooks'
import { answerClaim, cancelClaim, claimReasons, closeClaim, ddtPdfLink, getClaim, removeLine, returnGoods, sendCheck, sendClaim, updateClaim, type Claim, type PickerReason } from '../api'
import {
  answerBody,
  answerHeld,
  claimsCan,
  dialogRefusal,
  formHeld,
  formPatch,
  formRefusal,
  goodsBody,
  goodsHeld,
  LOADING,
  readWords,
  ready,
  sendBody,
  sendHeld,
  simpleHeld,
  tabOf,
  withCheck,
  words,
  type ClaimDialog,
  type ClaimForm,
  type ClaimRecordModel,
  type Loaded,
  type Part,
  type Words,
} from '../model'
import { ClaimRecordView } from './view/ClaimRecordView'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/purchasing/claims/<id>` (SCR-131 record; `?tab=claim|goods|credit|activity`): loads the claim
 * (purchasing.view; values with the cost grain), the CLAIM reason list when its reason may still change, the send check
 * when Send opens; every write is ONE call with the claim's version as read and one Idempotency-Key per dialog (a new one
 * after a refusal). Live: supplier_claim.* events of this claim read it again — or, while a dialog or the form is open,
 * say "Changed at hh:mm · Reload".
 */
export function ClaimRecord({ claimId }: { claimId: string }) {
  return (
    <WithMessages namespaces={['purchasing-claims', 'lists', 'records']}>
      <Container claimId={claimId} />
    </WithMessages>
  )
}

function Container({ claimId }: { claimId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/purchasing\/claims\/[^/]+\/?$/, '')
  const can = useMemo(() => claimsCan(session.permissions), [session.permissions])

  const [claim, setClaim] = useState<Loaded<Claim>>({ status: 'loading' })
  const [dialog, setDialog] = useState<ClaimDialog | null>(null)
  const [dialogProblem, setDialogProblem] = useState<Words | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ClaimRecordModel['notice']>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [form, setForm] = useState<ClaimForm | null>(null)
  const [formProblem, setFormProblem] = useState<Words | null>(null)
  const [saving, setSaving] = useState(false)
  const [reasons, setReasons] = useState<Part<PickerReason[]>>(LOADING)
  const reasonsAsked = useRef(false)
  const open = useRef({ dialog, form })
  open.current = { dialog, form }
  const key = useRef(newIdempotencyKey())
  const saveKey = useRef(newIdempotencyKey())
  const { dockOpen, toggleDock } = useThreadDock('SupplierClaim')

  const load = useCallback(async () => {
    try {
      setClaim({ status: 'ready', value: await getClaim(api, claimId) })
      setChanged(null)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setClaim({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setClaim({ status: 'forbidden' })
      else setClaim({ status: 'error', problem: readWords(error) })
    }
  }, [api, claimId])

  useEffect(() => {
    void load()
  }, [load])

  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      if (!change.type.startsWith('supplier_claim.') || change.fields.supplierClaimId !== claimId) return
      if (open.current.dialog || open.current.form) setChanged({ at: new Date().toISOString() })
      else reread()
    },
    () => void load(),
  )

  // The CLAIM reason list, once, when the reason may still change (a draft, with the right).
  const value = claim.status === 'ready' ? claim.value : null
  useEffect(() => {
    if (reasonsAsked.current || !value || value.status !== 'DRAFT' || !can.manage || tab !== 'claim') return
    reasonsAsked.current = true
    claimReasons(api)
      .then((list) => setReasons(ready(list)))
      .catch((error: unknown) => setReasons({ value: null, problem: readWords(error) }))
  }, [api, value, can.manage, tab])

  const openDialog = useCallback(
    (next: ClaimDialog | null) => {
      setDialogProblem(null)
      if (next && (!open.current.dialog || open.current.dialog.kind !== next.kind)) {
        key.current = newIdempotencyKey()
        if (next.kind === 'send' && next.draft.check.value === null && next.draft.check.problem === null) {
          sendCheck(api, claimId)
            .then((check) => setDialog((current) => (current?.kind === 'send' ? { kind: 'send', draft: withCheck(current.draft, ready(check)) } : current)))
            .catch((error: unknown) => setDialog((current) => (current?.kind === 'send' ? { kind: 'send', draft: withCheck(current.draft, { value: null, problem: readWords(error) }) } : current)))
        }
      }
      setDialog(next)
    },
    [api, claimId],
  )

  const confirm = useCallback(async () => {
    const current = claim.status === 'ready' ? claim.value : null
    if (!current || !dialog || busy) return
    const held =
      dialog.kind === 'send' ? sendHeld(dialog.draft, current, can) : dialog.kind === 'answer' ? answerHeld(dialog.draft, current, can) : dialog.kind === 'returnGoods' ? goodsHeld(dialog.draft, current, can) : dialog.kind === 'returned' ? words('held.busy') : simpleHeld(dialog, current, can)
    if (held) return
    setBusy(true)
    setDialogProblem(null)
    try {
      switch (dialog.kind) {
        case 'send': {
          const next = await sendClaim(api, claimId, sendBody(dialog.draft, current), key.current)
          setClaim({ status: 'ready', value: next })
          setDialog(null)
          setNotice({ tone: 'success', words: words(dialog.draft.withMail ? 'notice.sentMail' : 'notice.sent', { number: next.number }) })
          break
        }
        case 'answer': {
          const next = await answerClaim(api, claimId, answerBody(dialog.draft, current, can), key.current)
          setClaim({ status: 'ready', value: next })
          setDialog(null)
          setNotice({ tone: 'success', words: words(next.status === 'ACCEPTED' ? 'notice.accepted' : 'notice.rejected', { number: next.number }) })
          break
        }
        case 'returnGoods': {
          const answer = await returnGoods(api, claimId, goodsBody(dialog.draft, current), key.current)
          setClaim({ status: 'ready', value: answer.claim })
          setDialog({ kind: 'returned', answer })
          break
        }
        case 'close': {
          const next = await closeClaim(api, claimId, current.version, dialog.note.trim(), key.current)
          setClaim({ status: 'ready', value: next })
          setDialog(null)
          setNotice({ tone: 'success', words: words('notice.closed', { number: next.number }) })
          break
        }
        case 'cancel': {
          const next = await cancelClaim(api, claimId, current.version, dialog.reason.trim(), key.current)
          setClaim({ status: 'ready', value: next })
          setDialog(null)
          setNotice({ tone: 'success', words: words('notice.cancelled', { number: next.number }) })
          break
        }
        case 'removeLines': {
          // One call per line, each with the version the previous one answered.
          let next = current
          for (const lineId of dialog.lineIds) next = await removeLine(api, claimId, lineId, next.version, newIdempotencyKey())
          setClaim({ status: 'ready', value: next })
          setDialog(null)
          setNotice({ tone: 'success', words: words('notice.linesRemoved', { count: dialog.lineIds.length }) })
          break
        }
      }
    } catch (error) {
      setDialogProblem(dialogRefusal(dialog.kind, error))
      key.current = newIdempotencyKey()
      if ((isApiError(error) && error.kind === 'conflict') || dialog.kind === 'removeLines') void load()
    } finally {
      setBusy(false)
    }
  }, [api, busy, can, claim, claimId, dialog, load])

  const save = useCallback(async () => {
    const current = claim.status === 'ready' ? claim.value : null
    if (!current || !form || saving || formHeld(form, current, can, reasons.value)) return
    setSaving(true)
    setFormProblem(null)
    try {
      const next = await updateClaim(api, claimId, formPatch(form, current, can), saveKey.current)
      saveKey.current = newIdempotencyKey()
      setClaim({ status: 'ready', value: next })
      setForm(null)
      setNotice({ tone: 'success', words: words('notice.saved') })
    } catch (error) {
      saveKey.current = newIdempotencyKey()
      setFormProblem(formRefusal(error))
      if (isApiError(error) && error.kind === 'conflict') setChanged({ at: new Date().toISOString() })
    } finally {
      setSaving(false)
    }
  }, [api, can, claim, claimId, form, reasons.value, saving])

  const openDdt = useCallback(
    async (ddtId: string) => {
      try {
        const link = await ddtPdfLink(api, ddtId)
        const anchor = document.createElement('a')
        anchor.href = storeUrl(link.url)
        anchor.target = '_blank'
        anchor.rel = 'noopener'
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      } catch (error) {
        setNotice({ tone: 'danger', words: words(isApiError(error) && error.kind === 'not_found' ? 'goods.pdfMissing' : readWords(error)) })
      }
    },
    [api],
  )

  const model: ClaimRecordModel = { prefix, can, tab, claim, live, dockOpen, changed, notice, busy, dialog, dialogProblem, form, formProblem, saving, reasons, timeZone: TIME_ZONE }

  return (
    <ClaimRecordView
      model={model}
      panels={value && (tab === 'activity' || dockOpen) ? <RecordPanels record={{ type: 'SupplierClaim', id: value.id, companyId: value.companyId, siteId: value.site.id }} title={`${value.number} · ${value.supplier.name}`} /> : null}
      actions={{
        onRetry: () => void load(),
        onReload: () => {
          setForm(null)
          setFormProblem(null)
          void load()
        },
        onDock: toggleDock,
        onDialog: openDialog,
        onConfirm: () => void confirm(),
        onForm: (next) => {
          setFormProblem(null)
          setForm(next)
        },
        onSave: () => void save(),
        onOpenDdt: (ddtId) => void openDdt(ddtId),
        onCopyNumber: () => {
          if (value) void navigator.clipboard?.writeText(value.number).catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
