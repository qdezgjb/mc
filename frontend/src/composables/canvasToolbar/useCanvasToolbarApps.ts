import { type ComputedRef, computed, inject, ref, watch } from 'vue'

import { Camera, Keyboard, Layers, LayoutGrid, type LucideIcon, Package } from 'lucide-vue-next'

import { eventBus } from '@/composables/core/useEventBus'
import { useLanguage } from '@/composables/core/useLanguage'
import { useNotifications } from '@/composables/core/useNotifications'
import { useAutoComplete } from '@/composables/editor/useAutoComplete'
import { useDiagramStore } from '@/stores'
import { usePanelsStore } from '@/stores/panels'
import { useSavedDiagramsStore } from '@/stores/savedDiagrams'
import { useUIStore } from '@/stores/ui'
import { buildConceptMapExpertSkeleton } from '@/utils/conceptMapExpertSkeleton'

import {
  consumeExpertSkeletonOriginalGraph,
  hasExpertSkeletonOriginalGraph,
  saveExpertSkeletonOriginalGraph,
} from './expertSkeletonOriginalGraph'

export type MoreAppHandlerKey = 'concept_map_modes'

export type MoreAppItem = {
  name: string
  icon: LucideIcon
  desc: string
  tag?: string
  iconBg: string
  iconColor: string
  handlerKey?: MoreAppHandlerKey
  appKey?: 'waterfall' | 'learning_sheet' | 'snapshot' | 'virtual_keyboard'
}

