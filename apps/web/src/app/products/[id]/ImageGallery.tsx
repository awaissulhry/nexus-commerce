'use client'

import { useState, useRef } from 'react'

interface ProductImage {
  url: string
  alt: string
  type: string
}

interface ImageGalleryProps {
  images: ProductImage[]
  productName: string
}

const PLACEHOLDER_IMAGE = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAwIiBoZWlnaHQ9IjYwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNjAwIiBoZWlnaHQ9IjYwMCIgZmlsbD0iI2YzZjRmNiIvPjx0ZXh0IHg9IjMwMCIgeT0iMzAwIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iNDAiIGZpbGw9IiM5Y2EzYWYiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj5ObyBJbWFnZTwvdGV4dD48L3N2Zz4='

export default function ImageGallery({ images, productName }: ImageGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isZooming, setIsZooming] = useState(false)
  const [zoomPosition, setZoomPosition] = useState({ x: 0, y: 0 })
  const imageRef = useRef<HTMLDivElement>(null)

  const allImages = images.length > 0 ? images : [{ url: PLACEHOLDER_IMAGE, alt: productName, type: 'MAIN' }]
  const currentImage = allImages[selectedIndex] || allImages[0]

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!imageRef.current) return
    const rect = imageRef.current.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    setZoomPosition({ x, y })
  }

  return (
    <div className="flex gap-4">
      {/* Thumbnail sidebar */}
      {allImages.length > 1 && (
        <div className="flex flex-col gap-2 w-16 flex-shrink-0">
          {allImages.map((img, idx) => (
            <button
              key={idx}
              type="button"
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={() => setSelectedIndex(idx)}
              className={`w-16 h-16 rounded-lg border-2 overflow-hidden transition-all flex-shrink-0 ${
                selectedIndex === idx
                  ? 'border-blue-500 shadow-md'
                  : 'border-gray-200 hover:border-gray-400'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.alt || `${productName} - ${idx + 1}`}
                className="w-full h-full object-cover"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).src = PLACEHOLDER_IMAGE
                }}
              />
            </button>
          ))}
        </div>
      )}

      {/* Main image with hover zoom */}
      <div
        ref={imageRef}
        className="relative flex-1 aspect-square bg-white rounded-xl border border-gray-200 overflow-hidden cursor-crosshair"
        onMouseEnter={() => setIsZooming(true)}
        onMouseLeave={() => setIsZooming(false)}
        onMouseMove={handleMouseMove}
      >
        {/* Normal image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={currentImage.url}
          alt={currentImage.alt || productName}
          className={`w-full h-full object-contain transition-opacity ${
            isZooming ? 'opacity-0' : 'opacity-100'
          }`}
          onError={(e) => {
            ;(e.target as HTMLImageElement).src = PLACEHOLDER_IMAGE
          }}
        />

        {/* Zoomed image */}
        {isZooming && (
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${currentImage.url})`,
              backgroundSize: '200%',
              backgroundPosition: `${zoomPosition.x}% ${zoomPosition.y}%`,
              backgroundRepeat: 'no-repeat',
            }}
          />
        )}

        {/* Image type badge */}
        <div className="absolute top-3 left-3">
          <span
            className={`inline-flex items-center px-2 py-1 rounded text-xs font-semibold ${
              currentImage.type === 'MAIN'
                ? 'bg-blue-100 text-blue-800'
                : currentImage.type === 'LIFESTYLE'
                  ? 'bg-green-100 text-green-800'
                  : 'bg-gray-100 text-gray-700'
            }`}
          >
            {currentImage.type}
          </span>
        </div>

        {/* Image counter */}
        {allImages.length > 1 && (
          <div className="absolute bottom-3 right-3 bg-black/60 text-white text-xs px-2 py-1 rounded">
            {selectedIndex + 1} / {allImages.length}
          </div>
        )}
      </div>
    </div>
  )
}
