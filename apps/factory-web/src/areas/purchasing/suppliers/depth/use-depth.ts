'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { storeUrl } from '../../../../record-panels/store'
import { useLiveBus } from '../../../../shell/live/use-live'
import { isStepUpCancelled, useStepUp } from '../../../admin/shared/step-up'
import {
  acceptUpload,
  approveChange,
  askForDocuments,
  askQualification,
  callBack,
  fileLink,
  moveQualification,
  proposeBank,
  readBank,
  readChanges,
  readClaims,
  readProfile,
  readQualifications,
  readReceipts,
  readVault,
  refuseBank,
  refuseChange,
  refuseUpload,
  retireBank,
  revealBank,
  saveProfile,
  setReceives,
  setStatus,
  statusReach,
  verifyBank,
  type BankView,
  type ChangeRequest,
  type ClaimRow,
  type Qualifications,
  type ReceiptRow,
  type Receives,
  type SupplierProfile,
  type SupplierStatus,
  type Vault,
} from './api'
import {
  acceptDraftOf,
  acceptProblem,
  depthCan,
  draftOf,
  dueInstant,
  dueProblem,
  EMPTY_PROPOSAL,
  failedRead,
  LOADING,
  phoneMatches,
  profileBody,
  profileProblems,
  proposalBody,
  proposalProblems,
  problemOf,
  qualificationProblem,
  qualifiesWork,
  ready,
  reasonProblem,
  refusedOf,
  refuseProblem,
  toggled,
  valueOf,
  type ProfileDraft,
  type Read,
  type Words,
} from './model'
import type { CellMark } from './view/ReceivesCard'
import type { DocumentsDialog } from './view/DocumentsDialogs'
import type { BankDialog } from './view/BankDialogs'
import type { StatusDialogModel } from './view/StatusDialog'

type Tone = 'success' | 'warning' | 'danger' | 'info'
export type Notice = { readonly tone: Tone; readonly words: Words } | null
const say = (key: string, params?: Record<string, string | number>): Words => (params ? { key, params } : { key })

