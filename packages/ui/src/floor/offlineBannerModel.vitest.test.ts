import { describe, expect, it } from 'vitest'

import { offlineBannerState } from './offlineBannerModel'

describe('offline banner (G2)', () => {
  it('offline: a warning, always shown, with what waits', () => {
    expect(offlineBannerState({ online: false, pending: 0 })).toEqual({ kind: 'offline', tone: 'warning', visible: true, pending: 0, refused: 0 })
    expect(offlineBannerState({ online: false, pending: 3, refused: 1 })).toMatchObject({ kind: 'offline', pending: 3, refused: 1 })
  })

  it('online with refused actions: danger, even with nothing pending', () => {
    expect(offlineBannerState({ online: true, pending: 0, refused: 2 })).toMatchObject({ kind: 'refused', tone: 'danger', visible: true })
  })

  it('online and still sending: info', () => {
    expect(offlineBannerState({ online: true, pending: 4 })).toMatchObject({ kind: 'sending', tone: 'info', visible: true, pending: 4 })
  })

  it('online and nothing waiting: hidden unless the screen asks for the "all sent" line', () => {
    expect(offlineBannerState({ online: true, pending: 0 })).toMatchObject({ kind: 'synced', visible: false })
    expect(offlineBannerState({ online: true, pending: 0, showWhenSynced: true })).toMatchObject({ kind: 'synced', tone: 'success', visible: true })
  })

  it('treats a negative, fractional or missing count as what it can be', () => {
    expect(offlineBannerState({ online: true, pending: -2, refused: Number.NaN })).toMatchObject({ kind: 'synced', pending: 0, refused: 0 })
    expect(offlineBannerState({ online: true, pending: 2.7 })).toMatchObject({ pending: 2 })
  })
})
