/**
 * UNUSED — Cloudinary unsigned upload.
 *
 * Guest copies now go to Cloudflare R2 (`src/services/r2.ts`). This
 * helper is kept so we can switch back by uncommenting the import in
 * PrintingView.vue. Do not call it from new code.
 */

export interface CloudinaryUploadResult {
    success: boolean
    url?: string
    publicId?: string
    error?: string
}

/**
 * Upload image to Cloudinary using unsigned upload with upload preset
 * @deprecated Use uploadToR2 from `@/services/r2` instead.
 */
export async function uploadToCloudinary(
    _imageDataUrl: string,
    _folder: string = 'nostalgia-photobooth',
    _publicId?: string,
    _tags?: string | string[]
): Promise<CloudinaryUploadResult> {
    console.warn('[Cloudinary] Disabled — uploads go to Cloudflare R2.')
    return {
        success: false,
        error: 'Cloudinary is disabled. Photos upload to Cloudflare R2.',
    }
}

/*
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

        const finalPublicId = publicId || `nostalgia_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        console.log('[Cloudinary] Public ID:', finalPublicId)

        const formData = new FormData()
        formData.append('file', imageDataUrl)
        formData.append('upload_preset', uploadPreset)
        formData.append('folder', folder)
        formData.append('public_id', finalPublicId)
        if (tags) {
            const tagString = Array.isArray(tags) ? tags.join(',') : tags
            formData.append('tags', tagString)
            console.log('[Cloudinary] - Tags:', tagString)
        }

        const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`
        const response = await fetch(uploadUrl, {
            method: 'POST',
            body: formData,
        })

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}))
            console.error('[Cloudinary] Upload failed. Error data:', errorData)
            throw new Error(errorData.error?.message || `Upload failed with status ${response.status}`)
        }

        const result = await response.json()
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
*/
