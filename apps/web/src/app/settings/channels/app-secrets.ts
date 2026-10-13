/**
 * P0.5 (docs/channel-connections/FINAL-PLAN.md) — what the "App secrets" card says about each of our
 * channel apps. Pure, so the web vitest runner (node, no DOM) can pin every wording and tone.
 *
 * The rows come from `GET /api/cx/apps`, which never returns a secret — only the expiry date an
 * operator recorded and the days left.
 */
import type { Tone } from '@/design-system/primitives'

export interface AppSecretRow {
  channelKey: string
  label: string
  environment: string
  secretExpiresAt: string | null
  daysLeft: number | null
  rotatedAt: string | null
  /** P6.1 — Amazon SP-API only: whether Nexus rotates the secret by itself. */
  automaticRotation?: boolean | null
}

/** P6.1 — one sentence about automatic rotation, for the apps that have it; null for the rest. */
export function rotationNote(row: AppSecretRow): string | null {
  if (row.automaticRotation === true) {
    return `Automatic rotation is on: Nexus asks Amazon for a new secret ${row.secretExpiresAt ? '30 days before this date' : 'as soon as Amazon reports the date'}, tests it and stores it.${row.rotatedAt ? ` Last rotated ${formatExpiryDate(row.rotatedAt)}.` : ''}`
  }
  if (row.automaticRotation === false) {
    return 'Automatic rotation is off: register the credential queue with Amazon to turn it on (see the channel-connections runbook).'
  }
  return null
}

/** Apps whose secret expires on a fixed schedule we must track (Amazon: every 180 days). */
export const SECRET_EXPIRES_ON_SCHEDULE = new Set(['AMAZON_SP'])

export function formatExpiryDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function appSecretStatus(row: AppSecretRow): { tone: Tone; label: string; detail: string } {
  const scheduled = SECRET_EXPIRES_ON_SCHEDULE.has(row.channelKey)
  if (!row.secretExpiresAt || row.daysLeft === null) {
    return scheduled
      ? {
          tone: 'warning',
          label: 'No expiry date recorded',
          detail: 'Find the date on this app’s LWA credentials in the Amazon Solution Provider Portal and record it here. Without it, Nexus cannot warn you before every Amazon call stops.',
        }
      : {
          tone: 'neutral',
          label: 'No expiry date recorded',
          detail: 'This channel does not expire our app secret on a schedule. Record a date only if the channel gave you one.',
        }
  }
  const date = formatExpiryDate(row.secretExpiresAt)
  const days = row.daysLeft
  if (days < 0) {
    return { tone: 'danger', label: 'Expired', detail: `The secret expired on ${date}. Rotate it in the channel’s developer portal now, then record the new date.` }
  }
  const left = `${days} day${days === 1 ? '' : 's'} left`
  const detail = `The secret expires on ${date}. Nexus alerts 90, 30 and 7 days before.`
  if (days <= 7) return { tone: 'danger', label: left, detail }
  if (days <= 30) return { tone: 'warning', label: left, detail }
  if (days <= 90) return { tone: 'info', label: left, detail }
  return { tone: 'success', label: left, detail }
}

/** The `yyyy-mm-dd` the date field edits, from the stored ISO timestamp (midnight UTC). */
export const expiryInputValue = (row: AppSecretRow): string => row.secretExpiresAt?.slice(0, 10) ?? ''

/** Apps with a scheduled expiry first (they can stop every call), then by name. */
export function sortAppSecrets(rows: AppSecretRow[]): AppSecretRow[] {
  const rank = (row: AppSecretRow) => (SECRET_EXPIRES_ON_SCHEDULE.has(row.channelKey) ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label) || a.environment.localeCompare(b.environment))
}

/**
 * Google (2026-10-13) — our own Google Cloud OAuth client, from `GET /api/cx/apps/credentials`. The secret
 * is write-only: the API says whether one is set, never what it is. The client id is not a secret.
 */
export interface AppCredentialsRow {
  channelKey: string
  label: string
  environment: string
  /** The exact address to register in Google Cloud; null when the server does not know its public address. */
  redirectUri: string | null
  redirectUriProblem: string | null
  clientId: string | null
  secretSet: boolean
  /** saved = set in Nexus; environment = from the server's environment variables; none = not set. */
  source: 'saved' | 'environment' | 'none'
  updatedAt: string | null
}

/** What the Google sign-in app's status pill and sentence say. */
export function appCredentialsStatus(row: AppCredentialsRow): { tone: Tone; label: string; detail: string } {
  if (row.source === 'none' || !row.clientId) {
    return {
      tone: 'warning',
      label: 'Not set',
      detail: 'Google cannot be connected until an Owner pastes the client ID and client secret of the Nexus OAuth client from Google Cloud.',
    }
  }
  if (!row.secretSet) {
    return { tone: 'warning', label: 'Secret missing', detail: `Client ${row.clientId} is set, but its secret is not. Paste the client secret to finish.` }
  }
  if (row.source === 'environment') {
    return {
      tone: 'info',
      label: 'From the server settings',
      detail: `Nexus uses client ${row.clientId} from the server’s environment. Saving here replaces it.`,
    }
  }
  return {
    tone: 'success',
    label: 'Set',
    detail: `Client ${row.clientId}. The secret is stored encrypted and is never shown.${row.updatedAt ? ` Saved ${formatExpiryDate(row.updatedAt)}.` : ''}`,
  }
}

/** Google's web client ids end in `.apps.googleusercontent.com` (the API checks the same). */
export const GOOGLE_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.apps\.googleusercontent\.com$/

/** What is wrong with the form before it is sent, in words; null when it can be saved. */
export function appCredentialsFormProblem(clientId: string, clientSecret: string): string | null {
  const id = clientId.trim()
  const secret = clientSecret.trim()
  if (!id && !secret) return 'Paste the client ID and the client secret.'
  if (!GOOGLE_CLIENT_ID_PATTERN.test(id)) return 'The client ID of a Google OAuth client ends in .apps.googleusercontent.com.'
  if (!secret) return 'Paste the client secret too. Google shows it next to the client ID.'
  if (/\s/.test(secret)) return 'The client secret has no spaces. Paste it again.'
  return null
}
