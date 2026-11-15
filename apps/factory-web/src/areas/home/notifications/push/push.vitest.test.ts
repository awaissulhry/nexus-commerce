import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CADENCES, EVENT_KINDS, PREFERENCE_CHANNELS } from '@nexus/factory-domain/notifications/preferences/preferences'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { pushWorker, PUSH_WORKER_SOURCE } from '../../../../sw/push'
import { designScreen as prefsScreen } from '../preferences/fixtures'
import { digestWaits, nextCell, pushWaits } from '../preferences/model'
import { designScreen as pushScreen } from './fixtures'
import { browserPush, deviceLabel, pushSteps, turnOnHeld, type PushState } from './model'

/** Notification preferences, push on this device and the push worker (B-W2b-388; PLT-140, PLT-141): rules, words, cases. */

const KEY_ON_SCREEN = /\b(prefs|push|held)\.[a-zA-Z]/
const FACTS = { secure: true, serviceWorker: true, pushManager: true, notification: true, ios: false, standalone: false }
const STATE: PushState = { available: true, unavailable: null, publicKey: 'k', devices: [], maxDevices: 10, urgent: [] }

describe('the preferences matrix', () => {
  it('moves between cells with the arrows, and says when a choice waits for the digest or a device', () => {
    expect(nextCell(EVENT_KINDS, PREFERENCE_CHANNELS, { event: 'MENTIONED', channel: 'IN_APP' }, 'ArrowRight')).toEqual({ event: 'MENTIONED', channel: 'EMAIL' })
    expect(nextCell(EVENT_KINDS, PREFERENCE_CHANNELS, { event: 'MENTIONED', channel: 'IN_APP' }, 'ArrowDown')).toEqual({ event: 'ASSIGNED', channel: 'IN_APP' })
    expect(nextCell(EVENT_KINDS, PREFERENCE_CHANNELS, { event: 'MENTIONED', channel: 'IN_APP' }, 'ArrowLeft')).toBeNull()
    const cell = (channel: 'EMAIL' | 'PUSH', cadence: 'DAILY_DIGEST' | 'INSTANT') => ({ event: 'MENTIONED' as const, channel, cadence, source: 'QUIET' as const, role: null, quiet: cadence, choices: [cadence] })
    expect(digestWaits({ digestOn: false, cells: [cell('EMAIL', 'DAILY_DIGEST')] })).toBe(true)
    expect(digestWaits({ digestOn: true, cells: [cell('EMAIL', 'DAILY_DIGEST')] })).toBe(false)
    expect(pushWaits({ pushDevices: 0, cells: [cell('PUSH', 'INSTANT')] })).toBe(true)
    expect(pushWaits({ pushDevices: 1, cells: [cell('PUSH', 'INSTANT')] })).toBe(false)
  })

  it('has words for every kind, channel and cadence in it and en', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['home-mywork'])['home-mywork'] ?? {})
      for (const key of [...EVENT_KINDS.flatMap((kind) => [`prefs.event.${kind}.label`, `prefs.event.${kind}.hint`]), ...PREFERENCE_CHANNELS.map((channel) => `prefs.channel.${channel}`), ...CADENCES.map((cadence) => `prefs.cadence.${cadence}`)]) {
        expect(t(key), `${locale} ${key}`).not.toBe(key)
      }
    }
  })
})

describe('push on this device', () => {
  it('knows what this browser can do, and the steps it needs', () => {
    expect(browserPush(FACTS)).toBe('ready')
    expect(browserPush({ ...FACTS, secure: false })).toBe('insecure')
    expect(browserPush({ ...FACTS, pushManager: false, ios: true })).toBe('ios-install')
    expect(browserPush({ ...FACTS, pushManager: false })).toBe('unsupported')
    expect(pushSteps('ios-install')).toEqual(['urgent', 'install', 'turnOn', 'test'])
    expect(pushSteps('ready')).toEqual(['urgent', 'turnOn', 'test'])
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iPhone')
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36')).toBe('Chrome · Windows')
  })

  it('holds Turn on push with its reason', () => {
    const state = { push: STATE, browser: 'ready' as const, busy: false, offline: false, label: 'Phone', thisDevice: false }
    expect(turnOnHeld(state)).toBeNull()
    expect(turnOnHeld({ ...state, offline: true })).toBe('held.offline')
    expect(turnOnHeld({ ...state, push: { ...STATE, available: false } })).toBe('push.held.unavailable')
    expect(turnOnHeld({ ...state, browser: 'ios-install' })).toBe('push.held.ios-install')
    expect(turnOnHeld({ ...state, thisDevice: true })).toBe('push.held.already')
    expect(turnOnHeld({ ...state, label: ' ' })).toBe('push.held.label')
    expect(turnOnHeld({ ...state, push: { ...STATE, maxDevices: 0 } })).toBe('push.held.tooMany')
  })
})

describe('the push worker', () => {
  it('shows our pushes and opens only this web’s pages', () => {
    const rules = pushWorker(null)!
    const origin = 'https://factory.example.com'
    expect(rules.readMessage(JSON.stringify({ v: 1, title: 'SO-1', body: 'Marco mentioned you', url: '/w/A/home/notifications?open=n1', tag: 'r1' }), origin)).toEqual({
      title: 'SO-1',
      body: 'Marco mentioned you',
      tag: 'r1',
      url: 'https://factory.example.com/w/A/home/notifications?open=n1',
    })
    expect(rules.readMessage('not json', origin)).toEqual({ title: 'Nexus Factory', body: '', tag: undefined, url: 'https://factory.example.com/' })
    expect(rules.target('https://elsewhere.example.org/x', origin)).toBe('https://factory.example.com/')
    expect(rules.target(null, origin)).toBe('https://factory.example.com/')
  })

  it('is sent as one self-contained script run on its own scope', () => {
    expect(PUSH_WORKER_SOURCE).toMatch(/^'use strict';\n\(function/)
    expect(PUSH_WORKER_SOURCE.trimEnd().endsWith(')(self);')).toBe(true)
    // It runs: given a scope, it attaches its four listeners and hands back nothing.
    const types: string[] = []
    const scope = { addEventListener: (type: string) => void types.push(type), registration: { showNotification: async () => undefined }, clients: { matchAll: async () => [], openWindow: async () => undefined, claim: async () => undefined }, location: { origin: 'https://x.example' }, skipWaiting: async () => undefined }
    expect(new Function('self', PUSH_WORKER_SOURCE)(scope)).toBeUndefined()
    expect(types).toEqual(['install', 'activate', 'push', 'notificationclick'])
  })
})

describe('the cases', () => {
  it('draws every case of SCR-546 and SCR-547 with no key on screen, in it and en', () => {
    for (const screen of [prefsScreen, pushScreen] as DesignScreen<unknown>[]) {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model: item.model })))
          expect(html, `${screen.screen} ${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
        }
      }
    }
  })
})
