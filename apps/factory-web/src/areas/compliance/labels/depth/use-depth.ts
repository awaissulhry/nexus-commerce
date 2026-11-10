'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import type { ApiClient } from '../../../../lib/api/client'
import { pictureAddress } from '../../../../lib/proofs/address'
import { failedRead, problemKey, reading, ready, type Notice, type Read } from '../../../quality/_shared/model'
import type { LabelDetail } from '../api'
import type { LabelDraft } from '../model'
import type { LabelRecordActions, PickedProof, RecordDepth, RecordDialog, RecordTab } from '../view-model'
import {
  addArtwork,
  approveArtwork,
  approveTranslation,
  proofBytes,
  proposeTranslation,
  readArtwork,
  readLabelChecks,
  readPhrases,
  readTextileChecks,
  removeArtwork,
  retireArtwork,
  saveMarking,
  uploadProof,
  type Artwork,
  type LabelChecks,
  type Phrases,
  type TextileChecks,
} from './api'
import { depthCan, fillFromLibrary, isPdf, labelPhraseSpecs, languageColumns, markingDirty, markingPatch, phraseRows, proofFileProblem, type MarkingDraft } from './model'

/** Opens a tab on the click (no blocker stops it) and sends it to an address that comes later; closes it on a refusal. */
function openLater(): { go: (url: string) => void; fail: () => void } {
  const tab = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null
  return {
    go: (url) => {
      if (tab && !tab.closed) tab.location.href = url
      else window.open(url, '_blank', 'noopener')
    },
    fail: () => tab?.close(),
  }
}

/** A refusal in our words (a key of compliance-labels-depth) with the API's sentences kept as data. */
function refusal(error: unknown, fallback: string): { key: string; lines?: readonly string[] } {
  if (!isApiError(error)) return { key: fallback }
  const lines = error.issues.map((issue) => issue.message ?? '').filter(Boolean)
  if (error.kind === 'conflict') return { key: 'problem.conflict', lines }
  if (error.kind === 'invalid') return { key: 'problem.invalid', lines }
  if (error.kind === 'forbidden') return { key: 'problem.forbidden' }
  return { key: fallback, lines }
}

export interface DepthInput {
  api: ApiClient
  me: string
  permissions: readonly string[]
  detail: LabelDetail | null
  /** The style the checks are read for (the label's, else the first naming it); null: none. */
  styleId: string | null
  tab: RecordTab
  draft: LabelDraft | null
  setDraft: (draft: LabelDraft) => void
  setDialog: (dialog: RecordDialog | null) => void
  dialog: RecordDialog | null
  setBusy: (busy: boolean) => void
  setNotice: (notice: Notice | null) => void
  /** The sample label of the preview's cell as a PDF (W1's print sheet). */
  samplePdf: () => Promise<Uint8Array>
}

/**
 * The label record's W2b container part (B-W2b-270): reads the marking checks per market and the textile checks with the
 * label (again after each save), the artwork with the label (its tab count; again on its live events), the phrase library's
 * cells with the Languages tab; keeps the draft's marking, the proof picked, the cell being written; and writes one thing
 * at a time with the version read: a proposal, approvals (one after another), a proof added / approved / retired / removed,
 * the proof opened in a new tab. LabelRecord.tsx joins it with W1's container (Save sends W1's patch, then the marking).
 */
