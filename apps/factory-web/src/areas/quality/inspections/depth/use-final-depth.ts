'use client'

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { failedRead, problemKey, ready, reading, type Read } from '../../_shared/model'
import { photoAddress } from '../api'
import { applyProfile, getInspectionAql, getSheet, listCauses, listProfiles, putMeasurements, putResults, type Cause, type ChartPoint, type InspectionAql, type ProfilePick, type ResultBody, type Sheet } from './api'
import { decimalOf, measurementBody, photoSlots, resultPhotoIds } from './model'

/** A cell or row's save mark while a write runs (CellSaveMark words) or why it was refused. */
export type SaveMark = { readonly state: 'saving' | 'saved' | 'unknown' } | { readonly state: 'refused'; readonly problem: string; readonly lines?: readonly string[] }

export interface ProfileDraft {
  readonly profileId: string | null
  readonly reason: string
}

export interface FinalDepthState {
  /** The bench sheet of an inspection on a plan; null for W1's fixed checklist. */
  readonly sheet: Read<Sheet> | null
  /** Sample & AQL (read when the tab opens). */
  readonly aql: Read<InspectionAql> | null
  /** The cause codes for the defects' Cause column (read when Defects & photos opens). */
  readonly causes: Read<readonly Cause[]> | null
  /** The photos' addresses once read (presigned, short-lived). */
  readonly photoSrc: Readonly<Record<string, string>>
  /** The unit the office records on Checks & results (1 … sample). */
  readonly unit: number
  /** Save marks per check row (`check:<code>`) and chart cell (`cell:<point>:<size>:<unit>`). */
  readonly marks: Readonly<Record<string, SaveMark>>
  /** Change profile (Sample & AQL): the profiles to pick from, the draft, its state. */
  readonly profiles: Read<readonly ProfilePick[]> | null
  readonly profileDraft: ProfileDraft | null
  readonly profileBusy: boolean
  readonly profileProblem: string | null
}

/** A sheet write's refusal in our words: stale (someone else changed it), a refused value, else by its kind. */
function writeRefusal(error: unknown): SaveMark {
  if (!isApiError(error)) return { state: 'unknown' }
  const lines = error.issues.map((issue) => issue.message ?? '').filter(Boolean)
  if (error.kind === 'conflict') return { state: 'refused', problem: 'checks.problem.conflict', lines }
  if (error.kind === 'invalid') return { state: 'refused', problem: 'checks.problem.refused', lines }
  return { state: 'refused', problem: problemKey(error) }
}

/**
 * The W2b parts of the final inspection record (B-W2b-127 on B-W2b-97 and B-W2b-93): the plan's sheet (checks, the chart, the
 * serial and batch check, the photo set, what holds the signature), Sample & AQL, the cause codes, the photos' addresses;
 * the office's answers per (check, unit) and chart cell (one PUT each, the record's version shared with the page's other
 * writes through `version`), Change profile. A write's answer is the new sheet; a stale write re-reads.
 */
