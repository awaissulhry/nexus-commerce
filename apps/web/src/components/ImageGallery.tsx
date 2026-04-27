'use client'

import { useState, useCallback } from 'react'
import Image from 'next/image'
import { useDropzone } from 'react-dropzone'

interface ImageData {
  id: string
  url: string
  alt?: string
  type: 'MAIN' | 'ALT' | 'LIFESTYLE' | 'SWATCH'
  dominantColor?: string
  colorConfidence?: number
  colorOverride?: string
  isHero: boolean
  assignedVariants: string[]
  uploadStatus: 'PENDING' | 'UPLOADING' | 'SUCCESS' | 'FAILED'
  uploadError?: string
}

interface ImageGalleryProps {
  productId: string
  images: ImageData[]
  onImageUpload: (file: File, type: string) => Promise<void>
  onSetHero: (imageId: string) => Promise<void>
  onDeleteImage: (imageId: string) => Promise<void>
  onAutoAssign: () => Promise<void>
  onColorOverride: (imageId: string, color: string) => Promise<void>
  isLoading?: boolean
}

const COLOR_PALETTE = [
  { hex: '#FF0000', name: 'Red' },
  { hex: '#00FF00', name: 'Green' },
  { hex: '#0000FF', name: 'Blue' },
  { hex: '#FFFF00', name: 'Yellow' },
  { hex: '#FF00FF', name: 'Magenta' },
  { hex: '#00FFFF', name: 'Cyan' },
  { hex: '#000000', name: 'Black' },
  { hex: '#FFFFFF', name: 'White' },
  { hex: '#808080', name: 'Gray' },
  { hex: '#FFA500', name: 'Orange' },
  { hex: '#800080', name: 'Purple' },
  { hex: '#FFC0CB', name: 'Pink' },
]

