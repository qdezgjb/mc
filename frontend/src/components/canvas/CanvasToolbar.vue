<script setup lang="ts">
/**
 * CanvasToolbar - Floating toolbar for canvas editing
 */
import { computed, nextTick, ref } from 'vue'

import { ElButton, ElTooltip } from 'element-plus'

import { ArrowDownUp, Brush } from 'lucide-vue-next'

import { useCanvasToolbarApps, useCanvasToolbarFormatting } from '@/composables/canvasToolbar'
import { joinLabelAndMathSnippet } from '@/composables/core/markdownKatexDelimiter'
import { eventBus } from '@/composables/core/useEventBus'
import { useLanguage } from '@/composables/core/useLanguage'
import { useNotifications } from '@/composables/core/useNotifications'
import { useNodeActions } from '@/composables/editor/useNodeActions'
import { useDiagramStore, usePanelsStore, useUIStore } from '@/stores'
import {
  isDefaultFocusQuestionLabel,
  shouldReplaceLabelWithMathInsert,
  stripConceptMapFocusQuestionPrefix,
} from '@/stores/diagram/diagramDefaultLabels'
import {
  computeHierarchyLayout,
  extractRootFromFocusQuestion,
  parseDiagramGenerationResponse,
} from '@/utils/conceptMapExtraction'

import CanvasMathInsertDialog from './CanvasMathInsertDialog.vue'
import CanvasToolbarAddDelete from './CanvasToolbarAddDelete.vue'
import CanvasToolbarAiSection from './CanvasToolbarAiSection.vue'
import CanvasToolbarBackgroundDropdown from './CanvasToolbarBackgroundDropdown.vue'
import CanvasToolbarBorderDropdown from './CanvasToolbarBorderDropdown.vue'
import CanvasToolbarMoreAppsDropdown from './CanvasToolbarMoreAppsDropdown.vue'
import CanvasToolbarStyleDropdown from './CanvasToolbarStyleDropdown.vue'
import CanvasToolbarTextDropdown from './CanvasToolbarTextDropdown.vue'
import CanvasToolbarUndoRedo from './CanvasToolbarUndoRedo.vue'
import CanvasVirtualKeyboardPanel from './CanvasVirtualKeyboardPanel.vue'

/**
 * When true, flatter styles for use inside CanvasTopBar (single merged chrome row).
 * When embedded, `compactToolbar` is driven by CanvasTopBar (two-tier bar width breakpoints).
 */
const props = withDefaults(defineProps<{ embedded?: boolean; compactToolbar?: boolean }>(), {
  embedded: false,
  compactToolbar: false,
})

const { t } = useLanguage()
const notify = useNotifications()

const diagramStore = useDiagramStore()
const uiStore = useUIStore()
const panelsStore = usePanelsStore()

const { handleAddNode, handleDeleteNode, handleAddCause, handleAddEffect } = useNodeActions({
  addNodePrimaryBehavior: 'toolbarPrimary',
  includeTreeMapPrimaryAdd: false,
  includeMultiFlowPrimaryAdd: false,
})

const formatting = useCanvasToolbarFormatting()
const {
  formatBrushActive,
  stylePresets,
  fontFamily,
  fontSize,
  textColor,
  fontWeight,
  fontStyle,
  textDecoration,
  textAlign,
  textColorPalette,
  backgroundColors,
  borderColor,
  borderColorPalette,
  borderWidth,
  borderStyle,
  borderStyleOptions,
  getBorderPreviewStyle,
  handleApplyStylePreset,
  applyBackgroundToSelected,
  applyBorderToSelected,
  handleToggleBold,
  handleToggleItalic,
  handleToggleUnderline,
  handleToggleStrikethrough,
  handleTextAlign,
  handleFontFamilyChange,
  handleFontSizeInput,
  handleTextColorPick,
  handleFormatBrush,
} = formatting
const backgroundOpacity = formatting.backgroundOpacity

