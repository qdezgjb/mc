<script setup lang="ts">
/**
 * CanvasToolbar - Floating toolbar for canvas editing
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

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
  stripAnyFocusQuestionLabel,
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

function estimateGeneratedConceptNodeWidth(text: string): number {
  const plain = String(text || '').replace(/\s+/gu, '').trim()
  const chars = Array.from(plain)
  const cjkCount = chars.filter((ch) => /[\u4e00-\u9fff]/u.test(ch)).length
  const otherCount = Math.max(0, chars.length - cjkCount)
  const estimated = 90 + cjkCount * 19 + otherCount * 12
  return Math.max(220, Math.min(estimated, 420))
}

function getGeneratedConceptNodeStyle(level: 1 | 2 | 3 | 4 | 5, text: string) {
  const isMajor = level <= 2
  return {
    width: estimateGeneratedConceptNodeWidth(text),
    height: isMajor ? 78 : 70,
    fontSize: isMajor ? 24 : 22,
    fontWeight: isMajor ? 'bold' : 'normal',
  } as const
}

function getConceptMapFocusQuestionStyle() {
  return {
    width: 760,
    height: 104,
    fontSize: 30,
    fontWeight: 'bold',
  } as const
}

function getConceptMapAspectIndexFromLayoutId(id: string): number | undefined {
  const raw = id.match(/^(?:aspect|noun|desc|detail)-(\d+)/)?.[1]
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * When true, flatter styles for use inside CanvasTopBar (single merged chrome row).
 * When embedded, `compactToolbar` is driven by CanvasTopBar (two-tier bar width breakpoints).
 */
const props = withDefaults(defineProps<{ embedded?: boolean; compactToolbar?: boolean }>(), {
  embedded: false,
  compactToolbar: false,
})

