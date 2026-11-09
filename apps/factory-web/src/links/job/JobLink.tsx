'use client'

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { useLocale } from '../../lib/i18n/provider'
import { dayIn } from '../../lib/po-answer/quantities'
import { LinkBrandingContext } from '../../shell/links/view/LinkFrameView'
import { answerLinkJob, readLinkJob } from './api'
import { answerHeld, answerOf, answerRefusal, endOf, LINK_DRAFT, readRefusal } from './model'
import { JobLinkView, type JobLinkViewModel } from './view/JobLinkView'

/**
 * A JOB_ACCEPT link, once it opened (the link landing did `POST /link/open`): reads the job in the page's language
 * (`GET /link/job`, again when the reader switches it), keeps the answer being chosen, and sends the ONE answer with the
 * typed name under one Idempotency-Key per answer. The answer uses the link: the end is drawn from the page the answer
 * gives back (the link opens nothing afterwards, so a language switch does not read it again). The tenant's colour goes on
 * the page's pop-ups too (brandPortals, D24). The token stays in the client's `x-factory-link` header.
 */
export function JobLink({ api }: { api: ApiClient }) {
  const locale = useLocale()
  const [model, setModel] = useState<JobLinkViewModel>({ link: 'valid', page: null, draft: LINK_DRAFT, today: dayIn(new Date()), answer: 'idle', end: null, problem: null })
  const latest = useRef(model)
  latest.current = model
  const answered = useRef(false)
  const key = useRef<{ body: string; key: string } | null>(null)

  const branding = useContext(LinkBrandingContext)
  useEffect(() => brandPortals(branding ? checkBranding(branding) : null), [branding])

  const load = useCallback(async () => {
    if (answered.current) return
    try {
      const page = await readLinkJob(api, locale)
      if (answered.current) return
      setModel((current) => ({ ...current, link: 'valid', page, problem: current.answer === 'idle' ? null : current.problem }))
    } catch (error) {
      const state = readRefusal(error)
      if (state === 'error') setModel((current) => (current.page ? current : { ...current, problem: { key: 'problem.read' } }))
      else setModel((current) => ({ ...current, link: state }))
    }
  }, [api, locale])

  useEffect(() => {
    void load()
  }, [load])

  const send = () => {
    const current = latest.current
    if (!current.page || current.answer !== 'idle') return
    if (answerHeld(current.draft, current.page.job, current.today)) return
    const answer = answerOf(current.draft)
    const text = JSON.stringify(answer)
    if (key.current?.body !== text) key.current = { body: text, key: newIdempotencyKey() }
    setModel((now) => ({ ...now, answer: 'busy', problem: null }))
    answerLinkJob(api, current.page.job.version, answer, locale, key.current.key)
      .then((page) => {
        answered.current = true
        setModel((now) => ({ ...now, page, answer: 'done', end: endOf(answer, page), problem: null }))
      })
      .catch((error: unknown) => {
        const refusal = answerRefusal(error)
        setModel((now) => ({ ...now, answer: 'idle', problem: refusal.words, ...(refusal.link ? { link: refusal.link } : {}) }))
        if (refusal.reload) void load()
      })
  }

  return <JobLinkView model={model} actions={{ onRetry: () => void load(), onDraft: (draft) => setModel((current) => ({ ...current, draft, problem: null })), onSend: send }} />
}
