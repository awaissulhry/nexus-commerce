'use client'

/**
 * Reviews — the Inbox reply box's "Templates" menu (build spec §3.6): the saved replies from Reviews › Settings for the
 * review's channel, in the review's language. `pick(id)` returns the text to put in the box and counts the pick
 * (`POST /api/reviews/reply-templates/:id/use`, the "Used" column in Settings); a failed count is not the person's
 * problem and says nothing. A failed read leaves the menu out: the box works without it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReplyTemplate } from '@/design-system/patterns'
import { reviewsGet, reviewsSend } from '../../_lib/reviewsFetch'
import { replyTemplateMenu, reviewLocale } from './replyTemplates'
import type { ReplyTemplateRow } from './settingsModel'

export function useReplyTemplates(channel: string | null, language: string | null, market: string | null): {
  templates: ReplyTemplate[]
  pick: (id: string) => string | null
} {
  const [rows, setRows] = useState<ReplyTemplateRow[]>([])
  useEffect(() => {
    if (!channel) return
    const controller = new AbortController()
    reviewsGet<{ items: ReplyTemplateRow[] }>('/reviews/reply-templates', { channel }, { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setRows(res.data?.items ?? []) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [channel])

  const templates = useMemo(
    () => (channel ? replyTemplateMenu(rows, channel, reviewLocale(language, market)) : []),
    [rows, channel, language, market],
  )

  const pick = useCallback((id: string) => {
    const chosen = templates.find((t) => t.id === id)
    if (!chosen) return null
    void reviewsSend('POST', `/reviews/reply-templates/${encodeURIComponent(id)}/use`)
    return chosen.body
  }, [templates])

  return { templates, pick }
}
