'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../lib/api/client'
import { newIdempotencyKey } from '../../lib/api/client'
import type { RecordKey } from '../api'
import { useLiveChanges } from '../live'
import { changeSharePermissions, inviteToRecord, readRecordShares, revokeShare } from './api'
import {
  expiresAtOf,
  invitedNotice,
  inviteDraftProblems,
  inviteRefusal,
  newInviteDraft,
  permissionsOfDraft,
  readProblemOf,
  shareActionRefusal,
  takesShares,
  type InviteDraft,
  type SharesPanelActions,
  type SharesPanelModel,
} from './model'

export interface SharesOptions {
  readonly api: ApiClient
  readonly record: RecordKey
  /** partners.shares.view / partners.shares.manage. */
  readonly can: { readonly view: boolean; readonly manage: boolean }
  /** Reads the record's thread and history again after an invitation or a revoke (the API writes there too). */
  readonly reloadPanels?: () => void
}

/**
 * The record panels' Partners tab as RecordPanels mounts it (B-W2b-200): null for a record nobody outside can be invited to,
 * or a person without partners.shares.view (no tab). It reads the record's partner and invitations, invites (one idempotent
 * write per draft; the link given once is kept in memory only, until dismissed), changes what one invited person may do and
 * revokes (each with the share's version), and reads again when the live stream says an invitation of this record changed
 * (record_share.invited / changed / revoked) or the stream came back.
 */
export function useShares({ api, record, can, reloadPanels }: SharesOptions): { model: SharesPanelModel | null; actions: SharesPanelActions } {
  const enabled = can.view && takesShares(record.type)
  const [read, setRead] = useState<SharesPanelModel['read']>({ status: 'loading' })
  const [invite, setInvite] = useState<SharesPanelModel['invite']>(null)
  const [change, setChange] = useState<SharesPanelModel['change']>(null)
  const [revoke, setRevoke] = useState<SharesPanelModel['revoke']>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<SharesPanelModel['notice']>(null)
  const [link, setLink] = useState<SharesPanelModel['link']>(null)
  const latest = useRef({ read, invite, change, revoke, busy })
  latest.current = { read, invite, change, revoke, busy }
  const inviteKey = useRef<{ body: string; key: string } | null>(null)

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      const data = await readRecordShares(api, record)
      setRead({ status: 'ready', data })
    } catch (error) {
      setRead({ status: 'failed', problem: readProblemOf(error) })
    }
  }, [api, record, enabled])

  useEffect(() => {
    setRead({ status: 'loading' })
    void load()
  }, [load])

  useLiveChanges(
    {
      onChange: (change) => {
        if (!change.type.startsWith('record_share.')) return
        if (change.fields.recordType !== record.type || change.fields.recordId !== record.id) return
        void load()
      },
      onReconnect: () => void load(),
    },
    enabled,
  )

  const send = async () => {
    const current = latest.current.invite
    if (!current || latest.current.busy) return
    const now = Date.now()
    const problems = inviteDraftProblems(current.draft, now)
    if (Object.keys(problems).length > 0) {
      setInvite({ ...current, problems, problem: null })
      return
    }
    const draft = current.draft
    const body = {
      recordType: record.type,
      recordId: record.id,
      ...(draft.to === 'contact' ? { contactId: draft.contactId } : { email: draft.email.trim() }),
      permissions: permissionsOfDraft(draft),
      expiresAt: expiresAtOf(draft.until)!,
      note: draft.note.trim() || null,
      send: draft.send,
      ...(draft.language ? { language: draft.language } : {}),
    }
    const text = JSON.stringify(body)
    if (inviteKey.current?.body !== text) inviteKey.current = { body: text, key: newIdempotencyKey() }
    setBusy(true)
    try {
      const answer = await inviteToRecord(api, body, inviteKey.current.key)
      inviteKey.current = null
      setInvite(null)
      setNotice(invitedNotice(answer))
      if (answer.url) setLink({ url: answer.url, email: answer.share.email })
      await load()
      reloadPanels?.()
    } catch (error) {
      const refusal = inviteRefusal(error)
      setInvite((now) => (now ? { ...now, problems: refusal.problems, problem: refusal.problem } : now))
      if (refusal.reload) void load()
    } finally {
      setBusy(false)
    }
  }

  const shareOf = (shareId: string) => {
    const state = latest.current.read
    return state.status === 'ready' ? state.data.shares.find((share) => share.id === shareId) : undefined
  }

  const saveChange = async () => {
    const current = latest.current.change
    const share = current ? shareOf(current.shareId) : undefined
    if (!current || !share || latest.current.busy) return
    setBusy(true)
    try {
      await changeSharePermissions(api, share.id, permissionsOfDraft(current), share.version)
      setChange(null)
      setNotice({ key: 'note.changed', tone: 'success', params: { email: share.email } })
      await load()
    } catch (error) {
      const refusal = shareActionRefusal(error)
      setChange((now) => (now ? { ...now, problem: refusal.key } : now))
      if (refusal.reload) void load()
    } finally {
      setBusy(false)
    }
  }

  const confirmRevoke = async () => {
    const current = latest.current.revoke
    const share = current ? shareOf(current.shareId) : undefined
    if (!current || !share || latest.current.busy) return
    setBusy(true)
    try {
      await revokeShare(api, share.id, share.version)
      setRevoke(null)
      setNotice({ key: 'note.revoked', tone: 'success', params: { email: share.email } })
      await load()
      reloadPanels?.()
    } catch (error) {
      const refusal = shareActionRefusal(error)
      setRevoke((now) => (now ? { ...now, problem: refusal.key } : now))
      if (refusal.reload) void load()
    } finally {
      setBusy(false)
    }
  }

  const actions: SharesPanelActions = {
    onRetry: () => {
      setRead({ status: 'loading' })
      void load()
    },
    onInvite: (open) => {
      setNotice(null)
      const state = latest.current.read
      setInvite(open && state.status === 'ready' ? { draft: newInviteDraft(state.data, Date.now()), problems: {}, problem: null } : null)
    },
    onDraft: (change: Partial<InviteDraft>) =>
      setInvite((current) => {
        if (!current) return current
        const cleared = { ...current.problems }
        for (const key of Object.keys(change)) delete cleared[key as keyof typeof cleared]
        if (change.to) {
          delete cleared.email
          delete cleared.to
        }
        return { draft: { ...current.draft, ...change }, problems: cleared, problem: null }
      }),
    onSend: () => void send(),
    onChange: (shareId) => {
      setNotice(null)
      const share = shareId ? shareOf(shareId) : undefined
      setChange(share ? { shareId: share.id, comment: share.permissions.includes('COMMENT'), upload: share.permissions.includes('UPLOAD'), problem: null } : null)
    },
    onChangeDraft: (next) => setChange((current) => (current ? { ...current, ...next, problem: null } : current)),
    onChangeSave: () => void saveChange(),
    onRevoke: (shareId) => {
      setNotice(null)
      setRevoke(shareId ? { shareId, problem: null } : null)
    },
    onRevokeConfirm: () => void confirmRevoke(),
    onCopyLink: () => {
      if (link) void navigator.clipboard?.writeText(link.url).then(() => setNotice({ key: 'note.copied', tone: 'success' }), () => setNotice({ key: 'note.copyFailed', tone: 'warning' }))
    },
    onDismissLink: () => setLink(null),
    onDismissNotice: () => setNotice(null),
  }

  if (!enabled) return { model: null, actions }
  return { model: { can: { manage: can.manage }, read, invite, change, revoke, busy, notice, link }, actions }
}
