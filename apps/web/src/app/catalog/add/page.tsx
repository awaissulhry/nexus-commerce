'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/layout/PageHeader';

interface ProductTypeOption {
  value: string;
  label: string;
}

interface FieldDefinition {
  name: string;
  label: string;
  dataType: string;
  required: boolean;
  description: string;
  enumValues?: string[];
  minValue?: number;
  maxValue?: number;
  maxLength?: number;
  placeholder?: string;
}

interface ParsedSchema {
  productType: string;
  requiredFields: FieldDefinition[];
  optionalFields: FieldDefinition[];
}

interface VariationAxis {
  name: string;
  values: string[];
}

interface GeneratedVariation {
  sku: string;
  quantity: number;
  price: number;
}

interface PlatformListing {
  channel: 'AMAZON' | 'SHOPIFY';
  title: string;
  priceOverride?: number;
  description: string;
  bulletPoints: string[];
  images: string[];
}

function showToast(message: string, type: 'success' | 'error') {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg text-white font-medium z-50 ${
    type === 'success' ? 'bg-green-600' : 'bg-red-600 dark:bg-red-700'
  }`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

interface FormFieldProps {
  field: FieldDefinition;
  value: any;
  onChange: (value: any) => void;
  error?: string;
  required?: boolean;
}

function FormField({ field, value, onChange, error, required }: FormFieldProps) {
  const borderColor = required ? 'border-red-300' : 'border-gray-300';
  const labelColor = required ? 'text-red-700 dark:text-red-300' : 'text-gray-700';

  return (
    <div>
      <label className={`block text-sm font-medium ${labelColor} mb-2`}>
        {field.label}
        {required && <span className="text-red-600 dark:text-red-400 ml-1">*</span>}
      </label>
      <p className="text-xs text-gray-500 mb-2">{field.description}</p>

      {field.dataType === 'ENUM' && field.enumValues ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full px-3 py-2 border ${borderColor} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`}
        >
          <option value="">Select {field.label}</option>
          {field.enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.dataType === 'INT' ? (
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value ? parseInt(e.target.value) : '')}
          placeholder={field.placeholder}
          min={field.minValue}
          max={field.maxValue}
          className={`w-full px-3 py-2 border ${borderColor} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`}
        />
      ) : field.dataType === 'DECIMAL' ? (
        <input
          type="number"
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value ? parseFloat(e.target.value) : '')}
          placeholder={field.placeholder}
          min={field.minValue}
          max={field.maxValue}
          className={`w-full px-3 py-2 border ${borderColor} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`}
        />
      ) : field.dataType === 'BOOLEAN' ? (
        <input
          type="checkbox"
          checked={value || false}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          className={`w-full px-3 py-2 border ${borderColor} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`}
        />
      )}

      {error && <p className="text-red-600 dark:text-red-400 text-sm mt-1">{error}</p>}
    </div>
  );
}

