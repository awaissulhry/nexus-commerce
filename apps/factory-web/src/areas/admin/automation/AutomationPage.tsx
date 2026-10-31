'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useRules } from '../../_shared/rules/use-rules'
import { useTodayLive } from '../../home/today/live'
import { automationAddress, controlsOf, MODULE_TIMERS, type AutomationControls, type AutomationNotice, type AutomationViewModel } from './model'
import { AutomationView } from './view/AutomationView'

/**
 * `/w/<company>/admin/automation` (SCR-167, the W2a part): Reminders & timers through the API client — the date rules
 * (GET /alerts/rules?trigger=DATE) with the list's own switch and number (PUT with the rule's version), New rule and the
 * rule dialog (`?rule=new|<id>`: roles and places from GET /alerts/rules/choices, a dry run, the rule's timers from GET
 * /alerts/rules/:id/timers) — the same hook as Home › Alerts. Live: alert.rule_changed and alert.raised read the rules
 * again (last fired, fired in 7 days, timers).
 */
export function AutomationPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const permissions = useMemo(() => new Set(session.permissions), [session.permissions])
  const allowed = permissions.has('alerts.view')
  const manage = permissions.has('alerts.rules.manage')
  const prefix = companyPrefix(session.company?.code ?? '')
  const controls = controlsOf(search)
  const query = useRef(controls)
  query.current = controls
  const [notice, setNotice] = useState<AutomationNotice | null>(null)
  const [help, setHelp] = useState(false)
  const [now] = useState(() => Date.now())

  const go = useCallback((next: Partial<AutomationControls>) => router.replace(`${pathname}${automationAddress({ ...query.current, ...next })}`, { scroll: false }), [router, pathname])
  const ruling = useRules({ api, enabled: allowed, manage, trigger: 'DATE', ruleParam: controls.rule, kinds: (kind) => kind.trigger === 'DATE', onClose: () => go({ rule: null }), onNotice: setNotice })

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readSoon = () => {
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      ruling.refresh()
    }, 500)
  }
  const live = useTodayLive({ onChange: (type) => (type === 'alert.rule_changed' || type === 'alert.raised') && readSoon(), onReconnect: readSoon }, allowed)

  const model: AutomationViewModel = {
    access: allowed ? 'open' : 'refused',
    now,
    prefix,
    manage,
    live,
    view: controls.view,
    rules: ruling.rules,
    savingRules: ruling.saving,
    ruleDialog: ruling.dialog,
    busy: ruling.busy,
    notice: notice ?? (ruling.dialogProblem ? { key: `rules:${ruling.dialogProblem}`, tone: 'danger' } : null),
    moduleTimers: MODULE_TIMERS,
    help,
  }

  return (
    <AutomationView
      model={model}
      actions={{
        onView: (view) => go({ view }),
        onRule: (id) => {
          setNotice(null)
          go({ rule: id })
        },
        onRetry: ruling.reload,
        onSwitch: ruling.switchRule,
        onNumber: ruling.numberRule,
        onSave: ruling.save,
        onTest: (draft, ruleId) => void ruling.test(draft, ruleId),
        onRetryChoices: ruling.retryChoices,
        onRetryTimers: ruling.retryTimers,
        onHelp: setHelp,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
