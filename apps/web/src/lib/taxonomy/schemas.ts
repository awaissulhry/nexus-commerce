/**
 * Phase 21: Dynamic Taxonomy Configuration
 * Centralized schema definitions for category-specific attributes
 * Maps Amazon product types to their required/optional fields
 */

export interface AttributeField {
  id: string
  label: string
  type: 'text' | 'select' | 'textarea' | 'number' | 'checkbox'
  options?: string[]
  required: boolean
  amazonKey: string
  placeholder?: string
  helpText?: string
  maxLength?: number
}

export interface CategorySchema {
  category: string
  displayName: string
  fields: AttributeField[]
}

export const categorySchemas: Record<string, AttributeField[]> = {
  OUTERWEAR: [
    {
      id: 'material',
      label: 'Material',
      type: 'select',
      options: ['Leather', 'Textile', 'Synthetic', 'Cotton', 'Wool', 'Polyester', 'Nylon', 'Silk'],
      required: true,
      amazonKey: 'FabricType',
      helpText: 'Primary material composition',
    },
    {
      id: 'size',
      label: 'Size',
      type: 'select',
      options: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'],
      required: true,
      amazonKey: 'Size',
      helpText: 'Standard clothing size',
    },
    {
      id: 'color',
      label: 'Color',
      type: 'text',
      required: true,
      amazonKey: 'Color',
      placeholder: 'e.g., Black, Navy Blue',
      helpText: 'Primary color of the garment',
    },
    {
      id: 'careInstructions',
      label: 'Care Instructions',
      type: 'textarea',
      required: false,
      amazonKey: 'CareInstructions',
      placeholder: 'e.g., Machine wash cold, tumble dry low',
      helpText: 'Washing and care instructions',
      maxLength: 500,
    },
    {
      id: 'gender',
      label: 'Gender',
      type: 'select',
      options: ['Men', 'Women', 'Unisex', 'Boys', 'Girls'],
      required: false,
      amazonKey: 'Gender',
      helpText: 'Target gender for this garment',
    },
    {
      id: 'season',
      label: 'Season',
      type: 'select',
      options: ['Spring', 'Summer', 'Fall', 'Winter', 'All Season'],
      required: false,
      amazonKey: 'Season',
      helpText: 'Intended season of use',
    },
  ],

  ELECTRONICS: [
    {
      id: 'brand',
      label: 'Brand',
      type: 'text',
      required: true,
      amazonKey: 'Brand',
      placeholder: 'e.g., Sony, Samsung',
      helpText: 'Manufacturer brand name',
    },
    {
      id: 'model',
      label: 'Model Number',
      type: 'text',
      required: true,
      amazonKey: 'ModelNumber',
      placeholder: 'e.g., WH-1000XM4',
      helpText: 'Specific model identifier',
    },
    {
      id: 'color',
      label: 'Color',
      type: 'text',
      required: false,
      amazonKey: 'Color',
      placeholder: 'e.g., Black, Silver',
      helpText: 'Product color variant',
    },
    {
      id: 'warranty',
      label: 'Warranty Period',
      type: 'text',
      required: false,
      amazonKey: 'WarrantyPeriod',
      placeholder: 'e.g., 1 Year',
      helpText: 'Manufacturer warranty duration',
    },
    {
      id: 'voltage',
      label: 'Voltage',
      type: 'select',
      options: ['110V', '220V', '110-240V'],
      required: false,
      amazonKey: 'Voltage',
      helpText: 'Operating voltage specification',
    },
    {
      id: 'batteryLife',
      label: 'Battery Life',
      type: 'text',
      required: false,
      amazonKey: 'BatteryLife',
      placeholder: 'e.g., 30 hours',
      helpText: 'Expected battery duration',
    },
  ],

  LUGGAGE: [
    {
      id: 'material',
      label: 'Material',
      type: 'select',
      options: ['Polycarbonate', 'ABS', 'Nylon', 'Polyester', 'Leather', 'Canvas'],
      required: true,
      amazonKey: 'Material',
      helpText: 'Luggage shell material',
    },
    {
      id: 'capacity',
      label: 'Capacity (Liters)',
      type: 'number',
      required: true,
      amazonKey: 'Capacity',
      placeholder: '50',
      helpText: 'Volume in liters',
    },
    {
      id: 'color',
      label: 'Color',
      type: 'text',
      required: true,
      amazonKey: 'Color',
      placeholder: 'e.g., Black, Red',
      helpText: 'Luggage color',
    },
    {
      id: 'wheelType',
      label: 'Wheel Type',
      type: 'select',
      options: ['2-Wheel', '4-Wheel', '8-Wheel', 'No Wheels'],
      required: false,
      amazonKey: 'WheelType',
      helpText: 'Number and type of wheels',
    },
    {
      id: 'lockType',
      label: 'Lock Type',
      type: 'select',
      options: ['TSA Lock', 'Combination Lock', 'Key Lock', 'No Lock'],
      required: false,
      amazonKey: 'LockType',
      helpText: 'Security lock mechanism',
    },
    {
      id: 'weight',
      label: 'Weight (kg)',
      type: 'number',
      required: false,
      amazonKey: 'Weight',
      placeholder: '2.5',
      helpText: 'Luggage weight when empty',
    },
  ],
}

/**
 * Get schema for a specific category
 */
export function getCategorySchema(category: string): AttributeField[] {
  return categorySchemas[category] || []
}

/**
 * Get all available categories
 */
export function getAvailableCategories(): string[] {
  return Object.keys(categorySchemas)
}

/**
 * Validate category attributes against schema
 */
export function validateCategoryAttributes(
  category: string,
  attributes: Record<string, any>
): { valid: boolean; errors: Array<{ field: string; message: string }> } {
  const schema = getCategorySchema(category)
  const errors: Array<{ field: string; message: string }> = []

  schema.forEach((field) => {
    const value = attributes[field.id]

    // Check required fields
    if (field.required && (!value || value.toString().trim() === '')) {
      errors.push({
        field: field.id,
        message: `${field.label} is required`,
      })
    }

    // Validate select options
    if (field.type === 'select' && value && field.options) {
      if (!field.options.includes(value)) {
        errors.push({
          field: field.id,
          message: `${field.label} must be one of: ${field.options.join(', ')}`,
        })
      }
    }

    // Validate max length
    if (field.maxLength && value && value.toString().length > field.maxLength) {
      errors.push({
        field: field.id,
        message: `${field.label} must not exceed ${field.maxLength} characters`,
      })
    }

    // Validate number fields
    if (field.type === 'number' && value && isNaN(Number(value))) {
      errors.push({
        field: field.id,
        message: `${field.label} must be a valid number`,
      })
    }
  })

  return {
    valid: errors.length === 0,
    errors,
  }
}