export function useFinalDepth(options: {
  api: ApiClient
  inspectionId: string
  onPlan: boolean
  tab: string
  language: string
  canDefects: boolean
  canAql: boolean
  companyId: string | null
  version: MutableRefObject<number | null>
  onChanged?: () => void
}) {
  const { api, inspectionId, onPlan, tab, language, canDefects, canAql, companyId, version, onChanged } = options
  const [state, setState] = useState<FinalDepthState>({ sheet: null, aql: null, causes: null, photoSrc: {}, unit: 1, marks: {}, profiles: null, profileDraft: null, profileBusy: false, profileProblem: null })
  const asked = useRef(new Set<string>())
  const profileKey = useRef<string | null>(null)

  const readPhotos = useCallback(
    (sheet: Sheet) => {
      const ids = [...photoSlots(sheet).flatMap((slot) => slot.fileIds), ...sheet.checks.flatMap(resultPhotoIds)]
      for (const fileId of ids) {
        if (asked.current.has(fileId)) continue
        asked.current.add(fileId)
        photoAddress(api, fileId)
          .then((src) => setState((current) => ({ ...current, photoSrc: { ...current.photoSrc, [fileId]: src } })))
          .catch(() => asked.current.delete(fileId))
      }
    },
    [api],
  )

  const loadSheet = useCallback(async () => {
    if (!onPlan) {
      setState((current) => ({ ...current, sheet: null }))
      return
    }
    setState((current) => ({ ...current, sheet: current.sheet?.value ? current.sheet : reading() }))
    try {
      const sheet = await getSheet(api, inspectionId, language)
      setState((current) => ({ ...current, sheet: ready(sheet), unit: Math.min(Math.max(1, current.unit), Math.max(1, sheet.inspection.sampleSize)) }))
      readPhotos(sheet)
    } catch (error) {
      setState((current) => ({ ...current, sheet: failedRead(problemKey(error)) }))
    }
  }, [api, inspectionId, language, onPlan, readPhotos])

  const loadAql = useCallback(async () => {
    setState((current) => ({ ...current, aql: current.aql?.value ? current.aql : reading() }))
    try {
      const aql = await getInspectionAql(api, inspectionId)
      setState((current) => ({ ...current, aql: ready(aql) }))
    } catch (error) {
      setState((current) => ({ ...current, aql: failedRead(problemKey(error)) }))
    }
  }, [api, inspectionId])

  const loadCauses = useCallback(async () => {
    if (!canDefects) {
      setState((current) => ({ ...current, causes: failedRead('problem.forbidden') }))
      return
    }
    setState((current) => ({ ...current, causes: current.causes?.value ? current.causes : reading() }))
    try {
      const causes = await listCauses(api)
      setState((current) => ({ ...current, causes: ready(causes) }))
    } catch (error) {
      setState((current) => ({ ...current, causes: failedRead(problemKey(error)) }))
    }
  }, [api, canDefects])

  useEffect(() => {
    void loadSheet()
  }, [loadSheet])
  useEffect(() => {
    if (tab === 'aql') void loadAql()
  }, [loadAql, tab])
  useEffect(() => {
    if (tab === 'defects') void loadCauses()
  }, [loadCauses, tab])

  /** One write of the sheet: marks the key saving, sends with the record's version, keeps the answer (and its version). */
  const write = useCallback(
    async (markKey: string, send: (version: number) => Promise<Sheet>) => {
      if (version.current === null) return
      setState((current) => ({ ...current, marks: { ...current.marks, [markKey]: { state: 'saving' } } }))
      try {
        const sheet = await send(version.current)
        version.current = sheet.inspection.version
        setState((current) => ({ ...current, sheet: ready(sheet), marks: { ...current.marks, [markKey]: { state: 'saved' } } }))
        readPhotos(sheet)
        onChanged?.()
      } catch (error) {
        setState((current) => ({ ...current, marks: { ...current.marks, [markKey]: writeRefusal(error) } }))
        if (isApiError(error) && error.kind === 'conflict') {
          void loadSheet()
          onChanged?.()
        }
      }
    },
    [loadSheet, onChanged, readPhotos, version],
  )

  /** Checks & results: one check's answer for the unit picked (null outcome takes it back). */
  const answer = useCallback(
    (body: ResultBody) => write(`check:${body.checkCode}`, (at) => putResults(api, inspectionId, { version: at, results: [body] })),
    [api, inspectionId, write],
  )

  /** The chart: one cell typed (empty takes the value back; a word that is no number is said and not sent). */
  const measure = useCallback(
    (point: ChartPoint, unit: number, text: string) => {
      const markKey = `cell:${point.pointCode}:${point.size ?? ''}:${unit}`
      const value = text.trim() ? decimalOf(text) : null
      if (text.trim() && value === null) {
        setState((current) => ({ ...current, marks: { ...current.marks, [markKey]: { state: 'refused', problem: 'chart.problem.decimal' } } }))
        return
      }
      void write(markKey, (at) => putMeasurements(api, inspectionId, { version: at, measurements: [measurementBody(point, unit, value)] }))
    },
    [api, inspectionId, write],
  )

  const openProfile = useCallback(() => {
    profileKey.current = null
    setState((current) => ({ ...current, profileDraft: { profileId: null, reason: '' }, profileProblem: null, profiles: canAql && companyId ? reading() : null }))
    if (canAql && companyId)
      listProfiles(api, companyId)
        .then((profiles) => setState((current) => ({ ...current, profiles: ready(profiles) })))
        .catch((error: unknown) => setState((current) => ({ ...current, profiles: failedRead(problemKey(error)) })))
  }, [api, canAql, companyId])

  const saveProfile = useCallback(async () => {
    const draft = state.profileDraft
    const aql = state.aql?.value
    if (!draft || !aql) return
    setState((current) => ({ ...current, profileBusy: true, profileProblem: null }))
    profileKey.current ??= newIdempotencyKey()
    try {
      const next = await applyProfile(api, inspectionId, { version: version.current ?? aql.inspection.version, profileId: draft.profileId, reason: draft.profileId ? draft.reason.trim() || null : null }, profileKey.current)
      profileKey.current = null
      version.current = next.inspection.version
      setState((current) => ({ ...current, aql: ready(next), profileDraft: null, profileBusy: false }))
      void loadSheet()
      onChanged?.()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'conflict') profileKey.current = null
      setState((current) => ({ ...current, profileBusy: false, profileProblem: isApiError(error) && (error.kind === 'invalid' || error.kind === 'conflict') ? 'aql.profile.refused' : problemKey(error) }))
    }
  }, [api, inspectionId, loadSheet, onChanged, state.aql, state.profileDraft, version])

  return {
    state,
    loadSheet,
    loadAql,
    loadCauses,
    answer,
    measure,
    setUnit: (unit: number) => setState((current) => ({ ...current, unit })),
    openProfile,
    setProfileDraft: (profileDraft: ProfileDraft | null) => setState((current) => ({ ...current, profileDraft, profileProblem: profileDraft ? current.profileProblem : null })),
    saveProfile,
  }
}

export type FinalDepthHook = ReturnType<typeof useFinalDepth>
