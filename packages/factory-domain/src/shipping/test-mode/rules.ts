import type { Issue } from '../../core/errors'
import type { CarrierAddress, CarrierLabel, CarrierLabelRequest } from '../../ports/carrier'

/**
 * Test carrier mode (B-W2b-390; LOG-035 "a fake carrier for training"; factory-db ShippingSettings.testMode, liveSince,
 * liveSetById, B-W2b-367), pure. Per site, ON by default (every site starts in test mode):
 *
 *   test mode  a buy's labels are made by the TEST carrier in the process: nothing is sent to a carrier or Sendcloud, nothing
 *              is charged, no Sendcloud connection is needed (setting up and training cost nothing). A TEST label is
 *              marked on the parcel by its provider id (`test:<the parcel's reference>`), its tracking number starts with
 *              TEST and its PDF and ZPL say TEST LABEL in large letters, with no barcode: it never looks like a real one.
 *              It is voided without a carrier call, never tracked, never polled.
 *   go live    "Switch to live labels": a fresh step-up and the site's usable Sendcloud connection; ONE write (testMode
 *              false, liveSince now, liveSetById the person) and, in the same command, every TEST label of the site's
 *              shipments that have not left is cleared (bought again, live, before they leave). From then on labels are
 *              bought and charged.
 *   back       back to test mode at any time (no step-up: nothing is spent); live labels bought stay as they are.
 *
 * Refusals are 409 with the issue path `refusal/<CODE>`; the screens word the code (`TEST_MODE_WORDS`).
 */

/** The provider id of a TEST label starts with this (a Sendcloud id never does). */
export const TEST_LABEL_PREFIX = 'test:'

/** A parcel's label was made by the TEST carrier (its provider id says so). */
export const isTestLabel = (providerId: string | null | undefined): boolean => typeof providerId === 'string' && providerId.startsWith(TEST_LABEL_PREFIX)

/** Why a test-mode switch is refused (409 `refusal/<CODE>`). */
export const TEST_MODE_REFUSALS = ['NO_SETTINGS', 'ALREADY_LIVE', 'ALREADY_TEST', 'NO_CARRIER_ACCOUNT'] as const
export type TestModeRefusalCode = (typeof TEST_MODE_REFUSALS)[number]

export const testModeRefusalPath = (code: TestModeRefusalCode): string => `refusal/${code}`

/** What test mode and live labels do, and the warning before going live (English; the screens word the codes). */
export const TEST_MODE_WORDS = Object.freeze({
  TEST: 'Test mode: a test carrier makes the labels, marked TEST; nothing is sent to a carrier and nothing is charged.',
  LIVE: "Live labels: labels are bought from the carrier through the company's Sendcloud connection and charged.",
  GO_LIVE: 'Labels will be bought and charged from now on.',
} as const)

/** The site's test mode as the settings keep it (null: the site has no shipping settings yet). */
export interface TestModeSettings {
  readonly testMode: boolean
}

/** Why the site cannot switch to live labels now (null: it can). `account` = the buy's own account problems. */
export function goLiveRefusal(settings: TestModeSettings | null, account: readonly Issue[]): { readonly code: TestModeRefusalCode; readonly message: string } | null {
  if (!settings) return { code: 'NO_SETTINGS', message: 'This site has no shipping settings yet: save its sender address first; it starts in test mode.' }
  if (!settings.testMode) return { code: 'ALREADY_LIVE', message: 'This site buys live labels already.' }
  if (account.length > 0) return { code: 'NO_CARRIER_ACCOUNT', message: `Live labels need the company's own Sendcloud connection: ${account.map((issue) => issue.message).join(' ')}` }
  return null
}

/** Why the site cannot go back to test mode (null: it can). */
export function backToTestRefusal(settings: TestModeSettings | null): { readonly code: TestModeRefusalCode; readonly message: string } | null {
  if (!settings) return { code: 'NO_SETTINGS', message: 'This site has no shipping settings yet: it is in test mode as soon as they are saved.' }
  if (settings.testMode) return { code: 'ALREADY_TEST', message: 'This site is in test mode already.' }
  return null
}

/**
 * The tracking number of a TEST label: TEST, the parcel's id (its first 10 hex digits) and its version, from the label's
 * reference `<parcelId>.v<version>`: the same parcel gives the same number until a void moves its version on.
 */
export function testTrackingNumberOf(externalReference: string): string {
  const [id = '', version = ''] = externalReference.split('.v')
  const digits = id.replace(/[^0-9a-fA-F]/g, '').slice(0, 10).toUpperCase()
  return `TEST-${digits || '0'}-${version.replace(/\D/g, '') || '1'}`
}

/** The TEST carrier's label for one parcel: no carrier, no tracking page, no expected delivery. */
export function testLabelOf(request: CarrierLabelRequest): CarrierLabel {
  return Object.freeze({
    providerId: `${TEST_LABEL_PREFIX}${request.externalReference}`,
    trackingNumber: testTrackingNumberOf(request.externalReference),
    trackingUrl: null,
    expectedDeliveryAt: null,
    carrierCode: request.carrierCode,
    // The shipment keeps the carrier name it has: a test carrier names none (the DDT's carrier stays a person's choice).
    carrierName: null,
  })
}

/** The lines a TEST label prints, top to bottom (the API lays them out as a PDF and as ZPL). */
export interface TestLabelText {
  readonly banner: 'TEST'
  readonly title: string
  readonly notice: string
  readonly lines: readonly string[]
}

const addressLines = (address: CarrierAddress): string[] =>
  [address.name, address.companyName, address.line1, address.line2, [address.postalCode, address.city, address.province].filter(Boolean).join(' '), address.country].filter(
    (line): line is string => typeof line === 'string' && line.trim() !== '',
  )

export function testLabelText(request: CarrierLabelRequest, label: Pick<CarrierLabel, 'trackingNumber'>): TestLabelText {
  return {
    banner: 'TEST',
    title: 'TEST LABEL - NOT FOR SHIPPING',
    notice: 'Test mode: nothing was sent to a carrier and nothing was charged.',
    lines: [
      `Shipment ${request.shipmentNumber} - parcel ${request.seq} of ${request.parcels}`,
      `Tracking ${label.trackingNumber}`,
      `Weight ${request.weightKg} kg`,
      'From:',
      ...addressLines(request.from),
      'To:',
      ...addressLines(request.to),
    ],
  }
}
