/**
 * MCP full control C9 — Settings › AI › Claude and the plan card are reachable and built on the design system only.
 *
 *   reach   the settings rail lists the page for a person who may see the assistant (ai.view, the API's own rule)
 *   build   Tabs (Rules, Activity), lists whose controls are each a Tab stop, the 2FA dialog before any raise, ActionConfirm before
 *           Undo; no raw <button>/<input>/<select>/<table>, no Tailwind class, only the page's own layout classes
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { settingsNavPermission } from '@/lib/auth/nav-permissions'

let buildSettingsNavigation: typeof import('../../_shell/settings-navigation').buildSettingsNavigation
beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
  vi.resetModules()
  ;({ buildSettingsNavigation } = await import('../../_shell/settings-navigation'))
})
afterAll(() => vi.unstubAllEnvs())

const HERE = import.meta.dirname
const APPROVALS = join(HERE, '../../../fleet/approvals')
const source = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8')
const FILES: Array<[string, string]> = [
  [HERE, 'ClaudeClient.tsx'], [HERE, 'RulesPanel.tsx'], [HERE, 'ActivityPanel.tsx'], [HERE, 'StepUpModal.tsx'], [APPROVALS, 'PlanCard.tsx'],
]

describe('C9 — reachable', () => {
  it('the settings rail lists Claude for a person who may see the assistant; it is its own page', () => {
    expect(settingsNavPermission('/settings/ai/claude')).toBe('ai.view')
    const items = buildSettingsNavigation('/w/business_a/settings/ai/claude', (permission) => permission === 'ai.view').flatMap((group) => group.items)
    expect(items.find((item) => item.label === 'Claude')).toMatchObject({ href: '/w/business_a/settings/ai/claude', active: true })
    expect(items.some((item) => item.label === 'AI providers')).toBe(false)
  })
})

describe('C9 — built on the design system', () => {
  it('Rules and Activity are tabs; a raise asks for the code; Undo asks first; the plan steps are a list', () => {
    expect(source(HERE, 'ClaudeClient.tsx')).toMatch(/<Tabs[\s\S]*id: 'rules'[\s\S]*id: 'activity'/)
    // Rules is a list (ToolRows): every Level select is a Tab stop, not a grid that holds Tab in its header.
    expect(source(HERE, 'RulesPanel.tsx')).toMatch(/<ToolRows /)
    expect(source(HERE, 'RulesPanel.tsx')).not.toMatch(/<NexusGrid/)
    expect(source(HERE, 'RulesPanel.tsx')).toMatch(/<StepUpModal/)
    expect(source(HERE, 'RulesPanel.tsx')).toMatch(/<Toggle/)
    // Activity is a list (ActivityRows): each Undo a Tab stop, on screen at phone width.
    expect(source(HERE, 'ActivityPanel.tsx')).toMatch(/<ActivityRows /)
    expect(source(HERE, 'ActivityPanel.tsx')).not.toMatch(/<NexusGrid/)
    expect(source(HERE, 'ActivityPanel.tsx')).toMatch(/useActionConfirm\(\)/)
    // The plan's steps are one tab stop (PlanStepList), not a grid that takes Tab through every cell.
    expect(source(APPROVALS, 'PlanCard.tsx')).toMatch(/<PlanStepList /)
    expect(source(APPROVALS, 'PlanCard.tsx')).not.toMatch(/<NexusGrid/)
  })

  it('no raw control, no Tailwind, and every grid control keeps its keyboard', () => {
    for (const [dir, name] of FILES) {
      const text = source(dir, name)
      expect(text, name).not.toMatch(/<(button|input|select|table|textarea)[\s>]/)
      for (const [, classes] of text.matchAll(/className="([^"]*)"/g)) {
        expect(classes.split(/\s+/).every((c) => /^(claude|plan)-[a-z-]+$/.test(c)), `${name}: ${classes}`).toBe(true)
      }
      if (text.includes('<NexusGrid')) expect(text, name).toMatch(/suppressKeyboardEvent: rendererOwnsKeyboard/)
    }
  })

  it('the stylesheets hold layout only, on the design tokens', () => {
    for (const css of [source(HERE, 'claude.css'), source(APPROVALS, 'planCard.css')]) {
      expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(css).not.toMatch(/font-size:\s*\d/)
      expect(css).not.toMatch(/var\(--(?!nds-)/)
    }
  })
})
