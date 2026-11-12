'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { isStepUpCancelled, useStepUp } from '../../../admin/shared/step-up'
import {
  accessCopy,
  addRequirement,
  endRequirement,
  eraseContact,
  placeHold,
  readCompanyTerms,
  readGlance,
  readHolds,
  readPartyFiles,
  readPrivacy,
  readRequirements,
  recordObjection,
  releaseHold,
  replaceRequirement,
  searchStyles,
  setLawfulBasis,
  setPoNumberRequired,
  type CompanyTerms,
  type Glance,
  type Hold,
  type Holds,
  type PartyFile,
  type Privacy,
  type PrivacyContact,
  type Requirement,
  type Requirements,
  type StyleOption,
} from './api'
import {
  basisBody,
  basisDraftOf,
  basisProblems,
  blankRequirement,
  depthCan,
  endReasonProblem,
  failedRead,
  holdDraftProblem,
  holdRefusal,
  LOADING,
  poChanges,
  poRows,
  privacyRefusal,
  problemOf,
  ready,
  requirementBody,
  requirementDraftOf,
  requirementProblems,
  requirementRefusal,
  todayOf,
  valueOf,
  wordsProblem,
  type HoldDialog,
  type Notice,
  type PrivacyDialog,
  type Read,
  type RequirementDialog,
} from './model'

/**
 * The customer record's W2b container (B-W2b-324): reads the customer at a glance on the Overview (one call; again on the
 * live events of this customer and on a reconnect), the holds and the PO number per company on Tax & terms, the
 * requirements on their tab, the contacts' privacy on Addresses & contacts; does every write with the version read and one
 * Idempotency-Key per attempt (a 409 reads again and says someone else changed it); an erasure asks a fresh code (the
 * step-up opens on the API's 403 `stepUp` and runs once more). After a write the glance is read again, and the party
 * when a contact changed (the record's own read).
 */