function onBackgroundOpacityInput(v: number) {
  backgroundOpacity.value = v
}

const {
  aiBlockedByCollab,
  isAIGenerating,
  isConceptMap,
  moreApps,
  virtualKeyboardOpen,
  handleAIGenerate,
  handleConceptGeneration,
  handleMoreAppItem,
} = useCanvasToolbarApps()

const isMultiFlowMap = computed(() => diagramStore.type === 'multi_flow_map')
const isBridgeMap = computed(() => diagramStore.type === 'bridge_map')
const isFlowMap = computed(() => diagramStore.type === 'flow_map')

const mathInsertDialogOpen = ref(false)

const insertEquationEnabled = computed(() => diagramStore.selectedNodes.length > 0)

function normalizeFocusQuestion(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (isDefaultFocusQuestionLabel(trimmed)) return ''
  // 无论 spec 还是节点文本，都统一剥离"焦点问题："前缀
  const stripped = stripConceptMapFocusQuestionPrefix(trimmed)
  return stripped.trim()
}

function resolveFocusQuestion(): string {
  const data = diagramStore.data as Record<string, unknown> | undefined
  const rawSpec = typeof data?.focus_question === 'string' ? (data.focus_question as string) : ''

  // 先从 spec.focus_question 读取
  let question = normalizeFocusQuestion(rawSpec)

  // 若 spec 为空或为默认占位，尝试从 topic / focus_question 节点的文本读取
  if (!question) {
    const topicNode = diagramStore.data?.nodes?.find(
      (n) => n.id === 'topic' || n.id === 'focus_question' || n.type === 'topic'
    )
    question = normalizeFocusQuestion(topicNode?.text ?? '')
  }

  return question
}

function clearConceptMapExceptFocusQuestion(): void {
  const data = diagramStore.data
  if (!data) return

  // 保留焦点问题（topic）节点，删除其他所有节点
  if (Array.isArray(data.nodes)) {
    for (let i = data.nodes.length - 1; i >= 0; i--) {
      const n = data.nodes[i]
      const isTopic = n.type === 'topic' || n.type === 'center' || n.id === 'topic'
      if (!isTopic) {
        data.nodes.splice(i, 1)
      }
    }
  }

  // 清空所有连线
  if (Array.isArray(data.connections)) {
    data.connections.splice(0, data.connections.length)
  }

  // 清空选择状态，避免残留引用已删节点的选择
  diagramStore.clearSelection?.()
  diagramStore.clearEdgeSelection?.()
}

/**
 * 将根节点、各方面节点、以及各方面下的名词节点，按照 "焦点(顶) → 根 → 方面 → 名词(底)"
 * 的层级自上而下依次写入概念图；节点一个一个生成，每完成一层（换行）自动触发一次画布
 * 自适应，使视口始终完整展示所有已生成节点。
 *
 * @param rootText 根节点文本
 * @param answer   大模型最终回答的完整文本；为空时只添加根节点
 */