/** Today on the factory's calendar (Europe/Rome), as YYYY-MM-DD. */
export function todayOf(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/**
 * The supplier record's W2b container (B-W2b-334): reads what the tab shown needs (the profile on Overview and Contacts,
 * the vault on Overview's Now and on Documents & qualification with the changes waiting and the qualifications, the bank
 * on Bank details, receipts and claims on Quality & rating), again on the live events of this supplier and on a
 * reconnect, and does every write with the version read and one Idempotency-Key per attempt: a 409 reads again and says
 * someone else changed it; a 403 asking for a fresh code opens the step-up and runs once more. The bank's whole IBAN lives
 * in its dialog's state only.
 */
export function useSupplierDepth(partyId: string) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const tab = params?.get('tab') ?? 'overview'
  const can = useMemo(() => depthCan(session.permissions), [session.permissions])
  const me = session.user.id
  const today = useMemo(() => todayOf(), [])
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const reloadParty = useRef<() => void>(() => undefined)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  // ---- reads ----
  const [profile, setProfile] = useState<Read<SupplierProfile>>(LOADING)
  const [vault, setVault] = useState<Read<Vault>>(LOADING)
  const [changes, setChanges] = useState<Read<readonly ChangeRequest[]> | null>(can.decideChanges ? LOADING : null)
  const [qualifications, setQualifications] = useState<Read<Qualifications>>(LOADING)
  const [bank, setBank] = useState<Read<BankView>>(LOADING)
  const [receipts, setReceipts] = useState<Read<readonly ReceiptRow[]> | null>(can.receipts ? LOADING : null)
  const [claims, setClaims] = useState<Read<readonly ClaimRow[]> | null>(can.claims ? LOADING : null)

  const readOne = useCallback(async <T,>(work: () => Promise<T>, set: (read: Read<T>) => void) => {
    try {
      set(ready(await work()))
    } catch (error) {
      set(failedRead(problemOf(error)))
    }
  }, [])

  const loadProfile = useCallback(() => readOne(() => readProfile(api, partyId), setProfile), [api, partyId, readOne])
  const loadVault = useCallback(() => readOne(() => readVault(api, partyId), setVault), [api, partyId, readOne])
  const loadChanges = useCallback(() => (can.decideChanges ? readOne(() => readChanges(api, partyId).then((answer) => answer.requests), (read) => setChanges(read)) : Promise.resolve()), [api, can.decideChanges, partyId, readOne])
  const loadQualifications = useCallback(() => readOne(() => readQualifications(api, partyId), setQualifications), [api, partyId, readOne])
  const loadBank = useCallback(() => (can.bankView ? readOne(() => readBank(api, partyId), setBank) : Promise.resolve()), [api, can.bankView, partyId, readOne])
  const loadQuality = useCallback(
    () =>
      Promise.all([
        can.receipts ? readOne(() => readReceipts(api, partyId).then((answer) => answer.receipts), (read) => setReceipts(read)) : Promise.resolve(),
        can.claims ? readOne(() => readClaims(api, partyId).then((answer) => answer.items), (read) => setClaims(read)) : Promise.resolve(),
      ]),
    [api, can.claims, can.receipts, partyId, readOne],
  )

  const loadTab = useCallback(() => {
    if (tab === 'overview') void Promise.all([loadProfile(), loadVault()])
    else if (tab === 'contacts') void loadProfile()
    else if (tab === 'documents') void Promise.all([loadVault(), loadChanges(), loadQualifications()])
    else if (tab === 'quality') void loadQuality()
    else if (tab === 'bank') void loadBank()
  }, [loadBank, loadChanges, loadProfile, loadQualifications, loadQuality, loadVault, tab])

  useEffect(() => {
    loadTab()
  }, [loadTab])

  // ---- the Overview's draft ----
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState<string | null>(null)
  const [refused, setRefused] = useState<readonly string[]>([])
  const [tried, setTried] = useState(false)
  const dirty = draft !== null

  const live = useLiveBus({
    onChange: (change) => {
      const about = change.fields.partyId
      if (typeof about === 'string' && about !== partyId) return
      const type = change.type
      if (type.startsWith('supplier_bank_account.')) void loadBank()
      else if (type.startsWith('supplier_document.') || type.startsWith('supplier_profile.')) void Promise.all([loadVault(), loadChanges()])
      else if (type.startsWith('supplier_qualification.')) void loadQualifications()
      else if ((type === 'supplier.status_changed' || type.startsWith('party.')) && typeof about === 'string' && !dirty) void loadProfile()
    },
    onReconnect: () => loadTab(),
  })

  /** The party's version moved under us (a W1 save of the form): read the profile again. */
  const syncVersion = useCallback(
    (version: number) => {
      const read = valueOf(profile)
      if (read && read.version !== version && !dirty) void loadProfile()
    },
    [dirty, loadProfile, profile],
  )

  const saveDraft = async () => {
    const read = valueOf(profile)
    if (!read || !draft || saving) return
    setTried(true)
    if (Object.keys(profileProblems(draft)).length > 0) return
    const body = profileBody(read, draft)
    if (!body) {
      setDraft(null)
      return
    }
    setSaving(true)
    setSaveFailed(null)
    setRefused([])
    try {
      setProfile(ready(await saveProfile(api, partyId, body, newIdempotencyKey())))
      setDraft(null)
      setTried(false)
      reloadParty.current()
    } catch (error) {
      setSaveFailed(problemOf(error))
      setRefused(refusedOf(error))
      if (isApiError(error) && error.kind === 'conflict') void loadProfile()
    } finally {
      setSaving(false)
    }
  }

  // ---- status ----
  const [statusDialog, setStatusDialog] = useState<StatusDialogModel | null>(null)
  const openStatus = () => {
    const read = valueOf(profile)
    // The reason belongs to the new status: it starts empty (the one in force is shown beside the pill).
    if (read) setStatusDialog({ profile: read, to: null, reason: '', reach: null, busy: false, failed: null, tried: false })
  }
  const pickStatus = (to: SupplierStatus | null) => {
    setStatusDialog((current) => (current ? { ...current, to, reach: to ? LOADING : null, failed: null } : current))
    if (!to) return
    statusReach(api, partyId, to).then(
      (reach) => setStatusDialog((current) => (current && current.to === to ? { ...current, reach: ready(reach) } : current)),
      (error: unknown) => setStatusDialog((current) => (current && current.to === to ? { ...current, reach: failedRead(problemOf(error)) } : current)),
    )
  }
  const statusKey = useRef<string | null>(null)
  const confirmStatus = async () => {
    const dialog = statusDialog
    if (!dialog || dialog.busy) return
    setStatusDialog({ ...dialog, tried: true })
    if (reasonProblem(dialog.to, dialog.reason) || !dialog.to) return
    setStatusDialog({ ...dialog, tried: true, busy: true, failed: null })
    statusKey.current ??= newIdempotencyKey()
    try {
      setProfile(ready(await setStatus(api, partyId, { version: dialog.profile.version, status: dialog.to, reason: dialog.reason.trim() || null }, statusKey.current)))
      setStatusDialog(null)
      statusKey.current = null
      reloadParty.current()
    } catch (error) {
      statusKey.current = null
      setStatusDialog((current) => (current ? { ...current, busy: false, failed: problemOf(error) } : current))
      if (isApiError(error) && error.kind === 'conflict') void loadProfile()
    }
  }

  // ---- what each contact receives ----
  const [cells, setCells] = useState<Record<string, CellMark>>({})
  const [receivesNotice, setReceivesNotice] = useState<Words | null>(null)
  const toggle = async (contactId: string, kind: Receives, on: boolean) => {
    const read = valueOf(profile)
    const contact = read?.contacts.find((entry) => entry.id === contactId)
    if (!read || !contact) return
    const key = `${contactId}:${kind}`
    setCells((current) => ({ ...current, [key]: { state: 'saving' } }))
    setReceivesNotice(null)
    try {
      setProfile(ready(await setReceives(api, partyId, contactId, { version: contact.version, receives: toggled(contact, kind, on) }, newIdempotencyKey())))
      setCells((current) => ({ ...current, [key]: { state: 'saved' } }))
      reloadParty.current()
    } catch (error) {
      const problem = problemOf(error)
      setCells((current) => ({ ...current, [key]: { state: 'refused', words: say(problem === 'problem.invalid' ? 'receives.invalid' : problem) } }))
      if (problem === 'problem.conflict') {
        setReceivesNotice(say('receives.conflict'))
        void loadProfile()
      }
    }
  }

  // ---- documents: the office review, Request documents, qualifications ----
  const [docsDialog, setDocsDialog] = useState<DocumentsDialog | null>(null)
  const [docsNotice, setDocsNotice] = useState<Notice>(null)
  const docsKey = useRef<string | null>(null)
  const openDocs = (dialog: DocumentsDialog) => {
    docsKey.current = null
    setDocsDialog(dialog)
  }
  const busy = { busy: false, failed: null, tried: false }
  const vaultValue = valueOf(vault)
  const qualValue = valueOf(qualifications)

  const documents = {
    onRequest: () => openDocs({ kind: 'request', due: '', ...busy }),
    onAccept: (uploadId: string) => {
      const upload = vaultValue?.review.uploads.find((entry) => entry.uploadId === uploadId)
      if (!upload) return
      openDocs({ kind: 'accept', upload, draft: acceptDraftOf(upload), replaceable: (vaultValue?.documents ?? []).map((doc) => ({ fileId: doc.fileId, name: doc.name })), ...busy })
    },
    onRefuse: (uploadId: string) => {
      const upload = vaultValue?.review.uploads.find((entry) => entry.uploadId === uploadId)
      if (upload) openDocs({ kind: 'refuse', upload, reason: '', ...busy })
    },
    onApproveChange: (requestId: string) => {
      const request = valueOf(changes ?? LOADING)?.find((entry) => entry.requestId === requestId)
      if (request) openDocs({ kind: 'approveChange', request, ...busy })
    },
    onRefuseChange: (requestId: string) => {
      const request = valueOf(changes ?? LOADING)?.find((entry) => entry.requestId === requestId)
      if (request) openDocs({ kind: 'refuseChange', request, reason: '', ...busy })
    },
    onAskQualification: () => {
      const workshop = qualifiesWork(qualValue?.supplier.roles ?? [])
      openDocs({ kind: 'qualification', form: { kind: 'ask', workCentreKinds: [], materialKinds: [], validFrom: '', validUntil: '' }, workshop, companyId: session.company?.id ?? companies[0]?.id ?? '', ...busy })
    },
    onMove: (qualificationId: string, move: 'decide' | 'suspend' | 'lift' | 'withdraw') => {
      const row = qualValue?.qualifications.find((entry) => entry.id === qualificationId)
      if (!row) return
      const workshop = qualifiesWork(qualValue?.supplier.roles ?? [])
      if (move === 'lift') openDocs({ kind: 'lift', row, ...busy })
      else if (move === 'decide') openDocs({ kind: 'qualification', form: { kind: 'decide', id: row.id, decision: 'APPROVED', conditions: '', refuseReason: '', validFrom: row.validFrom ?? today, validUntil: row.validUntil ?? '' }, workshop, companyId: row.companyId, ...busy })
      else openDocs({ kind: 'qualification', form: { kind: move, id: row.id, reason: '' }, workshop, companyId: row.companyId, ...busy })
    },
  }

  const confirmDocs = async () => {
    const dialog = docsDialog
    if (!dialog || dialog.busy) return
    const tried = { ...dialog, tried: true } as DocumentsDialog
    setDocsDialog(tried)
    const held =
      dialog.kind === 'accept'
        ? acceptProblem(dialog.draft, today)
        : dialog.kind === 'refuse'
          ? refuseProblem(dialog.reason, 500)
          : dialog.kind === 'refuseChange'
            ? refuseProblem(dialog.reason, 600)
            : dialog.kind === 'request'
              ? dueProblem(dialog.due, today)
              : dialog.kind === 'qualification'
                ? qualificationProblem(dialog.form, dialog.workshop)
                : null
    if (held) return
    setDocsDialog({ ...tried, busy: true, failed: null } as DocumentsDialog)
    docsKey.current ??= newIdempotencyKey()
    const key = docsKey.current
    try {
      let done: Words
      if (dialog.kind === 'accept') {
        await acceptUpload(api, dialog.upload.fileId, { category: dialog.draft.category, expiresOn: dialog.draft.expiresOn || null, replacesFileId: dialog.draft.replacesFileId, version: dialog.upload.version }, key)
        done = say('review.accepted')
      } else if (dialog.kind === 'refuse') {
        await refuseUpload(api, dialog.upload.fileId, { reason: dialog.reason.trim(), version: dialog.upload.version }, key)
        done = say('review.refused')
      } else if (dialog.kind === 'approveChange') {
        await approveChange(api, dialog.request.requestId, key)
        done = say('review.changeApproved')
        reloadParty.current()
      } else if (dialog.kind === 'refuseChange') {
        await refuseChange(api, dialog.request.requestId, dialog.reason.trim(), key)
        done = say('review.changeRefused')
      } else if (dialog.kind === 'request') {
        const answer = await askForDocuments(api, partyId, { dueAt: dueInstant(dialog.due), ...(session.company ? { companyId: session.company.id } : {}) }, key)
        done = say(answer.made ? 'request.done' : 'request.already')
      } else if (dialog.kind === 'lift') {
        setQualifications(ready(await moveQualification(api, partyId, dialog.row.id, 'lift', { version: dialog.row.version }, key)))
        done = say('qual.done.lift')
      } else {
        const form = dialog.form
        if (form.kind === 'ask') {
          setQualifications(ready(await askQualification(api, partyId, { companyId: dialog.companyId, ...(dialog.workshop ? { workCentreKinds: [...form.workCentreKinds] } : { materialKinds: [...form.materialKinds] }), validFrom: form.validFrom || null, validUntil: form.validUntil || null }, key)))
          done = say('qual.done.ask')
        } else {
          const row = qualValue?.qualifications.find((entry) => entry.id === form.id)
          const version = row?.version ?? 1
          const body =
            form.kind === 'decide'
              ? { version, decision: form.decision, conditions: form.decision === 'CONDITIONAL' ? form.conditions.trim() : null, refuseReason: form.decision === 'REFUSED' ? form.refuseReason.trim() : null, ...(form.decision !== 'REFUSED' ? { validFrom: form.validFrom || null, validUntil: form.validUntil || null } : {}) }
              : { version, reason: form.reason.trim() }
          setQualifications(ready(await moveQualification(api, partyId, form.id, form.kind, body, key)))
          done = say(`qual.done.${form.kind}`)
        }
      }
      setDocsDialog(null)
      docsKey.current = null
      setDocsNotice({ tone: 'success', words: done })
      void Promise.all([loadVault(), loadChanges()])
    } catch (error) {
      docsKey.current = null
      // A yes with nothing it rests on: said in our words (the API names body/evidence).
      const failed = refusedOf(error).includes('evidence') ? 'qual.problem.noEvidence' : problemOf(error)
      setDocsDialog((current) => (current ? ({ ...current, busy: false, failed } as DocumentsDialog) : current))
      if (isApiError(error) && error.kind === 'conflict') void Promise.all([loadVault(), loadChanges(), loadQualifications()])
    }
  }

  const openFile = async (fileId: string) => {
    try {
      const link = await fileLink(api, fileId)
      const anchor = document.createElement('a')
      anchor.href = storeUrl(link.url)
      anchor.target = '_blank'
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    } catch (error) {
      setDocsNotice({ tone: 'danger', words: say(problemOf(error)) })
    }
  }

  // ---- bank ----
  const [bankDialog, setBankDialog] = useState<BankDialog | null>(null)
  const [bankNotice, setBankNotice] = useState<Notice>(null)
  const bankKey = useRef<string | null>(null)
  const bankValue = valueOf(bank)
  const accountOf = (accountId: string) => bankValue?.accounts.find((account) => account.id === accountId)
  const openBank = (dialog: BankDialog) => {
    bankKey.current = null
    setBankDialog(dialog)
  }
  const bankActions = {
    onPropose: () => openBank({ kind: 'propose', draft: EMPTY_PROPOSAL, review: false, ...busy }),
    onCallBack: (accountId: string) => {
      const account = accountOf(accountId)
      const first = account?.callBackCandidates?.usable[0]
      if (account) openBank({ kind: 'callBack', account, pick: first?.id ?? null, phone: first?.phone ?? '', ...busy })
    },
    onVerify: (accountId: string) => {
      const account = accountOf(accountId)
      if (account) openBank({ kind: 'verify', account, ...busy })
    },
    onRefuse: (accountId: string) => {
      const account = accountOf(accountId)
      if (account) openBank({ kind: 'refuse', account, reason: '', ...busy })
    },
    onRetire: (accountId: string) => {
      const account = accountOf(accountId)
      if (account) openBank({ kind: 'retire', account, reason: '', ...busy })
    },
    onReveal: (accountId: string) => {
      const account = accountOf(accountId)
      if (account) openBank({ kind: 'reveal', account, grouped: null, ...busy })
    },
  }

  const confirmBank = async () => {
    const dialog = bankDialog
    if (!dialog || dialog.busy) return
    const tried = { ...dialog, tried: true } as BankDialog
    setBankDialog(tried)
    if (dialog.kind === 'propose' && !dialog.review) {
      if (Object.keys(proposalProblems(dialog.draft)).length === 0) setBankDialog({ ...dialog, review: true, tried: false })
      return
    }
    if (dialog.kind === 'callBack') {
      const picked = dialog.account.callBackCandidates?.usable.find((entry) => entry.id === dialog.pick)
      if (!picked || !phoneMatches(dialog.phone, picked.phone)) return
    }
    if ((dialog.kind === 'refuse' || dialog.kind === 'retire') && refuseProblem(dialog.reason, dialog.kind === 'refuse' ? 2000 : 500)) return
    setBankDialog({ ...tried, busy: true, failed: null } as BankDialog)
    bankKey.current ??= newIdempotencyKey()
    const key = bankKey.current
    try {
      if (dialog.kind === 'propose') {
        const answer = await guard('bank.stepUp.propose', () => proposeBank(api, partyId, proposalBody(dialog.draft), key))
        setBank(ready(answer))
        setBankNotice({ tone: 'success', words: say('bank.done.proposed') })
      } else if (dialog.kind === 'callBack') {
        const picked = dialog.account.callBackCandidates?.usable.find((entry) => entry.id === dialog.pick)!
        setBank(ready(await callBack(api, partyId, dialog.account.id, { version: dialog.account.version, ...(picked.kind === 'CONTACT' ? { contactId: picked.id } : { addressId: picked.id }), phone: dialog.phone.trim() }, key)))
        setBankNotice({ tone: 'success', words: say('bank.done.calledBack') })
      } else if (dialog.kind === 'verify') {
        const answer = await guard('bank.stepUp.verify', () => verifyBank(api, partyId, dialog.account.id, dialog.account.version, key))
        setBank(ready(answer))
        setBankNotice(answer.approval ? { tone: 'info', words: say('bank.done.waitsYes') } : { tone: 'success', words: say('bank.done.verified') })
      } else if (dialog.kind === 'refuse') {
        setBank(ready(await refuseBank(api, partyId, dialog.account.id, { version: dialog.account.version, reason: dialog.reason.trim() }, key)))
        setBankNotice({ tone: 'warning', words: say('bank.done.refused') })
      } else if (dialog.kind === 'retire') {
        setBank(ready(await retireBank(api, partyId, dialog.account.id, { version: dialog.account.version, reason: dialog.reason.trim() }, key)))
        setBankNotice({ tone: 'warning', words: say('bank.done.retired') })
      } else {
        const answer = await guard('bank.stepUp.reveal', () => revealBank(api, partyId, dialog.account.id, key))
        setBankDialog({ ...dialog, grouped: answer.grouped, busy: false, failed: null, tried: false })
        bankKey.current = null
        return
      }
      setBankDialog(null)
      bankKey.current = null
    } catch (error) {
      if (isStepUpCancelled(error)) {
        setBankDialog((current) => (current ? ({ ...current, busy: false } as BankDialog) : current))
        return
      }
      bankKey.current = null
      const problem = problemOf(error)
      const refusal = isApiError(error) && error.kind === 'forbidden' && error.issues.some((issue) => String((issue as { path?: unknown }).path ?? '').includes('OWN')) ? 'bank.problem.own' : problem
      setBankDialog((current) => (current ? ({ ...current, busy: false, failed: refusal, ...(current.kind === 'propose' ? { review: refusal === 'problem.invalid' ? false : current.review } : {}) } as BankDialog) : current))
      if (isApiError(error) && error.kind === 'conflict') void loadBank()
    }
  }

  return {
    can,
    me,
    today,
    tab,
    companies,
    live,
    setReloadParty: (reload: () => void) => {
      reloadParty.current = reload
    },
    syncVersion,
    profile: {
      read: profile,
      draft,
      saving,
      failed: saveFailed,
      refused,
      tried,
      onDraft: (next: ProfileDraft) => {
        const read = valueOf(profile)
        setDraft(read && JSON.stringify(next) === JSON.stringify(draftOf(read)) ? null : next)
      },
      onSave: () => void saveDraft(),
      onDiscard: () => {
        setDraft(null)
        setTried(false)
        setSaveFailed(null)
        setRefused([])
      },
      onRetry: () => void loadProfile(),
    },
    status: {
      dialog: statusDialog,
      onOpen: openStatus,
      onPick: pickStatus,
      onReason: (reason: string) => setStatusDialog((current) => (current ? { ...current, reason } : current)),
      onConfirm: () => void confirmStatus(),
      onClose: () => setStatusDialog((current) => (current?.busy ? current : null)),
    },
    receives: { cells, notice: receivesNotice, onToggle: (contactId: string, kind: Receives, on: boolean) => void toggle(contactId, kind, on) },
    documents: {
      vault,
      changes,
      qualifications,
      dialog: docsDialog,
      notice: docsNotice,
      ...documents,
      onOpenFile: (fileId: string) => void openFile(fileId),
      onRetry: () => void Promise.all([loadVault(), loadChanges(), loadQualifications()]),
      onDismissNotice: () => setDocsNotice(null),
      dialogs: {
        onAcceptDraft: (next: Extract<DocumentsDialog, { kind: 'accept' }>['draft']) => setDocsDialog((current) => (current?.kind === 'accept' ? { ...current, draft: next } : current)),
        onReason: (reason: string) => setDocsDialog((current) => (current && (current.kind === 'refuse' || current.kind === 'refuseChange') ? { ...current, reason } : current)),
        onDue: (due: string) => setDocsDialog((current) => (current?.kind === 'request' ? { ...current, due } : current)),
        onForm: (form: Extract<DocumentsDialog, { kind: 'qualification' }>['form']) => setDocsDialog((current) => (current?.kind === 'qualification' ? { ...current, form } : current)),
        onCompany: (companyId: string) => setDocsDialog((current) => (current?.kind === 'qualification' ? { ...current, companyId } : current)),
        onConfirm: () => void confirmDocs(),
        onClose: () => setDocsDialog((current) => (current?.busy ? current : null)),
      },
    },
    bank: {
      read: bank,
      dialog: bankDialog,
      notice: bankNotice,
      stepUp,
      ...bankActions,
      onOpenFile: (fileId: string) => void openFile(fileId),
      onRetry: () => void loadBank(),
      onDismissNotice: () => setBankNotice(null),
      onStepUpCode: (code: string) => void submitStepUp(code),
      onStepUpClose: cancelStepUp,
      dialogs: {
        onDraft: (next: Extract<BankDialog, { kind: 'propose' }>['draft']) => setBankDialog((current) => (current?.kind === 'propose' ? { ...current, draft: next } : current)),
        onReview: (review: boolean) => setBankDialog((current) => (current?.kind === 'propose' ? { ...current, review } : current)),
        onPick: (pick: string, phone: string | null) => setBankDialog((current) => (current?.kind === 'callBack' ? { ...current, pick, phone: phone ?? '' } : current)),
        onPhone: (phone: string) => setBankDialog((current) => (current?.kind === 'callBack' ? { ...current, phone } : current)),
        onReason: (reason: string) => setBankDialog((current) => (current && (current.kind === 'refuse' || current.kind === 'retire') ? { ...current, reason } : current)),
        onConfirm: () => void confirmBank(),
        // The whole IBAN leaves with the dialog.
        onClose: () => setBankDialog((current) => (current?.busy ? current : null)),
      },
    },
    quality: { receipts, claims },
  }
}

export type SupplierDepthState = ReturnType<typeof useSupplierDepth>
