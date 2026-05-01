'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Check, AlertCircle, Save, Send } from 'lucide-react'
import MasterDataTab from './tabs/MasterDataTab'
import VariationsTab from './tabs/VariationsTab'
import ChannelListingTab from './tabs/ChannelListingTab'

type TabType = 'master' | 'variations' | string // e.g. "AMAZON_IT"

interface Marketplace {
  code: string
  name: string
  channel: string
  marketplaceId?: string | null
  region: string
  currency: string
  language: string
  domainUrl?: string | null
}

interface Listing {
  id: string
  channel: string
  marketplace: string
  channelMarket: string
  region: string
  title: string | null
  description: string | null
  price: string | number | null
  quantity: number | null
  isPublished: boolean
  listingStatus: string
  externalListingId: string | null
  bulletPointsOverride: string[] | null
  [key: string]: any
}

interface Props {
  product: any
  listings: Record<string, Listing[]>
  marketplaces: Record<string, Marketplace[]>
  childrenList: any[]
}

const COUNTRY_FLAGS: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧',
  NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', US: '🇺🇸', GLOBAL: '🌍',
}

const SINGLE_STORE_CHANNELS = new Set(['SHOPIFY', 'WOOCOMMERCE', 'ETSY'])

export default function ProductEditClient({
  product,
  listings,
  marketplaces,
  childrenList,
}: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<TabType>('master')
  const [openChannel, setOpenChannel] = useState<string | null>(null)
  const [unsavedChanges, setUnsavedChanges] = useState(false)

  const hasListing = (channel: string, marketplace: string) =>
    listings[channel]?.some((l) => l.marketplace === marketplace) ?? false

  const getListing = (channel: string, marketplace: string) =>
    listings[channel]?.find((l) => l.marketplace === marketplace)

  const channelOrder = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']
  const orderedChannels = channelOrder.filter((c) => marketplaces[c]?.length)

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Sticky header ───────────────────────────────────────── */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <button
                onClick={() => router.push('/inventory')}
                className="text-sm text-slate-500 hover:text-slate-700 mb-1"
              >
                ← Back to inventory
              </button>
              <h1 className="text-xl font-semibold line-clamp-1 max-w-3xl">{product.name}</h1>
              <div className="text-xs text-slate-500 mt-1 flex items-center gap-3 flex-wrap">
                <span className="font-mono">{product.sku}</span>
                {product.isParent && (
                  <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px]">
                    Master · {childrenList.length} variations
                  </span>
                )}
                {product.amazonAsin && (
                  <span className="font-mono">ASIN: {product.amazonAsin}</span>
                )}
                {unsavedChanges && (
                  <span className="text-amber-600 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> Unsaved changes
                  </span>
                )}
              </div>
            </div>

            <div className="flex gap-2">
              <button className="px-3 py-1.5 text-sm border border-slate-200 rounded-md hover:bg-slate-50">
                <Save className="w-3.5 h-3.5 inline mr-1" /> Save Draft
              </button>
              <button className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">
                <Send className="w-3.5 h-3.5 inline mr-1" /> Save &amp; Publish
              </button>
            </div>
          </div>
        </div>

        {/* ── Tab navigation ─────────────────────────────────────── */}
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex items-center gap-1 -mb-px overflow-x-auto">
            <TabButton
              active={activeTab === 'master'}
              onClick={() => setActiveTab('master')}
              label="Master Data"
            />

            {product.isParent && (
              <TabButton
                active={activeTab === 'variations'}
                onClick={() => setActiveTab('variations')}
                label={`Variations (${childrenList.length})`}
              />
            )}

            {orderedChannels.map((channel) => {
              const channelMarkets = marketplaces[channel] ?? []
              const channelListings = listings[channel] ?? []
              const isOpen = openChannel === channel
              const isActiveTab = activeTab.startsWith(`${channel}_`)
              const isSingleStore = SINGLE_STORE_CHANNELS.has(channel)

              return (
                <div key={channel} className="relative">
                  <button
                    onClick={() => {
                      if (isSingleStore) {
                        setActiveTab(`${channel}_GLOBAL`)
                        setOpenChannel(null)
                      } else {
                        setOpenChannel(isOpen ? null : channel)
                      }
                    }}
                    className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                      isActiveTab
                        ? 'border-blue-600 text-blue-600'
                        : 'border-transparent text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {channel.charAt(0) + channel.slice(1).toLowerCase()}
                    {channelListings.length > 0 && (
                      <span className="bg-green-100 text-green-700 text-[10px] px-1.5 py-0.5 rounded">
                        {channelListings.length}
                      </span>
                    )}
                    {!isSingleStore && (
                      <ChevronDown
                        className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                      />
                    )}
                  </button>

                  {isOpen && !isSingleStore && (
                    <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg min-w-[240px] z-20">
                      {channelMarkets.map((market) => {
                        const isListed = hasListing(channel, market.code)
                        return (
                          <button
                            key={market.code}
                            onClick={() => {
                              setActiveTab(`${channel}_${market.code}`)
                              setOpenChannel(null)
                            }}
                            className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-slate-50 text-left"
                          >
                            <span className="flex items-center gap-2">
                              <span className="text-base">
                                {COUNTRY_FLAGS[market.code] ?? '🌐'}
                              </span>
                              <span>{market.name}</span>
                            </span>
                            {isListed ? (
                              <Check className="w-3.5 h-3.5 text-green-600" />
                            ) : (
                              <span className="text-[10px] text-slate-400">Not listed</span>
                            )}
                          </button>
                        )
                      })}
                      <div className="border-t border-slate-200 px-3 py-2 text-[11px] text-slate-500">
                        Click a marketplace to edit its listing
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Tab content ─────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {activeTab === 'master' && (
          <MasterDataTab product={product} onChange={() => setUnsavedChanges(true)} />
        )}

        {activeTab === 'variations' && product.isParent && (
          <VariationsTab
            parent={product}
            childrenList={childrenList}
            onChange={() => setUnsavedChanges(true)}
          />
        )}

        {activeTab.includes('_') && (() => {
          const [channel, marketplace] = activeTab.split('_')
          const listing = getListing(channel, marketplace)
          const marketInfo = marketplaces[channel]?.find((m) => m.code === marketplace)
          if (!marketInfo) {
            return (
              <div className="bg-white border border-slate-200 rounded-lg p-6 text-sm text-slate-500">
                Marketplace {channel}/{marketplace} is not configured.
              </div>
            )
          }
          return (
            <ChannelListingTab
              key={`${channel}_${marketplace}`}
              product={product}
              channel={channel}
              marketplace={marketplace}
              marketInfo={marketInfo}
              listing={listing}
              onChange={() => setUnsavedChanges(true)}
              onSave={() => {
                setUnsavedChanges(false)
                router.refresh()
              }}
            />
          )
        })()}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active
          ? 'border-blue-600 text-blue-600'
          : 'border-transparent text-slate-600 hover:text-slate-900'
      }`}
    >
      {label}
    </button>
  )
}
