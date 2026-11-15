'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { problemKey } from '../../shared/model'
import { refusalOf } from '../../documents/template-editor/model'
import { listContactLanguages, setContactLanguage, type ContactLanguage } from './api'
import { withOwn, type OwnChoice, type PartnerModel, type PartnerNotice, type PartnerRead } from './model'
import { PartnerLanguagesView } from './view/PartnerLanguagesView'

/** The search waits this long after the last key before it reads. */
const SEARCH_WAIT_MS = 300

/**
 * Admin › Languages & formats › per partner contact (SCR-634, B-W2b-432): reads `GET /templates/languages/contacts?q&cursor`
 * (parties.view; never asked without it), 50 a page with "Show more"; a contact's own language is written with the parties'
 * `PATCH …/contacts/:id` at the version read (parties.manage), one contact at a time — for the selected rows too, said in
 * ONE notice with each refused contact in words. A stale contact (409) is read again with its page.
 */
export function PartnerLanguagesSection() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const canView = held.has('parties.view')
  const canManage = held.has('parties.manage')
  const [query, setQuery] = useState('')
  const [asked, setAsked] = useState('')
  const [read, setRead] = useState<PartnerRead>({ status: 'loading' })
  const [selected, setSelected] = useState<readonly string[]>([])
  const [saving, setSaving] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<PartnerNotice | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const rowsRef = useRef<readonly ContactLanguage[]>([])
  rowsRef.current = read.status === 'ready' ? read.contacts : []

  // The search reads after a short pause (each key would be a read otherwise).
  useEffect(() => {
    const timer = setTimeout(() => setAsked(query), SEARCH_WAIT_MS)
    return () => clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    if (!canView) return
    try {
      const answer = await listContactLanguages(api, { q: asked })
      setRead({ status: 'ready', contacts: answer.contacts, nextCursor: answer.nextCursor, more: answer.nextCursor !== null })
    } catch (error) {
      setRead({ status: 'failed', problem: problemKey(error) })
    }
  }, [api, asked, canView])

  useEffect(() => {
    setRead({ status: 'loading' })
    setSelected([])
    void load()
  }, [load])

  const replace = (row: ContactLanguage) => setRead((now) => (now.status === 'ready' ? { ...now, contacts: now.contacts.map((entry) => (entry.contactId === row.contactId ? row : entry)) } : now))

  const set = async (rows: readonly ContactLanguage[], to: OwnChoice) => {
    if (!canManage || rows.length === 0) return
    setNotice(null)
    setSaving(rows.map((row) => row.contactId))
    const refused: Array<{ id: string; said: ReturnType<typeof refusalOf> }> = []
    let done = 0
    let stale = false
    for (const row of rows) {
      const own = to === '' ? null : to
      try {
        const version = await setContactLanguage(api, row, own)
        replace(withOwn(row, own, version))
        done += 1
      } catch (error) {
        const said = refusalOf(error)
        if (said.key === 'tpl.problem.stale') stale = true
        refused.push({ id: row.contactId, said: said.key === 'tpl.problem.stale' ? { key: 'tpl.partner.stale' } : said.key === 'tpl.problem.noRight' ? { key: 'tpl.partner.held.manage' } : said })
      }
      setSaving((now) => now.filter((id) => id !== row.contactId))
    }
    setSaving([])
    if (rows.length > 1) setSelected([])
    setNotice(
      refused.length === 0
        ? { key: rows.length === 1 ? 'tpl.partner.done.one' : 'tpl.partner.done.many', tone: 'success', params: { count: done, name: rows[0]?.name ?? '' } }
        : { key: done === 0 ? 'tpl.partner.done.none' : 'tpl.partner.done.partial', tone: done === 0 ? 'danger' : 'warning', params: { count: done, refused: refused.length }, refused },
    )
    if (stale) void load()
  }

  const model: PartnerModel = { prefix: companyPrefix(session.company?.code ?? ''), canView, canManage, read, query, selected, saving, notice, loadingMore }

  return (
    <PartnerLanguagesView
      model={model}
      actions={{
        onQuery: setQuery,
        onSelect: setSelected,
        onRetry: () => {
          setRead({ status: 'loading' })
          void load()
        },
        onMore: () => {
          if (read.status !== 'ready' || !read.nextCursor || loadingMore) return
          setLoadingMore(true)
          listContactLanguages(api, { q: asked, cursor: read.nextCursor })
            .then((answer) => setRead((now) => (now.status === 'ready' ? { status: 'ready', contacts: [...now.contacts, ...answer.contacts], nextCursor: answer.nextCursor, more: answer.nextCursor !== null } : now)))
            .catch((error: unknown) => setNotice({ key: problemKey(error), tone: 'danger' }))
            .finally(() => setLoadingMore(false))
        },
        onSet: (rows, to) => void set(rows, to),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