export function useLabelDepth(input: DepthInput) {
  const { api, detail, styleId, tab, draft } = input
  const can = useMemo(() => depthCan(input.permissions), [input.permissions])
  const [checks, setChecks] = useState<Read<LabelChecks>>(reading())
  const [market, setMarket] = useState<string | null>(null)
  const [textile, setTextile] = useState<Read<TextileChecks> | null>(null)
  const [marking, setMarking] = useState<MarkingDraft | null>(null)
  const [artwork, setArtwork] = useState<Read<Artwork>>(reading())
  const [proof, setProof] = useState<RecordDepth['proof']>(null)
  const [picked, setPicked] = useState<PickedProof | null>(null)
  const [phrases, setPhrases] = useState<Read<Phrases>>(reading())
  const [selectedPhrases, setSelectedPhrases] = useState<readonly string[]>([])
  const [writing, setWriting] = useState<string | null>(null)
  const [cellProblem, setCellProblem] = useState<RecordDepth['cellProblem']>(null)
  const id = detail?.id ?? null
  const version = detail?.version ?? null

  // The revision the textile checks read: one naming this label (released first), else the API's own choice.
  const revisionId = detail ? (detail.usage.styleRevisions.filter((entry) => entry.styleId === styleId).sort((a, b) => Number(b.status === 'RELEASED') - Number(a.status === 'RELEASED'))[0]?.id ?? null) : null

  const loadChecks = useCallback(async () => {
    if (!id) return
    if (!styleId) {
      setChecks(failedRead('depth.needStyle'))
      return
    }
    setChecks((current) => (current.value ? current : reading()))
    try {
      setChecks(ready(await readLabelChecks(api, id, { styleId: detail?.styleId ? undefined : styleId })))
    } catch (error) {
      setChecks(failedRead(problemKey(error)))
    }
    // The label's content moves the checks: read again with each saved version.
  }, [api, id, styleId, version])

  const loadTextile = useCallback(async () => {
    if (!styleId) {
      setTextile(null)
      return
    }
    setTextile((current) => (current?.value ? current : reading()))
    try {
      setTextile(ready(await readTextileChecks(api, styleId, { revisionId })))
    } catch (error) {
      setTextile(failedRead(problemKey(error)))
    }
  }, [api, styleId, revisionId, version])

  const loadArtwork = useCallback(async () => {
    if (!id) return
    try {
      setArtwork(ready(await readArtwork(api, id)))
    } catch (error) {
      setArtwork(failedRead(problemKey(error)))
    }
  }, [api, id])

  // The columns of the Languages tab: the label's languages and those the switched-on markets need on labels.
  const languages = useMemo(() => {
    const own = draft?.languages ?? detail?.languages ?? []
    return languageColumns(own, (checks.value?.markets ?? []).map((entry) => entry.market)).map((column) => column.language)
  }, [draft?.languages, detail?.languages, checks.value])
  const languageKey = languages.join(',')

  const loadPhrases = useCallback(async () => {
    if (!checks.value || languageKey === '') return
    setPhrases((current) => (current.value ? current : reading()))
    try {
      setPhrases(ready(await readPhrases(api, languageKey.split(','))))
    } catch (error) {
      setPhrases(failedRead(problemKey(error)))
    }
  }, [api, checks.value, languageKey])

  useEffect(() => {
    void loadChecks()
  }, [loadChecks])
  useEffect(() => {
    void loadTextile()
  }, [loadTextile])
  useEffect(() => {
    void loadArtwork()
  }, [loadArtwork])
  useEffect(() => {
    if (tab === 'languages') void loadPhrases()
  }, [tab, loadPhrases])
  // Another label (a new revision): its own marking and selection.
  useEffect(() => {
    setMarking(null)
    setSelectedPhrases([])
    setCellProblem(null)
  }, [id])

  // ---- the approve dialog's proof: its bytes (a PDF) or its picture's address, read when the dialog opens ----
  const proofFor = input.dialog?.kind === 'approveProof' ? input.dialog.versionId : null
  const loadProof = useCallback(async () => {
    const entry = artwork.value?.versions.find((item) => item.id === proofFor)
    if (!entry?.file) return
    setProof({ versionId: entry.id, src: reading() })
    try {
      const bytes = await proofBytes(api, entry.file.id)
      setProof({ versionId: entry.id, src: ready(isPdf(entry.file.contentType) ? bytes : pictureAddress(bytes, entry.file.contentType)) })
    } catch (error) {
      setProof({ versionId: entry.id, src: failedRead(problemKey(error)) })
    }
  }, [api, artwork.value, proofFor])
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (!proofFor) {
      asked.current = null
      return
    }
    if (asked.current === proofFor) return
    asked.current = proofFor
    void loadProof()
  }, [proofFor, loadProof])

  // ---- writes ----
  const artworkWrite = async (at: string, work: () => Promise<Artwork>, done: (value: Artwork) => void) => {
    input.setBusy(true)
    setCellProblem(null)
    try {
      const value = await work()
      setArtwork(ready(value))
      done(value)
    } catch (error) {
      setCellProblem({ at, ...refusal(error, 'problem.failed') })
      void loadArtwork()
    } finally {
      input.setBusy(false)
    }
  }

  const propose = async (key: string, language: string, text: string, draftVersion?: number) => {
    const at = `${key}|${language}`
    setWriting(at)
    setCellProblem(null)
    try {
      const phrase = await proposeTranslation(api, key, { language, text, ...(draftVersion ? { version: draftVersion } : {}) })
      setPhrases((current) => (current.value ? ready({ ...current.value, phrases: current.value.phrases.map((entry) => (entry.key === phrase.key ? phrase : entry)) }) : current))
    } catch (error) {
      setCellProblem({ at, ...refusal(error, 'problem.proposeFailed') })
    } finally {
      setWriting(null)
    }
  }

  const approveTranslations = async (entries: readonly { key: string; draft: { id: string; version: number } }[]) => {
    let done = 0
    for (const entry of entries) {
      setWriting(`${entry.key}|*`)
      try {
        const phrase = await approveTranslation(api, entry.key, entry.draft)
        setPhrases((current) => (current.value ? ready({ ...current.value, phrases: current.value.phrases.map((item) => (item.key === phrase.key ? phrase : item)) }) : current))
        done += 1
      } catch (error) {
        setCellProblem({ at: `${entry.key}|*`, ...refusal(error, 'problem.approveFailed') })
        break
      }
    }
    setWriting(null)
    setSelectedPhrases([])
    if (done > 0) input.setNotice({ key: 'depth.done.approvedTranslations', params: { count: done }, tone: 'success' })
    void loadChecks()
  }

  const openProof = async (versionId: string | null) => {
    const value = artwork.value
    const entry = versionId ? value?.versions.find((item) => item.id === versionId) : value?.versions.find((item) => item.id === value.approvedId)
    const tab = openLater()
    try {
      if (entry?.file) {
        const bytes = await proofBytes(api, entry.file.id)
        tab.go(URL.createObjectURL(new Blob([bytes as BlobPart], { type: entry.file.contentType })))
      } else {
        const bytes = await input.samplePdf()
        tab.go(URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' })))
      }
    } catch {
      tab.fail()
      input.setNotice({ key: 'depth.notice.proofFailed', tone: 'warning' })
    }
  }

  const depth: RecordDepth = { can, me: input.me, checks, market, textile, marking, artwork, proof, picked, phrases, selectedPhrases, writing, cellProblem }

  const actions: Partial<LabelRecordActions> = {
    onMarket: setMarket,
    onMarking: setMarking,
    onRetryChecks: () => void loadChecks(),
    onRetryTextile: () => void loadTextile(),
    onRetryArtwork: () => void loadArtwork(),
    onRetryPhrases: () => void loadPhrases(),
    onRetryProof: () => void loadProof(),
    onSelectPhrases: setSelectedPhrases,
    onFillFromLibrary: () => {
      if (!draft || !detail || !checks.value || !phrases.value) return
      const columns = languageColumns(draft.languages, checks.value.markets.map((entry) => entry.market))
      const rows = phraseRows(labelPhraseSpecs({ animalOriginPhrase: draft.animalOriginPhrase, care: draft.care, originClaimKey: detail.originClaimKey }, checks.value.marking.warnings), phrases.value.phrases, columns, { layout: { ...detail.layout, texts: { animalOrigin: draft.animalOriginTexts } }, care: draft.care })
      const filled = fillFromLibrary(draft, rows)
      if (filled.filled === 0) return
      input.setDraft(filled.draft)
      input.setNotice({ key: 'depth.done.filled', params: { count: filled.filled }, tone: 'success' })
    },
    onPropose: (key, language, text, draftVersion) => void propose(key, language, text, draftVersion),
    onApproveTranslations: (entries) => void approveTranslations(entries),
    onPickProof: (file) => {
      setCellProblem(null)
      if (!file) return setPicked(null)
      file
        .arrayBuffer()
        .then((bytes) => setPicked({ name: file.name, contentType: file.type || 'application/octet-stream', size: file.size, bytes }))
        .catch(() => setCellProblem({ at: 'proof|add', key: 'artwork.problem.read' }))
    },
    onAddProof: (note) => {
      if (!detail || !picked || proofFileProblem({ contentType: picked.contentType, size: picked.size })) return
      void artworkWrite(
        'proof|add',
        async () => addArtwork(api, detail.id, { fileId: await uploadProof(api, { id: detail.id, companyId: detail.companyId }, picked), note: note.trim() || null }),
        (value) => {
          setPicked(null)
          input.setDialog(null)
          input.setNotice({ key: 'depth.done.proofAdded', params: { n: value.versions[0]?.versionNo ?? '—' }, tone: 'success' })
        },
      )
    },
    onApproveProof: (versionId, reason) => {
      const entry = artwork.value?.versions.find((item) => item.id === versionId)
      if (!entry) return
      void artworkWrite(`proof|${versionId}`, () => approveArtwork(api, entry, reason), () => {
        input.setDialog(null)
        input.setNotice({ key: 'depth.done.proofApproved', params: { n: entry.versionNo }, tone: 'success' })
      })
    },
    onRetireProof: (versionId, reason) => {
      const entry = artwork.value?.versions.find((item) => item.id === versionId)
      if (!entry) return
      void artworkWrite(`proof|${versionId}`, () => retireArtwork(api, entry, reason), () => {
        input.setDialog(null)
        input.setNotice({ key: 'depth.done.proofRetired', params: { n: entry.versionNo }, tone: 'success' })
      })
    },
    onRemoveProof: (versionId) => {
      const entry = artwork.value?.versions.find((item) => item.id === versionId)
      if (!entry) return
      void artworkWrite(`proof|${versionId}`, () => removeArtwork(api, entry), () => input.setNotice({ key: 'depth.done.proofRemoved', params: { n: entry.versionNo }, tone: 'success' }))
    },
    onOpenProof: (versionId) => void openProof(versionId),
  }

  return {
    depth,
    actions,
    /** The marking changed and waits for Save. */
    dirty: detail ? markingDirty(detail, marking) : false,
    /** Save's second half: the marking with the version W1's save left (none changed: the label as it is). */
    saveMarking: async (saved: LabelDetail): Promise<LabelDetail> => {
      const patch = markingPatch(saved, marking)
      if (Object.keys(patch).length === 0) return saved
      const next = await saveMarking(api, saved, patch)
      setMarking(null)
      return next
    },
    resetMarking: () => setMarking(null),
    reload: () => {
      void loadChecks()
      void loadTextile()
      void loadArtwork()
      if (tab === 'languages') void loadPhrases()
    },
    reloadArtwork: () => void loadArtwork(),
    reloadPhrases: () => void loadPhrases(),
  }
}
