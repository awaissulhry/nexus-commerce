'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadLink } from '../../../../record-panels/api'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { readFromStore, storeUrl } from '../../../../record-panels/store'
import {
  correctInvoice,
  createCreditNote,
  deleteDraft,
  getChecks,
  getInvoice,
  getRelated,
  getSdi,
  issueInvoice,
  makeFiles,
  removeDeduction,
  replaceLines,
  sendToSdi,
  updateDraft,
  type Checks,
  type Invoice,
  type Related,
  type Sdi,
} from '../../_shared/api'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp, useThreadDock } from '../../_shared/hooks'
import { abilitiesOf, lineInputsOf, readProblem, recordTouched, romeToday, writeProblem } from '../../_shared/model'
import { releaseOverpayment } from '../daily/api'
import { withCharge, withoutLine } from '../daily/model'
import { PART_LOADING, tabOf, type InvoiceRecordModel, type Loaded, type Part, type RecordDialog } from './record-model'
import { InvoiceRecordView } from './view/InvoiceRecordView'

/**
 * `/w/<company>/finance/invoices/<id>` (SCR-081): loads the invoice (invoices.view; the API checks its company and
 * customer), what its tabs show — the checks before issue (a draft), its DDTs, deductions, credit notes, payments and its
 * orders' deposits, where it is at SDI (issued) — and does what the view asks, one write at a time, each with the
 * invoice's version as read (a 409 reads it again and says so): Check and issue then send to SDI (P1: a confirm dialog;
 * a fresh authenticator code first), fix a rejected one and send it again with the same number and date, a credit note
 * (TD04) as a new draft, a draft's lines and text, remove a deduction, delete a draft, make missing files, the PDF and
 * the XML. Live: events that name the invoice or a record beside it read it again.
 */
export function InvoiceRecord({ invoiceId }: { invoiceId: string }) {
  return (
    <WithMessages namespaces={['finance', 'finance-daily', 'lists', 'records']}>
      <RecordContainer invoiceId={invoiceId} />
    </WithMessages>
  )
}

const part = <T,>(value: T): Part<T> => ({ value, problem: null })

