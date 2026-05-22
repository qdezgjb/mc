<script setup lang="ts">
import { computed, ref } from 'vue'

import { ElButton, ElIcon, ElInput, ElTooltip } from 'element-plus'

import { Close, VideoPause } from '@element-plus/icons-vue'

import { Paperclip, Send } from 'lucide-vue-next'

import { useLanguage } from '@/composables'
import type { MindMateFile } from '@/composables/mindmate/useMindMate'
import { useAuthStore } from '@/stores/auth'

import SuggestionBubbles from '../../common/SuggestionBubbles.vue'

const props = withDefaults(
  defineProps<{
    mode?: 'panel' | 'fullpage'
    inputText?: string
    isLoading?: boolean
    isStreaming?: boolean
    isUploading?: boolean
    pendingFiles?: MindMateFile[]
    showSuggestions?: boolean
    /** When false, hide file upload button (e.g. canvas mini-mindmate) */
    showFileUpload?: boolean
    /** Custom placeholder (default: question prompt) */
    placeholder?: string
    /** Max length for input (e.g. 1000 for comments) */
    maxlength?: number
    /**
     * 上传按钮的 accept 类型；默认为图片。概念图素材上传场景会覆盖为
     * 图片+常见文档类型（PDF/DOC/TXT/MD 等）。
     */
    acceptTypes?: string
    /** 上传按钮的 tooltip 文案 i18n key（不传则使用默认 mindmate.input.attachFile） */
    attachTooltipKey?: string
    /**
     * pendingFiles 是否影响发送按钮启用状态。
     * - 默认 true：与历史行为一致，光有附件即可点发送（用于 MindMate 聊天附件）。
     * - 概念图素材上传场景传 false：素材文件不参与 MindMate 发送判定，
     *   避免出现"按钮可点但点了没反应"的尴尬交互。
     */
    pendingFilesAttachToSend?: boolean
  }>(),
  {
    mode: 'panel',
    inputText: '',
    isLoading: false,
    isStreaming: false,
    isUploading: false,
    pendingFiles: () => [],
    showSuggestions: false,
    showFileUpload: true,
    placeholder: '',
    maxlength: undefined,
    acceptTypes: 'image/*',
    attachTooltipKey: '',
    pendingFilesAttachToSend: true,
  }
)

const emit = defineEmits<{
  (e: 'update:inputText', value: string): void
  (e: 'send'): void
  (e: 'stop'): void
  (e: 'upload', files: FileList): void
  (e: 'removeFile', fileId: string): void
  (e: 'suggestionSelect', suggestion: string): void
}>()

const { t } = useLanguage()
const authStore = useAuthStore()
const isFullpageMode = computed(() => props.mode === 'fullpage')
const fileInputRef = ref<HTMLInputElement | null>(null)

// Computed for send button disabled state
const isSendDisabled = computed(() => {
  const hasFilesForSend =
    props.showFileUpload && props.pendingFilesAttachToSend && props.pendingFiles.length > 0
  const hasContent = props.inputText.trim() || hasFilesForSend
  return !hasContent || props.isLoading || !authStore.isAuthenticated
})

// Get file icon based on type
function getFileIcon(type: string): string {
  switch (type) {
    case 'image':
      return '🖼️'
    case 'audio':
      return '🎵'
    case 'video':
      return '🎬'
    case 'document':
      return '📄'
    default:
      return '📎'
  }
}

// Trigger file input
function triggerFileUpload() {
  if (!authStore.isAuthenticated) {
    authStore.handleTokenExpired(undefined, undefined)
    return
  }
  fileInputRef.value?.click()
}

// 上传按钮 tooltip 文案：默认沿用历史的 attachFile，调用方可自定义
const attachTooltipText = computed(() =>
  props.attachTooltipKey ? t(props.attachTooltipKey) : t('mindmate.input.attachFile')
)

// 处理文件选择：accept 已经在原生层做过过滤，这里不再硬性限制类型，
// 让 props.acceptTypes 决定允许范围（默认仍为图片）。
function handleFileSelect(event: Event) {
  if (!authStore.isAuthenticated) {
    const input = event.target as HTMLInputElement
    input.value = ''
    authStore.handleTokenExpired(undefined, undefined)
    return
  }

  const input = event.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return

  emit('upload', files)
  input.value = ''
}

