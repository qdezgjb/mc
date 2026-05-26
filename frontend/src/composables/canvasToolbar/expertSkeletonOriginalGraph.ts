/**
 * 专家骨架图模式下的"原始完整概念图快照"。
 *
 * 进入骨架模式时（点击"专家骨架图"按钮触发），会把进入前的完整 nodes/
 * connections 深拷贝一份保存到这里；用户再次点击同一按钮、或通过 X 按钮
 * 关闭面板时，调用 `restoreExpertSkeletonOriginalGraph()` 把原图写回
 * `diagramStore.data`，从而退出骨架模式。
 *
 * 之所以用 module-level ref（而不是放进 panelsStore 或 diagramStore）：
 *   1. 整个 app 同时只可能有一个骨架图面板，不需要每个 component 实例
 *      各自保存；
 *   2. 原图节点数据反应式很重，放进 store 会拖累 watch；module-level
 *      ref 只在显式恢复时被读一次，没有反应性开销；
 *   3. 不污染现有 store 的类型与持久化逻辑。
 *
 * 注意：在骨架模式下用户对画布的修改（加节点、改文本、把 suggestion 拖到
 * 画布等）**不会**被合并回原图——恢复时一律以保存的快照为准。这是有意的
 * 简化，调用方在恢复时应给出明确提示告诉用户。
 */
import type { Connection, DiagramNode } from '@/types'

interface ExpertSkeletonOriginalGraph {
  nodes: DiagramNode[]
  connections: Connection[]
}

let savedOriginalGraph: ExpertSkeletonOriginalGraph | null = null

/**
 * 把当前完整概念图的 nodes/connections 深拷贝并保存为快照。
 * 后续可通过 `restoreExpertSkeletonOriginalGraph()` 恢复。
 *
 * 多次调用：后调用的快照覆盖之前的；正常流程中只会在"未保存 → 保存"时
 * 调用一次（进入骨架模式前）。
 */
export function saveExpertSkeletonOriginalGraph(
  nodes: readonly DiagramNode[] | undefined,
  connections: readonly Connection[] | undefined
): void {
  // 显式转可变数组：cloneDeep 内部用 structuredClone/JSON 都会产出可变副本，
  // 但 TypeScript 看不到那一层，需要在签名上把 readonly 摘掉。
  savedOriginalGraph = {
    nodes: cloneDeep([...(nodes ?? [])]),
    connections: cloneDeep([...(connections ?? [])]),
  }
}

/**
 * 是否存在已保存的快照。用来判断"当前是否处于骨架模式"。
 */
export function hasExpertSkeletonOriginalGraph(): boolean {
  return savedOriginalGraph !== null
}

/**
 * 取出已保存的快照副本（再做一层深拷贝，避免外部修改污染内部缓存），
 * 同时清空内部缓存。
 *
 * 返回 null 表示没有保存的快照（说明当前并不处于骨架模式）。
 */
export function consumeExpertSkeletonOriginalGraph(): ExpertSkeletonOriginalGraph | null {
  if (!savedOriginalGraph) return null
  const out: ExpertSkeletonOriginalGraph = {
    nodes: cloneDeep(savedOriginalGraph.nodes),
    connections: cloneDeep(savedOriginalGraph.connections),
  }
  savedOriginalGraph = null
  return out
}

/**
 * 仅清空内部缓存而不返回内容。用于以下场景：
 *   - 用户切换到不同 diagram 时；
 *   - 启动了新一次的"完整图生成"流程（不再属于上次骨架模式的会话）。
 */
export function clearExpertSkeletonOriginalGraph(): void {
  savedOriginalGraph = null
}

/**
 * 简单深拷贝。优先使用 `structuredClone`（现代浏览器原生支持，深度无限、
 * 处理循环引用），回退到 JSON 序列化（足够覆盖 DiagramNode/Connection
 * 的纯数据结构，不会出现 Date/Map/循环引用等问题）。
 */
function cloneDeep<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      // 极少数对象（如带函数引用）structuredClone 会抛错，回退到 JSON
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}
