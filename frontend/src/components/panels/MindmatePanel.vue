<script setup lang="ts">
/**
 * MindMate Panel - AI assistant chat interface (ChatGPT-style)
 * Uses useMindMate composable for SSE streaming
 * Features: Markdown rendering, code highlighting, message actions, stop generation
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { useLanguage, useMindMate, useNotifications } from '@/composables'
import { eventBus } from '@/composables/core/useEventBus'
import type { FeedbackRating } from '@/composables/mindmate/useMindMate'
import { useConversations, usePinnedConversations } from '@/composables/queries'
import { useAuthStore, useDiagramStore, useMindMateStore, useUIStore } from '@/stores'
import { stripAnyFocusQuestionLabel } from '@/stores/diagram/diagramDefaultLabels'

import ShareExportModal from './ShareExportModal.vue'
import ConversationHistory from './mindmate/ConversationHistory.vue'
import MindmateHeader from './mindmate/MindmateHeader.vue'
import MindmateInput from './mindmate/MindmateInput.vue'
import MindmateMessages from './mindmate/MindmateMessages.vue'

// Props for different display modes
const props = withDefaults(
  defineProps<{
    mode?: 'panel' | 'fullpage'
  }>(),
  {
    mode: 'panel',
  }
)

const emit = defineEmits<{
  (e: 'close'): void
}>()

// Computed for mode checks
const isFullpageMode = computed(() => props.mode === 'fullpage')

const route = useRoute()
const uiStore = useUIStore()

/** Simplified UI: chat list is in AppSidebar; hide redundant header drawer + menu. */
const hideHistoryToggle = computed(
  () =>
    uiStore.uiVersion === 'international' &&
    isFullpageMode.value &&
    route.path.startsWith('/mindmate')
)

const { promptLanguage, t } = useLanguage()
const notify = useNotifications()
const authStore = useAuthStore()
const mindMateStore = useMindMateStore()
const diagramStore = useDiagramStore()

// Typing effect state
const displayTitle = ref('MindMate')
const isTypingTitle = ref(false)

// Use MindMate composable for SSE streaming
const mindMate = useMindMate({
  language: promptLanguage.value,
  onError: (error) => {
    notify.error(error)
  },
  onTitleChanged: (title, oldTitle) => {
    animateTitleChange(title, oldTitle)
  },
})

// Local state
const inputText = ref('')
const editingMessageId = ref<string | null>(null)
const editingContent = ref('')
const hoveredMessageId = ref<string | null>(null)
const showHistorySidebar = ref(false)
const showShareModal = ref(false)

// Computed for loading state
const isLoading = computed(() => mindMate.isLoading.value || mindMate.isStreaming.value)

// User avatar from auth store
const userAvatar = computed(() => {
  const avatar = authStore.user?.avatar || '👤'
  if (avatar.startsWith('avatar_')) {
    return '👤'
  }
  return avatar
})

// Check if welcome message should be shown
const showWelcome = computed(() => {
  return !mindMate.hasMessages.value && !mindMate.isLoading.value && !mindMate.isStreaming.value
})

// In panel mode (canvas mini-mindmate): fetch conversations from Dify and sync to store
// ChatHistory sidebar is not mounted on canvas, so we must fetch here
const { data: conversationsData, isLoading: isLoadingConversationsQuery } = useConversations()
const { data: pinnedData } = usePinnedConversations()

const historyLoading = computed(() =>
  props.mode === 'panel' ? isLoadingConversationsQuery.value : mindMate.isLoadingConversations.value
)

watch(
  [conversationsData, pinnedData],
  ([convs, pinned]) => {
    if (convs && pinned !== undefined) {
      mindMateStore.syncConversationsFromQuery(convs, pinned)
    }
  },
  { immediate: true }
)

// Watch for title changes to sync display (from store)
watch(
  () => mindMateStore.conversationTitle,
  (newTitle) => {
    if (!isTypingTitle.value && newTitle !== displayTitle.value) {
      displayTitle.value = newTitle
    }
  }
)

