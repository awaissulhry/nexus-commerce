'use client'

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import ImageGallery from '@/components/ImageGallery'
import { useImageManagement } from '@/hooks/useImageManagement'

export default function ProductImagesPage() {
  const params = useParams()
  const productId = params.id as string

  const {
    images,
    isLoading,
    error,
    uploadImage,
    setHeroImage,
    deleteImage,
    autoAssignImages,
    updateColorOverride,
    fetchImages,
  } = useImageManagement(productId)

  // Fetch images on mount
  useEffect(() => {
    if (productId) {
      fetchImages(productId)
    }
  }, [productId, fetchImages])

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Product Images</h1>
          <p className="text-gray-600 mt-2">
            Manage product images with intelligent color-based variant assignment
          </p>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-800 font-semibold">Error</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
          </div>
        )}

        {/* Image Gallery */}
        {!isLoading && (
          <ImageGallery
            productId={productId}
            images={images}
            onImageUpload={uploadImage}
            onSetHero={setHeroImage}
            onDeleteImage={deleteImage}
            onAutoAssign={autoAssignImages}
            onColorOverride={updateColorOverride}
            isLoading={isLoading}
          />
        )}

        {/* Info Section */}
        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Features */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Features</h3>
            <ul className="space-y-3 text-sm text-gray-600">
              <li className="flex items-start gap-3">
                <span className="text-blue-500 font-bold">✓</span>
                <span>Drag-and-drop image upload</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-blue-500 font-bold">✓</span>
                <span>Automatic color detection and analysis</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-blue-500 font-bold">✓</span>
                <span>Intelligent variant assignment based on color</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-blue-500 font-bold">✓</span>
                <span>Manual color override for custom assignments</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-blue-500 font-bold">✓</span>
                <span>Hero image selection for primary product image</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-blue-500 font-bold">✓</span>
                <span>Mock cloud storage integration</span>
              </li>
            </ul>
          </div>

          {/* Image Types */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Image Types</h3>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3">
                <span className="inline-block w-3 h-3 bg-blue-600 rounded" />
                <span className="text-gray-600">
                  <span className="font-semibold">Main:</span> Primary product image
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="inline-block w-3 h-3 bg-gray-600 rounded" />
                <span className="text-gray-600">
                  <span className="font-semibold">Alt:</span> Alternative product views
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="inline-block w-3 h-3 bg-green-600 rounded" />
                <span className="text-gray-600">
                  <span className="font-semibold">Lifestyle:</span> Product in use
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="inline-block w-3 h-3 bg-purple-600 rounded" />
                <span className="text-gray-600">
                  <span className="font-semibold">Swatch:</span> Color/material samples
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* How It Works */}
        <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">How Color-Based Assignment Works</h3>
          <ol className="space-y-3 text-sm text-gray-700">
            <li className="flex gap-3">
              <span className="font-bold text-blue-600 flex-shrink-0">1.</span>
              <span>Upload images for your product using drag-and-drop</span>
            </li>
            <li className="flex gap-3">
              <span className="font-bold text-blue-600 flex-shrink-0">2.</span>
              <span>System automatically detects the dominant color in each image</span>
            </li>
            <li className="flex gap-3">
              <span className="font-bold text-blue-600 flex-shrink-0">3.</span>
              <span>Click "Auto-Assign" to match images to product variants by color</span>
            </li>
            <li className="flex gap-3">
              <span className="font-bold text-blue-600 flex-shrink-0">4.</span>
              <span>Manually override colors using the color picker if needed</span>
            </li>
            <li className="flex gap-3">
              <span className="font-bold text-blue-600 flex-shrink-0">5.</span>
              <span>Set a hero image to be the primary product image</span>
            </li>
            <li className="flex gap-3">
              <span className="font-bold text-blue-600 flex-shrink-0">6.</span>
              <span>Images are synced to marketplace listings automatically</span>
            </li>
          </ol>
        </div>
      </div>
    </div>
  )
}
