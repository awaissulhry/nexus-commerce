'use client'

import { useState } from 'react'
import { fromApiFile } from '../../../lib/record-thread/files/model'
import { paperFeed, paperFiles, type ThreadPrintModel } from './print/model'
import { ThreadPrintView } from './print/view/ThreadPrintView'
import { useRecordThread, type RecordThreadHost } from './use-record-thread'

/**
 * B-TH-280 — what the record frame's print view (`?print=1`) shows of the thread under the band and the body, on every record page
 * (`printThread={<ThreadPrint record title party />}`) and on the generic record page. It replaces the old record panels' print
 * form: the SAME container as the docked thread (use-record-thread: one read of the thread, its mail states, its files and its
 * changes, read again live), drawn read-only for paper. Nothing is marked read (no "seen" report) and no draft is read, written or
 * guarded from here (`readOnly`: no box); the record's party only names the Customer / Supplier audience of a file. Office only.
 */
export interface ThreadPrintProps {
  readonly record: RecordThreadHost['record']
  /** The record's name as its page shows it. */
  readonly title: string
  /** The record's customer, supplier or brand, when it has one. */
  readonly party?: { readonly id: string; readonly name: string } | null
  /** Whom the party is to us (the files' "Customer" / "Supplier" word); default customer. */
  readonly partyRole?: 'customer' | 'supplier' | 'partner'
}

export function ThreadPrint({ record, title, party = null, partyRole = 'customer' }: ThreadPrintProps) {
  const { model, actions, base } = useRecordThread({ record, title, recordLabel: title, party, readOnly: true })
  // "Now" for retention dates, read once (as the Files view).
  const [now] = useState(() => Date.now())
  const partyId = party?.id ?? base.partyId
  const paper: ThreadPrintModel = {
    title,
    feed: paperFeed(model.feed),
    files: base.can.readFiles ? paperFiles(base.files.map((file) => fromApiFile(file)), base.key) : null,
    party: partyId ? { id: partyId, role: partyRole } : null,
    now,
  }
  return <ThreadPrintView model={paper} actions={{ onOlder: actions.onOlder, onReload: actions.onReload }} />
}