export default function ImageGallery({
  productId,
  images,
  onImageUpload,
  onSetHero,
  onDeleteImage,
  onAutoAssign,
  onColorOverride,
  isLoading = false,
}: ImageGalleryProps) {
  const [draggedImageId, setDraggedImageId] = useState<string | null>(null)
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [showColorPicker, setShowColorPicker] = useState<string | null>(null)

  // Drag and drop handler
  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      for (const file of acceptedFiles) {
        try {
          await onImageUpload(file, 'ALT')
        } catch (error) {
          console.error('Upload failed:', error)
        }
      }
    },
    [onImageUpload]
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.webp', '.gif'],
    },
  })

  // Group images by type
  const imagesByType = {
    MAIN: images.filter((img) => img.type === 'MAIN'),
    ALT: images.filter((img) => img.type === 'ALT'),
    LIFESTYLE: images.filter((img) => img.type === 'LIFESTYLE'),
    SWATCH: images.filter((img) => img.type === 'SWATCH'),
  }

  const getColorName = (hex?: string) => {
    if (!hex) return 'Unknown'
    const color = COLOR_PALETTE.find(
      (c) => c.hex.toLowerCase() === hex.toLowerCase()
    )
    return color?.name || 'Custom'
  }

  const renderImageCard = (image: ImageData) => (
    <div
      key={image.id}
      className={`relative group rounded-lg overflow-hidden border-2 transition-all ${
        image.isHero
          ? 'border-blue-500 ring-2 ring-blue-300'
          : 'border-gray-200 hover:border-gray-300'
      } ${draggedImageId === image.id ? 'opacity-50' : ''}`}
      draggable
      onDragStart={() => setDraggedImageId(image.id)}
      onDragEnd={() => setDraggedImageId(null)}
      onClick={() => setSelectedImageId(image.id)}
    >
      {/* Image Preview */}
      <div className="relative w-full h-48 bg-gray-100">
        {image.url ? (
          <Image
            src={image.url}
            alt={image.alt || 'Product image'}
            fill
            className="object-cover"
            onError={(e) => {
              const img = e.target as HTMLImageElement
              img.style.display = 'none'
            }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400">
            <span className="text-4xl">📷</span>
          </div>
        )}

        {/* Upload Status Indicator */}
        {image.uploadStatus === 'UPLOADING' && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
          </div>
        )}

        {image.uploadStatus === 'FAILED' && (
          <div className="absolute inset-0 bg-red-500/50 flex items-center justify-center">
            <span className="text-white text-sm font-semibold">Upload Failed</span>
          </div>
        )}

        {/* Hero Badge */}
        {image.isHero && (
          <div className="absolute top-2 left-2 bg-blue-500 text-white px-2 py-1 rounded text-xs font-semibold">
            ⭐ Hero
          </div>
        )}

        {/* Type Badge */}
        <div
          className={`absolute top-2 right-2 px-2 py-1 rounded text-xs font-semibold text-white ${
            image.type === 'MAIN'
              ? 'bg-blue-600'
              : image.type === 'LIFESTYLE'
                ? 'bg-green-600'
                : image.type === 'SWATCH'
                  ? 'bg-purple-600'
                  : 'bg-gray-600'
          }`}
        >
          {image.type}
        </div>

        {/* Hover Actions */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSetHero(image.id)
            }}
            className="p-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
            title="Set as hero image"
          >
            ⭐
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setShowColorPicker(showColorPicker === image.id ? null : image.id)
            }}
            className="p-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors"
            title="Override color"
          >
            🎨
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDeleteImage(image.id)
            }}
            className="p-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors"
            title="Delete image"
          >
            🗑️
          </button>
        </div>
      </div>

      {/* Image Info */}
      <div className="p-3 bg-white">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-gray-600">
            {image.alt || 'No alt text'}
          </span>
        </div>

        {/* Color Tag */}
        {image.dominantColor && (
          <div className="flex items-center gap-2 mb-2">
            <div
              className="w-4 h-4 rounded border border-gray-300"
              style={{ backgroundColor: image.dominantColor }}
              title={`${getColorName(image.dominantColor)} (${image.colorConfidence}% confidence)`}
            />
            <span className="text-xs text-gray-600">
              {image.colorOverride || getColorName(image.dominantColor)}
            </span>
            {image.colorConfidence && (
              <span className="text-xs text-gray-400">
                ({image.colorConfidence}%)
              </span>
            )}
          </div>
        )}

        {/* Assigned Variants Count */}
        {image.assignedVariants.length > 0 && (
          <div className="text-xs text-blue-600 font-semibold">
            ✓ {image.assignedVariants.length} variant(s)
          </div>
        )}

        {/* Error Message */}
        {image.uploadError && (
          <div className="text-xs text-red-600 mt-1">{image.uploadError}</div>
        )}
      </div>

      {/* Color Picker Dropdown */}
      {showColorPicker === image.id && (
        <div className="absolute bottom-full left-0 right-0 mb-2 bg-white border border-gray-300 rounded-lg shadow-lg p-3 z-10">
          <div className="grid grid-cols-4 gap-2">
            {COLOR_PALETTE.map((color) => (
              <button
                key={color.hex}
                onClick={(e) => {
                  e.stopPropagation()
                  onColorOverride(image.id, color.name)
                  setShowColorPicker(null)
                }}
                className="flex flex-col items-center gap-1 p-2 hover:bg-gray-100 rounded transition-colors"
                title={color.name}
              >
                <div
                  className="w-6 h-6 rounded border-2 border-gray-300"
                  style={{ backgroundColor: color.hex }}
                />
                <span className="text-xs text-gray-600">{color.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Product Images</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">
            {images.length} image(s)
          </span>
          <button
            onClick={onAutoAssign}
            disabled={isLoading || images.length === 0}
            className="px-4 py-2 bg-green-500 hover:bg-green-600 disabled:bg-gray-300 text-white rounded-lg font-semibold transition-colors"
            title="Auto-assign images to variants based on color"
          >
            🤖 Auto-Assign
          </button>
        </div>
      </div>

      {/* Drag and Drop Zone */}
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          isDragActive
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 hover:border-gray-400'
        }`}
      >
        <input {...getInputProps()} />
        <div className="text-4xl mb-2">📤</div>
        <p className="text-gray-700 font-semibold">
          {isDragActive
            ? 'Drop images here...'
            : 'Drag and drop images here, or click to select'}
        </p>
        <p className="text-sm text-gray-500 mt-1">
          Supported formats: JPG, PNG, WebP, GIF
        </p>
      </div>

      {/* Images by Type */}
      {images.length > 0 ? (
        <div className="space-y-6">
          {/* Main Images */}
          {imagesByType.MAIN.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3">
                Main Images
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {imagesByType.MAIN.map(renderImageCard)}
              </div>
            </div>
          )}

          {/* Alt Images */}
          {imagesByType.ALT.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3">
                Alternative Images
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {imagesByType.ALT.map(renderImageCard)}
              </div>
            </div>
          )}

          {/* Lifestyle Images */}
          {imagesByType.LIFESTYLE.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3">
                Lifestyle Images
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {imagesByType.LIFESTYLE.map(renderImageCard)}
              </div>
            </div>
          )}

          {/* Swatch Images */}
          {imagesByType.SWATCH.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3">
                Swatches
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {imagesByType.SWATCH.map(renderImageCard)}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg mb-2">No images yet</p>
          <p className="text-sm">Upload images using the drag-and-drop zone above</p>
        </div>
      )}

      {/* Selected Image Details */}
      {selectedImageId && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold text-gray-900">Image Details</h4>
            <button
              onClick={() => setSelectedImageId(null)}
              className="text-gray-500 hover:text-gray-700"
            >
              ✕
            </button>
          </div>
          {images.find((img) => img.id === selectedImageId) && (
            <div className="space-y-2 text-sm">
              <p>
                <span className="font-semibold">ID:</span> {selectedImageId}
              </p>
              <p>
                <span className="font-semibold">Type:</span>{' '}
                {images.find((img) => img.id === selectedImageId)?.type}
              </p>
              <p>
                <span className="font-semibold">Status:</span>{' '}
                {images.find((img) => img.id === selectedImageId)?.uploadStatus}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
