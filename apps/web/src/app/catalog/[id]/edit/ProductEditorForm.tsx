'use client'

import { useState, useTransition } from 'react'
import { useForm, FormProvider } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { productEditorSchema, type ProductEditorFormData } from './schema'
import { updateProduct } from './actions'
import VitalInfoTab from './tabs/VitalInfoTab'
import OfferTab from './tabs/OfferTab'
import ImagesTab from './tabs/ImagesTab'
import DescriptionTab from './tabs/DescriptionTab'
import VariationsTab from './tabs/VariationsTab'
import MatrixEditor from './MatrixEditor'
import ChannelOverridesTab from './tabs/ChannelOverridesTab'

const TABS = [
  { id: 'vital', label: '📋 Vital Info', component: VitalInfoTab },
  { id: 'offer', label: '💰 Offer', component: OfferTab },
  { id: 'images', label: '🖼️ Images', component: ImagesTab },
  { id: 'description', label: '📝 Description', component: DescriptionTab },
  { id: 'variations', label: '🎨 Variations', component: VariationsTab },
  { id: 'matrix', label: '🌐 Multi-Channel Matrix', component: MatrixEditor },
  { id: 'channels', label: '🌐 Channel Overrides', component: ChannelOverridesTab },
] as const

interface ProductEditorFormProps {
  productId: string
  defaultValues: ProductEditorFormData
  product?: any
  isParent?: boolean
  childrenCount?: number
}

export default function ProductEditorForm({ productId, defaultValues, product, isParent = false, childrenCount = 0 }: ProductEditorFormProps) {
  const [activeTab, setActiveTab] = useState<string>('vital')
  const [isPending, startTransition] = useTransition()
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null)

  const methods = useForm<ProductEditorFormData>({
    resolver: zodResolver(productEditorSchema) as any,
    defaultValues,
    mode: 'onChange',
  })

  const {
    handleSubmit,
    formState: { errors, isDirty },
  } = methods

  const onSubmit = (data: ProductEditorFormData) => {
    startTransition(async () => {
      const result = await updateProduct(productId, data)
      setSaveResult(result)
      if (result.success) {
        setTimeout(() => setSaveResult(null), 3000)
      }
    })
  }

  // Count errors per tab for indicators
  const tabErrorCounts: Record<string, number> = {
    vital: [errors.name, errors.brand, errors.manufacturer, errors.upc, errors.ean].filter(Boolean)
      .length,
    offer: [
      errors.basePrice,
      errors.salePrice,
      errors.totalStock,
      errors.fulfillmentMethod,
    ].filter(Boolean).length,
    images: errors.images ? (Array.isArray(errors.images) ? errors.images.length : 1) : 0,
    description: [errors.bulletPoints, errors.aPlusContent].filter(Boolean).length,
    variations: errors.variations ? (Array.isArray(errors.variations) ? errors.variations.length : 1) : 0,
    matrix: 0, // Matrix tab doesn't use form validation
    channels: 0, // Channel overrides tab doesn't use form validation
  }

  return (
    <FormProvider {...methods}>
      <form onSubmit={handleSubmit(onSubmit)}>
        {/* Save bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            {saveResult && (
              <div
                className={`px-4 py-2 rounded-lg text-sm font-medium ${
                  saveResult.success
                    ? 'bg-green-100 text-green-800'
                    : 'bg-red-100 text-red-800'
                }`}
              >
                {saveResult.success ? '✓' : '✗'} {saveResult.message}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isDirty && (
              <span className="text-sm text-yellow-600 font-medium">● Unsaved changes</span>
            )}
            <button
              type="submit"
              disabled={isPending}
              className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {isPending ? 'Saving…' : '💾 Save Changes'}
            </button>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="border-b border-gray-200 mb-6">
          <nav className="flex gap-1 -mb-px">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors relative ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tab.label}
                {tabErrorCounts[tab.id] > 0 && (
                  <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                    {tabErrorCounts[tab.id]}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab content */}
        <div className="bg-white rounded-lg shadow p-6">
          {activeTab === 'vital' && (
            <VitalInfoTab isParent={isParent} childrenCount={childrenCount} />
          )}
          {activeTab === 'offer' && (
            <OfferTab />
          )}
          {activeTab === 'images' && (
            <ImagesTab />
          )}
          {activeTab === 'description' && (
            <DescriptionTab />
          )}
          {activeTab === 'variations' && (
            <VariationsTab />
          )}
          {activeTab === 'matrix' && (
            <MatrixEditor isParent={isParent} childrenCount={childrenCount} initialProduct={product} />
          )}
          {activeTab === 'channels' && product && (
            <ChannelOverridesTab product={product} channelListings={product.channelListings} />
          )}
        </div>
      </form>
    </FormProvider>
  )
}
