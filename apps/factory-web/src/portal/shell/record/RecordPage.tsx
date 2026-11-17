'use client'

import { useCallback, useEffect, useState } from 'react'
import { isApiError } from '../../../lib/api/errors'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { PartnerRecord } from '../api'
import { usePortalBand, usePortalFrame, usePortalLive } from '../frame'
import { recordPageOf } from '../nav/portal-nav'
import { recordTypeKey } from '../thread-model'
import { PortalThread } from '../thread/PortalThread'
import { RecordView, type RecordSummaryModel } from '../view/RecordView'
import { fetchRecordSummary, type RecordSummary } from './api'
import { parentHref, summaryTone } from './model'

/**
 * The portal's generic page (B-W2b-173; B-TH-274: P-ANY, PL5): `/p/<party>/open/<type>/<id>` — any record from a list, a
 * notification or a search before its own page exists, a record's conversation as its own page (`?view=conversation`: the route
 * does not send it on to the record's own page), and the account conversation (`Party`, the person's own party: "Ask us a
 * question"). No tabs: the conversation (PortalThread on the DS PartnerThread) is the main column, the box ready for "Ask a
 * question"; beside it the record's summary (GET /records/:type/:id/summary, the partner view only — B-TH-076). A record that is
 * not theirs answers like one that does not exist (the thread's or the summary's 404). A step that builds the record's page sets
 * its line in RECORD_PAGES (nav/portal-nav.ts) and the address opens that page instead.
 */
export function RecordPage({ type, id }: { type: string; id: string }) {
  const t = useT('portal')
  const locale = useLocale()
  const frame = usePortalFrame()
  const [record, setRecord] = useState<PartnerRecord | null>(null)
  const [missing, setMissing] = useState(false)
  const account = type === 'Party' && id === frame.me.party.id
  const [summary, setSummary] = useState<{ state: 'loading' | 'error' | 'ready'; read: RecordSummary | null }>({ state: 'loading', read: null })

  const loadSummary = useCallback(
    async (signal?: AbortSignal) => {
      if (account) return
      try {
        const answer = await fetchRecordSummary(frame.api, type, id, signal)
        setSummary({ state: 'ready', read: answer.summary })
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') return
        if (isApiError(error) && error.kind === 'not_found') setMissing(true)
        setSummary((current) => ({ state: current.read ? 'ready' : 'error', read: current.read }))
      }
    },
    [frame.api, type, id, account],
  )
  useEffect(() => {
    const abort = new AbortController()
    void loadSummary(abort.signal)
    return () => abort.abort()
  }, [loadSummary])
  // The record moved on (a state, a link): read the summary again.
  usePortalLive({ onChange: (change) => (change.type === 'partner_notification.created' ? void loadSummary() : undefined), onReconnect: () => void loadSummary() }, !account)

  const read = summary.read
  const name = read ? read.type[locale] : t(recordTypeKey(type))
  const label = read?.label ?? record?.ourRef ?? record?.theirRef ?? null
  const theirRef = read?.theirRef ?? record?.theirRef ?? null
  const ownPage = recordPageOf(frame.kinds, type, id)

  usePortalBand({
    title: missing ? t('record.missingTitle') : account ? t('thread.accountTitle') : label ? `${name} ${label}` : name,
    back: { href: frame.prefix, label: t('nav.home') },
    refs: !missing && !account && (theirRef || label) ? { theirs: theirRef && theirRef !== label ? theirRef : null, ours: label } : null,
    status: !missing && read?.state ? { label: read.state.words[locale], tone: summaryTone(read.state.code) } : null,
    // "Ask a question" focuses this page's own box (the account's too).
    ask: missing ? null : { type, id, label: account ? null : label },
  })

  const summaryModel: RecordSummaryModel | null = account
    ? null
    : {
        state: summary.state,
        type: name,
        label,
        theirRef: theirRef && theirRef !== label ? theirRef : null,
        stateWords: read?.state ? read.state.words[locale] : null,
        stateTone: summaryTone(read?.state?.code),
        parent: read?.parent ? { words: read.parent.label ? `${read.parent.type[locale]} ${read.parent.label}` : read.parent.type[locale], href: parentHref(frame.prefix, read.parent) } : null,
        ownPage: ownPage ? { href: `${frame.prefix}${ownPage}`, words: t('record.summary.open', { type: name }) } : null,
      }

  return (
    <RecordView
      model={{ missing, subtitle: account ? null : (record?.subtitle ?? null), homeHref: frame.prefix, account, summary: summaryModel }}
      onRetrySummary={() => {
        setSummary((current) => ({ ...current, state: 'loading' }))
        void loadSummary()
      }}
    >
      <PortalThread type={type} id={id} onRecord={setRecord} onMissing={() => setMissing(true)} showRecord={false} title={account ? t('thread.accountHeading') : undefined} />
    </RecordView>
  )
}