async function buildConceptHierarchyFromAnswer(
  rootText: string,
  answer: string
): Promise<void> {
  if (diagramStore.type !== 'concept_map') return
  if (!diagramStore.data?.nodes || !rootText) return

  const topicNode = diagramStore.data.nodes.find(
    (n) => n.id === 'topic' || n.type === 'topic' || n.type === 'center'
  )
  const topicPos = topicNode?.position ?? { x: 340, y: 40 }
  // 优先使用实际渲染测得的宽度，退而使用 style.width / data.width，最后兜底 180
  const measured = topicNode?.id ? diagramStore.nodeDimensions?.[topicNode.id] : undefined
  const topicWidth =
    measured?.width ??
    (topicNode?.style?.width as number | undefined) ??
    (topicNode?.data as { width?: number } | undefined)?.width ??
    180

  const parsed = parseDiagramGenerationResponse(answer ?? '')
  const layout = computeHierarchyLayout({
    topicX: topicPos.x,
    topicY: topicPos.y,
    topicWidth,
    rootText,
    aspects: parsed.aspects,
  })

  const removeNodeAndEdges = (nodeId: string) => {
    if (!diagramStore.data) return
    const idx = diagramStore.data.nodes?.findIndex((n) => n.id === nodeId) ?? -1
    if (idx >= 0) diagramStore.data.nodes!.splice(idx, 1)
    if (Array.isArray(diagramStore.data.connections)) {
      for (let i = diagramStore.data.connections.length - 1; i >= 0; i--) {
        const c = diagramStore.data.connections[i]
        if (c.source === nodeId || c.target === nodeId) {
          diagramStore.data.connections.splice(i, 1)
        }
      }
    }
  }
  removeNodeAndEdges('root')

  // 按层分组，实现从上到下的"逐层、逐个"生成
  const byLevel: Record<1 | 2 | 3 | 4, typeof layout.nodes> = { 1: [], 2: [], 3: [], 4: [] }
  for (const n of layout.nodes) {
    byLevel[n.level].push(n)
  }

  // 目标节点 id -> 其入边列表（每个节点只会有一条入边）
  const edgesByTarget: Record<string, { source: string; target: string; label?: string }> = {}
  for (const e of layout.edges) edgesByTarget[e.target] = e

  const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))
  const PER_NODE_DELAY = 400 // 同层相邻节点的出现间隔
  const LEVEL_SETTLE_DELAY = 450 // 一层绘制完成后等待 DOM 稳定再自适应
  const FIT_ANIM_WAIT = 500 // 等待自适应动画完成，避免与下一层重叠

  for (const level of [1, 2, 3, 4] as const) {
    const nodes = byLevel[level]
    if (!nodes || nodes.length === 0) continue

    for (const layoutNode of nodes) {
      if (diagramStore.type !== 'concept_map') return
      removeNodeAndEdges(layoutNode.id)
      diagramStore.addNode({
        id: layoutNode.id,
        text: layoutNode.text,
        type: 'branch',
        position: layoutNode.position,
      })
      // 紧随其后，把通向该节点的父子边补上；
      // level-3 → level-4 的边会带上连接词（动词）作为 label，
      // 这样第 4 层节点里只放纯名词性内容，动词出现在连线上。
      const incoming = edgesByTarget[layoutNode.id]
      if (incoming) {
        diagramStore.addConnection(incoming.source, incoming.target, incoming.label)
      }
      await sleep(PER_NODE_DELAY)
    }

    // 每完成一层（相当于"换行"），等 DOM 布局稳定后触发画布自适应，
    // 让新出现的一行节点与之前的节点整体缩放，完整展示在可视区内。
    // maxZoom=1 可避免内容较少时 fitView 把视图放大到 400%。
    await sleep(LEVEL_SETTLE_DELAY)
    eventBus.emit('view:fit_to_canvas_requested', { animate: true, maxZoom: 1 })
    await sleep(FIT_ANIM_WAIT)
  }

  // 最终再做一次自适应，确保所有节点完整展示（兜底）
  eventBus.emit('view:fit_to_canvas_requested', { animate: true, maxZoom: 1 })
}

