<script setup lang="ts">
/**
 * MindMate Panel - AI assistant chat interface (ChatGPT-style)
 * Uses useMindMate composable for SSE streaming
 * Features: Markdown rendering, code highlighting, message actions, stop generation
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { useLanguage, useMindMate, useNotifications } from '@/composables'
import { extractFocusQuestionFromImages } from '@/composables/conceptMap/useConceptMapImageFocus'
import { eventBus } from '@/composables/core/useEventBus'
import type { FeedbackRating } from '@/composables/mindmate/useMindMate'
import { useConversations, usePinnedConversations } from '@/composables/queries'
import {
  CONCEPT_MAP_UPLOAD_ACCEPT,
  useAuthStore,
  useConceptMapFileUploadStore,
  useDiagramStore,
  useMindMateStore,
  useUIStore,
} from '@/stores'
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
const conceptMapFileStore = useConceptMapFileUploadStore()

/**
 * 概念图素材上传模式：仅在画布迷你 MindMate（panel 模式）+ 概念图类型下启用。
 *
 * 双投递语义：上传的文件既会作为 MindMate 聊天附件随下一条消息发出（让 MindMate
 * 立刻能看到/分析），也会同步复制到 conceptMapFileStore，作为后续"概念图生成"
 * 流程的素材库（即使 MindMate 发送时清空了聊天通道的附件，素材库依然保留）。
 */
const isConceptMapUploadMode = computed(
  () => props.mode === 'panel' && diagramStore.type === 'concept_map'
)

/** 输入框是否显示上传按钮：MindMate 全屏页保持原有逻辑；概念图画布迷你面板新增显示。 */
const showInputFileUpload = computed(() => isFullpageMode.value || isConceptMapUploadMode.value)

/** 上传按钮 accept 范围：概念图素材支持图片+常见文档；MindMate 普通聊天保持只接图片。 */
const inputAcceptTypes = computed(() =>
  isConceptMapUploadMode.value ? CONCEPT_MAP_UPLOAD_ACCEPT : 'image/*'
)

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

/**
 * 输入框下方"待发送文件"chip 列表统一来自 MindMate 聊天通道：
 * - 文件上传后立刻进入 mindMate.pendingFiles，chip 立刻显示
 * - 用户点发送时，文件作为附件随消息发给 MindMate（mindMate 内部会清空 pendingFiles）
 * - 概念图素材通道（conceptMapFileStore）在后台镜像保留，发送 MindMate 不会清空它
 */
// 概念图模式下：素材文件通道是 conceptMapFileStore（本地直传，不上 Dify），
// MindMate 聊天通道在概念图模式下是空的（避免冗余上传到 Dify 阻塞 7-60s）。
// 普通 MindMate 聊天模式：仍然走 mindMate 通道。
const inputPendingFiles = computed(() =>
  isConceptMapUploadMode.value ? conceptMapFileStore.pendingFiles : mindMate.pendingFiles.value
)

/** 输入框 loading 圈：与 inputPendingFiles 数据源对齐。 */
const inputIsUploading = computed(() =>
  isConceptMapUploadMode.value ? conceptMapFileStore.isUploading : mindMate.isUploading.value
)

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

/** 当前 pendingFiles 中是否有概念图素材（用于触发"上传文件生成概念图"分支）。 */
function getPendingUploadFileIds(): string[] {
  // 概念图模式下从素材通道（本地直传）取，普通模式从 MindMate 聊天通道取。
  const files = isConceptMapUploadMode.value
    ? conceptMapFileStore.pendingFiles
    : mindMate.pendingFiles.value
  return files.filter((f) => !!f.id).map((f) => f.id)
}

/**
 * 判断给定 fileIds 对应的待发文件是否**全部为图片**。
 * 用于决定 "正在读取……提炼焦点问题" 这条 assistant 占位消息的措辞——
 * 用户上传的可能是图片，也可能是 PDF / Word 等文档（CONCEPT_MAP_UPLOAD_ACCEPT
 * 在概念图模式下放开了文档类型）。统一显示"图片"两个字会让上传文档的用户
 * 困惑：明明传的是 PDF，提示却说在"读取图片内容"。
 *
 * 不同通道的 type 字段语义不同：
 *   - conceptMapFileStore.pendingFiles: type 是枚举 'image' | 'document' | ...
 *   - mindMate.pendingFiles: type 是 MIME 字符串（如 'image/png'）
 * 两边都兼容判断。空文件列表视为 true（落回 image 文案，与历史行为一致）。
 */
function pendingFilesAreAllImages(fileIds: string[]): boolean {
  if (!fileIds.length) return true
  const idSet = new Set(fileIds)
  if (isConceptMapUploadMode.value) {
    const matched = conceptMapFileStore.pendingFiles.filter((f) => idSet.has(f.id))
    if (!matched.length) return true
    return matched.every((f) => f.type === 'image')
  }
  const matched = mindMate.pendingFiles.value.filter((f) => idSet.has(f.id))
  if (!matched.length) return true
  return matched.every((f) => {
    // mindMate 通道里的 type 是 MIME 字符串
    const mime = typeof f.type === 'string' ? f.type : ''
    return mime.startsWith('image/')
  })
}

