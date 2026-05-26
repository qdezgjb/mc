import type {
  Connection,
  DiagramData,
  DiagramNode,
  ExpertSkeletonBranch,
  NodeSuggestion,
} from '@/types'
import { getTopicRootConceptTargetId } from '@/utils/conceptMapTopicRootEdge'

export interface ConceptMapExpertSkeleton {
  rootId: string
  branches: ExpertSkeletonBranch[]
  suggestions: NodeSuggestion[]
  visibleNodeIds: Set<string>
  visibleConnectionIds: Set<string>
}

/** source 节点 → 它的 outgoing 连接列表（向下方向）。 */
function childrenBySource(connections: Connection[]): Map<string, Connection[]> {
  const out = new Map<string, Connection[]>()
  for (const conn of connections) {
    const list = out.get(conn.source) ?? []
    list.push(conn)
    out.set(conn.source, list)
  }
  return out
}

/**
 * 从 ID 形如 `aspect-2`、`noun-2-0`、`desc-2-1`、`detail-2-1-b` 中抽出
 * "方面索引"（即第一段数字）。仅当节点是由 prompt → computeHierarchyLayout
 * 流程生成且 ID 仍保持原命名时返回数字；其它情况返回 null。
 */
function generatedAspectIndexFromId(id: string | undefined): number | null {
  if (!id) return null
  const match = /^(?:aspect|noun|desc|detail)-(\d+)(?:-|$)/.exec(id)
  if (!match?.[1]) return null
  const index = Number.parseInt(match[1], 10)
  return Number.isFinite(index) ? index : null
}

