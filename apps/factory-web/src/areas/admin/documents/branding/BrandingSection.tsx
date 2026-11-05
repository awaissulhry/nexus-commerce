'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { problemKey, type Loaded } from '../../shared/model'
import { isStepUpCancelled, useStepUp } from '../../shared/step-up'
import type { CompanyOption } from '../model'
import { getBranding, pickedLogo, saveBranding, uploadLogo } from './api'
import { bodyOf, companyFor, draftOf, pickProblem, SAVED_NOTICE, type BrandingDraft, type BrandingNotice, type BrandingPageView, type BrandingRead, type CompanyChoice, type LogoSlot } from './model'
import { BrandingView } from './view/BrandingView'

/** A picked picture as an inline image, so the form shows it before it is saved (the DS takes `data:image/…` addresses). */
function dataUrlOf(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
    reader.readAsDataURL(file)
  })
}

/**
 * `/w/<company>/admin/documents?view=branding&company=<id>` (SCR-014 › Branding, B-W2b-161): reads the company's branding
 * (`GET /branding`), uploads a picked logo (`POST /branding/:companyId/logo` → the store → `…/complete`: not the logo until
 * saved), saves the whole branding (`PUT /branding/:companyId` at the version read; the API asks a fresh code: useStepUp).
 * Reads again when the tab comes back into view, unless something is typed.
 */
export function BrandingSection({ companies, askedCompany, onView, onCompany }: { companies: Loaded<CompanyOption>; askedCompany: string | null; onView: (view: BrandingPageView) => void; onCompany: (companyId: string) => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  // The company list needs companies.view; a person who sees the documents without it (finance) works in the companies of
  // their session (whether their legal data is complete is then not known).
  const choices: CompanyChoice[] = useMemo(
    () =>
      companies.items
        ? companies.items.map((company) => ({ id: company.id, name: company.legalName, status: company.status, legalReady: company.legalReady }))
        : companies.problem
          ? session.companies.map((company) => ({ id: company.id, name: company.name, status: 'ACTIVE', legalReady: null }))
          : [],
    [companies.items, companies.problem, session.companies],
  )
  const companyId = companyFor(choices, askedCompany, session.company?.id ?? null)
  const [read, setRead] = useState<BrandingRead>({ status: 'loading' })
  const [draft, setDraft] = useState<BrandingDraft | null>(null)
  const [uploading, setUploading] = useState<LogoSlot | null>(null)
  const [uploadProblem, setUploadProblem] = useState<{ slot: LogoSlot; key: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<BrandingNotice | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const typed = useRef(false)
  typed.current = draft !== null

  const load = useCallback(async () => {
    if (!companyId) return
    try {
      setRead({ status: 'ready', branding: await getBranding(api, companyId) })
    } catch (error) {
      setRead({ status: 'failed', problem: problemKey(error) })
    }
  }, [api, companyId])

  useEffect(() => {
    if (companies.items === null && companies.problem && choices.length === 0) {
      setRead({ status: 'failed', problem: companies.problem })
      return
    }
    if (!companyId) return
    setRead({ status: 'loading' })
    setDraft(null)
    setProblem(null)
    setUploadProblem(null)
    void load()
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !typed.current) void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [companies.items, companies.problem, choices.length, companyId, load])

  const onPickLogo = useCallback(
    async (slot: LogoSlot, file: File) => {
      if (!companyId || read.status !== 'ready') return
      setUploadProblem(null)
      const refused = pickProblem(file)
      if (refused) {
        setUploadProblem({ slot, key: refused })
        return
      }
      setUploading(slot)
      try {
        const [src, uploaded] = await Promise.all([dataUrlOf(file), pickedLogo(file).then((picked) => uploadLogo(api, companyId, picked))])
        setDraft((current) => ({ ...(current ?? draftOf(read.branding)), [slot]: { fileId: uploaded.fileId, name: uploaded.name, src } }))
      } catch (error) {
        setUploadProblem({ slot, key: isApiError(error) && error.kind === 'invalid' ? 'brand.logo.problem.notPicture' : 'brand.logo.problem.upload' })
      } finally {
        setUploading(null)
      }
    },
    [api, companyId, read],
  )

  const onSave = useCallback(async () => {
    if (!companyId || read.status !== 'ready' || !draft) return
    setBusy(true)
    setProblem(null)
    const key = newIdempotencyKey()
    try {
      const saved = await guard('stepUp.sentence.default', () => saveBranding(api, companyId, bodyOf(read.branding, draft), key))
      setRead({ status: 'ready', branding: saved.branding })
      setDraft(null)
      setNotice(SAVED_NOTICE)
    } catch (error) {
      if (isStepUpCancelled(error)) return
      const refusal = problemKey(error)
      setProblem(refusal)
      if (refusal === 'problem.conflict') {
        setDraft(null)
        void load()
      }
    } finally {
      setBusy(false)
    }
  }, [api, companyId, draft, guard, load, read])

  return (
    <BrandingView
      model={{ companies: choices, companyId, read, draft, uploading, uploadProblem, busy, problem, notice, stepUp }}
      actions={{
        onView,
        onCompany: (next) => {
          setNotice(null)
          onCompany(next)
        },
        onDraft: (next) => {
          setProblem(null)
          setDraft(next)
        },
        onPickLogo: (slot, file) => void onPickLogo(slot, file),
        onSave: () => void onSave(),
        onRetry: () => {
          setRead({ status: 'loading' })
          void load()
        },
        onDismissNotice: () => setNotice(null),
        onSubmitStepUp: (code) => void submitStepUp(code),
        onCancelStepUp: cancelStepUp,
      }}
    />
  )
}