const { t, promptLanguage } = useLanguage()
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
  const byLevel: Record<1 | 2 | 3 | 4 | 5, typeof layout.nodes> = {
    1: [],
    2: [],
    3: [],
    4: [],
    5: [],
  }
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

  for (const level of [1, 2, 3, 4, 5] as const) {
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
        parentId: layoutNode.parentId ?? undefined,
        data: {
          conceptMapAspectIndex:
            layoutNode.level >= 2
              ? getConceptMapAspectIndexFromLayoutId(layoutNode.id)
              : undefined,
          conceptMapLevel: layoutNode.level,
        },
        style: getGeneratedConceptNodeStyle(level, layoutNode.text),
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

async function handleDiagramGeneration(opts?: {
  /**
   * 可选的"聊天展示文本"。
   * - 当 MindMate 面板从用户原话识别到"生成概念图"意图时，把用户原话传进来作为
   *   displayMessage，确保聊天历史里显示的就是用户实际输入的句子，而不是
   *   `t('canvas.toolbar.diagramGenerationDisplay')` 这个固定模板。
   * - 工具栏按钮直接调用本函数时不传这个参数，沿用默认模板。
   */
  displayMessageOverride?: string
  /**
   * 可选的"图片素材"。
   * - 当焦点问题来自"用户上传图片 → Qwen-VL 提取"时，会一并附带从图片中识别
   *   出的关键文本/术语/关系。本函数会把它作为「参考素材」段拼到 prompt 末尾，
   *   让 LLM 优先基于图片实际内容组织节点；图里没有的方面再用模型常识补充。
   * - 仅当本次生成确实有图片素材时传入；否则不附加，prompt 形态与旧行为一致。
   */
  imageContextOverride?: string
  /**
   * 当上层（如 MindmatePanel 的图片路径）已经自行 push 了用户消息到 mindMate.messages，
   * 这里 emit 'mindmate:send_message' 时应附加 silent=true，避免 sendMessage
   * 在内部又 push 一条"基于图片生成概念图（焦点问题：xxx）"的重复气泡。
   * 工具栏按钮直接调用时为 false，sendMessage 正常 push 用户气泡。
   */
  silentUserMessage?: boolean
}): Promise<void> {
  if (!isConceptMap.value) return

  const question = resolveFocusQuestion()
  if (!question) {
    notify.warning(t('canvas.toolbar.diagramGenerationNoFocus'))
    return
  }

  let prompt = t('canvas.toolbar.diagramGenerationPrompt', { question })
  prompt = `${prompt}

【本次层级深度覆盖要求】
请把生成结果组织成 5 层可视化链条：焦点问题 → 根概念 → 方面 → 关键名词 → 说明节点 → 再展开节点。每一张图都必须出现第 5 层，不能只停在第 4 层。为保证画布能生成第 5 层，所有关键名词优先使用四段直角引号格式：
「连接词B」【关键名词】『第一层动词』『第一层宾语』『第二层动词』『第二层宾语』
其中『第一层动词』『第一层宾语』会生成第 4 层，『第二层动词』『第二层宾语』会继续生成第 5 层。节点文字要短但必须完整：方面标题 4-6 字，关键名词 4-8 字，两个宾语各 4-8 字；不要写长句，也绝对不要输出被截断的词（例如不要把“人工智能”写成“人工智”）。所有「连接词A/B」和两组『动词』都必须是真实连接词，不能留空，不能写“输入关系”“关系”“待补充”。`
prompt = `${prompt}

【连接词命题性要求】
所有连接词必须是谓语或关系短语，放在两个节点中间后要能读成一句完整中文命题：节点A + 连接词 + 节点B。禁止把篇章衔接词、顺序词、副词当连接词，例如“同时”“进一步”“并且”“而且”“另外”“此外”“首先”“其次”“然后”“最后”等；如果出现这类词，必须改成“体现为”“包含”“表现为”“导致”“形成”“支持”“强化”“削弱”“依赖于”等能构成命题的关系词。`
prompt = `${prompt}

【第 5 层分支要求】
第 5 层不要只给单一路径：约一半的第 4 层节点应能继续形成两个不同的末层分支。需要两个末层分支时，请在同一个【关键名词】后连续给出六段直角引号：
「连接词B」【关键名词】『第一层动词』『第一层宾语』『第二层动词』『第二层宾语』『第三层动词』『第三层宾语』
其中第二层动词/宾语生成第一条末层分支，第三层动词/宾语生成第二条末层分支。第二层、第三层的动词都必须像上层一样是可合读成命题的真实关系词，不要使用“进一步”“同时”等篇章词，也不要省略连接词。`

  // 若本次有"图片素材"，作为参考资料追加到 prompt 末尾。
  // 注意只 append，不替换原模板——保留原有的"4 条层级链 + 严格输出格式"约束。
  const imageContext = (opts?.imageContextOverride || '').trim()
  if (imageContext) {
    const supplement = t('canvas.toolbar.diagramGenerationImageContext', {
      imageContext,
    })
    prompt = `${prompt}\n\n${supplement}`
  }
  // 优先使用调用方传入的"用户原话"，否则回退到 i18n 默认展示模板
  const overrideText = opts?.displayMessageOverride?.trim()
  const displayMessage =
    overrideText && overrideText.length > 0
      ? overrideText
      : t('canvas.toolbar.diagramGenerationDisplay', { question })

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

  // message 为实际发送给 LLM 的完整提示词；displayMessage 为聊天界面展示的简短文本。
  // silent=true 表示上层已自行 push 用户气泡（例如图片提取焦点问题路径），
  // useMindMate 不再重复 push，避免聊天里出现两条用户消息。
  const silent = opts?.silentUserMessage === true

  // 概念图教学设计生成：必须**绕开 Dify**直接走自家 LLM 流式接口。
  //
  // 原因（实测稳定复现）：
  //   /api/ai_assistant/stream 转发给 Dify chatflow，而 Dify 工作流里通常含
  //   一个 JSON 抽取节点期望前序 LLM 输出 ```json...```；本 prompt 模板明确
  //   要求"只返回纯文本，不要生成任何图示/JSON"，于是 LLM 老老实实输出
  //   1.「连接词」…【名词】『动词』『宾语』… —— 没有任何 JSON 代码块，
  //   Dify 抽取节点必然失败，回传 "Run failed: could not find json block in the output."。
  //
  // 解决方案：本入口（仅概念图）改走 /api/concept_map/generate-concept-map-text，
  // 该后端接口直接调 llm_service.chat_stream，按 SSE 协议流式返回，
  // 事件名（message / message_end / error）与 Dify 通道完全一致，
  // useMindMate.handleStreamEvent 无需新增分支即可复用。
  //
  // 顶部 if (!isConceptMap.value) return 已挡掉非概念图调用，所以这里直接覆盖端点。
  eventBus.emit('mindmate:send_message', {
    message: prompt,
    displayMessage,
    silent,
    endpoint: '/api/concept_map/generate-concept-map-text',
    extraBody: {
      prompt,
      language: promptLanguage.value || 'zh',
    },
  })
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

/**
 * 监听 MindMate 等外部模块发起的"根据焦点问题生成概念图"请求：
 * 若带 question，则先把焦点问题写入 topic 节点 + spec，再走标准生成流程；
 * 若 question 为空，则直接复用工具栏按钮的逻辑。
 */
let unsubFocusQuestionGenerate: (() => void) | null = null

onMounted(() => {
  unsubFocusQuestionGenerate = eventBus.on(
    'concept_map:focus_question_generation_requested',
    async (payload) => {
      if (!isConceptMap.value) return

      const trimmed =
        typeof payload?.question === 'string' ? payload.question.trim() : ''
      const originalMessage =
        typeof payload?.originalMessage === 'string'
          ? payload.originalMessage.trim()
          : ''
      // 来自"图片提取"路径时，把从图中识别出的关键文本/术语透传给生成 prompt。
      // 普通工具栏按钮触发时该字段为空，行为与旧逻辑完全一致。
      const imageContext =
        typeof payload?.imageContext === 'string'
          ? payload.imageContext.trim()
          : ''
      if (trimmed) {
        // 1) 强力剥离用户输入中所有可能的"焦点问题"前缀变体（中文冒号、英文
        //    冒号、不带冒号、连写多次等），得到一个干净的"纯"焦点问题文本。
        //    这样后续拼接 "焦点问题:" + 纯问题 不会出现 "焦点问题:焦点问题:xxx"。
        const pureQuestion = stripAnyFocusQuestionLabel(trimmed).trim() || trimmed

        // 2) 写入 topic 节点显示文本：标准 i18n 前缀 + 纯焦点问题；
        //    与画布默认占位形态保持一致（用户在 UI 直接编辑也是 "焦点问题:xxx"）。
        const prefix = t('diagram.conceptMap.focusQuestionPrefix')
        const topicText = `${prefix}${pureQuestion}`
        diagramStore.updateNode('topic', {
          text: topicText,
          style: {
            ...(diagramStore.data?.nodes?.find((n) => n.id === 'topic')?.style || {}),
            ...getConceptMapFocusQuestionStyle(),
          },
        })

        // 3) updateNode 内部会同步 data.focus_question = topicText（带前缀）。
        //    覆写为"纯"焦点问题，确保 LLM prompt 与根节点提取得到的都是无前缀文本。
        const data = diagramStore.data as Record<string, unknown> | undefined
        if (data) data.focus_question = pureQuestion

        diagramStore.pushHistory(t('canvas.toolbar.diagramGeneration'))
        await nextTick()
      }

      // 把用户原话作为聊天展示文本透传下去，避免聊天里显示的是固定模板；
      // 同时把"图片素材"透传给生成 prompt（仅在图片路径时有值）。
      // userMessageAlreadyShown=true 表示触发方（如 MindmatePanel 的图片路径）
      // 已自行 push 用户气泡，向下游 'mindmate:send_message' 附带 silent=true，
      // 避免聊天里冒出两条用户消息。注意这里不能用 imageContext 是否非空作为
      // 代理信号——若图里几乎没有文字，imageContext 可能为空但仍是图片路径。
      const alreadyShown = payload?.userMessageAlreadyShown === true
      await handleDiagramGeneration({
        displayMessageOverride: originalMessage,
        imageContextOverride: imageContext || undefined,
        silentUserMessage: alreadyShown,
      })
    }
  )
})

onUnmounted(() => {
  unsubFocusQuestionGenerate?.()
  unsubFocusQuestionGenerate = null
})
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