export function useCanvasToolbarApps() {
  const diagramStore = useDiagramStore()
  const savedDiagramsStore = useSavedDiagramsStore()
  const panelsStore = usePanelsStore()
  const uiStore = useUIStore()
  const { t } = useLanguage()
  const notify = useNotifications()
  const { isGenerating: isAIGenerating, autoComplete, validateForAutoComplete } = useAutoComplete()

  const collabCanvas = inject<
    | {
        isDiagramOwner?: ComputedRef<boolean>
      }
    | undefined
  >('collabCanvas', undefined)

  const aiBlockedByCollab = computed(() => {
    if (!diagramStore.collabSessionActive) {
      return false
    }
    const own = collabCanvas?.isDiagramOwner
    if (!own) {
      return false
    }
    return !own.value
  })

  const isConceptMap = computed(() => diagramStore.type === 'concept_map')

  const virtualKeyboardOpen = ref(false)

  watch(
    () => uiStore.uiVersion,
    (v) => {
      if (v !== 'international') {
        virtualKeyboardOpen.value = false
      }
    }
  )

  const moreApps = computed((): MoreAppItem[] => {
    const conceptMapModesRow: MoreAppItem = {
      name: t('canvas.toolbar.moreAppConceptMapModes'),
      icon: Layers,
      desc: t('canvas.toolbar.moreAppConceptMapModesDesc'),
      iconBg: 'bg-emerald-100',
      iconColor: 'text-emerald-600',
      handlerKey: 'concept_map_modes',
    }
    const apps: MoreAppItem[] = [
      {
        appKey: 'waterfall',
        name: t('canvas.toolbar.moreAppWaterfall'),
        icon: LayoutGrid,
        desc: t('canvas.toolbar.moreAppWaterfallDesc'),
        tag: t('canvas.toolbar.tagHot'),
        iconBg: 'bg-blue-100',
        iconColor: 'text-blue-600',
      },
      {
        appKey: 'learning_sheet',
        name: t('canvas.toolbar.moreAppLearningSheet'),
        icon: Package,
        desc: t('canvas.toolbar.moreAppLearningSheetDesc'),
        iconBg: 'bg-purple-100',
        iconColor: 'text-purple-600',
      },
      {
        appKey: 'snapshot',
        name: t('canvas.toolbar.moreAppSnapshot'),
        icon: Camera,
        desc: t('canvas.toolbar.moreAppSnapshotDesc'),
        iconBg: 'bg-amber-100',
        iconColor: 'text-amber-600',
      },
      ...(uiStore.uiVersion === 'international'
        ? [
            {
              appKey: 'virtual_keyboard' as const,
              name: t('canvas.toolbar.moreAppVirtualKeyboard'),
              icon: Keyboard,
              desc: t('canvas.toolbar.moreAppVirtualKeyboardDesc'),
              iconBg: 'bg-slate-100',
              iconColor: 'text-slate-600',
            },
          ]
        : []),
    ]
    const withoutWaterfall = isConceptMap.value
      ? apps.filter((a) => a.appKey !== 'waterfall')
      : apps
    if (isConceptMap.value) {
      return [conceptMapModesRow, ...withoutWaterfall]
    }
    return withoutWaterfall
  })

  async function handleAIGenerate() {
    if (aiBlockedByCollab.value) {
      notify.warning(t('canvas.toolbar.collabAiBlocked'))
      return
    }
    const validation = validateForAutoComplete()
    if (!validation.valid) {
      notify.warning(validation.error || t('canvas.toolbar.cannotGenerate'))
      return
    }

    const result = await autoComplete({
      promptSuffix: diagramStore.isLearningSheet ? ' 半成品' : undefined,
    })
    if (!result.success && result.error) {
      console.error('Auto-complete failed:', result.error)
    }
  }

  function handleConceptGeneration() {
    if (!diagramStore.data?.nodes?.length) {
      notify.warning(t('canvas.toolbar.createDiagramFirst'))
      return
    }
    const options: Record<string, unknown> = {}
    if (isConceptMap.value && diagramStore.selectedNodes.length === 1) {
      const nodeId = diagramStore.selectedNodes[0]
      const node = diagramStore.data?.nodes?.find((n) => n.id === nodeId)
      const topicNode = diagramStore.data?.nodes?.find(
        (n) => n.type === 'topic' || n.type === 'center' || n.id === 'root'
      )
      if (node && node.id !== topicNode?.id && node.text?.trim()) {
        options.conceptMapNodeId = node.id
        options.conceptMapNodeText = (node.text ?? '').trim()
      }
    }
    eventBus.emit('panel:open_requested', { panel: 'nodePalette', source: 'toolbar', options })
  }

  /**
   * 退出专家骨架图模式：把保存的原始完整概念图恢复到画布、关闭面板、提示用户。
   * 调用前提：`hasExpertSkeletonOriginalGraph()` 为 true（即当前确实在骨架模式）。
   * 注意：用户在骨架模式下对画布做的任何修改都不会被合并回原图，恢复后即丢失，
   *       所以必须给一条视觉提示（toast）让用户知道这件事。
   */
  function exitExpertSkeletonMode(): boolean {
    const original = consumeExpertSkeletonOriginalGraph()
    if (!original) return false
    if (!diagramStore.data) return false

    diagramStore.pushHistory(t('canvas.toolbar.expertSkeletonRestored'))
    diagramStore.data.nodes = original.nodes
    diagramStore.data.connections = original.connections
    diagramStore.clearSelection?.()
    diagramStore.clearEdgeSelection?.()
    // 关闭专家骨架图面板（保留普通节点面板的会话快照不动）
    panelsStore.clearNodePaletteState({ clearSessions: false })
    notify.success(t('canvas.toolbar.expertSkeletonRestored'))
    eventBus.emit('view:fit_to_canvas_requested', { animate: true, maxZoom: 1 })
    return true
  }

  function handleMoreAppItem(app: MoreAppItem) {
    if (app.handlerKey === 'concept_map_modes') {
      // 二次点击切换回完整图：以"已保存的快照"为唯一权威标志。
      // 直接看 panelsStore.expertSkeleton 不够稳定（用户可能从 X 按钮关掉
      // 了面板但画布还停留在骨架视图）；以快照为准能覆盖更多边界情况。
      if (hasExpertSkeletonOriginalGraph()) {
        exitExpertSkeletonMode()
        return
      }

      if (!diagramStore.data?.nodes?.length) {
        notify.warning(t('canvas.toolbar.createDiagramFirst'))
        return
      }
      const skeleton = buildConceptMapExpertSkeleton(diagramStore.data)
      if (!skeleton) {
        notify.warning(t('canvas.toolbar.expertSkeletonUnavailable'))
        return
      }

      // 先保存原始完整图的快照，再做骨架过滤——顺序不能反，否则保存的就是
      // 已经被裁掉的骨架视图，再次点击恢复时就拿不回完整图了。
      const nodes = diagramStore.data.nodes
      const connections = diagramStore.data.connections ?? []
      saveExpertSkeletonOriginalGraph(nodes, connections)

      diagramStore.pushHistory(t('canvas.toolbar.moreAppConceptMapModes'))
      diagramStore.data.nodes = nodes.filter((node) => skeleton.visibleNodeIds.has(node.id))
      diagramStore.data.connections = connections.filter((conn) =>
        skeleton.visibleConnectionIds.has(conn.id)
      )
      diagramStore.clearSelection?.()
      diagramStore.clearEdgeSelection?.()
      eventBus.emit('panel:open_requested', {
        panel: 'nodePalette',
        source: 'toolbar',
        options: {
          suggestions: skeleton.suggestions,
          selected: [],
          mode: skeleton.branches[0]?.id ?? null,
          stage: null,
          stage_data: null,
          conceptMapTabs: skeleton.branches.map((branch) => ({
            id: branch.id,
            name: branch.name,
          })),
          expertSkeleton: {
            branches: skeleton.branches,
          },
        },
      })
      notify.success(t('canvas.toolbar.expertSkeletonEntered'))
      eventBus.emit('view:fit_to_canvas_requested', { animate: true, maxZoom: 1 })
      return
    }
    void handleMoreApp(app)
  }

  async function handleMoreApp(app: MoreAppItem) {
    if (app.appKey === 'waterfall') {
      if (!diagramStore.data?.nodes?.length) {
        notify.warning(t('canvas.toolbar.createDiagramFirst'))
        return
      }
      eventBus.emit('panel:open_requested', { panel: 'nodePalette', source: 'toolbar' })
      return
    }
    if (app.appKey === 'learning_sheet') {
      if (!diagramStore.data?.nodes?.length) {
        notify.warning(t('canvas.toolbar.createDiagramFirst'))
        return
      }
      if (diagramStore.isLearningSheet) {
        diagramStore.restoreFromLearningSheetMode()
        notify.success(t('canvas.toolbar.switchedToRegular'))
      } else if (diagramStore.hasPreservedLearningSheet()) {
        diagramStore.applyLearningSheetView()
        notify.success(t('canvas.toolbar.learningSheetRestored'))
      } else {
        diagramStore.setLearningSheetMode(true)
        const spec = diagramStore.getSpecForSave()
        if (spec && diagramStore.type) {
          const enrichedSpec = {
            ...spec,
            is_learning_sheet: true,
            hidden_node_percentage: 0.2,
          }
          diagramStore.loadFromSpec(enrichedSpec, diagramStore.type)
          notify.success(t('canvas.toolbar.switchedLearningSheetMode'))
        }
      }
      return
    }
    if (app.appKey === 'snapshot') {
      if (!diagramStore.data?.nodes?.length) {
        notify.warning(t('canvas.toolbar.createDiagramFirst'))
        return
      }
      if (!savedDiagramsStore.activeDiagramId) {
        notify.warning(t('canvas.toolbar.snapshotSaveFirst'))
        return
      }
      eventBus.emit('snapshot:requested', {})
      return
    }
    if (app.appKey === 'virtual_keyboard') {
      virtualKeyboardOpen.value = !virtualKeyboardOpen.value
      return
    }
    notify.info(t('canvas.toolbar.featureInDevelopment', { name: app.name }))
  }

  return {
    aiBlockedByCollab,
    isAIGenerating,
    isConceptMap,
    moreApps,
    virtualKeyboardOpen,
    handleAIGenerate,
    handleConceptGeneration,
    handleMoreAppItem,
    exitExpertSkeletonMode,
  }
}
