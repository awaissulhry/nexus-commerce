/**
 * RV.6.2 — Customer-facing landing page for the "Something's wrong"
 * branch of the post-purchase sentiment check email.
 *
 * Shows a short feedback form. On submit, records NEGATIVE + the typed
 * feedback. Suppresses the Amazon Solicitations downstream send. Emails
 * the support inbox so ops can reach out before the customer leaves a
 * public 1-star review.
 */

import { NegativeForm } from './NegativeForm'

export const dynamic = 'force-dynamic'

export default async function NegativeLandingPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return (
    <main style={{
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      maxWidth: '520px',
      margin: '0 auto',
      padding: '40px 24px',
      color: '#1a1a1a',
    }}>
      <div style={{ fontSize: '52px', textAlign: 'center', marginBottom: '12px' }}>🙏</div>
      <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px', textAlign: 'center' }}>
        Ci dispiace molto.
      </h1>
      <p style={{ fontSize: '16px', lineHeight: 1.5, color: '#555', marginBottom: '24px', textAlign: 'center' }}>
        Vogliamo sistemare le cose. Dicci cosa è andato storto e ti risponderemo entro 24 ore.
      </p>
      <NegativeForm token={token} />
      <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '32px 0 16px' }} />
      <p style={{ fontSize: '12px', lineHeight: 1.5, color: '#999', textAlign: 'center' }}>
        We&apos;re sorry. Tell us what went wrong and we&apos;ll reach out within 24 hours.
      </p>
    </main>
  )
}
