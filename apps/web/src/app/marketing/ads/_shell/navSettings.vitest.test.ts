/**
 * AM-29 — the ads rail's "Settings" opens the real advertising settings (/settings/advertising: connections and their
 * read/write state). It opened a "This page is not built yet." stub; that route now redirects there too.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ADS_NAV } from './nav'

describe('the rail’s Settings row', () => {
  it('goes to /settings/advertising', () => {
    const row = ADS_NAV.find((n) => n.label === 'Settings')
    expect(row?.href).toBe('/settings/advertising')
  })

  it('the old route redirects there instead of showing a stub', () => {
    const page = readFileSync(fileURLToPath(new URL('../account-settings/page.tsx', import.meta.url)), 'utf8')
    expect(page).toContain("redirect('/settings/advertising')")
    expect(page).not.toContain('<p>This page is not built yet.</p>')
  })
})