async function handleDiagramGeneration(): Promise<void> {
  if (!isConceptMap.value) return

  const question = resolveFocusQuestion()
  if (!question) {
    notify.warning(t('canvas.toolbar.diagramGenerationNoFocus'))
    return
  }

  const prompt = t('canvas.toolbar.diagramGenerationPrompt', { question })
  const displayMessage = t('canvas.toolbar.diagramGenerationDisplay', { question })

  // 清空现有的根节点/概念节点/连线，只保留焦点问题框
  clearConceptMapExceptFocusQuestion()
  diagramStore.pushHistory(t('canvas.toolbar.diagramGeneration'))

  // 根节点关键词（从焦点问题提取，作为层级结构中的第一层）
  const rootText = extractRootFromFocusQuestion(question)

  // 注册一次性监听：message_completed / error / 超时 三者先到先触发
  // 无论成功、失败还是超时，都尝试把层级节点补上
  let finalizeTriggered = false
  const unsubscribers: Array<() => void> = []
  let fallbackTimer: number | null = null
  let finalAnswer = ''

  const finalize = async () => {
    if (finalizeTriggered) return
    finalizeTriggered = true
    unsubscribers.forEach((fn) => {
      try {
        fn()
      } catch {
        void 0
      }
    })
    if (fallbackTimer !== null) {
      window.clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
    if (diagramStore.type !== 'concept_map') return
    // 生成前先做一次自适应，从当前的高倍缩放（如 400%）回到合适的视口
    eventBus.emit('view:fit_to_canvas_requested', { animate: true, maxZoom: 1 })
    await buildConceptHierarchyFromAnswer(rootText, finalAnswer)
    diagramStore.pushHistory(t('canvas.toolbar.diagramGeneration'))
  }

  unsubscribers.push(
    eventBus.on('mindmate:message_completed', (payload) => {
      finalAnswer = (payload?.answer ?? '').trim()
      finalize()
    })
  )
  unsubscribers.push(eventBus.on('mindmate:error', () => finalize()))
  unsubscribers.push(eventBus.on('mindmate:stream_error', () => finalize()))
  // 兜底：最多等待 90 秒，防止事件因各种原因未到达
  fallbackTimer = window.setTimeout(finalize, 90_000)

  // 打开教学设计（MindMate）面板
  if (!panelsStore.mindmatePanel.isOpen) {
    panelsStore.openMindmate()
  }

  // 等待 MindmatePanel 挂载、useMindMate 注册事件监听后再 emit
  await nextTick()
  await nextTick()

  // message 为实际发送给 Dify 的完整提示词；displayMessage 为聊天界面展示的简短文本
  eventBus.emit('mindmate:send_message', { message: prompt, displayMessage })
}

function handleOpenMathInsert(): void {
  if (diagramStore.selectedNodes.length === 0) {
    notify.warning(t('canvas.toolbar.insertEquationSelectNode'))
    return
  }
  mathInsertDialogOpen.value = true
}

function handleMathInsertConfirm(latex: string): void {
  const trimmed = latex.trim()
  if (!trimmed) return
  const nodeId = diagramStore.selectedNodes[0]
  if (!nodeId) return
  const snippet = `$${trimmed}$`
  let consumed = false
  const unsub = eventBus.on('node_editor:insert_text_consumed', ({ nodeId: id }) => {
    if (id === nodeId) consumed = true
  })
  eventBus.emit('node_editor:insert_text', { nodeId, snippet })
  unsub()
  if (!consumed) {
    const node = diagramStore.data?.nodes?.find((n) => n.id === nodeId)
    const base = String(node?.text ?? (node?.data as { label?: string } | undefined)?.label ?? '')
    const nextText =
      diagramStore.type && shouldReplaceLabelWithMathInsert(diagramStore.type, nodeId, base)
        ? snippet
        : joinLabelAndMathSnippet(base, snippet)
    eventBus.emit('node:text_updated', { nodeId, text: nextText })
  }
}

function handleUndo() {
  diagramStore.undo()
}

function handleRedo() {
  diagramStore.redo()
}

function handleToggleOrientation() {
  diagramStore.toggleFlowMapOrientation()
  notify.success(t('canvas.toolbar.layoutDirectionToggled'))
}
</script>

<template>
  <div
    class="canvas-toolbar relative z-10 w-full flex justify-center"
    :class="props.embedded ? 'max-w-none' : 'max-w-[min(100vw-1rem,1200px)]'"
  >
    <div
      class="flex items-center justify-center w-full min-w-0 overflow-x-auto"
      :class="
        props.embedded
          ? 'rounded-lg p-1 bg-transparent'
          : 'rounded-xl shadow-lg p-1.5 border border-gray-200/80 dark:border-gray-600/80 bg-white/90 dark:bg-gray-800/90 backdrop-blur-md'
      "
    >
      <div
        class="toolbar-content flex items-center bg-gray-50 dark:bg-gray-700/50 rounded-lg p-1 gap-0.5 min-w-min"
      >
        <CanvasToolbarUndoRedo
          :can-undo="diagramStore.canUndo"
          :can-redo="diagramStore.canRedo"
          :undo-label="t('canvas.toolbar.undo')"
          :redo-label="t('canvas.toolbar.redo')"
          @undo="handleUndo"
          @redo="handleRedo"
        />

        <div class="divider" />

        <CanvasToolbarAddDelete
          :compact="compactToolbar"
          :is-multi-flow-map="isMultiFlowMap"
          :is-bridge-map="isBridgeMap"
          :add-cause-label="t('canvas.toolbar.addCause')"
          :add-effect-label="t('canvas.toolbar.addEffect')"
          :add-analogy-pair-label="t('canvas.toolbar.addAnalogyPair')"
          :add-pair-short="t('canvas.toolbar.addPairShort')"
          :add-node-label="t('canvas.toolbar.addNode')"
          :add-short="t('canvas.toolbar.addShort')"
          :delete-node-label="t('canvas.toolbar.deleteNode')"
          :delete-short="t('canvas.toolbar.deleteShort')"
          @add-cause="handleAddCause"
          @add-effect="handleAddEffect"
          @add-node="handleAddNode"
          @delete-node="handleDeleteNode"
        />

        <div class="divider" />

        <ElTooltip
          :content="t('canvas.toolbar.formatPainter')"
          placement="bottom"
        >
          <ElButton
            text
            size="small"
            :class="formatBrushActive ? 'bg-purple-100 ring-1 ring-purple-400 rounded' : ''"
            @click="handleFormatBrush"
          >
            <Brush
              class="w-4 h-4"
              :class="formatBrushActive ? 'text-purple-600' : 'text-purple-500'"
            />
          </ElButton>
        </ElTooltip>

        <ElTooltip
          v-if="isFlowMap"
          :content="t('canvas.toolbar.toggleDirection')"
          placement="bottom"
          :disabled="!compactToolbar"
        >
          <ElButton
            text
            size="small"
            @click="handleToggleOrientation"
          >
            <ArrowDownUp class="w-4 h-4 text-blue-500" />
            <span v-if="!compactToolbar">{{ t('canvas.toolbar.directionLabel') }}</span>
          </ElButton>
        </ElTooltip>

        <div class="divider" />

        <CanvasToolbarStyleDropdown
          :compact="compactToolbar"
          :style-menu-label="t('canvas.toolbar.styleMenu')"
          :presets-label="t('canvas.toolbar.presetsLabel')"
          :wireframe-label="t('canvas.toolbar.wireframe')"
          :wireframe-mode="uiStore.wireframeMode"
          :style-presets="stylePresets"
          @apply-preset="handleApplyStylePreset"
          @toggle-wireframe="uiStore.toggleWireframe()"
        />

        <CanvasToolbarTextDropdown
          :compact="compactToolbar"
          :text-style-menu-label="t('canvas.toolbar.textStyleMenu')"
          :format-label="t('canvas.toolbar.formatLabel')"
          :align-label="t('canvas.toolbar.alignLabel')"
          :font-label="t('canvas.toolbar.fontLabel')"
          :font-group-chinese="t('canvas.toolbar.fontGroupChinese')"
          :font-group-english="t('canvas.toolbar.fontGroupEnglish')"
          :color-label="t('canvas.toolbar.colorLabel')"
          :insert-equation-label="t('canvas.toolbar.insertEquation')"
          :insert-equation-tooltip="t('canvas.toolbar.insertEquationTooltip')"
          :insert-equation-enabled="insertEquationEnabled"
          :font-family="fontFamily"
          :font-size="fontSize"
          :font-weight="fontWeight"
          :font-style="fontStyle"
          :text-decoration="textDecoration"
          :text-align="textAlign"
          :text-color="textColor"
          :text-color-palette="textColorPalette"
          @toggle-bold="handleToggleBold"
          @toggle-italic="handleToggleItalic"
          @toggle-underline="handleToggleUnderline"
          @toggle-strikethrough="handleToggleStrikethrough"
          @set-text-align="handleTextAlign"
          @font-family-change="handleFontFamilyChange"
          @font-size-input="handleFontSizeInput"
          @text-color-pick="handleTextColorPick"
          @open-math-insert="handleOpenMathInsert"
        />

        <CanvasToolbarBackgroundDropdown
          :compact="compactToolbar"
          :bg-menu-label="t('canvas.toolbar.bgMenu')"
          :bg-color-label="t('canvas.toolbar.bgColorLabel')"
          :opacity-label="t('canvas.toolbar.opacityLabel')"
          :background-colors="backgroundColors"
          :background-opacity="backgroundOpacity"
          @pick-color="applyBackgroundToSelected"
          @update:background-opacity="onBackgroundOpacityInput"
          @apply-background="applyBackgroundToSelected()"
        />

        <CanvasToolbarBorderDropdown
          :compact="compactToolbar"
          :border-menu-label="t('canvas.toolbar.borderMenu')"
          :color-label="t('canvas.toolbar.colorLabel')"
          :border-width-label="t('canvas.toolbar.borderWidthLabel')"
          :border-style-label="t('canvas.toolbar.borderStyleLabel')"
          :border-color-palette="borderColorPalette"
          :border-color="borderColor"
          :border-width="borderWidth"
          :border-style="borderStyle"
          :border-style-options="borderStyleOptions"
          :get-border-preview-style="getBorderPreviewStyle"
          @apply-border="applyBorderToSelected"
        />

        <CanvasToolbarAiSection
          :compact="compactToolbar"
          :is-concept-map="isConceptMap"
          :is-a-i-generating="isAIGenerating"
          :ai-blocked-by-collab="aiBlockedByCollab"
          :concept-generation-label="t('canvas.toolbar.conceptGeneration')"
          :diagram-generation-label="t('canvas.toolbar.diagramGeneration')"
          :ai-generate-label="t('canvas.toolbar.aiGenerate')"
          :ai-generating-label="t('canvas.toolbar.aiGenerating')"
          @concept-generation="handleConceptGeneration"
          @diagram-generation="handleDiagramGeneration"
          @ai-generate="handleAIGenerate"
        />

        <div class="divider" />

        <CanvasToolbarMoreAppsDropdown
          :compact="compactToolbar"
          :more-apps-label="t('canvas.toolbar.moreApps')"
          :apps="moreApps"
          @select-app="handleMoreAppItem"
        />
      </div>
    </div>

    <CanvasMathInsertDialog
      v-model="mathInsertDialogOpen"
      @confirm="handleMathInsertConfirm"
    />

    <CanvasVirtualKeyboardPanel v-model="virtualKeyboardOpen" />
  </div>
</template>

<style scoped>
:deep(.divider) {
  height: 20px;
  width: 1px;
  background-color: #d1d5db;
  margin: 0 6px;
}

.toolbar-content {
  flex-wrap: nowrap;
  white-space: nowrap;
}

:deep(.toolbar-content .el-button) {
  --el-button-hover-bg-color: transparent;
  --el-button-hover-text-color: inherit;
  padding: 8px !important;
  margin: 0 !important;
  min-height: auto !important;
  height: auto !important;
  border-radius: 4px !important;
  transition: all 0.15s ease !important;
  border: none !important;
  font-size: 12px !important;
}

:deep(.toolbar-content .el-button--text) {
  color: #4b5563 !important;
  background: transparent !important;
}

:deep(.toolbar-content .el-button--text:hover) {
  background-color: #d1d5db !important;
  color: #374151 !important;
}

:deep(.toolbar-content .el-button--text:active) {
  background-color: #9ca3af !important;
}

:deep(.toolbar-content .el-button--text span) {
  margin-left: 0 !important;
}

:deep(.toolbar-content .el-button--text:not(:has(span))) {
  padding: 8px !important;
}

:deep(.toolbar-content .el-button:has(span)) {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
}

:deep(.dark .toolbar-content .el-button--text) {
  color: #d1d5db !important;
}

:deep(.dark .toolbar-content .el-button--text:hover) {
  background-color: #4b5563 !important;
  color: #f3f4f6 !important;
}

:deep(.dark .toolbar-content .el-button--text:active) {
  background-color: #374151 !important;
}

:deep(.ai-btn) {
  background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%) !important;
  border: none !important;
  padding: 6px 16px !important;
  margin-left: 8px !important;
  gap: 6px !important;
  box-sizing: border-box !important;
}

