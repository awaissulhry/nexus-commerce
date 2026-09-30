'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { getBackendUrl } from '@/lib/backend-url'
import { sendCommand, useCommandKey } from '@/lib/command-key'
import { channelLabel } from '../../scopes'
import { chooseCategoryLink } from './rulesStatus'
import { autoLoadKey, fieldsLoadOutcome, loadButtonLabel, missingFields, notLoadedTitle, type FieldsLoadOutcome } from './missingFields'

/** Loading a field list is PIM management, as the Requirements dialog's "Download rules" (`categories.routes.ts`). */
export const LOAD_FIELDS_PERMISSION = 'pim.manage'

/**
 * P0 item 8 — the channel sheet's banner for a field list it does not have (`meta.schemaMissing`): one automatic load
 * per open sheet, then "Load eBay fields"; on success the sheet reloads with the new columns. `ready` holds the
 * automatic attempt until the sheet has read and the operator's permissions are known.
 */
export function useMissingFieldsBanner({ channel, market, missing, ready, canLoad, onLoaded }: {
  channel: string; market: string; missing: readonly string[]; ready: boolean; canLoad: boolean; onLoaded: () => void
}) {
  const fields = missingFields(channel, market, missing)
  const loadable = fields?.loadable.join(',') ?? ''
  const auto = autoLoadKey(channel, market, fields?.loadable ?? [])
  const commandKey = useCommandKey()
  const tried = useRef(new Set<string>())
  const [busy, setBusy] = useState(false)
  // Kept with the set it was for, so a failure never speaks for another set of missing lists.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)

  const load = useCallback(async () => {
    if (!auto) return
    setBusy(true); setFailure(null)
    let outcome: FieldsLoadOutcome
    try {
      const answer = await sendCommand<{ results?: Array<{ productType: string; outcome: string; error?: string }>; error?: string }>(commandKey,
        `${getBackendUrl()}/api/categories/schema/download`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, market, productTypes: loadable.split(',') }) })
      outcome = fieldsLoadOutcome(channel, { status: answer.response.status, body: answer.body, conflict: answer.conflict })
    } catch {
      outcome = fieldsLoadOutcome(channel, 'no-answer')
    }
    setBusy(false)
    if (outcome.state === 'loaded') onLoaded()
    else setFailure({ key: auto, message: outcome.message })
  }, [auto, commandKey, channel, market, loadable, onLoaded])

  useEffect(() => {
    if (!ready || !canLoad || !auto || tried.current.has(auto)) return
    tried.current.add(auto)
    void load()
  }, [ready, canLoad, auto, load])

  if (!fields) return null
  const failed = failure && failure.key === auto ? failure.message : null
  const unloadable = fields.unloadable.join(' ')
  if (!fields.loadable.length) {
    // The pointer is the action, so the sentence does not say it twice ("… Choose one in Categories.").
    const link = chooseCategoryLink(channel, market, missing)
    const title = link && unloadable.endsWith(` ${link.label}.`) ? unloadable.slice(0, -(link.label.length + 2)) : unloadable
    return <Banner tone="warning" title={title}
      action={link ? <Button asChild size="sm" variant="link"><Link href={link.href}>{link.label}</Link></Button> : undefined} />
  }
  const state = busy ? `Loading them from ${channelLabel(channel)}…`
    : failed ?? `Until they load, this sheet shows only the fixed columns.${canLoad ? '' : ` Loading them needs the ${LOAD_FIELDS_PERMISSION} permission.`}`
  return <Banner tone={failed ? 'warning' : 'info'} title={notLoadedTitle(channel, market)}
    action={canLoad ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void load()}>{busy ? 'Loading…' : loadButtonLabel(channel)}</Button> : undefined}>
    {unloadable ? `${state} ${unloadable}` : state}
  </Banner>
}
