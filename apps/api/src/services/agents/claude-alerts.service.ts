/**
 * ADS AUTONOMY W4-2 — the failures of Claude's unattended work the Owner must hear about at once (agent-results/6 §8,
 * "Failures — the Owner must hear each one"): a daily run that never reported, a run that started and never ended,
 * Nexus pausing Claude's rule-runs by itself, and a Claude connection ended because a refresh token was used twice.
 *
 * Each is ONE `danger` notice (never deduped: ads-automation-notify.service.ts) and one e-mail through the shared
 * transport (a dry run unless outbound e-mail is on). A business-wide alert goes to the business's people's bell and to
 * the Monday ads digest's recipients — the same people the daily report reaches; a connection alert goes to the person
 * whose connection it was, bell and e-mail. Best-effort: an alert that cannot be delivered is logged, never thrown into
 * the work that raised it. The caller runs it inside the business (row-level security), after its transaction.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { sendEmail } from '../email/transport.js'
import { notifyAutomationDetailed } from '../advertising/ads-automation-notify.service.js'

export interface AlertMessage {
  /** Notification.type: what kind of alert (claude-ads-watchdog, claude-autorun-paused, claude-connection-revoked). */
  type: string
  title: string
  /** Plain words: what happened and what to do. Also the e-mail's text. */
  body: string
  href: string
  meta?: Record<string, unknown>
}

export interface AlertOutcome {
  notices: number
  email: 'sent' | 'dry-run' | 'skipped' | 'failed'
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function html(m: AlertMessage): string {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1c2530;max-width:680px">
  <div style="padding:12px 14px;border-left:3px solid #a3342b;background:#fdf6f5">
    <b>${esc(m.title)}</b>
    ${m.body.split('\n').map((line) => `<div style="margin-top:4px">${esc(line)}</div>`).join('')}
  </div>
</div>`
}

async function mail(to: string[], m: AlertMessage): Promise<AlertOutcome['email']> {
  if (!to.length) return 'skipped'
  try {
    const sent = await sendEmail({ to, subject: m.title, html: html(m), text: `${m.title}\n\n${m.body}`, tag: m.type })
    return sent.dryRun ? 'dry-run' : sent.ok ? 'sent' : 'failed'
  } catch (error) {
    logger.warn('[claude-alerts] e-mail failed', { type: m.type, error: String(error).slice(0, 140) })
    return 'failed'
  }
}

/** The Monday ads digest's recipients (NEXUS_ADS_DIGEST_RECIPIENTS); loaded where used, as its module graph is wide. */
async function digestRecipients(): Promise<string[]> {
  const { digestRecipients: read } = await import('../advertising/ads-weekly-digest-mail.service.js')
  return read()
}

/** To the business: a danger notice to its people's bell, and the e-mail to the Monday ads digest's recipients. */
export async function alertBusiness(m: AlertMessage): Promise<AlertOutcome> {
  try {
    const notice = await notifyAutomationDetailed({ type: m.type, severity: 'danger', title: m.title, body: m.body, href: m.href, meta: m.meta })
    return { notices: notice.created, email: await mail(await digestRecipients(), m) }
  } catch (error) {
    logger.warn('[claude-alerts] business alert failed', { type: m.type, error: String(error).slice(0, 140) })
    return { notices: 0, email: 'failed' }
  }
}

/** To one person: a danger notice to their bell and an e-mail to their own address. */
export async function alertPerson(userId: string, m: AlertMessage): Promise<AlertOutcome> {
  try {
    await prisma.notification.create({
      data: { userId, type: m.type, severity: 'danger', title: m.title, body: m.body, href: m.href, meta: (m.meta ?? undefined) as never },
    })
    const person = await prisma.userProfile.findUnique({ where: { id: userId }, select: { email: true, status: true } })
    const to = person?.email && person.status === 'active' ? [person.email] : []
    return { notices: 1, email: await mail(to, m) }
  } catch (error) {
    logger.warn('[claude-alerts] person alert failed', { type: m.type, error: String(error).slice(0, 140) })
    return { notices: 0, email: 'failed' }
  }
}