function RecordContainer({ invoiceId }: { invoiceId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/finance\/invoices\/[^/]+\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])

  const [invoice, setInvoice] = useState<Loaded<Invoice>>({ status: 'loading' })
  const current = useRef<Invoice | null>(null)
  const [checks, setChecks] = useState<Part<Checks> | null>(null)
  const [related, setRelated] = useState<Part<Related>>(PART_LOADING)
  const [sdi, setSdi] = useState<Part<Sdi> | null>(null)
  const sdiRef = useRef<Sdi | null>(null)
  const [pdf, setPdf] = useState<InvoiceRecordModel['pdf']>({ status: 'idle', src: null })
  // B-W2a-80: the list's row verb "Credit note" lands with `?do=credit` (the dialog opens once the invoice is read).
  const [dialog, setDialog] = useState<RecordDialog | null>(params?.get('do') === 'credit' ? { kind: 'credit' } : null)
  const dialogRef = useRef<RecordDialog | null>(null)
  dialogRef.current = dialog
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<InvoiceRecordModel['notice']>(null)
  const [dialogProblem, setDialogProblem] = useState<InvoiceRecordModel['dialogProblem']>(null)
  const [resendProblems, setResendProblems] = useState<InvoiceRecordModel['resendProblems']>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const { dockOpen, toggleDock } = useThreadDock('Invoice')
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)

  const loadParts = useCallback(
    (value: Invoice) => {
      getRelated(api, value.id)
        .then((answer) => setRelated(part(answer)))
        .catch((error: unknown) => setRelated({ value: null, problem: readProblem(error) }))
      if (value.status === 'DRAFT') {
        setSdi(null)
        sdiRef.current = null
        setChecks((known) => known ?? PART_LOADING)
        getChecks(api, value.id)
          .then((answer) => setChecks(part(answer)))
          .catch((error: unknown) => setChecks({ value: null, problem: readProblem(error) }))
      } else {
        setChecks(null)
        setSdi((known) => known ?? PART_LOADING)
        getSdi(api, value.id)
          .then((answer) => {
            sdiRef.current = answer
            setSdi(part(answer))
          })
          .catch((error: unknown) => setSdi({ value: null, problem: readProblem(error) }))
      }
    },
    [api],
  )

  const setValue = useCallback((next: Invoice) => {
    current.current = next
    setInvoice({ status: 'ready', value: next })
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await getInvoice(api, invoiceId)
      setValue(next)
      setChanged(null)
      loadParts(next)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setInvoice({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setInvoice({ status: 'forbidden' })
      else setInvoice({ status: 'error', problem: readProblem(error) })
    }
  }, [api, invoiceId, setValue, loadParts])

  useEffect(() => {
    setPdf({ status: 'idle', src: null })
    void load()
  }, [load])

  // Live: an event naming this invoice or a record beside it; a dialog with typed work open → "changed · Reload".
  const reread = useCoalesced(() => void load(), 700)
  const known = useMemo(() => {
    if (invoice.status !== 'ready') return null
    const value = invoice.value
    const ids = new Set<string>([value.id, ...(value.salesOrderId ? [value.salesOrderId] : []), ...(value.creditOfId ? [value.creditOfId] : []), ...(value.depositRequestId ? [value.depositRequestId] : [])])
    for (const entry of related.value?.creditNotes ?? []) ids.add(entry.id)
    for (const entry of related.value?.payments ?? []) ids.add(entry.paymentId)
    for (const entry of related.value?.depositRequests ?? []) ids.add(entry.id)
    return ids
  }, [invoice, related.value])
  const knownRef = useRef(known)
  knownRef.current = known
  const live = useLive(
    (change) => {
      if (!knownRef.current || !recordTouched(change, knownRef.current)) return
      const open = dialogRef.current
      if (open && (open.kind === 'lines' || open.kind === 'details' || open.kind === 'credit' || open.kind === 'fix')) setChanged({ at: new Date().toISOString() })
      else reread()
    },
    () => void load(),
  )

  /** One write; the invoice it answers (when it answers one) replaces the page's, then the parts are read again. */
  const write = useCallback(
    async (run: () => Promise<Invoice | null>, success: InvoiceRecordModel['notice'], keepDialog = false) => {
      if (busy) return
      setBusy(true)
      setNotice(null)
      setDialogProblem(null)
      try {
        const next = await run()
        if (next) {
          setValue(next)
          loadParts(next)
        } else await load()
        if (!keepDialog) setDialog(null)
        if (success) setNotice(success)
      } catch (error) {
        if (isStepUpCancelled(error)) return
        const words = writeProblem(error)
        if (dialogRef.current) setDialogProblem(words)
        else setNotice({ tone: 'danger', words })
        if (words.reload) void load()
      } finally {
        setBusy(false)
      }
    },
    [busy, load, loadParts, setValue],
  )

  const version = () => current.current?.version ?? 1
  const sendNow = async (key: string) => {
    const fresh = await getSdi(api, invoiceId)
    const answer = await guard('stepUp.sentence.sdi', () => sendToSdi(api, invoiceId, fresh.version, key))
    sdiRef.current = answer
    setSdi(part(answer))
    return answer
  }

  const model: InvoiceRecordModel = { prefix, can, today: romeToday(), tab, invoice, checks, related, sdi, pdf, live, dockOpen, changed, notice, busy, dialog, dialogProblem, resendProblems, stepUp }
  const value = invoice.status === 'ready' ? invoice.value : null

  return (
    <InvoiceRecordView
      model={model}
      panels={value ? <RecordPanels record={{ type: 'Invoice', id: value.id, companyId: value.companyId, siteId: null }} title={`${value.number ?? value.docType} · ${value.party.legalName}`} party={{ id: value.buyerPartyId, name: value.party.legalName, emails: [] }} /> : null}
      actions={{
        onRetry: () => void load(),
        onRetryPart: () => value && loadParts(value),
        onReload: () => void load(),
        onDock: toggleDock,
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
          setResendProblems(null)
        },
        onIssue: ({ send }) => {
          // One key per write, kept for its repeat after the code: the API answers the second from its receipt.
          const issueKey = newIdempotencyKey()
          const sendKey = newIdempotencyKey()
          void write(async () => {
            await ensureFresh('stepUp.sentence.issue')
            const issued = await guard('stepUp.sentence.issue', () => issueInvoice(api, invoiceId, version(), issueKey))
            const number = issued.invoice.number ?? '—'
            if (!send) {
              setNotice({ tone: issued.filesPending ? 'warning' : 'success', words: { key: issued.filesPending ? 'notice.issuedFilesPending' : 'notice.issued', params: { number } } })
              return issued.invoice
            }
            try {
              await sendNow(sendKey)
              setNotice({ tone: 'success', words: { key: 'notice.issuedSent', params: { number } } })
            } catch (error) {
              setNotice({ tone: 'warning', words: { key: isStepUpCancelled(error) ? 'notice.issuedNotSent' : 'notice.issuedSendFailed', params: { number } } })
            }
            return null
          }, null)
        },
        onSend: () => {
          const key = newIdempotencyKey()
          void write(
            async () => {
              await ensureFresh('stepUp.sentence.sdi')
              await sendNow(key)
              return null
            },
            { tone: 'success', words: { key: 'notice.sent' } },
          )
        },
        onFixAndResend: ({ lines, causale }) => {
          const fixKey = newIdempotencyKey()
          const sendKey = newIdempotencyKey()
          void write(
            async () => {
              await ensureFresh('stepUp.sentence.fix')
              const stored = current.current
              if (stored && (lines !== null || causale !== null)) {
                const corrected = await guard('stepUp.sentence.fix', () =>
                  correctInvoice(api, invoiceId, { version: stored.version, ...(lines ? { lines: lineInputsOf(stored.lines, lines) } : {}), ...(causale !== null ? { causale: causale.trim() || null } : {}) }, fixKey),
                )
                if (!corrected.resend.ready) {
                  // Saved, but the resend's checks do not pass yet: the dialog stays and says what is left.
                  setResendProblems(corrected.resend.problems)
                  setDialogProblem({ key: 'fix.notReady' })
                  return corrected.invoice
                }
              }
              await sendNow(sendKey)
              setDialog(null)
              setNotice({ tone: 'success', words: { key: 'notice.resent' } })
              return null
            },
            null,
            true,
          )
        },
        onCreditNote: (input) => {
          const key = newIdempotencyKey()
          void write(
            async () => {
              const answer = await createCreditNote(api, invoiceId, input, key)
              setDialog(null)
              router.push(`${prefix}/finance/invoices/${answer.invoice.id}?tab=lines`)
              return null
            },
            null,
            true,
          )
        },
        onSaveLines: (drafts) => {
          const stored = current.current
          if (!stored) return
          void write(() => replaceLines(api, invoiceId, stored.version, lineInputsOf(stored.lines, drafts)), { tone: 'success', words: { key: 'notice.linesSaved' } })
        },
        onSaveDetails: ({ causale, dueDate }) => {
          const stored = current.current
          if (!stored) return
          const installment = stored.paymentTerms?.installments?.[0]
          void write(
            () =>
              updateDraft(api, invoiceId, {
                version: stored.version,
                causale: causale?.trim() ? causale.trim() : null,
                payment: { method: installment?.method ?? 'MP05', dueDate: dueDate || null, iban: installment?.iban ?? null },
              }),
            { tone: 'success', words: { key: 'notice.detailsSaved' } },
          )
        },
        onDelete: () =>
          void write(async () => {
            await deleteDraft(api, invoiceId, version())
            router.push(`${prefix}/finance/invoices`)
            return null
          }, null),
        onRemoveDeduction: (lineId) => void write(() => removeDeduction(api, invoiceId, lineId, version()), { tone: 'success', words: { key: 'notice.deductionRemoved' } }),
        onAddCharge: (draft) => {
          const stored = current.current
          if (!stored) return
          void write(() => replaceLines(api, invoiceId, stored.version, withCharge(stored, draft)), { tone: 'success', words: { key: 'notice.linesSaved' } })
        },
        onRemoveCharge: (lineId) => {
          const stored = current.current
          if (!stored) return
          void write(() => replaceLines(api, invoiceId, stored.version, withoutLine(stored, lineId)), { tone: 'success', words: { key: 'notice.linesSaved' } })
        },
        onCarry: (note) => {
          const key = newIdempotencyKey()
          void write(async () => {
            await releaseOverpayment(api, invoiceId, note, key)
            return null
          }, { tone: 'success', words: { key: 'notice.carried' } })
        },
        onMakeFiles: () => void write(() => makeFiles(api, invoiceId), { tone: 'success', words: { key: 'notice.filesMade' } }),
        onDownload: (fileId) => {
          void (async () => {
            try {
              const { download } = await downloadLink(api, fileId)
              const anchor = document.createElement('a')
              anchor.href = storeUrl(download.url)
              anchor.rel = 'noopener'
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
            } catch (error) {
              setNotice({ tone: 'danger', words: { key: readProblem(error) } })
            }
          })()
        },
        onViewPdf: () => {
          const fileId = current.current?.pdfFileId
          if (!fileId) return
          setPdf({ status: 'loading', src: null })
          void (async () => {
            try {
              const { download } = await downloadLink(api, fileId)
              setPdf({ status: 'ready', src: await readFromStore(download) })
            } catch {
              setPdf({ status: 'error', src: null })
            }
          })()
        },
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