:deep(.ai-btn:hover) {
  background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%) !important;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4) !important;
}

:deep(.ai-btn span) {
  color: white !important;
}

@property --ai-toolbar-ring-angle {
  syntax: '<angle>';
  inherits: false;
  initial-value: 0deg;
}

:deep(.ai-btn--generating) {
  position: relative !important;
  background: transparent !important;
  box-shadow: none !important;
  padding: 2px !important;
}

:deep(.ai-btn--generating:hover) {
  transform: none !important;
  box-shadow: none !important;
  background: transparent !important;
}

:deep(.ai-btn--generating::before) {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 6px;
  padding: 2px;
  --ai-toolbar-ring-angle: 0deg;
  pointer-events: none;
  z-index: 0;
  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask-composite: exclude;
  -webkit-mask-composite: xor;
  animation: ai-toolbar-ring-spin 2.5s linear infinite;
  background: conic-gradient(
    from var(--ai-toolbar-ring-angle) at 50% 50%,
    rgba(59, 130, 246, 0.35) 0deg,
    rgba(255, 255, 255, 0.75) 52deg,
    #93c5fd 130deg,
    #3b82f6 180deg,
    #60a5fa 228deg,
    rgba(255, 255, 255, 0.75) 308deg,
    rgba(59, 130, 246, 0.35) 360deg
  );
}

