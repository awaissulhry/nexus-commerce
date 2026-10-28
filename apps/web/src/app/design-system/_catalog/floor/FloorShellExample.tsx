'use client'

import { useEffect, useState } from 'react'
import { Boxes, ClipboardList, PackageOpen, ScanLine, Scissors, ShoppingBasket } from 'lucide-react'

import {
  FloorActionBar,
  FloorButton,
  FloorFrame,
  FloorHeader,
  FloorHelpButton,
  FloorTile,
  FloorTileGrid,
  IdleOverlay,
  OfflineBanner,
  OperatorChip,
} from '@/design-system/floor'
import { Button, SegmentedControl } from '@/design-system/primitives'

import type { FloorCopy, FloorLang } from './floorCopy'
import s from './floorCatalog.module.css'

/*
 * SCR-022 floor shell, made from the floor kit with fake data: operator chip, station, language and Help in the top bar;
 * the offline banner with its waiting count; six home tiles; the big action bar; the idle overlay (contained in the frame
 * here, the whole screen in the app). The controls above the frame drive the fake state. Verify light and dark, 1280 and
 * 390 px: nothing under 48 px, tiles 128 px, 8 mm between targets; Tab reaches chip, language, Help, every tile and
 * every action; the idle overlay traps Tab, Escape means "I am here".
 */
export function FloorShellExample({ copy, lang, onLang }: { copy: FloorCopy; lang: FloorLang; onLang: (l: FloorLang) => void }) {
  const [online, setOnline] = useState(false)
  const [pending, setPending] = useState(3)
  const [refused, setRefused] = useState(0)
  const [idle, setIdle] = useState(false)
  const [seconds, setSeconds] = useState(30)
  const [signedOut, setSignedOut] = useState(false)

  // The fake idle countdown: the app runs it with useIdleSignOut.
  useEffect(() => {
    if (!idle) return
    setSeconds(30)
    const t = setInterval(() => setSeconds((v) => Math.max(0, v - 1)), 1000)
    return () => clearInterval(t)
  }, [idle])
  useEffect(() => {
    if (idle && seconds === 0) {
      setIdle(false)
      setSignedOut(true)
    }
  }, [idle, seconds])

  return (
    <div className={s.example} id="floor-shell-example">
      <h3 className={s.title}>Floor shell — FloorFrame, OperatorChip, OfflineBanner, FloorHelpButton, IdleOverlay, tiles, action bar</h3>
      <div className={s.controls}>
        <SegmentedControl
          size="sm"
          ariaLabel="Connection"
          value={online ? 'online' : 'offline'}
          onChange={(v) => setOnline(v === 'online')}
          options={[
            { value: 'offline', label: 'Offline' },
            { value: 'online', label: 'Online' },
          ]}
        />
        <Button size="sm" onClick={() => setPending((n) => n + 1)}>
          + 1 waiting
        </Button>
        <Button size="sm" onClick={() => setPending((n) => Math.max(0, n - 1))}>
          − 1 waiting
        </Button>
        <Button size="sm" onClick={() => setRefused((n) => (n ? 0 : 1))}>
          {refused ? 'Clear refused' : 'Refuse one'}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setSignedOut(false)
            setIdle(true)
          }}
        >
          Show idle warning
        </Button>
      </div>
      <div className={`${s.screen} ${s.tall}`}>
        <FloorFrame
          fill={false}
          landmarks={false}
          label={copy.station}
          header={
            <FloorHeader
              start={<OperatorChip name={copy.operator} detail={copy.operatorDetail} label={copy.operatorMenu} onPress={() => setSignedOut(false)} />}
              title={copy.station}
              end={
                <>
                  <FloorButton size="sm" variant="quiet" lang={lang === 'it' ? 'en' : 'it'} onClick={() => onLang(lang === 'it' ? 'en' : 'it')}>
                    {copy.otherLanguage}
                  </FloorButton>
                  <FloorHelpButton label={copy.help} onPress={() => undefined} hasPopup="dialog" />
                </>
              }
            />
          }
          banner={
            <OfflineBanner
              online={online}
              pending={pending}
              refused={refused}
              offlineLabel={copy.offline}
              sendingLabel={copy.sending}
              pendingLabel={copy.pending}
              refusedLabel={copy.refused}
              syncedLabel={copy.synced}
              lastSyncLabel={copy.lastSync}
              queueLabel={copy.queue}
              onOpenQueue={() => undefined}
              showWhenSynced
            />
          }
          actions={
            <FloorActionBar
              start={signedOut ? copy.signedOut : undefined}
              actions={[{ label: copy.tiles.scan, icon: <ScanLine />, onPress: () => undefined }]}
            />
          }
          overlay={
            <IdleOverlay
              contained
              open={idle}
              secondsLeft={seconds}
              title={copy.idleTitle}
              message={copy.idleMessage}
              secondsLabel={copy.seconds}
              stayLabel={copy.stay}
              onStay={() => setIdle(false)}
              signOutLabel={copy.signOutNow}
              onSignOut={() => {
                setIdle(false)
                setSignedOut(true)
              }}
            />
          }
        >
          <FloorTileGrid label={copy.home} columns={3}>
            <FloorTile icon={<ClipboardList />} label={copy.tiles.work} hint={copy.tileHints.work} count={2} countLabel={copy.queued(2)} tone="primary" onPress={() => undefined} />
            <FloorTile icon={<Scissors />} label={copy.tiles.cutting} count={4} countLabel={copy.queued(4)} tone="warning" onPress={() => undefined} />
            <FloorTile icon={<Boxes />} label={copy.tiles.bundles} onPress={() => undefined} />
            <FloorTile icon={<ScanLine />} label={copy.tiles.scan} tone="info" onPress={() => undefined} />
            <FloorTile icon={<PackageOpen />} label={copy.tiles.receive} count={1} countLabel={copy.queued(1)} tone="success" onPress={() => undefined} />
            <FloorTile icon={<ShoppingBasket />} label={copy.tiles.pick} hint={copy.tileHints.locked} heldReason={copy.tileHints.locked} />
          </FloorTileGrid>
        </FloorFrame>
      </div>
    </div>
  )
}
