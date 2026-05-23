/**
 * RV.9.5 — Public unsubscribe confirmation page.
 *
 * The API /email/unsubscribe endpoint redirects here after recording
 * the suppression. No auth — anonymous customer landing page.
 *
 * Multilingual: detects ?lang= or accepts the standard 4 locales
 * Xavia sends to. Defaults to IT.
 */

interface PageProps {
  searchParams: Promise<{ channel?: string; lang?: string }>
}

type Lang = 'it' | 'de' | 'fr' | 'es' | 'en'

const COPY: Record<Lang, { title: string; body: string; channelLabel: string; resub: string }> = {
  it: {
    title: 'Iscrizione annullata',
    body: 'Hai annullato l\'iscrizione. Non ti invieremo più email di richiesta recensione.',
    channelLabel: 'Canale',
    resub: 'Per riattivare, scrivi a support@xavia.it.',
  },
  de: {
    title: 'Abgemeldet',
    body: 'Du hast Dich abgemeldet. Wir senden Dir keine Bewertungsanfragen mehr.',
    channelLabel: 'Kanal',
    resub: 'Zum Wiederanmelden schreibe an support@xavia.it.',
  },
  fr: {
    title: 'Désinscription confirmée',
    body: 'Tu es désinscrit. Nous ne t\'enverrons plus de demandes d\'avis.',
    channelLabel: 'Canal',
    resub: 'Pour te réinscrire, écris à support@xavia.it.',
  },
  es: {
    title: 'Suscripción cancelada',
    body: 'Has cancelado la suscripción. No te enviaremos más solicitudes de reseña.',
    channelLabel: 'Canal',
    resub: 'Para reactivar, escribe a support@xavia.it.',
  },
  en: {
    title: 'Unsubscribed',
    body: 'You\'ve unsubscribed. We won\'t send you any more review request emails.',
    channelLabel: 'Channel',
    resub: 'To re-subscribe, email support@xavia.it.',
  },
}

export default async function UnsubscribedPage({ searchParams }: PageProps) {
  const { channel, lang } = await searchParams
  const l: Lang = (['it', 'de', 'fr', 'es', 'en'] as Lang[]).includes((lang ?? 'it') as Lang)
    ? ((lang ?? 'it') as Lang)
    : 'it'
  const copy = COPY[l]
  const channelDisplay = channel === 'all' || !channel ? '—' : channel

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg shadow-sm p-8 text-center">
        <div className="text-5xl mb-3">✓</div>
        <h1 className="text-xl font-semibold text-slate-900 mb-2">{copy.title}</h1>
        <p className="text-sm text-slate-600 mb-4">{copy.body}</p>
        <div className="text-xs text-slate-500 border-t border-slate-100 pt-3 space-y-1">
          <div>
            <span className="text-slate-400">{copy.channelLabel}:</span>{' '}
            <code className="bg-slate-100 px-1 rounded">{channelDisplay}</code>
          </div>
          <div className="text-slate-400">{copy.resub}</div>
        </div>
        <div className="mt-4 text-[10px] tracking-widest text-rose-700 font-bold">XAVIA</div>
      </div>
    </div>
  )
}
