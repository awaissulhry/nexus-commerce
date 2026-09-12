import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Tooltip, TooltipPortalProvider } from './Tooltip'
import { ToolbarButton } from './ToolbarButton'
import { Button } from './Button'

const quiet = (children: ReactNode) => h(TooltipPortalProvider, { disabled: true, children })

describe('quiet scrolling hosts', () => {
  it('removes tooltip wrappers while preserving the labelled control and its keyboard access', () => {
    const html = renderToStaticMarkup(quiet(h(ToolbarButton, { icon: '✎', label: 'Edit name', tabIndex: 0 })))
    expect(html).not.toContain('nds-tooltip')
    expect(html).not.toContain('role="tooltip"')
    expect(html).toContain('aria-label="Edit name"')
    expect(html).toContain('tabindex="0"')
  })

  it('keeps nested providers and explicit portal triggers quiet', () => {
    const html = renderToStaticMarkup(quiet(h(TooltipPortalProvider, { disabled: false,
      children: h(Tooltip, { portal: true, label: 'Pin this value',
        children: h(Button, { 'aria-label': 'Pin this value' }, 'Pin'),
      }),
    })))
    expect(html).not.toContain('nds-tooltip')
    expect(html).toContain('<button')
    expect(html).toContain('aria-label="Pin this value"')
  })

  it('also suppresses inline tips without changing their content', () => {
    const html = renderToStaticMarkup(quiet(h(Tooltip, { portal: false, label: 'Hint', children: h('span', null, 'Value') })))
    expect(html).toBe('<span>Value</span>')
  })

  it('leaves hints outside a quiet host available', () => {
    const html = renderToStaticMarkup(h(Tooltip, { label: 'Hint', children: h('span', null, 'Value') }))
    expect(html).toContain('role="tooltip">Hint')
  })
})
