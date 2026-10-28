'use client'

import { useState } from 'react'

import { SegmentedControl } from '@/design-system/primitives'

import { FLOOR_COPY, type FloorLang } from './floorCopy'
import s from './floorCatalog.module.css'
import { FloorShellExample } from './FloorShellExample'
import { FloorWorkExample } from './FloorWorkExample'
import { PinPadExample } from './PinPadExample'
import { ScanInputExample } from './ScanInputExample'

/*
 * 2026-10-28 — the floor kit (`packages/ui/src/floor`, gaps G2 G3 G4 G5 G8): the parts the factory's floor tablets are
 * built from, each on the floor density tier (the PIN pad on comfortable too), with fake Italian and English words passed
 * in by this page as the factory app will. Switch the language here or with the language button in the frame's top bar.
 */
export function FloorKitExample() {
  const [lang, setLang] = useState<FloorLang>('it')
  const copy = FLOOR_COPY[lang]
  return (
    <section id="floor-kit-example" className={s.kit} lang={lang}>
      <div className={s.controls}>
        <SegmentedControl
          size="sm"
          ariaLabel="Language of the examples"
          value={lang}
          onChange={(v) => setLang(v === 'en' ? 'en' : 'it')}
          options={[
            { value: 'it', label: 'Italiano' },
            { value: 'en', label: 'English' },
          ]}
        />
        <p className={s.note}>Every word below comes from the page; the floor parts hold none. All names, codes and numbers are made up.</p>
      </div>
      <FloorShellExample copy={copy} lang={lang} onLang={setLang} />
      <ScanInputExample copy={copy} />
      <PinPadExample copy={copy} />
      <FloorWorkExample copy={copy} />
    </section>
  )
}
