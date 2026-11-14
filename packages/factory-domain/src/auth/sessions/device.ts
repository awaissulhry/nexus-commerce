/**
 * Where a session runs (B-W2b-404; PLT-064; design shell.profile "Where I'm signed in": "device and browser · place
 * (country, city from IP) · last used"), pure. Set once when the session starts (Session.deviceLabel, browser, ipCountry,
 * ipCity: the database refuses a change, B-W2b-373), never the address itself:
 *
 *   device   from the browser's user agent: one of DEVICE_LABELS (the stored text; the API answers its kind, a code, so
 *            the web says it in the person's language), or nothing for one we do not know
 *   browser  the browser's name and major version ("Firefox 132"): names and numbers, said the same in every language
 *   place    the country (ISO 3166-1, two capitals) and city an edge proxy we trust put on the request; nothing without
 *            one (the factory keeps no address database)
 */

export const DEVICE_LABELS = Object.freeze({
  MAC: 'Mac',
  WINDOWS: 'Windows PC',
  LINUX: 'Linux PC',
  CHROMEBOOK: 'Chromebook',
  IPHONE: 'iPhone',
  IPAD: 'iPad',
  ANDROID_PHONE: 'Android phone',
  ANDROID_TABLET: 'Android tablet',
})
export type DeviceKind = keyof typeof DEVICE_LABELS
export const DEVICE_KINDS = Object.freeze(Object.keys(DEVICE_LABELS) as DeviceKind[])

/** The kind of a stored device label (null: none, or a label we do not know). */
export function deviceKindOf(label: string | null): DeviceKind | null {
  if (label === null) return null
  return DEVICE_KINDS.find((kind) => DEVICE_LABELS[kind] === label) ?? null
}

function deviceKind(agent: string): DeviceKind | null {
  if (/\biPad\b/.test(agent)) return 'IPAD'
  if (/\biPhone\b|\biPod\b/.test(agent)) return 'IPHONE'
  if (/\bAndroid\b/.test(agent)) return /\bMobile\b/.test(agent) ? 'ANDROID_PHONE' : 'ANDROID_TABLET'
  if (/\bCrOS\b/.test(agent)) return 'CHROMEBOOK'
  if (/\bWindows\b/.test(agent)) return 'WINDOWS'
  if (/\bMacintosh\b|\bMac OS X\b/.test(agent)) return 'MAC'
  if (/\bLinux\b|\bX11\b/.test(agent)) return 'LINUX'
  return null
}

/** Browser names and the user-agent token that carries their version, first match wins (Edge and Opera say Chrome too). */
const BROWSERS: readonly (readonly [string, RegExp])[] = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/(\d{1,4})/],
  ['Opera', /\bOPR\/(\d{1,4})/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d{1,4})/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d{1,4})/],
  ['Chrome', /\b(?:Chrome|CriOS)\/(\d{1,4})/],
  ['Safari', /\bVersion\/(\d{1,4})[.\d]*.*\bSafari\//],
]

function browserOf(agent: string): string | null {
  for (const [name, pattern] of BROWSERS) {
    const match = pattern.exec(agent)
    if (match) return `${name} ${match[1]}`
  }
  return null
}

export interface SessionDevice {
  /** One of DEVICE_LABELS, or null. */
  readonly deviceLabel: string | null
  readonly browser: string | null
}

/** The device and browser of a user agent (nothing for an empty or unknown one). */
export function deviceOf(userAgent: string | null | undefined): SessionDevice {
  const agent = typeof userAgent === 'string' ? userAgent.slice(0, 512) : ''
  if (agent.trim() === '') return { deviceLabel: null, browser: null }
  const kind = deviceKind(agent)
  return { deviceLabel: kind === null ? null : DEVICE_LABELS[kind], browser: browserOf(agent) }
}

export interface SessionPlace {
  /** ISO 3166-1 alpha-2, two capitals. */
  readonly ipCountry: string | null
  /** Only with its country. */
  readonly ipCity: string | null
}

/** Codes an edge proxy uses for "no country" (unknown, Tor). */
const NO_COUNTRY = new Set(['XX', 'T1'])

/** The place an edge proxy put on the request: its country and city headers (null without a country we can keep). */
export function placeOf(headers: { readonly country?: unknown; readonly city?: unknown }): SessionPlace {
  const country = typeof headers.country === 'string' ? headers.country.trim().toUpperCase() : ''
  if (!/^[A-Z]{2}$/.test(country) || NO_COUNTRY.has(country)) return { ipCountry: null, ipCity: null }
  const city = typeof headers.city === 'string' ? headers.city.trim() : ''
  // One line of at most 100 characters, without control characters (the database keeps the same rule).
  const keep = city.length > 0 && city.length <= 100 && !/[\u0000-\u001f\u007f]/.test(city)
  return { ipCountry: country, ipCity: keep ? city : null }
}
