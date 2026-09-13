import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ScopeBar } from './ScopeBar'

it('keeps held scopes announced, without a native disabled attribute or an extra tab stop', () => {
  const html = renderToStaticMarkup(createElement(ScopeBar, {
    items: [{ id: 'master', label: 'Master' }, { id: 'held', label: 'Held channel', disabled: true, disabledReason: 'Connect the account first.' }],
    active: 'master', onChange: () => {},
  }))
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  const held = buttons.find(b => b[2].includes('Held channel'))!
  expect(held[1]).not.toMatch(/\sdisabled=/)
  expect(held[1]).toContain('aria-disabled="true"')
  expect(held[1]).toContain('aria-description="Connect the account first."')
  expect(held[1]).toContain('title="Connect the account first."')
  expect((html.match(/tabindex="0"/g) ?? [])).toHaveLength(1)
  expect(buttons.find(b => b[2] === '<span class="nds-scope-label">Master</span>')![1]).toContain('aria-checked="true"')
})
