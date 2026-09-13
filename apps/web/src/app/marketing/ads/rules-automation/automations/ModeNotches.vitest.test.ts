import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Button } from '@/design-system/primitives'
import { ModeNotches } from './ModeNotches'

const props = { level: 'OBSERVE' as const, ceiling: 'PROPOSE' as const, ceilingReason: 'The graduation ceiling is Propose.', ruleName: 'Example rule', busy: false, earnedAuto: false }
function buttons(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(buttons)
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  return node.type === Button ? [node as ReactElement<Record<string, unknown>>] : buttons(node.props.children)
}
it('busy and above-ceiling activation explain the refusal and make zero writes; an allowed choice writes once', () => {
  const onSet = vi.fn(), onRefused = vi.fn()
  const busy = ModeNotches({ ...props, busy: true, onSet, onRefused })
  for (const button of buttons(busy)) (button.props.onClick as () => void)()
  expect(onSet).not.toHaveBeenCalled()
  expect(onRefused.mock.calls).toEqual(Array(4).fill(['Wait for the pending write to finish.']))
  const html = renderToStaticMarkup(busy)
  expect(html).not.toMatch(/\sdisabled=/)
  expect((html.match(/aria-disabled="true"/g) ?? [])).toHaveLength(4)
  const ready = buttons(ModeNotches({ ...props, onSet, onRefused }))
  ;(ready[3].props.onClick as () => void)()
  expect(onRefused).toHaveBeenLastCalledWith(props.ceilingReason)
  expect(onSet).not.toHaveBeenCalled()
  ;(ready[2].props.onClick as () => void)()
  expect(onSet).toHaveBeenCalledExactlyOnceWith('PROPOSE')
})
