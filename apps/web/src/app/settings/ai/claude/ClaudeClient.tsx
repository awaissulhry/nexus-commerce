'use client'
/**
 * MCP full control C9 — Settings › AI › Claude: two tabs.
 *
 *   Rules      how far Claude may go here without a person: each tool's level and limits, the Pause and the daily
 *              limit (RulesPanel). Reading needs ai.view; Pause and lowering need ai.run; letting Claude do more needs
 *              settings.security.manage and a fresh 2FA code — the API says so when it refuses.
 *   Activity   what Claude did here, with Undo (ActivityPanel).
 */
import { useCallback, useEffect, useState } from 'react'
import { Banner, Tabs, tabPanelProps } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { ActivityPanel } from './ActivityPanel'
import { claudeApi, ClaudeApiError } from './claudeApi'
import type { ClaudeRules } from './claudeWords'
import { RulesPanel } from './RulesPanel'
import './claude.css'

type TabId = 'rules' | 'activity'
const TABS_BASE = 'claude-settings'

export default function ClaudeClient() {
  const [tab, setTab] = useState<TabId>('rules')
  const [rules, setRules] = useState<ClaudeRules | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setRules(await claudeApi.rules())
    } catch (err) {
      // A permission refusal is not a failure to load: say what opens this page instead.
      if (err instanceof ClaudeApiError && err.status === 403) setDenied(true)
      else setError(err instanceof Error ? err.message : 'Claude’s rules could not be loaded.')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  return (
    <div className="claude-page">
      <header className="claude-heading">
        <h2>Claude</h2>
        <p className="claude-note">
          What Claude may do in this business without a person, how to stop it at once, and everything it did. Changes
          from Claude wait for a person in Approvals unless you set a tool to Auto here.
        </p>
      </header>
      {denied ? (
        <Banner tone="info" title="Claude’s settings are not available to you here">
          They need the permission to see the assistant (ai.view) in this business. Ask an owner for it.
        </Banner>
      ) : (
        <>
          <Tabs
            ariaLabel="Claude settings"
            idBase={TABS_BASE}
            tabs={[
              { id: 'rules', label: 'Rules' },
              { id: 'activity', label: 'Activity' },
            ]}
            active={tab}
            onChange={(id) => setTab(id as TabId)}
          />
          <div {...tabPanelProps(TABS_BASE, tab)} className="claude-tabpanel">
            {tab === 'rules' ? (
              error ? (
                <Banner tone="danger" title="Claude’s rules could not be loaded" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>
                  {error}
                </Banner>
              ) : rules ? (
                <RulesPanel rules={rules} onChanged={() => void load()} />
              ) : (
                <p className="claude-note" role="status">Loading…</p>
              )
            ) : (
              <ActivityPanel />
            )}
          </div>
        </>
      )}
    </div>
  )
}
