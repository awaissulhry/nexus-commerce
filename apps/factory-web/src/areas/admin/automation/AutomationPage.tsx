'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useRules } from '../../_shared/rules/use-rules'
import { useTodayLive } from '../../home/today/live'
import { automationAddress, controlsOf, MODULE_TIMERS, type AutomationControls, type AutomationNotice, type AutomationViewModel } from './model'
import { AutomationView } from './view/AutomationView'
// B-W2b-307: Approval rules.
import { useApprovalRules } from './approval-rules/use-approval-rules'
import { NEW_RULE_KIND_PARAM } from './approval-rules/new-kind/new-kind'

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
  const timersAllowed = permissions.has('alerts.view')
  // B-W2b-307: the page opens with alert rules (Reminders & timers) or approval rules (approvals.view).
  const approvalsAllowed = permissions.has('approvals.view')
  const allowed = timersAllowed || approvalsAllowed
  const manage = permissions.has('alerts.rules.manage')
  const prefix = companyPrefix(session.company?.code ?? '')
  const controls = controlsOf(search)
  const query = useRef(controls)
  query.current = controls
  const [notice, setNotice] = useState<AutomationNotice | null>(null)
  const [help, setHelp] = useState(false)
  const [now] = useState(() => Date.now())

  const go = useCallback((next: Partial<AutomationControls>) => router.replace(`${pathname}${automationAddress({ ...query.current, ...next })}`, { scroll: false }), [router, pathname])
  const ruling = useRules({ api, enabled: timersAllowed, manage, trigger: 'DATE', ruleParam: controls.view === 'timers' ? controls.rule : null, kinds: (kind) => kind.trigger === 'DATE', onClose: () => go({ rule: null }), onNotice: setNotice })
  const approvals = useApprovalRules({ api, enabled: approvalsAllowed, ruleParam: controls.view === 'approvals' || (!timersAllowed && approvalsAllowed) ? controls.rule : null, /* B-W2b-382 */ newKind: search.get(NEW_RULE_KIND_PARAM), readRoles: permissions.has('roles.view'), onNotice: (next) => setNotice(next ? { ...next, key: `approvals:${next.key}` } : null) })

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readSoon = () => {
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      ruling.refresh()
    }, 500)
  }
  const live = useTodayLive(
    {
      onChange: (type) => {
        if (type === 'alert.rule_changed' || type === 'alert.raised') readSoon()
        // B-W2b-307: a rule changed elsewhere, or one asked a request (fired in 30 days).
        if (type === 'approval.rule_changed' || type === 'approval.requested') approvals.refresh()
      },
      onReconnect: () => {
        readSoon()
        approvals.refresh()
      },
    },
    allowed,
  )

  const model: AutomationViewModel = {
    access: allowed ? 'open' : 'refused',
    now,
    prefix,
    manage,
    live,
    // B-W2b-307: a person who reads approval rules but no alert rules opens on Approval rules.
    view: !timersAllowed && approvalsAllowed && controls.view === 'timers' ? 'approvals' : controls.view,
    rules: ruling.rules,
    savingRules: ruling.saving,
    ruleDialog: ruling.dialog,
    busy: ruling.busy,
    notice: notice ?? (ruling.dialogProblem ? { key: `rules:${ruling.dialogProblem}`, tone: 'danger' } : null),
    moduleTimers: MODULE_TIMERS,
    help,
    timersAllowed,
    ...(approvalsAllowed
      ? {
          approvalRules: {
            rules: approvals.rules,
            kinds: approvals.kinds,
            roles: approvals.roles,
            companies: session.companies.map((company) => ({ id: company.id, name: company.name })),
            manage: permissions.has('approvals.rules.manage'),
            offline: live === 'offline',
            busy: approvals.busy,
            saving: approvals.saving,
            dialog: approvals.dialog,
            prefix,
          },
        }
      : {}),
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
        approvals: {
          onRule: (id) => {
            // Closing after a save keeps its notice ("created — it is off until you switch it on").
            if (id !== null) setNotice(null)
            go({ rule: id })
          },
          onSwitch: (rule, next) => void approvals.switchRule(rule, next),
          onRetry: approvals.retry,
          onSaveRule: approvals.save,
          onTestRule: (body) => void approvals.runTest(body),
          onRetryKinds: approvals.retryKinds,
        },
      }}
    />
  )
}