/** 优先信任 ID，再读 data.conceptMapAspectIndex，最后兜底 null。 */
function conceptMapAspectIndexFromNode(node: DiagramNode | undefined): number | null {
  if (!node) return null
  const generatedIndex = generatedAspectIndexFromId(node.id)
  if (generatedIndex !== null) return generatedIndex

  const raw =
    (node.data as { conceptMapAspectIndex?: unknown; aspectIndex?: unknown } | undefined)
      ?.conceptMapAspectIndex ??
    (node.data as { aspectIndex?: unknown } | undefined)?.aspectIndex
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * 顺着 `parentId` 链向上找，看是否能命中 rootChildIdSet 中的某个 L2 方面节点。
 * 找到则返回该 L2 节点 id；否则返回 null。
 */
function assignByParentChain(
  node: DiagramNode,
  nodeById: Map<string, DiagramNode>,
  rootChildIdSet: Set<string>
): string | null {
  const seen = new Set<string>()
  let parentId = node.parentId

  while (parentId && !seen.has(parentId)) {
    if (rootChildIdSet.has(parentId)) return parentId
    seen.add(parentId)
    parentId = nodeById.get(parentId)?.parentId
  }

  return null
}

/**
 * 计算并返回当前概念图的 "专家骨架图" 数据：把所有非骨架节点（即 topic / root /
 * 4 个 L2 方面之外的节点）严格归类到它们各自所属的 L2 方面分支下。
 *
 * 归类策略（按优先级递减依次尝试）：
 *
 *   1. **沿父子边 source → target 的 BFS（最稳健）**
 *      从每个 L2 方面节点出发，只走 outgoing 边、且遇到任何"已可见"或
 *      "已被其它分支抢到"的节点就停止——这样就完美还原了 prompt → layout
 *      流程构建的 "L2 → L3 → L4 → L5" 子树关系。这一遍能正确归类绝大
 *      多数节点（前提是 source/target 方向是从父到子）。
 *
 *   2. **形态A 的 ID 命名（aspect-X-Y）+ data.conceptMapAspectIndex**
 *      兜底兜未能在第 1 步被到达的节点（连线断裂、用户手动添加节点没接
 *      上线时常见）。直接用节点本身存的 aspectIndex 字段。
 *
 *   3. **`parentId` 链向上回溯**
 *      最后一道兜底。只要节点的 parentId 链最终能命中某个 L2 方面，
 *      就归到那个方面。
 *
 * 已删除的旧逻辑：原版还有第 4 道兜底 ——
 *   `collectConnectedDescendantIds`（无向 BFS 通过 visibleIds 屏障收集
 *    剩余节点）。这道兜底的问题是：当某个节点既不是某个 L2 的真正后代
 *    （source→target 不可达）、aspectIndex 也缺失、parentId 链断裂时，
 *    它会按 rootChildIds 的顺序被"先到达"的 L2 抢走 ——结果是大量孤儿
 *    节点全部沉淀到第一个 L2 分支下，造成"所有内容都堆在第一个 tab"
 *    的视觉错乱。改用前 3 步严格归类后，孤儿节点宁可不显示也不被错配。
 */
/**
 * 控制是否开启专家骨架图的诊断日志（输出到浏览器开发者工具 → Console）。
 *
 * 排查"节点全部堆到第一个 tab"等归类失败的现象时，把这个常量临时改成
 * `true`，浏览器刷新一次后再点击"专家骨架图"按钮，控制台会按 group 打印：
 *   - 输入图的全部节点 / 连接概览（id、text、source→target）
 *   - rootId、4 个 rootChildIds 的 id+name
 *   - Pass 1 / 2 / 3 各自归到每个分支的节点
 *   - 仍然孤立、未归到任何分支的节点列表
 *
 * 默认开启便于现场诊断；问题排查完成后建议改回 false 以减少 console 噪音。
 */
const DEBUG_EXPERT_SKELETON = true

/**
 * 进入专家骨架图视图后，每个 L2 方面节点下要在画布上**保留**的 L3 节点数量。
 *
 *   值=0：画布上仅显示 topic / root / 4 个 L2，是最简洁的纯骨架；
 *   值=2：每个 L2 下再保留 2 个 L3，让用户能看到每个分支大致的展开方向，
 *         又不会把所有内容暴露——既给提示又留空白让学生填补；
 *   值=N：保留前 N 个 L3。
 *
 * 选取规则按 `childMap.get(branchId)` 的天然顺序（即概念图 connections 的
 * 收集顺序）取前 N 个，避免引入 y 坐标比较等不稳定因素。被保留的 L3 节点
 * 不会再出现在面板的"骨架图"卡片列表里（避免画布和面板内容重复）。
 */
const KEPT_CHILDREN_PER_BRANCH = 2

function debugLog(...args: unknown[]): void {
  if (!DEBUG_EXPERT_SKELETON) return
  // eslint-disable-next-line no-console
  console.log('[ExpertSkeleton]', ...args)
}

function debugGroup(label: string): void {
  if (!DEBUG_EXPERT_SKELETON) return
  // eslint-disable-next-line no-console
  console.groupCollapsed(`[ExpertSkeleton] ${label}`)
}

function debugGroupEnd(): void {
  if (!DEBUG_EXPERT_SKELETON) return
  // eslint-disable-next-line no-console
  console.groupEnd()
}

export function buildConceptMapExpertSkeleton(
  data: DiagramData | null | undefined
): ConceptMapExpertSkeleton | null {
  const nodes = data?.nodes ?? []
  const connections = data?.connections ?? []

  debugGroup(
    `BUILD START: nodes=${nodes.length}, connections=${connections.length}`
  )
  // 列出所有节点的简要信息，方便核对节点 ID 命名是否符合 aspect-X-Y 模式
  // 以及 parentId / data.conceptMapAspectIndex 是否被正确设置。
  if (DEBUG_EXPERT_SKELETON) {
    debugLog(
      'all_nodes:',
      nodes.map((n) => ({
        id: n.id,
        text: (n.text ?? '').slice(0, 30),
        type: n.type,
        parentId: n.parentId ?? null,
        aspectIdx:
          (n.data as { conceptMapAspectIndex?: unknown } | undefined)
            ?.conceptMapAspectIndex ?? null,
        level:
          (n.data as { conceptMapLevel?: unknown } | undefined)?.conceptMapLevel ?? null,
      }))
    )
    debugLog(
      'all_connections:',
      connections.map((c) => ({
        id: c.id,
        source: c.source,
        target: c.target,
        label: c.label,
      }))
    )
  }

  if (!nodes.length || !connections.length) {
    debugLog('ABORT: empty nodes or connections')
    debugGroupEnd()
    return null
  }

  const rootId = getTopicRootConceptTargetId(connections) ?? 'root'
  debugLog('resolved rootId:', rootId)

  if (!nodes.some((node) => node.id === rootId)) {
    debugLog('ABORT: rootId not found in nodes')
    debugGroupEnd()
    return null
  }

  const childMap = childrenBySource(connections)
  const rootChildConnections = childMap.get(rootId) ?? []
  const rootChildIds = rootChildConnections
    .map((conn) => conn.target)
    .filter((id) => nodes.some((node) => node.id === id))
  debugLog('rootChildIds (= L2 branches):', rootChildIds)

  if (!rootChildIds.length) {
    debugLog('ABORT: no rootChildIds (root has no outgoing edges)')
    debugGroupEnd()
    return null
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const))
  const rootChildIdSet = new Set(rootChildIds)

  // -----------------------------------------------------------------
  // 区分两个语义不同的 Set（之前耦合在 visibleNodeIds 一起，现在拆开）：
  //
  //   bfsBarrierIds  = topic / root / 所有 L2 方面节点
  //                    └── BFS 屏障：归类时遇到这些就停止扩展，避免一个
  //                        L2 的 BFS 跨边界把另一个 L2 的子树吞掉。
  //
  //   visibleNodeIds = bfsBarrierIds + 每个 L2 下保留的前 N 个 L3 节点
  //                    └── 进入骨架图视图后**画布上保留显示**的节点。
  //
  // 早期版本两者是同一个 Set，导致一旦想"在画布上保留若干 L3"，就会同时
  // 把这些 L3 当成 BFS 屏障——它们的子孙 L4/L5 就走不到 BFS 路径上，
  // 全部沉淀成 orphan。拆分后：BFS 仍能穿过被画布保留的 L3 继续向下找
  // 子孙，但 assignNodeToBranch 时跳过 visible 节点（不重复加到面板）。
  // -----------------------------------------------------------------
  const bfsBarrierIds = new Set<string>(['topic', rootId, ...rootChildIds])
  const visibleNodeIds = new Set<string>(bfsBarrierIds)

  // 为每个 L2 选出要在画布上保留的前 N 个 L3 子节点。
  // 选取顺序 = childMap.get(branchId) 的天然顺序，等价于 connections
  // 数组里同 source 的相对顺序。
  const keptChildrenByBranch = new Map<string, string[]>()
  if (KEPT_CHILDREN_PER_BRANCH > 0) {
    for (const branchId of rootChildIds) {
      const childConns = childMap.get(branchId) ?? []
      const kept: string[] = []
      for (const conn of childConns) {
        if (kept.length >= KEPT_CHILDREN_PER_BRANCH) break
        const childId = conn.target
        // 必须真实存在；不能是另一个 L2（极少数环形图防御）；不能是 topic/root
        if (!nodeById.has(childId)) continue
        if (rootChildIdSet.has(childId)) continue
        if (childId === 'topic' || childId === rootId) continue
        if (visibleNodeIds.has(childId)) continue
        visibleNodeIds.add(childId)
        kept.push(childId)
      }
      if (kept.length) keptChildrenByBranch.set(branchId, kept)
    }
  }
  debugLog(
    'kept L3 children per branch (画布保留):',
    Array.from(keptChildrenByBranch.entries()).map(([bid, ids]) => ({
      branchId: bid,
      branchName: nodeById.get(bid)?.text ?? '',
      keptIds: ids,
      keptTexts: ids.map((id) => (nodeById.get(id)?.text ?? '').slice(0, 20)),
    }))
  )

  // 画布保留的边：root→L2 的 4 条，加上 L2→保留 L3 的若干条
  const visibleConnectionIds = new Set(
    connections
      .filter((conn) => {
        if (!visibleNodeIds.has(conn.source) || !visibleNodeIds.has(conn.target)) return false
        // 顶层骨架边
        if (conn.source === 'topic' || conn.source === rootId) return true
        // L2 → 保留的 L3 边
        if (rootChildIdSet.has(conn.source)) {
          const kept = keptChildrenByBranch.get(conn.source)
          if (kept && kept.includes(conn.target)) return true
        }
        return false
      })
      .map((conn) => conn.id)
  )

  const branches: ExpertSkeletonBranch[] = []
  const branchNodeIds = new Map<string, string[]>()
  const branchIdByAspectIndex = new Map<number, string>()

  for (const branchId of rootChildIds) {
    const branchNode = nodeById.get(branchId)
    const branchName = (branchNode?.text ?? '').trim()
    if (!branchName) {
      debugLog('skip branch with empty text:', branchId)
      continue
    }

    const aspectIndex = conceptMapAspectIndexFromNode(branchNode)
    if (aspectIndex !== null) {
      branchIdByAspectIndex.set(aspectIndex, branchId)
    }
    const nodeIds: string[] = []
    branches.push({ id: branchId, name: branchName, nodeIds })
    branchNodeIds.set(branchId, nodeIds)
  }
  debugLog(
    'branches:',
    branches.map((b) => ({
      id: b.id,
      name: b.name,
      aspectIdx: conceptMapAspectIndexFromNode(nodeById.get(b.id)),
    }))
  )
  debugLog(
    'branchIdByAspectIndex (Map):',
    Array.from(branchIdByAspectIndex.entries())
  )

  const assignedIds = new Set<string>()
  // 记录每个节点是被哪一遍归类（pass1/pass2/pass3）认领的，最后统一打印。
  const assignmentSource = new Map<string, 'pass1' | 'pass2' | 'pass3'>()

  const assignNodeToBranch = (
    nodeId: string,
    branchId: string | null,
    source: 'pass1' | 'pass2' | 'pass3'
  ): boolean => {
    if (!branchId || assignedIds.has(nodeId)) return false
    // 已在画布保留的节点（包括 topic/root/L2 屏障节点和保留的 L3 节点）
    // 不再加进面板列表——避免画布与面板内容重复。但要标记成 assigned，
    // 以免后续的 pass2/pass3 兜底再次尝试归类它们。
    if (visibleNodeIds.has(nodeId)) {
      assignedIds.add(nodeId)
      return false
    }
    const node = nodeById.get(nodeId)
    if (!node?.id || !(node.text ?? '').trim()) return false
    const list = branchNodeIds.get(branchId)
    if (!list) return false
    list.push(nodeId)
    assignedIds.add(nodeId)
    assignmentSource.set(nodeId, source)
    return true
  }

  // ============================================================
  // Pass 1: 严格沿 source → target 边的 BFS。
  //   - 每个分支独立 BFS，从 branchId 出发；
  //   - 一旦遇到 bfsBarrierIds 里的节点（topic/root/其它 L2）就停止
  //     扩展——保证 BFS 不会跨越其它 L2 分支；
  //   - 一旦遇到已被某个分支抢到的节点（assignedIds）也跳过——保证
  //     即使图里有交叉边，先到先得，不会把一个节点重复挂到多个分支；
  //   - 遇到"已在画布保留的 L3"（visibleNodeIds 减去 bfsBarrierIds 的
  //     部分）继续扩展但不加进面板列表，由 assignNodeToBranch 内部处理。
  //
  //   遍历顺序按 rootChildIds 的天然顺序，没有偏向。
  // ============================================================
  for (const branchId of rootChildIds) {
    const queue: string[] = [branchId]
    const visitedInThisBranch = new Set<string>([branchId])

    while (queue.length > 0) {
      const currentId = queue.shift()
      if (!currentId) continue
      const outgoing = childMap.get(currentId) ?? []
      for (const conn of outgoing) {
        const targetId = conn.target
        if (visitedInThisBranch.has(targetId)) continue
        // BFS 屏障：仅 topic / root / 其它 L2 是真正的屏障
        if (bfsBarrierIds.has(targetId)) continue
        // 互斥：已被任何分支认领过的节点不再处理
        if (assignedIds.has(targetId)) continue
        visitedInThisBranch.add(targetId)
        // 尝试加进面板列表；assignNodeToBranch 会自动跳过 visible 节点
        // （但仍然把它标记为 assigned）。不论 push 是否成功，都继续
        // 沿 source→target 扩展，让保留 L3 的子孙能被找到。
        assignNodeToBranch(targetId, branchId, 'pass1')
        queue.push(targetId)
      }
    }
  }
  debugLog(
    'after pass1 (source→target BFS) — counts by branch:',
    branches.map((b) => ({
      name: b.name,
      count: b.nodeIds.length,
    }))
  )

  // ============================================================
  // Pass 2: 兜底——按 ID 命名 / data.conceptMapAspectIndex 归类。
  //   只处理还没归到任何分支的节点。
  // ============================================================
  let pass2Hits = 0
  for (const node of nodes) {
    if (assignedIds.has(node.id)) continue
    if (visibleNodeIds.has(node.id)) continue
    const aspectIndex = conceptMapAspectIndexFromNode(node)
    const branchId =
      aspectIndex !== null ? (branchIdByAspectIndex.get(aspectIndex) ?? null) : null
    if (branchId && assignNodeToBranch(node.id, branchId, 'pass2')) pass2Hits += 1
  }
  debugLog(`after pass2 (aspectIndex fallback) — newly assigned: ${pass2Hits}`)

  // ============================================================
  // Pass 3: 兜底——顺着 parentId 链向上找祖先 L2。
  //   还没归类的节点最后一次机会。
  // ============================================================
  let pass3Hits = 0
  for (const node of nodes) {
    if (assignedIds.has(node.id)) continue
    if (visibleNodeIds.has(node.id)) continue
    const branchId = assignByParentChain(node, nodeById, rootChildIdSet)
    if (branchId && assignNodeToBranch(node.id, branchId, 'pass3')) pass3Hits += 1
  }
  debugLog(`after pass3 (parentId chain fallback) — newly assigned: ${pass3Hits}`)

  // 列出未能归类的孤儿节点，方便定位"图本身的连线/数据问题"
  if (DEBUG_EXPERT_SKELETON) {
    const orphans: { id: string; text: string; parentId: string | null }[] = []
    for (const node of nodes) {
      if (assignedIds.has(node.id)) continue
      if (visibleNodeIds.has(node.id)) continue
      orphans.push({
        id: node.id,
        text: (node.text ?? '').slice(0, 30),
        parentId: node.parentId ?? null,
      })
    }
    if (orphans.length) {
      debugLog('ORPHAN nodes (not assigned to any branch):', orphans)
    } else {
      debugLog('no orphan nodes — every hidden node was assigned')
    }

    // 打印每个分支的最终归类结果（含归类来源），便于核对分组对不对
    for (const branch of branches) {
      const items = branch.nodeIds.map((id) => ({
        id,
        text: (nodeById.get(id)?.text ?? '').slice(0, 30),
        via: assignmentSource.get(id) ?? '?',
      }))
      debugGroup(`branch "${branch.name}" (${branch.id}) — ${items.length} nodes`)
      // eslint-disable-next-line no-console
      console.table(items)
      debugGroupEnd()
    }
  }

  // ============================================================
  // 收尾：组装 suggestions 列表（按节点在画布上的 y 坐标排序，让面板里
  // 的列表顺序大致跟原图从上到下的视觉顺序一致）。
  // ============================================================
  const suggestions: NodeSuggestion[] = []
  for (const branch of branches) {
    branch.nodeIds.sort((a, b) => {
      const na = nodeById.get(a)
      const nb = nodeById.get(b)
      const ay = na?.position?.y ?? 0
      const by = nb?.position?.y ?? 0
      if (Math.abs(ay - by) > 12) return ay - by
      return (na?.position?.x ?? 0) - (nb?.position?.x ?? 0)
    })

    for (const nodeId of branch.nodeIds) {
      const node = nodeById.get(nodeId)
      const text = (node?.text ?? '').trim()
      if (!node || !text) continue
      const incoming = connections.find((conn) => conn.target === nodeId)
      const label = (incoming?.label ?? '').trim()
      suggestions.push({
        id: `expert-${nodeId}`,
        text,
        type: node.type,
        parent_id: branch.id,
        relationship_label: label || undefined,
      })
    }
  }

  if (!branches.length || !suggestions.length) {
    debugLog('ABORT: no branches or no suggestions assembled')
    debugGroupEnd()
    return null
  }

  debugLog(
    `BUILD DONE: ${branches.length} branches, ${suggestions.length} suggestions in total`
  )
  debugGroupEnd()

  return {
    rootId,
    branches,
    suggestions,
    visibleNodeIds,
    visibleConnectionIds,
  }
}
