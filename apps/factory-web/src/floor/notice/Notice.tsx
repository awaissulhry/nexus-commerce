'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { acknowledgeNotice, fetchNotice, type ShownNotice } from '../api'
import { useFloor } from '../FloorApp'
import { useFloorKeys } from '../keys'
import { noticePages } from '../model'
import { NoticeView, type NoticeAction, type NoticeState } from './view/NoticeView'

/**
 * The live SCR-025 (`/floor/notice`): GET /privacy/floor/notice in the worker's language (or the one they ask for),
 * paged; "I have read it" on the last page sends the version, the language shown and the text's fingerprint
 * (POST /privacy/floor/notice/acknowledge, with an Idempotency-Key). A newer version in force meanwhile (409) opens
 * that one. The new gate (due, blocksScans) goes back to the app, so Home's tiles open at once.
 */
export function FloorNotice() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('notice.title', { showHome: true })
  const [state, setState] = useState<NoticeState>({ kind: 'loading' })
  const [shown, setShown] = useState<ShownNotice | null>(null)
  const { me, setMe, sessionEnded, api, locale } = store

  const open = useCallback(
    async (language?: string) => {
      setState({ kind: 'loading' })
      const answer = await fetchNotice(api, language ?? locale)
      if (!answer.ok) {
        if (answer.problem === 'notEnrolled') return void sessionEnded()
        return setState({ kind: 'unavailable' })
      }
      const { notice } = answer.value
      setShown(notice)
      if (!notice) return setState({ kind: 'none' })
      if (answer.value.gate.acknowledged) return setState({ kind: 'done', label: notice.label })
      const pages = noticePages(notice.body)
      setState({ kind: 'reading', notice: { label: notice.label, locale: notice.locale, languages: notice.languages, languageReady: notice.languageReady, pages }, page: 0 })
    },
    [api, locale, sessionEnded],
  )

  useEffect(() => {
    void open()
    // Once per visit (and per language the worker asks for).
  }, [])

  const onAction = async (action: NoticeAction) => {
    switch (action.type) {
      case 'next':
        if (state.kind !== 'reading') return
        return setState({ ...state, page: Math.min(state.page + 1, state.notice.pages.length - 1) })
      case 'previous':
        if (state.kind !== 'reading') return
        return setState({ ...state, page: Math.max(0, state.page - 1) })
      case 'language':
        return open(action.locale)
      case 'home':
        return router.push('/floor')
      case 'reload':
        return open()
      case 'acknowledge': {
        if (state.kind !== 'reading' || !shown || state.page < state.notice.pages.length - 1) return
        setState({ ...state, busy: true })
        const answer = await acknowledgeNotice(api, shown)
        if (!answer.ok) {
          feedback('error')
          if (answer.problem === 'newerNotice') return setState({ kind: 'newer' })
          if (answer.problem === 'notEnrolled') return void sessionEnded()
          return setState({ kind: 'unavailable' })
        }
        feedback('success')
        if (me) setMe({ ...me, notice: answer.value })
        return setState({ kind: 'done', label: shown.label })
      }
    }
  }

  useFloorKeys({
    enter:
      state.kind === 'reading'
        ? () => void onAction({ type: state.page >= state.notice.pages.length - 1 ? 'acknowledge' : 'next' })
        : state.kind === 'done' || state.kind === 'none'
          ? () => void onAction({ type: 'home' })
          : null,
    escape: state.kind === 'reading' && state.page > 0 ? () => void onAction({ type: 'previous' }) : null,
  })

  return <NoticeView model={{ frame, state, blocksScans: Boolean(me?.notice.blocksScans) }} onFrame={onFrame} onAction={(action) => void onAction(action)} />
}
