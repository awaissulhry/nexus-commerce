import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../i18n/locales'
import { CATALOGUE } from '../i18n/messages'
import { render, textOf } from '../record-thread/parts/testing'
import { YellowLine, YellowLineBody } from './YellowLine'

/**
 * owb-of7 step 4 — THE yellow line + Go on (design X2 "Warn, don't stop"; L1: no new warn row): the part renders the host's words and its
 * ONE "Go on" calls the host's act; without an act it is the words only; the Confirm window's open details use it. Written, not run.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
/** Every element of a drawn tree (the part is a plain function: no hook in YellowLineBody). */
function elementsOf(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return Array.isArray(node) ? node.flatMap(elementsOf) : []
  const props = node.props as { children?: ReactNode }
  return [node, ...elementsOf(props.children)]
}

describe('owb-of7 step 4: the part renders the words and calls Go on', () => {
  it('the words and "Go on" in the page\'s language', () => {
    const drawn = textOf(render(createElement(YellowLine, { onGoOn: () => undefined, children: 'A payment is still due.' })))
    expect(drawn).toContain('A payment is still due.')
    expect(drawn).toContain('Go on')
    expect(textOf(render(createElement(YellowLine, { onGoOn: () => undefined, children: 'Un pagamento è ancora dovuto.' }), 'it'))).toContain('Procedi')
  })
  it('Go on calls the host\'s act; no act → the words only', () => {
    const onGoOn = vi.fn()
    const tree = YellowLineBody({ children: 'Two details are still open.', goOn: 'Go on', onGoOn })
    const button = elementsOf(tree).find((element) => (element.props as { onClick?: unknown }).onClick === onGoOn)
    expect(button).toBeDefined()
    ;(button!.props as { onClick: () => void }).onClick()
    expect(onGoOn).toHaveBeenCalledTimes(1)
    const quiet = YellowLineBody({ children: 'Words only.', goOn: 'Go on' })
    expect(elementsOf(quiet).some((element) => typeof (element.props as { onClick?: unknown }).onClick === 'function')).toBe(false)
  })
  it('one part in lib (no office code), its word in both languages, used by the Confirm window\'s open details', () => {
    for (const locale of LOCALES) expect(CATALOGUE[locale].orders?.['kit.goOn'], locale).toBeTruthy()
    expect(read('./YellowLine.tsx')).not.toMatch(/from '\.\.\/\.\.\/(areas|portal|app)\//)
    expect(read('../../areas/sales/orders/draft/view/ConfirmOrderWindowView.tsx')).toContain('<YellowLine onGoOn={() => actions?.onSend?.()} held={actHeld}>')
  })
})