export default function AddProductPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState<'type' | 'master' | 'variations' | 'platforms'>('type');

  const [productTypes, setProductTypes] = useState<ProductTypeOption[]>([]);
  const [selectedProductType, setSelectedProductType] = useState<string>('');
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [typesError, setTypesError] = useState<string | null>(null);

  const [schema, setSchema] = useState<ParsedSchema | null>(null);
  const [masterData, setMasterData] = useState<Record<string, any>>({
    name: '',
    sku: '',
    basePrice: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [_schemaLoading, setSchemaLoading] = useState(false);

  // Detect hasVariations early - moved before variations step
  const [hasVariations, setHasVariations] = useState(false);
  // Track variation attributes that should be disabled when hasVariations=true
  const variationAttributeNames = ['Color', 'Size', 'Style', 'Material', 'Pattern', 'Fit', 'Length', 'Width', 'Height', 'Weight', 'Flavor', 'Scent'];
  const [variationAxes, setVariationAxes] = useState<VariationAxis[]>([]);
  const [generatedVariations, setGeneratedVariations] = useState<GeneratedVariation[]>([]);
  const [currentAxisInput, setCurrentAxisInput] = useState('');
  const [currentAxisValues, setCurrentAxisValues] = useState<string[]>([]);
  const [currentAxisValuesInput, setCurrentAxisValuesInput] = useState('');

  const [platformListings, setPlatformListings] = useState<PlatformListing[]>([
    { channel: 'AMAZON', title: '', description: '', bulletPoints: ['', '', '', '', ''], images: [] },
    { channel: 'SHOPIFY', title: '', description: '', bulletPoints: ['', '', '', '', ''], images: [] },
  ]);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fetchProductTypes = async () => {
      try {
        setLoadingTypes(true);
        setTypesError(null);
        const response = await fetch('/api/catalog/product-types');
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error?.message || 'Failed to fetch product types');
        setProductTypes(data.data.map((type: string) => ({ value: type, label: type.replace(/_/g, ' ') })));
      } catch (error) {
        setTypesError(error instanceof Error ? error.message : 'Failed to fetch product types');
      } finally {
        setLoadingTypes(false);
      }
    };
    fetchProductTypes();
  }, []);

  const handleProductTypeSelect = async (productType: string) => {
    setSelectedProductType(productType);
    try {
      setSchemaLoading(true);
      const response = await fetch(`/api/catalog/product-types/${productType}/schema`);
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (!data.success) throw new Error(data.error?.message || 'Failed to fetch schema');
      setSchema(data.data);
      setMasterData({ name: '', sku: '', basePrice: '' });
      setErrors({});
      setCurrentStep('master');
    } catch (error) {
      setErrors({ schema: error instanceof Error ? error.message : 'Failed to load schema' });
    } finally {
      setSchemaLoading(false);
    }
  };

  const handleMasterFieldChange = (fieldName: string, value: any) => {
    // Sanitize input to prevent console logs or HMR output from leaking into form state
    let sanitizedValue = value;
    if (typeof value === 'string') {
      // Remove any HMR or console-like patterns
      sanitizedValue = value.replace(/\[HMR\].*?(?=\n|$)/g, '').trim();
      sanitizedValue = sanitizedValue.replace(/forward-logs.*?(?=\n|$)/g, '').trim();
      sanitizedValue = sanitizedValue.replace(/\[Fast Refresh\].*?(?=\n|$)/g, '').trim();
      sanitizedValue = sanitizedValue.replace(/page\.tsx:\d+.*?(?=\n|$)/g, '').trim();
    }
    setMasterData((prev) => ({ ...prev, [fieldName]: sanitizedValue }));
    if (errors[fieldName]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[fieldName];
        return newErrors;
      });
    }
  };

  const generateVariations = () => {
    if (variationAxes.some((axis) => !axis.name || axis.values.length === 0)) {
      showToast('Please define all variation axes with values', 'error');
      return;
    }

    const axes = variationAxes.filter((a) => a.name && a.values.length > 0);
    const generateCombinations = (index: number, currentSku: string): GeneratedVariation[] => {
      if (index === axes.length) {
        return [{ sku: currentSku, quantity: 0, price: parseFloat(masterData.basePrice) || 0 }];
      }
      const results: GeneratedVariation[] = [];
      const axis = axes[index];
      for (const value of axis.values) {
        const newSku = currentSku ? `${currentSku}-${value.toUpperCase()}` : `${masterData.sku}-${value.toUpperCase()}`;
        results.push(...generateCombinations(index + 1, newSku));
      }
      return results;
    };

    const generated = generateCombinations(0, '');
    setGeneratedVariations(generated);
    showToast(`Generated ${generated.length} variations`, 'success');
  };

  const addVariationAxis = () => {
    if (!currentAxisInput.trim()) {
      showToast('Please enter an axis name', 'error');
      return;
    }
    if (currentAxisValues.length === 0) {
      showToast('Please add at least one value to the axis', 'error');
      return;
    }

    const newAxis = { name: currentAxisInput, values: currentAxisValues };
    setVariationAxes([...variationAxes, newAxis]);
    setCurrentAxisInput('');
    setCurrentAxisValues([]);
    
    showToast(`Added axis "${currentAxisInput}" with ${currentAxisValues.length} values`, 'success');
  };

  const removeVariationAxis = (index: number) => {
    setVariationAxes(variationAxes.filter((_, i) => i !== index));
  };

  const updateVariation = (index: number, field: 'quantity' | 'price', value: number) => {
    const updated = [...generatedVariations];
    updated[index] = { ...updated[index], [field]: value };
    setGeneratedVariations(updated);
  };

  const updatePlatformListing = (channel: 'AMAZON' | 'SHOPIFY', field: string, value: any) => {
    setPlatformListings(
      platformListings.map((listing) =>
        listing.channel === channel ? { ...listing, [field]: value } : listing
      )
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const newErrors: Record<string, string> = {};

    try {
      if (!masterData.name || masterData.name.trim() === '') newErrors.name = 'Product name is required';
      if (!masterData.sku || masterData.sku.trim() === '') newErrors.sku = 'SKU is required';
      if (!masterData.basePrice || masterData.basePrice === '') {
        newErrors.basePrice = 'Base price is required';
      } else if (isNaN(parseFloat(masterData.basePrice))) {
        newErrors.basePrice = 'Base price must be a valid number';
      }

      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors);
        setSubmitting(false);
        return;
      }

      const categoryAttributes: Record<string, any> = {};
      if (schema) {
        const allFields = [...schema.requiredFields, ...schema.optionalFields];
        allFields.forEach((field) => {
          if (field.name in masterData && masterData[field.name] !== '') {
            categoryAttributes[field.name] = masterData[field.name];
          }
        });
      }

      // Skip validation for parent products (variations will be validated on backend)
      const isParentProduct = hasVariations && generatedVariations.length > 0;
      
      if (!isParentProduct) {
        const validateResponse = await fetch('/api/catalog/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productType: selectedProductType, attributes: categoryAttributes }),
        });

        const validationData = await validateResponse.json();
        if (!validationData.success) throw new Error('Validation failed');
        if (!validationData.data.valid) {
          const validationErrors: Record<string, string> = {};
          validationData.data.errors.forEach((error: { field: string; message: string }) => {
            validationErrors[error.field] = error.message;
          });
          setErrors(validationErrors);
          setSubmitting(false);
          return;
        }
      }

      const payload: any = {
        master: {
          sku: masterData.sku,
          name: masterData.name,
          basePrice: parseFloat(masterData.basePrice),
          productType: selectedProductType,
          categoryAttributes,
          isParent: isParentProduct,
        },
        children: hasVariations ? generatedVariations : [],
        channelListings: platformListings.filter((listing) => listing.title && listing.description),
      };

      const createResponse = await fetch('/api/catalog/products/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const responseText = await createResponse.text();
      if (!createResponse.ok) throw new Error(`API Error ${createResponse.status}`);

      let createData;
      try {
        createData = JSON.parse(responseText);
      } catch (parseError) {
        throw new Error(`Invalid JSON response from server`);
      }

      if (!createData.success) throw new Error(createData.error?.message || 'Failed to create product');

      showToast('Product created successfully!', 'success');
      setTimeout(() => router.push('/catalog'), 1500);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create product';
      showToast(errorMessage, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Step 1: Product Type Selection
  if (currentStep === 'type') {
    return (
      <div>
        <PageHeader title="Add New Product" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Add Product' }]} />
        <div className="max-w-2xl mx-auto p-6">
          {/* Bulk Upload Alternative */}
          <div className="mb-8 p-6 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 dark:border-blue-900 rounded-lg">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Have multiple products?</h3>
                <p className="text-sm text-gray-600">Skip the manual process and upload your products in bulk using a spreadsheet.</p>
              </div>
              <Link
                href="/catalog/import"
                className="ml-4 px-4 py-2 bg-blue-600 dark:bg-blue-700 text-white text-sm font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors whitespace-nowrap"
              >
                📤 Upload via Spreadsheet
              </Link>
            </div>
          </div>

          <div className="mb-8 border-t border-gray-200 pt-8">
            <p className="text-gray-600 mb-6 font-medium">Or create a single product manually:</p>
          </div>

          <p className="text-gray-600 mb-8">Select a product type to get started.</p>
          {typesError && <div className="mb-6 p-4 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg"><p className="text-red-700 dark:text-red-300">{typesError}</p></div>}
          {loadingTypes ? (
            <div className="text-center py-12"><div className="inline-block"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div><p className="mt-4 text-gray-600">Loading product types...</p></div>
          ) : productTypes.length === 0 ? (
            <div className="text-center py-12"><p className="text-gray-600">No product types available</p></div>
          ) : (
            <div className="space-y-3">
              {productTypes.map((type) => (
                <button key={type.value} onClick={() => handleProductTypeSelect(type.value)} className="w-full p-4 text-left border border-gray-300 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:border-blue-500 transition-colors">
                  <div className="font-semibold text-gray-900">{type.label}</div>
                  <div className="text-sm text-gray-500">Click to view required fields</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Step 2: Master Product Data
  if (currentStep === 'master' && schema) {
    // Only filter out variation attributes when hasVariations is true
    // When hasVariations is false, show all fields including Color, Material, Size, etc.
    const isVariationAttribute = (fieldName: string) =>
      variationAttributeNames.some(attr => fieldName.toLowerCase().includes(attr.toLowerCase()));
    
    const requiredFieldsFiltered = hasVariations
      ? schema.requiredFields.filter(f => !isVariationAttribute(f.name))
      : schema.requiredFields; // Show all required fields when no variations
    
    const optionalFieldsFiltered = hasVariations
      ? schema.optionalFields.filter(f => !isVariationAttribute(f.name))
      : schema.optionalFields; // Show all optional fields when no variations

    return (
      <div>
        <PageHeader title={`Add ${selectedProductType.replace(/_/g, ' ')} Product`} breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Add Product' }]} />
        <div className="max-w-3xl mx-auto p-6">
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-gray-900">Create New Product</h2>
          </div>
          <div className="mb-6 flex items-center gap-2"><div className="flex-1 h-1 bg-blue-600 dark:bg-blue-700 rounded"></div><span className="text-sm font-medium text-gray-600">Step 1 of 3</span><div className="flex-1 h-1 bg-gray-300 rounded"></div></div>
          <button onClick={() => setCurrentStep('type')} className="mb-6 text-blue-600 dark:text-blue-400 hover:text-blue-800 flex items-center gap-2">← Back to Product Types</button>
          {errors.schema && <div className="mb-6 p-4 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg"><p className="text-red-700 dark:text-red-300">{errors.schema}</p></div>}
          <form onSubmit={(e) => { e.preventDefault(); setCurrentStep('variations'); }} className="space-y-8">
            <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200">
              <h2 className="text-lg font-semibold mb-4 text-gray-900">Master Product Information</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Product Name <span className="text-red-600 dark:text-red-400">*</span></label>
                  <input type="text" value={masterData.name} onChange={(e) => handleMasterFieldChange('name', e.target.value)} placeholder="Enter product name" className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.name ? 'border-red-300' : 'border-gray-300'}`} />
                  {errors.name && <p className="text-red-600 dark:text-red-400 text-sm mt-1">{errors.name}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">SKU <span className="text-red-600 dark:text-red-400">*</span></label>
                  <input type="text" value={masterData.sku} onChange={(e) => handleMasterFieldChange('sku', e.target.value)} placeholder="Enter SKU" className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.sku ? 'border-red-300' : 'border-gray-300'}`} />
                  {errors.sku && <p className="text-red-600 dark:text-red-400 text-sm mt-1">{errors.sku}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Base Price <span className="text-red-600 dark:text-red-400">*</span></label>
                  <input type="number" step="0.01" value={masterData.basePrice} onChange={(e) => handleMasterFieldChange('basePrice', e.target.value)} placeholder="0.00" className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.basePrice ? 'border-red-300' : 'border-gray-300'}`} />
                  {errors.basePrice && <p className="text-red-600 dark:text-red-400 text-sm mt-1">{errors.basePrice}</p>}
                </div>
              </div>
            </div>

            {/* Variations Toggle - Early Detection */}
            <div className="bg-blue-50 dark:bg-blue-950/40 p-6 rounded-lg border border-blue-200 dark:border-blue-900">
              <div className="flex items-center gap-4">
                <input
                  type="checkbox"
                  id="hasVariations"
                  checked={hasVariations}
                  onChange={(e) => setHasVariations(e.target.checked)}
                  className="w-5 h-5 text-blue-600 dark:text-blue-400 rounded"
                />
                <label htmlFor="hasVariations" className="text-lg font-medium text-gray-900">Does this product have variations?</label>
              </div>
              <p className="text-sm text-gray-600 mt-2 ml-9">Enable this to create child SKUs with different attributes (e.g., colors, sizes)</p>
            </div>

            {/* Informational Banner for Disabled Attributes */}
            {hasVariations && (
              <div className="bg-amber-50 dark:bg-amber-950/40 p-4 rounded-lg border border-amber-200 dark:border-amber-900">
                <p className="text-sm text-amber-800">
                  <span className="font-semibold">ℹ️ Variation attributes disabled:</span> Attributes like Color, Size, Style, and similar variation-specific fields are disabled here because they will be defined in the Variations step. These attributes belong on child products, not the parent.
                </p>
              </div>
            )}

            {requiredFieldsFiltered.length > 0 && (
              <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200">
                <h2 className="text-lg font-semibold mb-4 text-red-600 dark:text-red-400">Required Fields</h2>
                <div className="space-y-4">
                  {requiredFieldsFiltered.map((field) => (
                    <FormField key={field.name} field={field} value={masterData[field.name] || ''} onChange={(value) => handleMasterFieldChange(field.name, value)} error={errors[field.name]} required />
                  ))}
                </div>
              </div>
            )}

            {optionalFieldsFiltered.length > 0 && (
              <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200">
                <h2 className="text-lg font-semibold mb-4 text-gray-700">Optional Fields</h2>
                <div className="space-y-4">
                  {optionalFieldsFiltered.map((field) => (
                    <FormField key={field.name} field={field} value={masterData[field.name] || ''} onChange={(value) => handleMasterFieldChange(field.name, value)} error={errors[field.name]} />
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-4 pt-6 border-t border-gray-200">
              <button type="button" onClick={() => setCurrentStep('type')} className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Back</button>
              <button type="submit" className="px-6 py-2 bg-blue-600 dark:bg-blue-700 text-white rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors">Next: Variations</button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Step 3: Variations
  if (currentStep === 'variations') {
    const totalVariations = variationAxes.reduce((acc, a) => acc * a.values.length, 1);
    return (
      <div>
        <PageHeader title="Configure Variations" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Add Product' }]} />
        <div className="max-w-4xl mx-auto p-6">
          <div className="mb-6 flex items-center gap-2"><div className="flex-1 h-1 bg-blue-600 dark:bg-blue-700 rounded"></div><span className="text-sm font-medium text-gray-600">Step 2 of 3</span><div className="flex-1 h-1 bg-blue-600 dark:bg-blue-700 rounded"></div><div className="flex-1 h-1 bg-gray-300 rounded"></div></div>
          <form onSubmit={(e) => { e.preventDefault(); setCurrentStep('platforms'); }} className="space-y-8">
            <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200">
              <div className="flex items-center gap-4">
                <input type="checkbox" id="hasVariations" checked={hasVariations} onChange={(e) => setHasVariations(e.target.checked)} className="w-5 h-5 text-blue-600 dark:text-blue-400 rounded" />
                <label htmlFor="hasVariations" className="text-lg font-medium text-gray-900">Does this product have variations?</label>
              </div>
              <p className="text-sm text-gray-600 mt-2 ml-9">Enable this to create child SKUs with different attributes (e.g., colors, sizes)</p>
            </div>

            {hasVariations && (
              <>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200">
                  <h2 className="text-lg font-semibold mb-4 text-gray-900">Define Variation Axes</h2>
                  {variationAxes.map((axis, index) => (
                    <div key={index} className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-between">
                      <div><p className="font-medium text-gray-900">{axis.name}</p><p className="text-sm text-gray-600">{axis.values.join(', ')}</p></div>
                      <button type="button" onClick={() => removeVariationAxis(index)} className="text-red-600 dark:text-red-400 hover:text-red-800 text-sm font-medium">Remove</button>
                    </div>
                  ))}
                  <div className="space-y-4 mt-6 pt-6 border-t border-gray-200">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Axis Name (e.g., Color, Size)</label>
                      <input type="text" value={currentAxisInput} onChange={(e) => setCurrentAxisInput(e.target.value)} placeholder="e.g., Color" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Values (comma-separated)</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="e.g., Red, Blue, Green"
                          value={currentAxisValuesInput}
                          onChange={(e) => setCurrentAxisValuesInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const inputValue = currentAxisValuesInput || '';
                              const values = inputValue.split(',').map((v) => v.trim()).filter((v) => v);
                              if (values.length > 0) {
                                setCurrentAxisValues(values);
                                setCurrentAxisValuesInput('');
                              }
                            }
                          }}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const inputValue = currentAxisValuesInput || '';
                            const values = inputValue.split(',').map((v) => v.trim()).filter((v) => v);
                            if (values.length > 0) {
                              setCurrentAxisValues(values);
                              setCurrentAxisValuesInput('');
                            } else {
                              showToast('Please enter at least one value', 'error');
                            }
                          }}
                          className="px-4 py-2 bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 rounded-lg hover:bg-blue-200 transition-colors font-medium"
                        >
                          Add Values
                        </button>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">Press Enter or click "Add Values" button</p>
                    </div>
                    {currentAxisValues.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {currentAxisValues.map((value, idx) => (
                          <span key={idx} className="px-3 py-1 bg-blue-100 dark:bg-blue-900/60 text-blue-800 rounded-full text-sm">{value}</span>
                        ))}
                      </div>
                    )}
                    <button type="button" onClick={addVariationAxis} className="w-full px-4 py-2 bg-gray-100 text-gray-900 rounded-lg hover:bg-gray-200 transition-colors font-medium">Add Axis</button>
                  </div>
                </div>

                {variationAxes.length > 0 && (
                  <button type="button" onClick={generateVariations} className="w-full px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium">
                    Generate {totalVariations} Variations
                  </button>
                )}

                {generatedVariations.length > 0 && (
                  <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200">
                    <h2 className="text-lg font-semibold mb-4 text-gray-900">Generated Variations ({generatedVariations.length})</h2>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-200">
                            <th className="text-left py-2 px-3 font-medium text-gray-700">SKU</th>
                            <th className="text-left py-2 px-3 font-medium text-gray-700">Quantity</th>
                            <th className="text-left py-2 px-3 font-medium text-gray-700">Price</th>
                          </tr>
                        </thead>
                        <tbody>
                          {generatedVariations.map((variation, idx) => (
                            <tr key={idx} className="border-b border-gray-100">
                              <td className="py-2 px-3 text-gray-900">{variation.sku}</td>
                              <td className="py-2 px-3"><input type="number" value={variation.quantity} onChange={(e) => updateVariation(idx, 'quantity', parseInt(e.target.value) || 0)} className="w-20 px-2 py-1 border border-gray-300 rounded" /></td>
                              <td className="py-2 px-3"><input type="number" step="0.01" value={variation.price} onChange={(e) => updateVariation(idx, 'price', parseFloat(e.target.value) || 0)} className="w-24 px-2 py-1 border border-gray-300 rounded" /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-gray-600 mt-4">Note: You can still link existing orphaned SKUs to this parent later from the Edit Matrix.</p>
                  </div>
                )}
              </>
            )}

            <div className="flex gap-4 pt-6 border-t border-gray-200">
              <button type="button" onClick={() => setCurrentStep('master')} className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Back</button>
              <button type="submit" className="px-6 py-2 bg-blue-600 dark:bg-blue-700 text-white rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors">Next: Platforms</button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Step 4: Platform Listings
  if (currentStep === 'platforms') {
    return (
      <div>
        <PageHeader title="Platform Listings" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Add Product' }]} />
        <div className="max-w-4xl mx-auto p-6">
          <div className="mb-6 flex items-center gap-2"><div className="flex-1 h-1 bg-blue-600 dark:bg-blue-700 rounded"></div><span className="text-sm font-medium text-gray-600">Step 3 of 3</span><div className="flex-1 h-1 bg-blue-600 dark:bg-blue-700 rounded"></div></div>
          <form onSubmit={handleSubmit} className="space-y-8">
            {platformListings.map((listing) => (
              <div key={listing.channel} className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200">
                <h2 className="text-lg font-semibold mb-4 text-gray-900">{listing.channel} Listing</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Platform Title</label>
                    <input type="text" value={listing.title} onChange={(e) => updatePlatformListing(listing.channel, 'title', e.target.value)} placeholder="e.g., Premium Blue Widget" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
                    <textarea value={listing.description} onChange={(e) => updatePlatformListing(listing.channel, 'description', e.target.value)} placeholder="Enter product description for this platform" rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Price Override (optional)</label>
                    <input type="number" step="0.01" value={listing.priceOverride || ''} onChange={(e) => updatePlatformListing(listing.channel, 'priceOverride', e.target.value ? parseFloat(e.target.value) : undefined)} placeholder="Leave blank to use base price" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Bullet Points (up to 5)</label>
                    {listing.bulletPoints.map((point, idx) => (
                      <input key={idx} type="text" value={point} onChange={(e) => { const updated = [...listing.bulletPoints]; updated[idx] = e.target.value; updatePlatformListing(listing.channel, 'bulletPoints', updated); }} placeholder={`Bullet point ${idx + 1}`} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2" />
                    ))}
                  </div>
                </div>
              </div>
            ))}

            <div className="flex gap-4 pt-6 border-t border-gray-200">
              <button type="button" onClick={() => setCurrentStep('variations')} className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Back</button>
              <button type="submit" disabled={submitting} className="px-6 py-2 bg-blue-600 dark:bg-blue-700 text-white rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 transition-colors flex items-center gap-2">
                {submitting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Creating...
                  </>
                ) : (
                  'Create Product'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return null;
}
