/**
 * RV.6.2 — Customer-facing landing page for the "I love it" branch of
 * the post-purchase sentiment check email.
 *
 * Public route — no auth, the token IS the auth (32-char cryptographically
 * random, never exposes orderId). Server-renders + fires the response
 * recording inline so a clicked email link records the POSITIVE response
 * in a single round-trip — no JS required on the customer device.
 *
 * Idempotent: re-clicking after a response shows the same thank-you page.
 */

import { getBackendUrl } from '@/lib/backend-url'
import { headers } from 'next/headers'

export const dynamic = 'force-dynamic'

async function recordPositive(token: string): Promise<{ ok: boolean; alreadyResponded?: boolean }> {
  try {
    const h = await headers()
    const res = await fetch(`${getBackendUrl()}/api/r/${encodeURIComponent(token)}/positive`, {
      method: 'POST',
      // Forward IP + UA so the API can record them for anti-spam audit.
      headers: {
        'x-forwarded-for': h.get('x-forwarded-for') ?? '',
        'user-agent': h.get('user-agent') ?? '',
      },
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false }
    const data = await res.json()
    return { ok: true, alreadyResponded: data.alreadyResponded === true }
  } catch {
    return { ok: false }
  }
}

export default async function PositiveLandingPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const result = await recordPositive(token)

  // Visual presentation kept intentionally simple: this page is opened
  // from a phone in 2 seconds after a customer clicks. No nav, no chrome.
  return (
    <main style={{
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      maxWidth: '480px',
      margin: '0 auto',
      padding: '48px 24px',
      textAlign: 'center',
      color: '#1a1a1a',
    }}>
      <div style={{ fontSize: '64px', marginBottom: '16px' }}>🙏</div>
      <h1 style={{ fontSize: '28px', fontWeight: 700, marginBottom: '12px' }}>
        Grazie mille!
      </h1>
      <p style={{ fontSize: '17px', lineHeight: 1.5, color: '#555', marginBottom: '24px' }}>
        Siamo davvero felici che il tuo ordine sia andato bene. Il tuo
        feedback significa molto per noi.
      </p>
      <p style={{ fontSize: '15px', lineHeight: 1.5, color: '#777', marginBottom: '32px' }}>
        Ti invieremo a breve un breve invito a lasciare una recensione su
        Amazon — bastano 30 secondi e aiuterà tantissimi altri motociclisti
        a scegliere il prodotto giusto.
      </p>
      <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '24px 0' }} />
      <p style={{ fontSize: '14px', lineHeight: 1.5, color: '#888' }}>
        Thank you! We&apos;ll send a short Amazon review invitation shortly.
        It takes 30 seconds and helps many other riders pick the right gear.
      </p>
      {!result.ok && (
        <p style={{ marginTop: '24px', fontSize: '12px', color: '#c00' }}>
          Couldn&apos;t record your response — please try the link again later.
        </p>
      )}
      {result.alreadyResponded && (
        <p style={{ marginTop: '24px', fontSize: '12px', color: '#888', fontStyle: 'italic' }}>
          We already received your response — thank you!
        </p>
      )}
    </main>
  )
}
