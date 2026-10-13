import { describe, expect, it } from 'vitest'
import { appCredentialsFormProblem, appCredentialsStatus, appSecretStatus, expiryInputValue, formatExpiryDate, rotationNote, type AppCredentialsRow, type AppSecretRow } from './app-secrets'

// P0.5 — what the "App secrets" card says. The web runner is node-only, so the pure logic is pinned.

const row = (over: Partial<AppSecretRow>): AppSecretRow => ({
  channelKey: 'AMAZON_SP', label: 'Amazon SP-API', environment: 'production',
  secretExpiresAt: '2026-12-23T00:00:00.000Z', daysLeft: 95, rotatedAt: null, ...over,
})

describe('appSecretStatus', () => {
  it('Amazon with no date is a WARNING that says where to find it', () => {
    const s = appSecretStatus(row({ secretExpiresAt: null, daysLeft: null }))
    expect(s).toMatchObject({ tone: 'warning', label: 'No expiry date recorded' })
    expect(s.detail).toMatch(/Solution Provider Portal/)
  })
  it('a channel without a scheduled expiry and no date is neutral', () => {
    expect(appSecretStatus(row({ channelKey: 'EBAY', label: 'eBay', secretExpiresAt: null, daysLeft: null })).tone).toBe('neutral')
  })
  it.each([
    [120, 'success', '120 days left'],
    [90, 'info', '90 days left'],
    [31, 'info', '31 days left'],
    [30, 'warning', '30 days left'],
    [8, 'warning', '8 days left'],
    [7, 'danger', '7 days left'],
    [1, 'danger', '1 day left'],
    [0, 'danger', '0 days left'],
    [-1, 'danger', 'Expired'],
  ])('%i days → %s "%s"', (daysLeft, tone, label) => {
    expect(appSecretStatus(row({ daysLeft }))).toMatchObject({ tone, label })
  })
  it('names the date in words, not a raw timestamp', () => {
    expect(appSecretStatus(row({})).detail).toBe('The secret expires on 23 Dec 2026. Nexus alerts 90, 30 and 7 days before.')
    expect(formatExpiryDate('2027-03-18T00:00:00.000Z')).toBe('18 Mar 2027')
  })
})

describe('expiryInputValue', () => {
  it('gives the date field yyyy-mm-dd, or empty when no date is recorded', () => {
    expect(expiryInputValue(row({}))).toBe('2026-12-23')
    expect(expiryInputValue(row({ secretExpiresAt: null }))).toBe('')
  })
})

describe('rotationNote (P6.1)', () => {
  it('says rotation is on, when, and the last rotation', () => {
    expect(rotationNote(row({ automaticRotation: true, rotatedAt: '2026-07-30T08:00:00.000Z' }))).toBe('Automatic rotation is on: Nexus asks Amazon for a new secret 30 days before this date, tests it and stores it. Last rotated 30 Jul 2026.')
    expect(rotationNote(row({ automaticRotation: true, secretExpiresAt: null, daysLeft: null }))).toMatch(/as soon as Amazon reports the date/)
  })
  it('says how to turn it on when it is off, and says nothing for apps without it', () => {
    expect(rotationNote(row({ automaticRotation: false }))).toMatch(/^Automatic rotation is off: register the credential queue/)
    expect(rotationNote(row({ channelKey: 'EBAY', label: 'eBay', automaticRotation: null }))).toBeNull()
  })
})

describe('Google sign-in app (appCredentialsStatus, appCredentialsFormProblem)', () => {
  const creds = (over: Partial<AppCredentialsRow>): AppCredentialsRow => ({
    channelKey: 'GOOGLE', label: 'Google', environment: 'production',
    redirectUri: 'https://api.example.test/api/cx/callback/google', redirectUriProblem: null,
    clientId: '123-abc.apps.googleusercontent.com', secretSet: true, source: 'saved', updatedAt: '2026-10-13T09:00:00.000Z', ...over,
  })
  it('not set → a warning that says who sets it', () => {
    expect(appCredentialsStatus(creds({ source: 'none', clientId: null, secretSet: false }))).toMatchObject({ tone: 'warning', label: 'Not set' })
  })
  it('saved → success, names the client and never a secret', () => {
    const s = appCredentialsStatus(creds({}))
    expect(s).toMatchObject({ tone: 'success', label: 'Set' })
    expect(s.detail).toBe('Client 123-abc.apps.googleusercontent.com. The secret is stored encrypted and is never shown. Saved 13 Oct 2026.')
  })
  it('from the environment → info; a client with no secret → warning', () => {
    expect(appCredentialsStatus(creds({ source: 'environment' }))).toMatchObject({ tone: 'info', label: 'From the server settings' })
    expect(appCredentialsStatus(creds({ secretSet: false }))).toMatchObject({ tone: 'warning', label: 'Secret missing' })
  })
  it.each([
    ['', '', /client ID and the client secret/],
    ['not-a-client', 'GOCSPX-x', /ends in \.apps\.googleusercontent\.com/],
    ['123-abc.apps.googleusercontent.com', '', /client secret too/],
    ['123-abc.apps.googleusercontent.com', 'has space', /no spaces/],
  ])('refuses %j / %j before sending', (id, secret, words) => {
    expect(appCredentialsFormProblem(id, secret)).toMatch(words)
  })
  it('accepts a Google client id + secret (spaces around them are trimmed)', () => {
    expect(appCredentialsFormProblem(' 123-abc.apps.googleusercontent.com ', ' GOCSPX-secret ')).toBeNull()
  })
})
