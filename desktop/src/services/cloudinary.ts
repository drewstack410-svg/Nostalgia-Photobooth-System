/**
 * Browser-compatible Cloudinary upload using unsigned upload API
 * This approach works in Electron's renderer process without Node.js dependencies
 */

export interface CloudinaryUploadResult {
    success: boolean
    url?: string
    publicId?: string
    error?: string
}

/**
 * Upload image to Cloudinary using unsigned upload with upload preset
 * @param imageDataUrl - Base64 data URL of the image
 * @param folder - Optional folder path in Cloudinary (default: 'nostalgia-photobooth')
 * @param publicId - Optional custom public ID for the image
 * @param tags - Optional tag(s) to attach. Used by the gallery page to
 *   group session captures so Cloudinary's `multi` endpoint can stitch
 *   them into an animated GIF. Pass a single tag like
 *   `session_1234567890` per session.
 * @returns Promise with upload result
 */
export async function uploadToCloudinary(
    imageDataUrl: string,
    folder: string = 'nostalgia-photobooth',
    publicId?: string,
    tags?: string | string[]
): Promise<CloudinaryUploadResult> {
    try {
        console.log('[Cloudinary] Starting upload process...')
        const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
        const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET

        console.log('[Cloudinary] Cloud name:', cloudName ? '✓ Set' : '✗ Missing')
        console.log('[Cloudinary] Upload preset:', uploadPreset ? '✓ Set' : '✗ Missing')

        if (!cloudName || !uploadPreset) {
            console.warn('[Cloudinary] Credentials not configured. Cloud uploads will be disabled.')
            console.warn('[Cloudinary] Please create an unsigned upload preset at: https://console.cloudinary.com/settings/upload_presets')
            return {
                success: false,
                error: 'Cloudinary credentials not configured. Please set VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET in your .env file',
            }
        }

        // Generate unique public ID if not provided
        const finalPublicId = publicId || `nostalgia_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        console.log('[Cloudinary] Public ID:', finalPublicId)

        // Create FormData for upload
        // Note: For unsigned uploads, only specific parameters are allowed
        // Format parameter is NOT allowed in unsigned uploads
        const formData = new FormData()
        formData.append('file', imageDataUrl)
        formData.append('upload_preset', uploadPreset)
        formData.append('folder', folder)
        formData.append('public_id', finalPublicId)
        // Tags must be a comma-separated string in the unsigned upload
        // form. The Cloudinary upload preset must allow tags (toggle in
        // the preset's "Tags" setting) — most presets allow this by
        // default since it's not considered a privileged operation.
        if (tags) {
            const tagString = Array.isArray(tags) ? tags.join(',') : tags
            formData.append('tags', tagString)
            console.log('[Cloudinary] - Tags:', tagString)
        }
        // Note: 'format' parameter is NOT allowed in unsigned uploads
        
        console.log('[Cloudinary] - Upload preset:', uploadPreset)
        console.log('[Cloudinary] - Folder:', folder)
        console.log('[Cloudinary] - Public ID:', finalPublicId)

        // Upload to Cloudinary using unsigned upload endpoint
        const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`
        console.log('[Cloudinary] Upload URL:', uploadUrl)
        console.log('[Cloudinary] Uploading to folder:', folder)
        
        const response = await fetch(uploadUrl, {
            method: 'POST',
            body: formData,
        })

        console.log('[Cloudinary] Response status:', response.status, response.statusText)

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}))
            console.error('[Cloudinary] Upload failed. Error data:', errorData)
            throw new Error(errorData.error?.message || `Upload failed with status ${response.status}`)
        }

        const result = await response.json()
        console.log('[Cloudinary] Upload successful!')
        console.log('[Cloudinary] Full response:', result)
        console.log('[Cloudinary] Secure URL:', result.secure_url)
        console.log('[Cloudinary] Public ID:', result.public_id)
        console.log('[Cloudinary] Folder:', result.folder || 'Not specified in response')
        console.log('[Cloudinary] ✅ Photo should be visible at:', result.secure_url)
        console.log('[Cloudinary] 📁 Check folder in Media Library: https://console.cloudinary.com/console/media_library/folders/nostalgia-photobooth')

        return {
            success: true,
            url: result.secure_url,
            publicId: result.public_id,
        }
    } catch (error) {
        console.error('[Cloudinary] Upload error:', error)
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred',
        }
    }
}
