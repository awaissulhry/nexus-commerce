/**
 * `Button heldReason` (Keyword Harvest DS lane H5, 2026-10-10) — a held action keeps its focus and says why; it is never
 * `disabled` (a disabled button takes no focus, so its reason is never heard), and a click does nothing.
 */
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Button, type ButtonProps } from './Button'

type El = ReactElement<Record<string, unknown>>
/** The element Button returns (forwardRef's render), so its handlers can be called without a DOM. */
const tree = (props: ButtonProps) => (Button as unknown as { render: (p: ButtonProps, ref: null) => El }).render(props, null)

describe('Button heldReason', () => {
  it('held: focusable (no disabled), aria-disabled, the reason as its description, and never a submit', () => {
    const html = renderToStaticMarkup(createElement(Button, { heldReason: 'Pick terms of one product first.', type: 'submit', disabled: true }, 'Harvest'))
    expect(html).toMatch(/<button [^>]*aria-disabled="true"/)
    expect(html).toMatch(/aria-description="Pick terms of one product first\."/)
    expect(html).toMatch(/type="button"/)
    expect(html).not.toMatch(/\sdisabled=""/)
  })

  it('a click does nothing: the handler is not called and a link child does not navigate', () => {
    const onClick = vi.fn()
    const held = tree({ heldReason: 'Not now.', onClick, children: 'Go' })
    const button = held.props.children as El
    const preventDefault = vi.fn()
    ;(button.props.onClick as (e: unknown) => void)({ preventDefault })
    expect(onClick).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalled()
    const link = tree({ heldReason: 'Not now.', asChild: true, children: createElement('a', { href: '/x' }, 'Open') })
    const anchor = link.props.children as El
    expect(anchor.type).toBe('a')
    expect(anchor.props['aria-disabled']).toBe(true)
    ;(anchor.props.onClick as (e: unknown) => void)({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it('the reason shows on hover and focus: a portal Tooltip wraps the held control', () => {
    const held = tree({ heldReason: 'Not now.', children: 'Go' })
    expect(held.props.label).toBe('Not now.')
    expect(held.props.portal).toBe(true)
  })

  it('no reason (null or empty) = an ordinary button that runs', () => {
    const onClick = vi.fn()
    for (const heldReason of [null, undefined, '']) {
      const el = tree({ heldReason, onClick, children: 'Go' })
      expect(el.type).toBe('button')
      expect(el.props.onClick).toBe(onClick)
      expect(el.props['aria-disabled']).toBeUndefined()
    }
  })
})