/**
 * 把概念图素材通道里挂载的 base64 data URL 取出来，按 file_id 顺序对齐。
 * 仅返回有 data_url 的那部分（缺失 base64 的图会回退到 Dify 反向下载兜底）。
 */
function getPendingFileDataUrlsByIds(fileIds: string[]): string[] {
  const map = new Map<string, string>()
  for (const f of conceptMapFileStore.pendingFiles) {
    if (f.data_url) map.set(f.id, f.data_url)
  }
  const out: string[] = []
  for (const fid of fileIds) {
    const url = map.get(fid)
    if (url) out.push(url)
  }
  return out
}

function getPendingFileNamesByIds(fileIds: string[]): string[] {
  const map = new Map<string, string>()
  for (const f of conceptMapFileStore.pendingFiles) {
    map.set(f.id, f.name)
  }
  return fileIds.map((fid) => map.get(fid) || fid)
}

/** 用户输入是否为"生成概念图"意图（必须明确出现"概念图"关键字）。 */
function isConceptMapGenerationIntent(message: string): boolean {
  const text = (message || '').trim()
  if (!text) return false
  return /概念图|concept[\s-]*map/i.test(text)
}

/**
 * 把图片素材通过后端 Qwen-VL 接口提炼成"问句焦点问题"，再走标准生成流程。
 *
 * 期间会推一条临时的 assistant"读图中..."消息让用户感知到等待原因。
 * 失败时占位消息会被撤掉，让上层调用方按 false 兜底走 mindMate.sendMessage，
 * 由 mindMate 自身负责 push 含附件的用户消息（避免重复 push）。
 */
