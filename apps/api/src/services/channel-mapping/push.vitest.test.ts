/**
 * CHMAP M4 — which fields the push leaves out: only what the Owner decided in an ACTIVE version, never a rule.
 */
import { describe, expect, it } from 'vitest'
import type { MappingFieldRow } from '@nexus/shared/channel-mapping'
import { amazonExcludedRoots, pushExclusions, pushStops } from './push.js'

const row = (channelKey: string, targetKind: MappingFieldRow['targetKind'], targetKey: string | null, extra: Partial<MappingFieldRow> = {}): MappingFieldRow => ({
  channelKey, columnKey: channelKey, label: null, aliases: [], productTypes: [], requirement: 'optional', templateRequirement: null, targetKind, targetKey,
  transform: [], direction: 'both', state: 'mapped', reason: null, decidedBy: 'rule', sortOrder: 0, ...extra,
})

describe('CHMAP push exclusions', () => {
  it('leaves out a field only when the Owner stopped every column that carries it', () => {
    const got = pushExclusions([
      row('team_name#1.value', 'channelField', 'team_name', { state: 'ignored', decidedBy: 'owner', reason: 'workaround' }),
      row('athlete#1.value', 'channelField', 'athlete', { state: 'managed', decidedBy: 'owner', reason: 'other workflow' }),
      row('style#1.value', 'channelField', 'style', { direction: 'in', decidedBy: 'owner', reason: 'read only' }),
      row('color#1.value', 'channelField', 'color'),
    ])
    expect([...got.fieldKeys].sort()).toEqual(['athlete', 'style', 'team_name'])
  })

  it('never lets a rule change the push, and a field still written by one column stays', () => {
    const got = pushExclusions([
      // The rules' own "read only" rows (several document columns, one written back): still sent.
      row('compliance_media[content_type=user_manual]', 'channelField', 'compliance_media'),
      row('compliance_media[content_type=safety_information]', 'channelField', 'compliance_media', { direction: 'in', reason: 'one value' }),
      // A rule-ignored column (not an attribute of this type) has no field.
      row('rise#1.style', 'none', null, { state: 'ignored', reason: 'not in COAT' }),
      // The Owner ignored one of two columns of the same field: the other still carries it.
      row('material#1.value', 'channelField', 'material', { state: 'ignored', decidedBy: 'owner', reason: 'x' }),
      row('material#2.value', 'channelField', 'material'),
      // A column the RULES made read-only, alone for its field: the rules never stop a push.
      row('lining#1.value', 'channelField', 'lining', { direction: 'in', reason: 'rule' }),
    ])
    expect(got.fieldKeys.size).toBe(0)
  })

  it('Amazon: an attribute is left out whole or not at all — a part the Owner stopped stays while another column sends the attribute', () => {
    const fields = [
      row('sleeve#1.type#1.value', 'channelField', 'sleeve__type'),
      row('sleeve#1.length_description#1.value', 'channelField', 'sleeve__length_description', { state: 'ignored', decidedBy: 'owner', reason: 'x' }),
      row('team_name#1.value', 'channelField', 'team_name', { state: 'ignored', decidedBy: 'owner', reason: 'workaround' }),
      // Every column the version has for `waist` is stopped; the version has none for waist__width.
      row('waist#1.style#1.value', 'channelField', 'waist__style', { state: 'ignored', decidedBy: 'owner', reason: 'x' }),
    ]
    const got = pushExclusions(fields)
    expect([...got.sentKeys]).toEqual(['sleeve__type'])
    expect([...amazonExcludedRoots(got)].sort()).toEqual(['team_name', 'waist'])
    const words = pushStops('AMAZON', fields)
    expect([...words.stops.keys()].sort()).toEqual(['team_name', 'waist'])
    expect(words.kept).toEqual(['sleeve__length_description: Amazon takes sleeve as one field, and another column still sends it'])
  })

  it('eBay: the push follows item specifics only, and says so for any other field the Owner stopped', () => {
    const words = pushStops('EBAY', [
      row('aspect:Marca', 'channelField', 'brand', { state: 'ignored', decidedBy: 'owner', reason: 'x' }),
      row('specific:Team name', 'itemSpecific', 'itemSpecifics.Team name', { state: 'ignored', decidedBy: 'owner', reason: 'x' }),
      row('Title', 'channelField', 'title', { state: 'ignored', decidedBy: 'owner', reason: 'x' }),
      row('aspect:Colore', 'channelField', 'color'),
    ])
    expect([...words.stops.values()].sort()).toEqual(['item specific “Marca”', 'item specific “Team name”'])
    expect(words.kept).toEqual(['title: the eBay push follows a version for item specifics only'])
  })

  it('names eBay specifics without case or accents', () => {
    const got = pushExclusions([row('specific:Team name', 'itemSpecific', 'itemSpecifics.Team name', { state: 'ignored', decidedBy: 'owner', reason: 'x' })])
    expect([...got.specifics]).toEqual(['team name'])
  })
})
