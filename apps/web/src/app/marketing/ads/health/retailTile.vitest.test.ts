/**
 * AM-32 — the Health tile that counts campaigns says it counts campaigns. Titled "Wasted spend (retail)", it showed a
 * campaign count with no unit, so it read as money; the retail check has no money in it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = readFileSync(fileURLToPath(new URL('./HealthClient.tsx', import.meta.url)), 'utf8')

describe('the retail tile', () => {
  it('is titled for what it counts', () => {
    expect(src).toContain('<div className="hl-tile-k">Campaigns on unsellable products</div>')
    expect(src).not.toContain('Wasted spend (retail)')
  })
  it('its sub-line names the two kinds without the word "pause"', () => {
    expect(src).toContain('all unsellable · ${retail.summary?.watch ?? 0} partly')
    expect(src).not.toMatch(/\$\{retail\.summary\?\.pause \?\? 0\} pause/)
  })
})
