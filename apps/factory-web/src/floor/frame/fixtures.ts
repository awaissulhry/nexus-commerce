'use client'

import { createElement, useEffect, type ComponentType, type ReactNode } from 'react'
import type { FrameModel } from './view/FloorFrameView'

/**
 * Made-up data shared by the floor screens' design fixtures (SCR-020 … 025): a "Demo" plant, made-up people, a fixed
 * made-up tenant tag. Never a real company, person, badge or number. No `designScreen` here: each screen's own
 * `fixtures.ts` holds its cases.
 */

export const DEMO_SITE = 'Stabilimento Demo Nord'
export const DEMO_STATION = 'CUT-02 · Tavolo taglio 2'
export const DEMO_OPERATOR = 'Ada Demo'

/** A signed-in screen's frame. */
export function signedInFrame(titleKey: string, extra: Partial<FrameModel> = {}): FrameModel {
  return { operator: { name: DEMO_OPERATOR }, station: { name: DEMO_STATION, site: DEMO_SITE }, titleKey, online: true, pending: 0, showHome: true, ...extra }
}

/** A frame before anyone is signed in (set-up, sign-in): brand, language, Help. */
export function deviceFrame(titleKey: string, extra: Partial<FrameModel> = {}): FrameModel {
  return { operator: null, station: { name: DEMO_STATION, site: DEMO_SITE }, titleKey, online: true, pending: 0, showLanguage: true, ...extra }
}

/**
 * A floor view as the design index shows it: like the live app, `<html>` carries the floor density while it is on
 * screen, so its pop-ups (portalled to `<body>`) are floor sized too.
 */
export function onFloor<P extends { model: unknown }>(View: ComponentType<P>): ComponentType<P & { children?: ReactNode }> {
  function FloorDesign(props: P & { children?: ReactNode }) {
    useEffect(() => {
      document.documentElement.setAttribute('data-density', 'floor')
      return () => document.documentElement.removeAttribute('data-density')
    }, [])
    return createElement(View, props)
  }
  return FloorDesign
}
