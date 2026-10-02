/**
 * MCP full control, wave 3 step 0 — content-guidelines tells "no brand voice is set" apart from "the brand voice could
 * not be read". Before, `resolveBrandVoice` turned every read error into null, so a failed read answered "No brand
 * voice is set for this scope." — a false statement Claude would write text on. The prompt builders keep their
 * best-effort read (a prompt without a voice is still a prompt); the tool says what it does not know.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ voices: null as null | Array<Record<string, unknown>> }))
vi.mock('../../../db.js', () => ({
  default: {
    terminologyPreference: { findMany: async () => [] },
    brandVoice: {
      findMany: async () => {
        if (!store.voices) throw new Error('connection terminated unexpectedly')
        return store.voices
      },
    },
  },
}))

import { CONTENT_TOOLS } from './content.tools.js'
import { resolveBrandVoice } from '../../ai/brand-voice.service.js'

const guidelines = CONTENT_TOOLS.find((tool) => tool.name === 'content-guidelines')!
const ctx = { can: () => true, via: 'claude' as const }
type Data = Record<string, any>

beforeEach(() => { store.voices = null })

describe('content-guidelines — a brand voice that could not be read is not "not set"', () => {
  it('the read fails: it says the voice could not be read, never that none is set', async () => {
    const out = await guidelines.handler({ market: 'IT' }, ctx)
    expect(out.ok).toBe(true)
    const data = out.data as Data
    expect(data.brandVoice).toBeNull()
    expect(data.brandVoiceNote).toMatch(/could not be read/)
    expect(data.brandVoiceNote).not.toMatch(/No brand voice is set/)
    // The database's own error text stays in the log, not in the answer.
    expect(JSON.stringify(data)).not.toContain('connection terminated')
  })

  it('control: none is set — it says so', async () => {
    store.voices = []
    const data = (await guidelines.handler({ market: 'IT' }, ctx)).data as Data
    expect(data).toMatchObject({ brandVoice: null, brandVoiceNote: 'No brand voice is set for this scope.' })
  })

  it('the prompt builders keep their best-effort read: a failed read is no voice there', async () => {
    expect(await resolveBrandVoice({ brandVoice: { findMany: async () => { throw new Error('boom') } } } as never, {})).toBeNull()
  })
})