async function triggerConceptMapGenerationFromImages(
  message: string,
  uploadFileIds: string[]
): Promise<boolean> {
  const fileDataUrls = getPendingFileDataUrlsByIds(uploadFileIds)
  const fileNames = getPendingFileNamesByIds(uploadFileIds)

  // 关键顺序：必须**在 detachPendingFiles() 之前**判断文件类型。
  // detachPendingFiles 会清空 conceptMapFileStore.pendingFiles，之后再调
  // pendingFilesAreAllImages 会因为找不到任何匹配文件而落到"默认 true"
  // 分支，导致即使用户上传的是 PDF/文档也被错误地识别为图片。
  const allImages = pendingFilesAreAllImages(uploadFileIds)
  const analyzingMessageKey = allImages
    ? 'conceptMapImage.analyzingImageForFocusQuestion'
    : 'conceptMapImage.analyzingFileForFocusQuestion'
  const generateOriginalMessageKey = allImages
    ? 'conceptMapImage.generateFromImageWithFocusQuestion'
    : 'conceptMapImage.generateFromFileWithFocusQuestion'
  const focusQuestionExtractFailedKey = allImages
    ? 'conceptMapImage.imageFocusQuestionExtractFailed'
    : 'conceptMapImage.fileFocusQuestionExtractFailed'

  const messageFiles = isConceptMapUploadMode.value
    ? conceptMapFileStore.detachPendingFiles()
    : [...mindMate.pendingFiles.value]
  mindMate.messages.value.push({
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: 'user',
    content: message,
    timestamp: Date.now(),
    files: messageFiles,
  })

  // 推一条临时 assistant 消息提示"读图/读文件中"，便于用户感知耗时来源；
  // 注意此处不主动 push 用户消息——失败时让 mindMate.sendMessage 完整走流程，
  // 成功时由 CanvasToolbar 触发的 'mindmate:send_message' 路径展示原话。
  const placeholderId = `assistant_pending_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  mindMate.messages.value.push({
    id: placeholderId,
    role: 'assistant',
    content: t(analyzingMessageKey),
    timestamp: Date.now(),
    isStreaming: true,
  })

  // 优先用本地 base64（避开 Dify /files/{id}/preview 在文件未参与 chat 上下文时的 404）；
  // 缺失 base64 的部分仍把 file_id 传过去，后端会兜底再尝试 Dify 下载。
  let result
  try {
    result = await extractFocusQuestionFromImages({
      fileIds: uploadFileIds,
      fileDataUrls,
      fileNames,
      userMessage: message,
      language: promptLanguage.value || 'zh',
    })
  } finally {
    // 不论成功失败都移除占位消息
    mindMate.messages.value = mindMate.messages.value.filter((m) => m.id !== placeholderId)
  }

  if (!result.success || !result.question) {
    notify.error(
      `${t(focusQuestionExtractFailedKey)}${result.error ? `: ${result.error}` : ''}`
    )
    return true
  }

  // 已成功 → 清空 chip 与概念图素材通道（图已经被消耗，避免下次重复使用）
  // 概念图模式下 mindMate.pendingFiles 本就为空，调 clearPendingFiles 也是 no-op；保留兼容。
  mindMate.clearPendingFiles()

  // 通过 eventBus 通知 CanvasToolbar：写入焦点问题框 + 触发生成。
  // originalMessage 传一段"基于图片生成"提示，仅作 fallback 兜底；
  // 因为 userMessageAlreadyShown=true，下游 silent=true，displayMessage 不会被使用。
  // imageContext 是从图片里 OCR/识别出的关键文本/术语/关系，CanvasToolbar 会
  // 把它作为「参考素材」段拼到生成 prompt 末尾，让 LLM 优先基于图片实际内容
  // 组织节点；图里没有的方面再用模型常识补充。
  // userMessageAlreadyShown=true：上面已经手动 push 了一条 user 气泡（原话+files），
  // 让 useMindMate 在收到 'mindmate:send_message' 时不再重复 push 第二条气泡。
  eventBus.emit('concept_map:focus_question_generation_requested', {
    question: result.question,
    originalMessage: t(generateOriginalMessageKey, {
      question: result.question,
    }),
    imageContext: (result.imageContent || '').trim() || undefined,
    userMessageAlreadyShown: true,
  })
  return true
}

/**
 * 在画布的迷你 MindMate 面板里，若识别到"生成概念图"意图，
 * 则把焦点问题写入画布顶部的"焦点问题"框，并触发已有的生成流程。
 *
 * 优先级：
 *   1) 当前 pendingFiles 里有图片 → 调 Qwen-VL 提取问句式焦点问题
 *   2) 否则按用户输入做"焦点问题"剥离（原有逻辑）
 *
 * @returns 是否成功拦截并触发生成（true 时调用方应跳过普通的发送逻辑）
 */
async function tryTriggerConceptMapGeneration(message: string): Promise<boolean> {
  // 只在画布的迷你 MindMate（panel 模式）+ 概念图类型下生效；
  // 在独立的 MindMate 全屏页（fullpage 模式）保持原有问答行为。
  if (props.mode !== 'panel') return false
  if (diagramStore.type !== 'concept_map') return false

  // 必须明确提到"概念图"关键字，避免误判
  if (!isConceptMapGenerationIntent(message)) return false

  // 分支 A：当前有图片 → 走"图片提取焦点问题"流程
  const uploadFileIds = getPendingUploadFileIds()
  if (uploadFileIds.length > 0) {
    const ok = await triggerConceptMapGenerationFromImages(message, uploadFileIds)
    if (ok) return true
    // 图片提取失败 → 不再尝试文字解析路径，让消息原样发给 MindMate（避免误生成）
    return false
  }

  // 分支 B：无图片 → 按文字意图剥离焦点问题
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
  if ((!inputText.value.trim() && inputPendingFiles.value.length === 0) || isLoading.value)
    return

  const message = inputText.value.trim()
  inputText.value = ''

  // 识别"根据焦点问题生成概念图"意图：先把焦点问题写入画布顶部，再触发生成流程
  if (await tryTriggerConceptMapGeneration(message)) {
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

// 处理文件选择：
// - 普通 MindMate：仅上传到 MindMate 聊天通道（与历史行为一致）。
// - 概念图模式：**完全跳过 Dify 上传**（避免 242KB ~ 7s、1MB ~ 60s 的跨境网络等待）。
//   走 conceptMapFileStore.addLocalFile：浏览器本地读 base64 + 即时显示缩略图（< 200ms），
//   id 用 `local_<rand>` 与真 Dify file id 区分。后续概念图生成完全走 base64 通道
//   （concept_map_image_focus.py 第 339-355 行的 images_base64 优先逻辑），
//   不依赖 Dify file_id。
// - 普通 MindMate 聊天模式：保持原行为，上传到 Dify 拿 file_id（聊天附件需要它）。
async function handleFileSelect(files: FileList) {
  if (!files || files.length === 0) return

  for (const file of Array.from(files)) {
    if (isConceptMapUploadMode.value) {
      await conceptMapFileStore.addLocalFile(file)
    } else {
      await mindMate.uploadFile(file)
    }
  }
}

// 移除待用文件：根据当前模式从对应通道删除。
function handleRemoveFile(fileId: string) {
  if (isConceptMapUploadMode.value) {
    conceptMapFileStore.removeFile(fileId)
  } else {
    mindMate.removeFile(fileId)
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
        :is-uploading="inputIsUploading"
        :pending-files="inputPendingFiles"
        :show-suggestions="showWelcome"
        :show-file-upload="showInputFileUpload"
        :accept-types="inputAcceptTypes"
        @send="sendMessage"
        @stop="stopGeneration"
        @upload="handleFileSelect"
        @remove-file="handleRemoveFile"
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