export function useCustomerDepth(partyId: string) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const tab = params?.get('tab') ?? 'overview'
  const can = useMemo(() => depthCan(session.permissions), [session.permissions])
  const today = useMemo(() => todayOf(), [])
  const companyId = session.company?.id ?? null
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const reloadParty = useRef<() => void>(() => undefined)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  // ---- reads ----
  const [glance, setGlance] = useState<Read<Glance>>(LOADING)
  const [holds, setHolds] = useState<Read<Holds>>(LOADING)
  const [terms, setTerms] = useState<Read<CompanyTerms>>(LOADING)
  const [requirements, setRequirements] = useState<Read<Requirements>>(LOADING)
  const [privacy, setPrivacy] = useState<Read<Privacy>>(LOADING)

  const readOne = useCallback(async <T,>(work: () => Promise<T>, set: (read: Read<T>) => void) => {
    try {
      set(ready(await work()))
    } catch (error) {
      set(failedRead(problemOf(error)))
    }
  }, [])
  const loadGlance = useCallback(() => readOne(() => readGlance(api, partyId, companyId), setGlance), [api, companyId, partyId, readOne])
  const loadHolds = useCallback(() => readOne(() => readHolds(api, partyId), setHolds), [api, partyId, readOne])
  const loadTerms = useCallback(() => readOne(() => readCompanyTerms(api, partyId), setTerms), [api, partyId, readOne])
  const loadRequirements = useCallback(() => readOne(() => readRequirements(api, partyId), setRequirements), [api, partyId, readOne])
  const loadPrivacy = useCallback(() => readOne(() => readPrivacy(api, partyId), setPrivacy), [api, partyId, readOne])

  const loadTab = useCallback(() => {
    if (tab === 'overview') void loadGlance()
    else if (tab === 'tax') void Promise.all([loadHolds(), loadTerms()])
    else if (tab === 'requirements') void loadRequirements()
    else if (tab === 'addresses') void loadPrivacy()
  }, [loadGlance, loadHolds, loadPrivacy, loadRequirements, loadTerms, tab])

  useEffect(() => {
    loadTab()
  }, [loadTab])

  // Live: a change of this customer (or one that names no customer) reads the tab shown again, a burst once.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const live = useLiveBus({
    onChange: (change) => {
      const about = change.fields.partyId ?? change.fields.customerId
      if (typeof about === 'string' && about !== partyId) return
      if (!/^(party\.|sample_round\.|repair|sales_order\.|credit_|payment\.|invoice\.|quote\.)/.test(change.type)) return
      if (pending.current) clearTimeout(pending.current)
      pending.current = setTimeout(() => loadTab(), 400)
    },
    onReconnect: () => loadTab(),
  })
  useEffect(() => () => (pending.current ? clearTimeout(pending.current) : undefined), [])

  const [notice, setNotice] = useState<Notice>(null)

  // ---- Tax & terms › Hold ----
  const [holdDialog, setHoldDialog] = useState<HoldDialog | null>(null)
  const openPlace = () => setHoldDialog({ kind: 'place', draft: { companyId, reason: null, words: '' }, busy: false, failed: null, tried: false })
  const openRelease = (hold: Hold) => setHoldDialog({ kind: 'release', hold, draft: { holdId: hold.id, words: '' }, busy: false, failed: null, tried: false })
  const confirmHold = async () => {
    const dialog = holdDialog
    if (!dialog || dialog.busy) return
    const problem = holdDraftProblem(dialog.kind === 'place' ? dialog.draft : { words: dialog.draft.words }, dialog.kind)
    if (problem) {
      setHoldDialog({ ...dialog, tried: true })
      return
    }
    setHoldDialog({ ...dialog, busy: true, failed: null, tried: true })
    try {
      const answer =
        dialog.kind === 'place'
          ? await placeHold(api, partyId, { companyId: dialog.draft.companyId, reason: dialog.draft.reason!, words: dialog.draft.words.trim() }, newIdempotencyKey())
          : await releaseHold(api, partyId, dialog.hold.id, { version: dialog.hold.version, words: dialog.draft.words.trim() }, newIdempotencyKey())
      setHolds(ready(answer))
      setHoldDialog(null)
      setNotice({ tone: 'success', words: { key: dialog.kind === 'place' ? 'hold.placed' : 'hold.released' } })
      void loadGlance()
    } catch (error) {
      setHoldDialog({ ...dialog, busy: false, failed: holdRefusal(error), tried: true })
      if (isApiError(error) && error.kind === 'conflict') void loadHolds()
    }
  }
  const toggleHold = (on: boolean) => {
    const read = valueOf(holds)
    if (!read) return
    if (on) openPlace()
    else {
      const inForce = read.holds.filter((hold) => hold.inForce)
      if (inForce.length === 1) openRelease(inForce[0]!)
    }
  }

  // ---- Customer PO number required ----
  const [poDraft, setPoDraft] = useState<Readonly<Record<string, boolean>>>({})
  const [poSaving, setPoSaving] = useState(false)
  const [poFailed, setPoFailed] = useState<string | null>(null)
  const savePo = async () => {
    const read = valueOf(terms)
    if (!read || poSaving) return
    const changes = poChanges(poRows(read), poDraft)
    if (changes.length === 0) {
      setPoDraft({})
      return
    }
    setPoSaving(true)
    setPoFailed(null)
    try {
      let answer: CompanyTerms = read
      for (const row of changes) answer = await setPoNumberRequired(api, partyId, row.companyId, { ...(row.version !== null ? { version: row.version } : {}), poNumberRequired: poDraft[row.companyId]! }, newIdempotencyKey())
      setTerms(ready(answer))
      setPoDraft({})
      setNotice({ tone: 'success', words: { key: 'po.saved', params: { count: changes.length } } })
    } catch (error) {
      setPoFailed(problemOf(error))
      void loadTerms()
    } finally {
      setPoSaving(false)
    }
  }

  // ---- Requirements ----
  const [reqDialog, setReqDialog] = useState<RequirementDialog | null>(null)
  const [styles, setStyles] = useState<Read<readonly StyleOption[]> | null>(null)
  const [files, setFiles] = useState<Read<readonly PartyFile[]> | null>(null)
  const loadPickers = () => {
    if (can.styles && styles === null) {
      setStyles(LOADING)
      void readOne(() => searchStyles(api, ''), setStyles)
    }
    if (can.files && files === null) {
      setFiles(LOADING)
      void readOne(() => readPartyFiles(api, partyId), setFiles)
    }
  }
  const openAdd = () => {
    loadPickers()
    setReqDialog({ kind: 'add', target: null, draft: blankRequirement(companyId), busy: false, failed: null, tried: false })
  }
  const openReplace = (row: Requirement) => {
    loadPickers()
    setReqDialog({ kind: 'replace', target: row, draft: requirementDraftOf(row), busy: false, failed: null, tried: false })
  }
  const openEnd = (row: Requirement) => setReqDialog({ kind: 'end', target: row, reason: '', busy: false, failed: null, tried: false })
  const confirmRequirement = async () => {
    const dialog = reqDialog
    if (!dialog || dialog.busy) return
    if (dialog.kind === 'end' ? endReasonProblem(dialog.reason) : Object.keys(requirementProblems(dialog.draft)).length > 0) {
      setReqDialog({ ...dialog, tried: true })
      return
    }
    setReqDialog({ ...dialog, busy: true, failed: null, tried: true })
    try {
      const answer =
        dialog.kind === 'end'
          ? await endRequirement(api, partyId, dialog.target.id, { version: dialog.target.version, reason: dialog.reason.trim() }, newIdempotencyKey())
          : dialog.kind === 'replace'
            ? await replaceRequirement(api, partyId, dialog.target!.id, { ...requirementBody(dialog.draft), version: dialog.target!.version, reason: dialog.draft.reason.trim() || null }, newIdempotencyKey())
            : await addRequirement(api, partyId, requirementBody(dialog.draft), newIdempotencyKey())
      setRequirements(ready(answer))
      setReqDialog(null)
      setNotice({ tone: 'success', words: { key: `req.done.${dialog.kind}` } })
      void loadGlance()
    } catch (error) {
      setReqDialog({ ...dialog, busy: false, failed: requirementRefusal(error), tried: true })
      if (isApiError(error) && error.kind === 'conflict') void loadRequirements()
    }
  }

  // ---- contacts: lawful basis, objection, access copy, erasure ----
  const [privacyDialog, setPrivacyDialog] = useState<PrivacyDialog | null>(null)
  const openPrivacy = (kind: PrivacyDialog['kind'], contact: PrivacyContact) => {
    if (kind === 'basis') setPrivacyDialog({ kind, contact, draft: basisDraftOf(contact), busy: false, failed: null, portal: false, tried: false })
    else setPrivacyDialog({ kind, contact, words: '', busy: false, failed: null, portal: false, tried: false, copy: null, kept: null })
  }
  const confirmPrivacy = async () => {
    const dialog = privacyDialog
    if (!dialog || dialog.busy) return
    const problem = dialog.kind === 'basis' ? Object.keys(basisProblems(dialog.draft, today)).length > 0 : wordsProblem(dialog.words) !== null
    if (problem) {
      setPrivacyDialog({ ...dialog, tried: true })
      return
    }
    setPrivacyDialog({ ...dialog, busy: true, failed: null, portal: false, tried: true })
    const contact = dialog.contact
    try {
      if (dialog.kind === 'basis') {
        setPrivacy(ready(await setLawfulBasis(api, partyId, contact.id, basisBody(dialog.draft, contact.version), newIdempotencyKey())))
        setPrivacyDialog(null)
        setNotice({ tone: 'success', words: { key: 'privacy.done.basis', params: { name: contact.name } } })
      } else if (dialog.kind === 'objection') {
        setPrivacy(ready(await recordObjection(api, partyId, contact.id, { version: contact.version, words: dialog.words.trim() }, newIdempotencyKey())))
        setPrivacyDialog(null)
        setNotice({ tone: 'success', words: { key: 'privacy.done.objection', params: { name: contact.name } } })
      } else if (dialog.kind === 'copy') {
        const copy = await accessCopy(api, partyId, contact.id, { words: dialog.words.trim() }, newIdempotencyKey())
        setPrivacyDialog({ ...dialog, busy: false, copy })
      } else {
        const erased = await guard('erase.stepUp', () => eraseContact(api, partyId, contact.id, { version: contact.version, words: dialog.words.trim() }, newIdempotencyKey()))
        setPrivacy(ready(erased.privacy))
        setPrivacyDialog({ ...dialog, busy: false, kept: erased.kept })
        reloadParty.current()
      }
    } catch (error) {
      if (isStepUpCancelled(error)) {
        setPrivacyDialog({ ...dialog, busy: false, failed: 'erase.notErased' })
        return
      }
      const refusal = privacyRefusal(error)
      setPrivacyDialog({ ...dialog, busy: false, failed: refusal.key, portal: refusal.portal })
      if (isApiError(error) && error.kind === 'conflict' && !refusal.portal) void loadPrivacy()
    }
  }

  return {
    can,
    today,
    companyId,
    companies,
    live,
    notice,
    onDismissNotice: () => setNotice(null),
    setReloadParty: (reload: () => void) => {
      reloadParty.current = reload
    },
    glance: { read: glance, onRetry: () => void loadGlance() },
    holds: {
      read: holds,
      dialog: holdDialog,
      onPlace: openPlace,
      onRelease: openRelease,
      onToggle: toggleHold,
      onDraft: (dialog: HoldDialog) => setHoldDialog(dialog),
      onConfirm: () => void confirmHold(),
      onClose: () => setHoldDialog(null),
      onRetry: () => void loadHolds(),
    },
    po: {
      read: terms,
      draft: poDraft,
      saving: poSaving,
      failed: poFailed,
      onToggle: (company: string, on: boolean) => setPoDraft((current) => ({ ...current, [company]: on })),
      onSave: () => void savePo(),
      onDiscard: () => {
        setPoDraft({})
        setPoFailed(null)
      },
      onRetry: () => void loadTerms(),
    },
    requirements: {
      read: requirements,
      dialog: reqDialog,
      styles,
      files,
      onAdd: openAdd,
      onReplace: openReplace,
      onEnd: openEnd,
      onDraft: (dialog: RequirementDialog) => setReqDialog(dialog),
      onConfirm: () => void confirmRequirement(),
      onClose: () => setReqDialog(null),
      onRetry: () => void loadRequirements(),
    },
    privacy: {
      read: privacy,
      dialog: privacyDialog,
      stepUp,
      onOpen: openPrivacy,
      onDraft: (dialog: PrivacyDialog) => setPrivacyDialog(dialog),
      onConfirm: () => void confirmPrivacy(),
      onClose: () => setPrivacyDialog(null),
      onRetry: () => void loadPrivacy(),
      onStepUpCode: (code: string) => void submitStepUp(code),
      onStepUpClose: cancelStepUp,
    },
  }
}

export type CustomerDepthState = ReturnType<typeof useCustomerDepth>