// Handle keyboard
function handleKeydown(event: Event | KeyboardEvent) {
  // Type guard for KeyboardEvent
  if (!('key' in event)) return

  // Check authentication before allowing input
  if (!authStore.isAuthenticated) {
    event.preventDefault()
    authStore.handleTokenExpired(undefined, undefined)
    return
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    handleSend()
  }
}

// Handle input focus - show login modal if not authenticated
function handleInputFocus() {
  if (!authStore.isAuthenticated) {
    authStore.handleTokenExpired(undefined, undefined)
  }
}

// Handle send button click
function handleSend() {
  if (!authStore.isAuthenticated) {
    authStore.handleTokenExpired(undefined, undefined)
    return
  }
  emit('send')
}

// Handle suggestion bubble click
function handleSuggestionSelect(suggestion: string) {
  emit('update:inputText', suggestion)
  emit('suggestionSelect', suggestion)
}
</script>

<template>
  <div class="shrink-0">
    <!-- Suggestion Bubbles - Above Input (Fullpage Mode) -->
    <div
      v-if="showSuggestions && isFullpageMode"
      class="suggestions-above-input"
    >
      <SuggestionBubbles @select="handleSuggestionSelect" />
    </div>

    <!-- Suggestion Bubbles - Above Input (Panel Mode) -->
    <div
      v-if="showSuggestions && !isFullpageMode"
      class="suggestions-above-input-panel"
    >
      <SuggestionBubbles @select="handleSuggestionSelect" />
    </div>

    <!-- Input Area - Same design for fullpage and panel (MindMate module style) -->
    <div class="input-area-fullpage">
      <!-- Hidden file input -->
      <input
        id="mindmate-file-input"
        ref="fileInputRef"
        type="file"
        class="hidden"
        name="mindmate-file-input"
        :accept="acceptTypes"
        multiple
        :aria-label="attachTooltipText"
        @change="handleFileSelect"
      />

      <!-- Pending Files Preview -->
      <div
        v-if="showFileUpload && pendingFiles.length > 0"
        class="pending-files-fullpage"
      >
        <div
          v-for="file in pendingFiles"
          :key="file.id"
          class="file-chip"
        >
          <img
            v-if="file.preview_url"
            :src="file.preview_url"
            :alt="file.name"
            class="w-5 h-5 object-cover rounded"
          />
          <span v-else>{{ getFileIcon(file.type) }}</span>
          <span class="file-name">{{ file.name }}</span>
          <ElButton
            text
            circle
            size="small"
            class="file-remove-btn"
            @click="emit('removeFile', file.id)"
          >
            <ElIcon :size="12"><Close /></ElIcon>
          </ElButton>
        </div>
      </div>

      <!-- Input Container -->
      <div class="input-container-fullpage">
        <!-- Text Input -->
        <div class="input-field-fullpage">
          <ElInput
            id="mindmate-chat-input"
            :model-value="inputText"
            type="textarea"
            name="mindmate-chat-input"
            :autosize="{ minRows: 1, maxRows: 4 }"
            :placeholder="placeholder || t('mindmate.input.placeholder')"
            :disabled="isLoading || !authStore.isAuthenticated"
            :maxlength="maxlength"
            :show-word-limit="maxlength != null"
            class="fullpage-textarea"
            :aria-label="placeholder || t('mindmate.input.placeholder')"
            @update:model-value="emit('update:inputText', $event)"
            @keydown="handleKeydown"
            @focus="handleInputFocus"
          />
        </div>

        <!-- Action buttons (right side) -->
        <div class="input-actions-fullpage">
          <!-- Upload Button (Paperclip) - hidden when showFileUpload is false -->
          <ElTooltip
            v-if="showFileUpload"
            :content="attachTooltipText"
          >
            <ElButton
              text
              class="attach-btn-fullpage"
              :disabled="isLoading || isUploading || !authStore.isAuthenticated"
              @click="triggerFileUpload"
            >
              <Paperclip
                v-if="!isUploading"
                :size="20"
              />
              <span
                v-else
                class="loading-dot"
              />
            </ElButton>
          </ElTooltip>

          <!-- Send/Stop Button -->
          <ElButton
            v-if="isStreaming"
            type="danger"
            class="send-btn-fullpage stop"
            @click="emit('stop')"
          >
            <ElIcon><VideoPause /></ElIcon>
          </ElButton>
          <ElButton
            v-else
            type="primary"
            class="send-btn-fullpage"
            :disabled="isSendDisabled"
            @click="handleSend"
          >
            <Send :size="18" />
          </ElButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import './mindmate.css';
</style>
