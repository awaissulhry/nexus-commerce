/**
 * Phase S1 (auth core) — transactional auth emails (invite + reset).
 *
 * Uses the shared Resend transport (services/email/transport.ts). Like
 * every outbound email it is dry-run unless NEXUS_ENABLE_OUTBOUND_EMAILS
 * =true — so in dev/staging the invite/reset LINK is still returned to
 * the caller (owner) as a copyable string; email is the delivery bonus,
 * not the dependency (master prompt S0/S1).
 *
 * Security emails deliberately do NOT consult EmailSuppression — an
 * unsubscribe from marketing must never suppress a password reset.
 */

import { sendEmail, type SendResult } from './transport.js'

function webBase(): string {
  return (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app').replace(/\/$/, '')
}

export function invitationLink(rawToken: string): string {
  return `${webBase()}/accept-invite?token=${encodeURIComponent(rawToken)}`
}

export function passwordResetLink(rawToken: string): string {
  return `${webBase()}/reset-password?token=${encodeURIComponent(rawToken)}`
}

const wrap = (title: string, body: string) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
    <h1 style="font-size:18px;margin:0 0 16px">${title}</h1>
    ${body}
    <p style="font-size:12px;color:#888;margin-top:24px">Nexus Commerce · If you didn't expect this email you can ignore it.</p>
  </div>`

const button = (href: string, label: string) => `
  <p style="margin:20px 0"><a href="${href}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600">${label}</a></p>
  <p style="font-size:12px;color:#666">Or paste this link:<br><span style="word-break:break-all">${href}</span></p>`

export async function sendInvitationEmail(opts: {
  to: string
  roleName: string
  link: string
  expiresAt: Date
}): Promise<SendResult> {
  const html = wrap(
    'You have been invited to Nexus Commerce',
    `<p>You have been invited to join as <strong>${opts.roleName}</strong>. Set your password to activate your account.</p>
     ${button(opts.link, 'Accept invitation')}
     <p style="font-size:12px;color:#666">This invitation expires ${opts.expiresAt.toUTCString()}.</p>`,
  )
  return sendEmail({
    to: opts.to,
    subject: 'Your Nexus Commerce invitation',
    html,
    tag: 'auth-invitation',
  })
}

export async function sendPasswordResetEmail(opts: {
  to: string
  link: string
  expiresAt: Date
}): Promise<SendResult> {
  const html = wrap(
    'Reset your Nexus Commerce password',
    `<p>We received a request to reset your password. This link is valid for a short time and can be used once.</p>
     ${button(opts.link, 'Reset password')}
     <p style="font-size:12px;color:#666">Expires ${opts.expiresAt.toUTCString()}. If you didn't request this, no action is needed — your password is unchanged.</p>`,
  )
  return sendEmail({
    to: opts.to,
    subject: 'Reset your Nexus Commerce password',
    html,
    tag: 'auth-password-reset',
  })
}
