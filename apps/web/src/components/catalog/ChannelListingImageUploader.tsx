'use client'

import { useState, useRef, useCallback } from 'react'
import { logger } from '@/lib/logger'

interface ImageData {
  id: string
  url: string
  alt: string
  sortOrder: number
  channelListingId?: string
  productId?: string
  file?: File // Store file reference for later upload
}

interface ChannelListingImageUploaderProps {
  images: ImageData[]
  onImagesChange: (images: ImageData[]) => void
  context: 'master' | 'channel' // 'master' for master images, 'channel' for channel-specific
  maxImages?: number
}

export default function ChannelListingImageUploader({
  images,
  onImagesChange,
  context,
  maxImages = 10,
}: ChannelListingImageUploaderProps) {
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    handleFiles(files)
  }, [images.length])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    handleFiles(files)
  }, [images.length])

  const handleFiles = useCallback((files: File[]) => {
    if (images.length >= maxImages) {
      logger.warn('Max images reached', { context, maxImages })
      return
    }

    files.forEach((file) => {
      if (!file.type.startsWith('image/')) {
        logger.warn('Invalid file type', { fileName: file.name, type: file.type })
        return
      }

      // Use URL.createObjectURL for instant preview instead of Base64
      const objectUrl = URL.createObjectURL(file)
      const newImage: ImageData = {
        id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        url: objectUrl, // Use object URL for preview
        alt: file.name.replace(/\.[^/.]+$/, ''),
        sortOrder: images.length,
        file, // Store file for later upload
      }
      onImagesChange([...images, newImage])
      logger.info('Image added', { context, imageId: newImage.id })
    })
  }, [images.length, maxImages, context, onImagesChange])

  const handleDeleteImage = useCallback((imageId: string) => {
    const imageToDelete = images.find((img) => img.id === imageId)
    // Revoke object URL to free memory
    if (imageToDelete && imageToDelete.url.startsWith('blob:')) {
      URL.revokeObjectURL(imageToDelete.url)
    }
    
    const updated = images
      .filter((img) => img.id !== imageId)
      .map((img, idx) => ({ ...img, sortOrder: idx }))
    onImagesChange(updated)
    logger.info('Image deleted', { context, imageId })
  }, [images, context, onImagesChange])

  const handleMoveImage = useCallback((imageId: string, direction: 'up' | 'down') => {
    const index = images.findIndex((img) => img.id === imageId)
    if (index === -1) return

    if (direction === 'up' && index === 0) return
    if (direction === 'down' && index === images.length - 1) return

    const newImages = [...images]
    const swapIndex = direction === 'up' ? index - 1 : index + 1
    ;[newImages[index], newImages[swapIndex]] = [newImages[swapIndex], newImages[index]]

    // Update sort order
    newImages.forEach((img, idx) => {
      img.sortOrder = idx
    })

    onImagesChange(newImages)
    logger.info('Image moved', { context, imageId, direction })
  }, [images, context, onImagesChange])

  const handleAltTextChange = useCallback((imageId: string, alt: string) => {
    const updated = images.map((img) => (img.id === imageId ? { ...img, alt } : img))
    onImagesChange(updated)
  }, [images, onImagesChange])

  return (
    <div className="space-y-6">
      {/* Upload Area */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          isDragging
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 bg-gray-50 hover:border-gray-400'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />

        <div className="space-y-3">
          <div className="text-4xl">📸</div>
          <div>
            <p className="text-lg font-semibold text-gray-900">
              {context === 'master' ? 'Upload Master Images' : 'Upload Regional Images'}
            </p>
            <p className="text-sm text-gray-600 mt-1">
              Drag and drop images here or click to browse
            </p>
          </div>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium inline-block"
          >
            Choose Images
          </button>

          <p className="text-xs text-gray-500 mt-3">
            {images.length} / {maxImages} images uploaded
          </p>

          {context === 'master' && (
            <p className="text-xs text-blue-600 mt-2">
              💡 Master images are used as defaults across all platforms
            </p>
          )}

          {context === 'channel' && (
            <p className="text-xs text-green-600 mt-2">
              💡 Regional images override master images for this specific market
            </p>
          )}
        </div>
      </div>

      {/* Image Grid */}
      {images.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">
            {context === 'master' ? 'Master Images' : 'Regional Images'}
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {images.map((image, index) => (
              <div
                key={image.id}
                className="border border-gray-200 rounded-lg overflow-hidden bg-white hover:shadow-lg transition-shadow"
              >
                {/* Image Preview */}
                <div className="relative bg-gray-100 aspect-square overflow-hidden">
                  <img
                    src={image.url}
                    alt={image.alt}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-2 right-2 bg-gray-900 text-white px-2 py-1 rounded text-xs font-medium">
                    #{index + 1}
                  </div>
                </div>

                {/* Image Details */}
                <div className="p-4 space-y-3">
                  {/* Alt Text */}
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Alt Text
                    </label>
                    <input
                      type="text"
                      value={image.alt}
                      onChange={(e) => handleAltTextChange(image.id, e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="Describe the image..."
                    />
                  </div>

                  {/* Controls */}
                  <div className="flex gap-2">
                    {/* Move Up */}
                    <button
                      onClick={() => handleMoveImage(image.id, 'up')}
                      disabled={index === 0}
                      className="flex-1 px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
                      title="Move image up"
                    >
                      ⬆️
                    </button>

                    {/* Move Down */}
                    <button
                      onClick={() => handleMoveImage(image.id, 'down')}
                      disabled={index === images.length - 1}
                      className="flex-1 px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
                      title="Move image down"
                    >
                      ⬇️
                    </button>

                    {/* Delete */}
                    <button
                      onClick={() => handleDeleteImage(image.id)}
                      className="flex-1 px-3 py-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 transition-colors text-sm font-medium"
                      title="Delete image"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {images.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <p className="text-sm">No images uploaded yet</p>
        </div>
      )}
    </div>
  )
}