:deep(.ai-btn--generating .el-button__inner),
:deep(.ai-btn--generating > span) {
  position: relative;
  z-index: 1;
  box-sizing: border-box !important;
  background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%) !important;
  border-radius: 4px !important;
  padding: 4px 14px !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
}

:deep(.dark .ai-btn--generating::before) {
  background: conic-gradient(
    from var(--ai-toolbar-ring-angle) at 50% 50%,
    rgba(59, 130, 246, 0.4) 0deg,
    rgba(31, 41, 55, 0.92) 52deg,
    #60a5fa 130deg,
    #2563eb 180deg,
    #38bdf8 228deg,
    rgba(31, 41, 55, 0.92) 308deg,
    rgba(59, 130, 246, 0.4) 360deg
  );
}

@keyframes ai-toolbar-ring-spin {
  to {
    --ai-toolbar-ring-angle: 360deg;
  }
}

:deep(.more-apps-btn) {
  background: white !important;
  border: 1px solid #e5e7eb !important;
  color: #374151 !important;
  padding: 6px 12px !important;
  margin-left: 12px !important;
  gap: 4px !important;
}

:deep(.more-apps-btn:hover) {
  background: #f9fafb !important;
  border-color: #d1d5db !important;
}

:deep(.more-apps-btn span) {
  color: #374151 !important;
}

:deep(.more-apps-menu) {
  width: 280px !important;
}

:deep(.more-apps-menu .el-dropdown-menu__item) {
  padding: 8px 12px !important;
  line-height: 1.4 !important;
}

:deep(.dark .divider) {
  background-color: #4b5563;
}

:deep(.dark .more-apps-btn) {
  background: #374151 !important;
  border-color: #4b5563 !important;
  color: #e5e7eb !important;
}
</style>