// Typing animation for title changes
async function animateTitleChange(newTitle: string, oldTitle?: string) {
  if (isTypingTitle.value) return
  isTypingTitle.value = true

  // Use provided oldTitle or current displayTitle
  const currentTitle = oldTitle ?? displayTitle.value

  // Clear old title character by character
  for (let i = currentTitle.length; i >= 0; i--) {
    displayTitle.value = currentTitle.substring(0, i)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  // Type new title character by character
  for (let i = 0; i <= newTitle.length; i++) {
    displayTitle.value = newTitle.substring(0, i)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }

  isTypingTitle.value = false
}

// Toggle history sidebar
function toggleHistorySidebar() {
  showHistorySidebar.value = !showHistorySidebar.value
  // No need to fetch - Vue Query handles it automatically
}

// Start a new conversation
function startNewConversation() {
  if (!authStore.isAuthenticated) {
    authStore.handleTokenExpired(undefined, undefined)
    return
  }
  mindMate.startNewConversation()
  displayTitle.value = 'MindMate'
}

// Load a conversation from history
async function loadConversationFromHistory(convId: string) {
  await mindMate.loadConversation(convId)
  showHistorySidebar.value = false
}

// Delete a conversation
async function deleteConversationFromHistory(convId: string) {
  const success = await mindMate.deleteConversation(convId)
  if (success) {
    notify.success(t('notification.conversationDeleted'))
  } else {
    notify.error(t('notification.deleteFailed'))
  }
}

/**
 * 用户输入里"包裹焦点问题"的常见引号字符集合（中英文 / 单双引号 / 直角引号）。
 * 用于优先策略：当用户写 `请帮我生成焦点问题为"光合作用"的概念图` 时，
 * 引号内才是真正的焦点问题，绕开复杂的模板剥离。
 */
const QUOTE_OPEN_CLOSE_CLASS = '[\\u201c\\u201d\\u2018\\u2019\\u300c\\u300d\\u300e\\u300f"\']'

/**
 * 识别用户输入是否为"根据焦点问题生成概念图"的意图。
 * 仅当输入中明确包含"概念图 / concept map"关键词时才视为命中，
 * 防止把普通问答误判成生成请求。
 *
 * 命中后返回提取出的纯焦点问题（不带任何"焦点问题/Focus question"标签
 * 和命令性短语）；未命中或无法提取出有效焦点问题时返回 null。
 */
function extractFocusQuestionFromIntent(input: string): string | null {
  const text = input.trim()
  if (!text) return null

  // 必须明确提到"概念图 / concept map"才算"生成概念图"意图
  if (!/概念图|concept[\s-]*map/i.test(text)) return null

  // ──────────────────────────────────────────────────────────────────
  // 策略 1：优先匹配引号包裹的内容。覆盖 99% 的"请生成焦点问题为'xxx'的概念图"
  //   写法，能避开"焦点问题为""的"等连接词的复杂剥离逻辑。
  // ──────────────────────────────────────────────────────────────────
  const quotedRegex = new RegExp(
    `${QUOTE_OPEN_CLOSE_CLASS}([^${QUOTE_OPEN_CLOSE_CLASS.slice(1, -1)}]{2,})${QUOTE_OPEN_CLOSE_CLASS}`,
    'u'
  )
  const quotedMatch = text.match(quotedRegex)
  if (quotedMatch && quotedMatch[1]) {
    const inside = quotedMatch[1].trim()
    const cleaned = stripAnyFocusQuestionLabel(inside).trim()
    if (cleaned.length >= 2) return cleaned
    if (inside.length >= 2) return inside
  }

  // ──────────────────────────────────────────────────────────────────
  // 策略 2：无引号时，按顺序剥离常见模板。
  // ──────────────────────────────────────────────────────────────────
  let q = text
    // 礼貌语 / 命令前缀
    .replace(/^(请|麻烦|帮我|帮忙|劳烦|请你|please|help me|can you|could you)[\s,，:：]*/giu, '')
    // "生成 / 制作 / generate" 等动词（含可选量词、可选介词"关于/为"等）
    .replace(
      /(生成|制作|绘制|画出|画|创建|创作|做出|做|产生|帮做|generate|create|draw|make|build)[\s]*(一个|个|一张|张|一幅|幅|a|an|the)?[\s]*(关于|针对|基于|围绕|对于|对|为|of|for|about|on|regarding)?/giu,
      ' '
    )
    // ★ 关键：剥离"焦点问题为/是/的/:" 等模板（无论中英冒号）
    .replace(
      /(焦点问题|焦點問題|focus[\s-]*question)[\s\u00a0]*(为|是|的|:|：)?[\s\u00a0]*/giu,
      ' '
    )
    // "概念图"关键词（含可能的前置"的/一张/一幅"）
    .replace(/(的|关于)?(一个|个|一张|张|一幅|幅)?[\s]*(概念图|concept[\s-]*map)/giu, ' ')
    // 残留的纯介词
    .replace(/(关于|针对|基于|围绕|对于|对|以|为|of|for|about|on|regarding)/giu, ' ')
    // 清理首尾的引号 / 标点 / 空白
    .replace(/^[\s\u00a0\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f"'，,。.;；:：、！!？?]+/u, '')
    .replace(/[\s\u00a0\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f"'，,。.;；:：、]+$/u, '')
    // 末尾的"的"（如 "...的概念图" 剥完概念图后还会留个"的"）
    .replace(/的$/u, '')
    .replace(/\s+/g, ' ')
    .trim()

  // 最终再走一次强力剥离，处理任何遗漏的"焦点问题"标签
  q = stripAnyFocusQuestionLabel(q).trim()

  // 兜底：完全剥不出来时，回退到"原文剔除关键词后剩余的内容"
  if (!q || q.length < 2) {
    const fallback = stripAnyFocusQuestionLabel(
      text
        .replace(/(概念图|concept[\s-]*map)/giu, '')
        .replace(
          /[\s\u00a0\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f"'，,。.;；:：、！!？?]+/g,
          ' '
        )
        .trim()
    ).trim()
    return fallback.length >= 2 ? fallback : null
  }

  return q
}

/**
 * 在画布的迷你 MindMate 面板里，若识别到"生成概念图"意图，
 * 则把用户给的焦点问题写入画布顶部的"焦点问题"框，并触发已有的生成流程。
 *
 * @returns 是否成功拦截并触发生成（true 时调用方应跳过普通的发送逻辑）
 */
function tryTriggerConceptMapGeneration(message: string): boolean {
  // 只在画布的迷你 MindMate（panel 模式）+ 概念图类型下生效；
  // 在独立的 MindMate 全屏页（fullpage 模式）保持原有问答行为。
  if (props.mode !== 'panel') return false
  if (diagramStore.type !== 'concept_map') return false

  const question = extractFocusQuestionFromIntent(message)
  if (!question) return false

  // 把"用户原话"通过 originalMessage 字段透传给 CanvasToolbar，
  // CanvasToolbar 在调用 handleDiagramGeneration 时会用它覆盖 displayMessage，
  // 让聊天历史里展示的就是用户实际输入的句子，而不是 i18n 固定模板。
  // 也因此不需要在这里手动 push 一条用户消息——避免聊天里出现两条重复消息。
  eventBus.emit('concept_map:focus_question_generation_requested', {
    question,
    originalMessage: message,
  })
  return true
}

// Send message using composable
async function sendMessage() {
  if ((!inputText.value.trim() && mindMate.pendingFiles.value.length === 0) || isLoading.value)
    return

  const message = inputText.value.trim()
  inputText.value = ''

  // 识别"根据焦点问题生成概念图"意图：先把焦点问题写入画布顶部，再触发生成流程
  if (tryTriggerConceptMapGeneration(message)) {
    return
  }

  await mindMate.sendMessage(message)
}

// Handle suggestion bubble click
function handleSuggestionSelect(suggestion: string) {
  inputText.value = suggestion
  // Focus the input and optionally send immediately
  nextTick(() => {
    sendMessage()
  })
}

// Handle file selection
async function handleFileSelect(files: FileList) {
  if (!files || files.length === 0) return

  for (const file of Array.from(files)) {
    await mindMate.uploadFile(file)
  }
}

// Stop generation
function stopGeneration() {
  mindMate.stopGeneration()
}

// Copy message to clipboard
async function copyMessage(content: string) {
  try {
    await navigator.clipboard.writeText(content)
    notify.success(t('notification.copied'))
  } catch {
    notify.error(t('notification.copyFailed'))
  }
}

// Regenerate message
function regenerateMessage(messageId: string) {
  mindMate.regenerateMessage(messageId)
}

// Handle like/dislike feedback
async function handleFeedback(messageId: string, rating: FeedbackRating) {
  const message = mindMate.messages.value.find((m) => m.id === messageId)
  if (!message) return

  // Toggle if same rating clicked again
  const newRating = message.feedback === rating ? null : rating

  const success = await mindMate.submitFeedback(messageId, newRating)
  if (success) {
    notify.success(
      newRating === 'like'
        ? t('notification.feedbackThanks')
        : newRating === 'dislike'
          ? t('notification.feedbackThanksDislike')
          : t('notification.feedbackCancelled')
    )
  }
}

// Open share modal
function openShareModal() {
  showShareModal.value = true
}

// Start editing message
function startEdit(message: { id: string; content: string }) {
  editingMessageId.value = message.id
  editingContent.value = message.content
}

// Cancel editing
function cancelEdit() {
  editingMessageId.value = null
  editingContent.value = ''
}

// Save edited message
async function saveEdit(content: string) {
  if (!editingMessageId.value || !content.trim()) {
    cancelEdit()
    return
  }

  const messageId = editingMessageId.value
  editingMessageId.value = null
  editingContent.value = ''

  // Remove the edited user message and resend
  const msgIndex = mindMate.messages.value.findIndex((m) => m.id === messageId)
  if (msgIndex !== -1) {
    mindMate.messages.value = mindMate.messages.value.slice(0, msgIndex)
  }

  await mindMate.sendMessage(content, false)
}

// Get previous user message for regeneration context
function hasPreviousUserMessage(messageId: string): boolean {
  const msgIndex = mindMate.messages.value.findIndex((m) => m.id === messageId)
  if (msgIndex <= 0) return false

  for (let i = msgIndex - 1; i >= 0; i--) {
    if (mindMate.messages.value[i].role === 'user') {
      return true
    }
  }
  return false
}

// Check if a message is the last assistant message
function isLastAssistantMessage(messageId: string): boolean {
  const assistantMessages = mindMate.messages.value.filter((m) => m.role === 'assistant')
  if (assistantMessages.length === 0) return false
  return assistantMessages[assistantMessages.length - 1].id === messageId
}
</script>

<template>
  <div
    class="mindmate-panel bg-white dark:bg-gray-800 flex flex-col h-full overflow-hidden"
    :class="{
      'border-l border-gray-200 dark:border-gray-700 shadow-lg': !isFullpageMode,
      'panel-mode': !isFullpageMode,
      'welcome-mode': showWelcome,
    }"
  >
    <!-- Header -->
    <MindmateHeader
      :mode="mode"
      :title="displayTitle"
      :is-typing="isTypingTitle"
      :is-authenticated="authStore.isAuthenticated"
      :hide-history-toggle="hideHistoryToggle"
      :conversations="mindMate.conversations.value"
      :is-loading-history="historyLoading"
      :current-conversation-id="mindMateStore.currentConversationId"
      @toggle-history="toggleHistorySidebar"
      @new-conversation="startNewConversation"
      @close="emit('close')"
      @load-history="loadConversationFromHistory"
      @delete-history="deleteConversationFromHistory"
    />

    <!-- Conversation History Drawer - fullpage when sidebar does not list chats -->
    <ConversationHistory
      v-if="isFullpageMode && !hideHistoryToggle"
      v-model:visible="showHistorySidebar"
      :conversations="mindMate.conversations.value"
      :is-loading="historyLoading"
      :current-conversation-id="mindMateStore.currentConversationId"
      @load="loadConversationFromHistory"
      @delete="deleteConversationFromHistory"
    />

    <!-- Messages -->
    <MindmateMessages
      :mode="mode"
      :messages="mindMate.messages.value"
      :user-avatar="userAvatar"
      :show-welcome="showWelcome"
      :is-loading="mindMate.isLoading.value"
      :is-streaming="mindMate.isStreaming.value"
      :is-loading-history="mindMate.isLoadingHistory.value"
      :editing-message-id="editingMessageId"
      :editing-content="editingContent"
      :hovered-message-id="hoveredMessageId"
      :is-last-assistant-message="isLastAssistantMessage"
      :has-previous-user-message="hasPreviousUserMessage"
      @edit="startEdit"
      @cancel-edit="cancelEdit"
      @save-edit="saveEdit"
      @copy="copyMessage"
      @regenerate="regenerateMessage"
      @feedback="handleFeedback"
      @share="openShareModal"
      @message-hover="hoveredMessageId = $event"
    />

    <!-- Input Area - wrapper pins to bottom in panel mode -->
    <div class="mindmate-input-section">
      <MindmateInput
        v-model:input-text="inputText"
        :mode="mode"
        :is-loading="isLoading"
        :is-streaming="mindMate.isStreaming.value"
        :is-uploading="mindMate.isUploading.value"
        :pending-files="mindMate.pendingFiles.value"
        :show-suggestions="showWelcome"
        :show-file-upload="isFullpageMode"
        @send="sendMessage"
        @stop="stopGeneration"
        @upload="handleFileSelect"
        @remove-file="mindMate.removeFile"
        @suggestion-select="handleSuggestionSelect"
      />
    </div>

    <!-- Share Export Modal -->
    <ShareExportModal
      v-model:visible="showShareModal"
      :messages="mindMate.messages.value"
      :conversation-title="mindMate.conversationTitle.value"
    />
  </div>
</template>

<style scoped>
@import './mindmate/mindmate.css';
</style>
