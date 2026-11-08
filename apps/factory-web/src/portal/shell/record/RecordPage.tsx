'use client'

import { useState } from 'react'
import { useT } from '../../../lib/i18n/provider'
import type { PartnerRecord } from '../api'
import { usePortalBand, usePortalFrame } from '../frame'
import { recordTypeKey } from '../thread-model'
import { PortalThread } from '../thread/PortalThread'
import { RecordView } from '../view/RecordView'

/**
 * Any record from a list, a notification or a search, before its own page exists (design portal.frame › tab:any-record,
 * thread; B-W2b-173): `/p/<party>/open/<type>/<id>` draws the record's band — back to Home, its name, their reference first
 * and ours second — and its Messages (every record has its conversation, COL-059), the box ready for "Ask a question". A
 * record that is not one of theirs answers like one that does not exist. A step that builds the record's page sets its
 * line in RECORD_PAGES (nav/portal-nav.ts) and the address opens that page instead.
 */
export function RecordPage({ type, id }: { type: string; id: string }) {
  const t = useT('portal')
  const frame = usePortalFrame()
  const [record, setRecord] = useState<PartnerRecord | null>(null)
  const [missing, setMissing] = useState(false)
  const name = t(recordTypeKey(type))
  const ref = record?.ourRef ?? record?.theirRef ?? null
  usePortalBand({
    title: missing ? t('record.missingTitle') : ref ? `${name} ${ref}` : name,
    back: { href: frame.prefix, label: t('nav.home') },
    refs: record && (record.theirRef || record.ourRef) ? { theirs: record.theirRef, ours: record.ourRef } : null,
    tabs: missing ? null : { label: t('record.tabs'), active: 'messages', items: [{ id: 'messages', label: t('record.messages'), href: `${frame.prefix}/open/${encodeURIComponent(type)}/${encodeURIComponent(id)}#messages` }] },
    ask: missing ? null : { type, id, label: ref },
  })
  return (
    <RecordView model={{ missing, subtitle: record?.subtitle ?? null, homeHref: frame.prefix }}>
      <PortalThread type={type} id={id} onRecord={setRecord} onMissing={() => setMissing(true)} showRecord={false} />
    </RecordView>
  )
}
