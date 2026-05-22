/**
 * Concept Map File Upload Store
 *
 * 用于"概念图生成"场景的文件上传通道，与 MindMate 聊天的 pendingFiles 完全隔离。
 *
 * 用户在画布迷你 MindMate 面板（concept_map 类型）下上传的文件会保存到这里，
 * 后续用于"提取内容供概念图生成"的逻辑（生成流程接入由后续需求决定）。
 *
 * 上传走与 MindMate 一致的 /api/dify/files/upload 接口（已支持图片+文档+音视频），
 * 但文件 ID 不会进入 MindMate 聊天的 pendingFiles，因此用户向 MindMate 发问时
 * 不会把这些素材当作聊天附件发出去。
 */
import { computed, ref } from 'vue'

import { defineStore } from 'pinia'

import { useAuthStore } from './auth'

// ============================================================================
// Types
// ============================================================================

export type ConceptMapUploadFileType = 'image' | 'document' | 'audio' | 'video' | 'custom'

export interface ConceptMapUploadFile {
  id: string
  name: string
  type: ConceptMapUploadFileType
  size: number
  extension: string
  mime_type: string
  /** 仅图片有本地预览 URL，需要在移除时 revoke */
  preview_url?: string
  /**
   * 仅图片：本地读取的 base64 data URL（形如 `data:image/png;base64,...`）。
   *
   * 用于"图片→焦点问题"的后端调用，**直接把 base64 传给 Qwen-VL**，避开
   * 通过 Dify `/files/{id}/preview` 反向下载（该接口在文件未参与 chat
   * 上下文时返回 404）。
   */
  data_url?: string
}

// ============================================================================
// Constants
// ============================================================================

/** 概念图素材允许的 MIME / 扩展名白名单（与后端 /api/dify/files/upload 支持范围对齐） */
export const CONCEPT_MAP_UPLOAD_ACCEPT =
  'image/*,.pdf,.doc,.docx,.txt,.md,.markdown,.html,.htm,.csv,.xlsx,.xls,.ppt,.pptx,.xml,.epub'

const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'txt',
  'md',
  'markdown',
  'html',
  'htm',
  'csv',
  'xlsx',
  'xls',
  'ppt',
  'pptx',
  'xml',
  'epub',
])

// ============================================================================
// Helpers
// ============================================================================

function inferFileType(mimeType: string, extension: string): ConceptMapUploadFileType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (
    mimeType.includes('pdf') ||
    mimeType.includes('document') ||
    mimeType.includes('text') ||
    mimeType.includes('spreadsheet') ||
    mimeType.includes('presentation') ||
    DOCUMENT_EXTENSIONS.has(extension.toLowerCase())
  ) {
    return 'document'
  }
  return 'custom'
}

