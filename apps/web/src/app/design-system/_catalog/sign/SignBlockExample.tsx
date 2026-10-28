'use client'

import { useEffect, useRef, useState } from 'react'

import { SummaryTable } from '@/design-system/components'
import { SignBlock, type SignAcceptance, type SignBlockState } from '@/design-system/components/SignBlock'
import { DensityProvider } from '@/design-system/lib/density'
import { SegmentedControl } from '@/design-system/primitives'

import s from './sign.module.css'

/*
 * 2026-10-28 — sign and accept (gap G12, `packages/ui/src/components/SignBlock`): the quote-accept link (SCR-099) on the
 * comfortable tier, phone width and desktop width, and a PO confirmation (SCR-100) without the email check. Fake data;
 * the fake check takes "Maria Rossi" in any case, order or accents, and maria@example.com. Verify: no error while typing;
 * leaving a field or pressing Accept says what is wrong and focuses the first problem; Busy holds Accept with its reason;
 * Done replaces the form with the end state; Used holds the whole block.
 */

type Demo = 'live' | 'used'

function QuoteAccept({ id, demo }: { id: string; demo: Demo }) {
  const [state, setState] = useState<SignBlockState>('idle')
  const [accepted, setAccepted] = useState<SignAcceptance | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <SignBlock
      id={id}
      title="Accetta il preventivo Q-2026-0042"
      summary={
        <SummaryTable
          label="Il preventivo"
          columns={['Articolo', 'Quantità', 'Totale']}
          rows={[
            { id: 'a', cells: ['Giacca Aria su misura', '1', '1.180,00 €'] },
            { id: 'b', cells: ['Acconto da versare', '', '354,00 €'] },
          ]}
          stackOnPhone
        />
      }
      legal={
        <p>
          Scrivendo il tuo nome e premendo Accetto accetti il preventivo Q-2026-0042 e le condizioni di vendita. Il capo è
          fatto su misura per te: non si applica il diritto di recesso. Ti mandiamo una copia per email.
        </p>
      }
      acknowledgements={[{ id: 'mtm', label: 'Ho letto: un capo su misura non si può restituire.' }]}
      acknowledgementMissingLabel="Spunta per continuare"
      nameLabel="Nome e cognome"
      nameHint="Come sul preventivo"
      expectedName="Maria Rossi"
      nameEmptyLabel="Scrivi nome e cognome"
      nameMismatchLabel="Il nome non è quello del preventivo"
      email={{
        label: 'La tua email',
        hint: "L'indirizzo a cui hai ricevuto questo link",
        expected: 'maria@example.com',
        emptyLabel: 'Scrivi la tua email',
        invalidLabel: 'Non sembra un indirizzo email',
        mismatchLabel: "Non è l'indirizzo a cui abbiamo scritto",
      }}
      acceptLabel="Accetto"
      onAccept={(a) => {
        setState('busy')
        timer.current = window.setTimeout(() => {
          setAccepted(a)
          setState('done')
        }, 900)
      }}
      declineLabel="Rifiuta"
      onDecline={() => undefined}
      state={state}
      busyLabel="Invio in corso"
      heldReason={demo === 'used' ? 'Questo link è già stato usato il 27/10 alle 18:04' : null}
      done={
        <p>
          Accettato da {accepted?.name}. Ti abbiamo mandato una copia a {accepted?.email}. Per l&apos;acconto trovi i dati del
          bonifico nell&apos;email.
        </p>
      }
    />
  )
}

function PoConfirm() {
  const [state, setState] = useState<SignBlockState>('idle')
  return (
    <SignBlock
      title="Conferma l'ordine d'acquisto PO-2026-0107"
      summary={
        <SummaryTable
          label="L'ordine"
          columns={['Materiale', 'Quantità', 'Consegna']}
          rows={[
            { id: 'a', cells: ['Pelle bovina 1,2 mm nera', '120 m²', '14/11'] },
            { id: 'b', cells: ['Fodera rete', '80 m', '14/11'] },
          ]}
          stackOnPhone
        />
      }
      legal={<p>Confermando ti impegni a consegnare le quantità e le date indicate. Per cambiarle usa Proponi modifiche.</p>}
      nameLabel="Nome e cognome di chi conferma"
      nameEmptyLabel="Scrivi nome e cognome"
      acceptLabel="Confermo l'ordine"
      onAccept={() => setState('done')}
      state={state}
      done={<p>Ordine confermato. Grazie.</p>}
    />
  )
}

export function SignBlockExample() {
  const [demo, setDemo] = useState<Demo>('live')
  return (
    <section id="sign-block-example" className={s.kit} lang="it">
      <div className={s.controls}>
        <SegmentedControl
          size="sm"
          ariaLabel="Link state"
          value={demo}
          onChange={(v) => setDemo(v === 'used' ? 'used' : 'live')}
          options={[
            { value: 'live', label: 'Link valid' },
            { value: 'used', label: 'Link already used' },
          ]}
        />
        <p className={s.note}>Comfortable tier, as a link page. The fake check takes “Maria Rossi” and maria@example.com.</p>
      </div>
      <DensityProvider value="comfortable">
        <div className={s.pair}>
          <div className={s.example}>
            <span className={s.caption}>Phone width (390 px)</span>
            <div className={`${s.page} ${s.phone}`}>
              <QuoteAccept key={`phone-${demo}`} id="sign-quote-phone" demo={demo} />
            </div>
          </div>
          <div className={s.example}>
            <span className={s.caption}>PO confirmation (SCR-100): no email check</span>
            <div className={s.page}>
              <PoConfirm />
            </div>
          </div>
        </div>
        <div className={s.example}>
          <span className={s.caption}>Desktop width</span>
          <div className={`${s.page} ${s.desktop}`}>
            <QuoteAccept key={`desk-${demo}`} id="sign-quote-desktop" demo={demo} />
          </div>
        </div>
      </DensityProvider>
    </section>
  )
}
