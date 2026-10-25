/**
 * varyByWorkspace — a browser-cached API answer is keyed by the business it was asked for (x-nexus-workspace-id), so a
 * switch to another business never shows the first business's numbers (2026-10-22: one business's review stats showed
 * the other's for up to 30 s).
 */
import { describe, expect, it } from 'vitest'
import { varyByWorkspace } from './workspace-hook.js'

describe('varyByWorkspace', () => {
  it('adds the workspace header and keeps what is there', () => {
    expect(varyByWorkspace(undefined)).toBe('x-nexus-workspace-id')
    expect(varyByWorkspace('Origin')).toBe('Origin, x-nexus-workspace-id')
    expect(varyByWorkspace(['Origin', 'accept-encoding'])).toBe('Origin, accept-encoding, x-nexus-workspace-id')
  })
  it('never adds it twice, and leaves * alone', () => {
    expect(varyByWorkspace('Origin, X-Nexus-Workspace-Id')).toBe('Origin, X-Nexus-Workspace-Id')
    expect(varyByWorkspace('*')).toBe('*')
  })
})