function getDifyUserId(authUserId: string | number | undefined): string {
  if (authUserId !== undefined && authUserId !== null && `${authUserId}`.length > 0) {
    return `mg_user_${authUserId}`
  }
  let id = localStorage.getItem('mindgraph_guest_id')
  if (!id) {
    id = `guest_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    localStorage.setItem('mindgraph_guest_id', id)
  }
  return id
}

// ============================================================================
// Store
// ============================================================================

export const useConceptMapFileUploadStore = defineStore('conceptMapFileUpload', () => {
  const authStore = useAuthStore()

  const pendingFiles = ref<ConceptMapUploadFile[]>([])
  const isUploading = ref(false)
  const lastError = ref<string | null>(null)

  const hasPendingFiles = computed(() => pendingFiles.value.length > 0)

  async function uploadFile(file: File): Promise<ConceptMapUploadFile | null> {
    if (!file) return null
    lastError.value = null

    isUploading.value = true
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('user_id', getDifyUserId(authStore.user?.id))

      const response = await fetch('/api/dify/files/upload', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      })

      if (!response.ok) {
        if (response.status === 401) {
          authStore.handleTokenExpired('您的登录已过期，请重新登录后上传文件')
          throw new Error('Session expired')
        }
        const error = await response.json().catch(() => ({ detail: 'Upload failed' }))
        throw new Error(error.detail || 'Upload failed')
      }

      const result = await response.json()
      const data = result.data
      if (!data || !data.id) {
        throw new Error('Invalid response from file upload API')
      }

      const extension = data.extension || file.name.split('.').pop() || ''
      const mimeType = data.mime_type || file.type || 'application/octet-stream'

      const uploaded: ConceptMapUploadFile = {
        id: data.id,
        name: data.name || file.name,
        type: inferFileType(mimeType, extension),
        size: data.size || file.size,
        extension,
        mime_type: mimeType,
        preview_url: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      }

      pendingFiles.value.push(uploaded)
      return uploaded
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'File upload failed'
      lastError.value = msg
      return null
    } finally {
      isUploading.value = false
    }
  }

  /**
   * 概念图模式专用：**完全在浏览器本地**添加一个文件到素材通道，**不调用任何上传接口**。
   *
   * 设计动机：
   *   概念图生成全程不依赖 Dify file_id —— "图片→焦点问题" 后端首选 base64 通道
   *   （`concept_map_image_focus.py` 第 339-355 行的 images_base64 优先逻辑），
   *   "概念图文本生成" 走自家 LLM 直接消费 image_content 文字，更不需要 Dify。
   *   因此在概念图模式下，把图片传到 Dify 是 100% 浪费的网络等待
   *   （242KB ~ 7s，1MB ~ 60s，跨境链路）。本方法让上传时间从 7~60s 降到 <200ms
   *   （仅浏览器本地 FileReader 读 base64 的开销）。
   *
   * id 用 `local_<rand>` 形式与真 Dify file id 区分，避免误传给后端做反向下载。
   *
   * 返回新增对象，便于调用方拿到 id（例如做撤销）。失败（读取 base64 异常等）返回 null。
   */
  async function addLocalFile(file: File): Promise<ConceptMapUploadFile | null> {
    if (!file) return null
    lastError.value = null

    isUploading.value = true
    try {
      const extension = (file.name.split('.').pop() || '').toLowerCase()
      const mimeType = file.type || 'application/octet-stream'
      const type = inferFileType(mimeType, extension)

      let dataUrl: string | undefined
      if (type === 'image' || type === 'document') {
        dataUrl = await new Promise<string | undefined>((resolve) => {
          try {
            const reader = new FileReader()
            reader.onload = () =>
              resolve(typeof reader.result === 'string' ? reader.result : undefined)
            reader.onerror = () => resolve(undefined)
            reader.readAsDataURL(file)
          } catch {
            resolve(undefined)
          }
        })
        if (!dataUrl) {
          throw new Error('Failed to read file as base64')
        }
      }

      const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      const uploaded: ConceptMapUploadFile = {
        id: localId,
        name: file.name,
        type,
        size: file.size,
        extension,
        mime_type: mimeType,
        preview_url: type === 'image' ? URL.createObjectURL(file) : undefined,
        data_url: dataUrl,
      }

      pendingFiles.value.push(uploaded)
      return uploaded
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Local file add failed'
      lastError.value = msg
      return null
    } finally {
      isUploading.value = false
    }
  }

  /**
   * 把"已经上传完毕"的文件信息直接挂到概念图素材通道，避免再调一次 /api/dify/files/upload。
   *
   * 用于"双投递"场景：用户在概念图模式下上传文件时，先由 MindMate 聊天通道完成实际上传，
   * 拿到的 MindMateFile 同步复制一份到这里，作为后续概念图生成的素材库。
   *
   * 注意：传入对象的 preview_url 由调用方自行管理生命周期。本 store 在 removeFile/clear 时
   * 不会 revoke 它（避免和 MindMate 那份同 URL 重复 revoke），统一由 MindMate 那份处理。
   *
   * 第二个参数 dataUrl：可选的本地 base64 data URL，供"图片→焦点问题"后端调用直接消费。
   */
  function addUploadedFile(file: ConceptMapUploadFile, dataUrl?: string): void {
    if (!file || !file.id) return
    const existing = pendingFiles.value.find((f) => f.id === file.id)
    if (existing) {
      // 同 id 重复加入：补齐 data_url（防止上次没读到）
      if (dataUrl && !existing.data_url) existing.data_url = dataUrl
      return
    }
    pendingFiles.value.push({
      ...file,
      // 这里不复制 preview_url —— blob URL 的所有权交给 MindMate.pendingFiles 那份。
      preview_url: undefined,
      data_url: dataUrl ?? file.data_url,
    })
  }

  function removeFile(fileId: string): void {
    const file = pendingFiles.value.find((f) => f.id === fileId)
    if (file?.preview_url) {
      URL.revokeObjectURL(file.preview_url)
    }
    pendingFiles.value = pendingFiles.value.filter((f) => f.id !== fileId)
  }

  function clearPendingFiles(): void {
    pendingFiles.value.forEach((f) => {
      if (f.preview_url) URL.revokeObjectURL(f.preview_url)
    })
    pendingFiles.value = []
    lastError.value = null
  }

  function detachPendingFiles(): ConceptMapUploadFile[] {
    const files = [...pendingFiles.value]
    pendingFiles.value = []
    lastError.value = null
    return files
  }

  return {
    pendingFiles,
    isUploading,
    lastError,
    hasPendingFiles,
    uploadFile,
    addLocalFile,
    addUploadedFile,
    removeFile,
    clearPendingFiles,
    detachPendingFiles,
  }
})
