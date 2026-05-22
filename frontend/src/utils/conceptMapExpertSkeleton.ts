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

function childrenBySource(connections: Connection[]): Map<string, Connection[]> {
  const out = new Map<string, Connection[]>()
  for (const conn of connections) {
    const list = out.get(conn.source) ?? []
    list.push(conn)
    out.set(conn.source, list)
  }
  return out
}

function collectDescendantIds(
  startId: string,
  childMap: Map<string, Connection[]>,
  visibleIds: Set<string>
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const queue = [...(childMap.get(startId) ?? []).map((conn) => conn.target)]

  while (queue.length > 0) {
    const id = queue.shift()
    if (!id || seen.has(id) || visibleIds.has(id)) continue
    seen.add(id)
    result.push(id)
    queue.push(...(childMap.get(id) ?? []).map((conn) => conn.target))
  }

  return result
}

function generatedAspectIndexFromId(id: string | undefined): number | null {
  if (!id) return null
  const match = /^(?:aspect|noun|desc|detail)-(\d+)(?:-|$)/.exec(id)
  if (!match?.[1]) return null
  const index = Number.parseInt(match[1], 10)
  return Number.isFinite(index) ? index : null
}

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

function collectConnectedDescendantIds(
  startId: string,
  connections: Connection[],
  visibleIds: Set<string>
): string[] {
  const adjacency = new Map<string, string[]>()
  for (const conn of connections) {
    const sourceNeighbors = adjacency.get(conn.source) ?? []
    sourceNeighbors.push(conn.target)
    adjacency.set(conn.source, sourceNeighbors)

    const targetNeighbors = adjacency.get(conn.target) ?? []
    targetNeighbors.push(conn.source)
    adjacency.set(conn.target, targetNeighbors)
  }

  const result: string[] = []
  const seen = new Set<string>([startId])
  const queue = [...(adjacency.get(startId) ?? [])]

  while (queue.length > 0) {
    const id = queue.shift()
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (visibleIds.has(id)) continue
    result.push(id)
    queue.push(...(adjacency.get(id) ?? []))
  }

  return result
}

export function buildConceptMapExpertSkeleton(
  data: DiagramData | null | undefined
): ConceptMapExpertSkeleton | null {
  const nodes = data?.nodes ?? []
  const connections = data?.connections ?? []
  if (!nodes.length || !connections.length) return null

  const rootId = getTopicRootConceptTargetId(connections) ?? 'root'
  if (!nodes.some((node) => node.id === rootId)) return null

  const childMap = childrenBySource(connections)
  const rootChildConnections = childMap.get(rootId) ?? []
  const rootChildIds = rootChildConnections
    .map((conn) => conn.target)
    .filter((id) => nodes.some((node) => node.id === id))
  if (!rootChildIds.length) return null

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const))
  const visibleNodeIds = new Set(['topic', rootId, ...rootChildIds])
  const rootChildIdSet = new Set(rootChildIds)
  const visibleConnectionIds = new Set(
    connections
      .filter(
        (conn) =>
          visibleNodeIds.has(conn.source) &&
          visibleNodeIds.has(conn.target) &&
          (conn.source === 'topic' || conn.source === rootId)
      )
      .map((conn) => conn.id)
  )

  const branches: ExpertSkeletonBranch[] = []
  const branchNodeIds = new Map<string, string[]>()
  const branchIdByAspectIndex = new Map<number, string>()

  for (const branchId of rootChildIds) {
    const branchNode = nodeById.get(branchId)
    const branchName = (branchNode?.text ?? '').trim()
    if (!branchName) continue

    const aspectIndex = conceptMapAspectIndexFromNode(branchNode)
    if (aspectIndex !== null) {
      branchIdByAspectIndex.set(aspectIndex, branchId)
    }
    const nodeIds: string[] = []
    branches.push({ id: branchId, name: branchName, nodeIds })
    branchNodeIds.set(branchId, nodeIds)
  }

  const hiddenNodes = nodes.filter((node) => !visibleNodeIds.has(node.id))
  const assignedIds = new Set<string>()
  const assignNodeToBranch = (nodeId: string, branchId: string | null): boolean => {
    if (!branchId || assignedIds.has(nodeId) || visibleNodeIds.has(nodeId)) return false
    const node = nodeById.get(nodeId)
    if (!node?.id || !(node.text ?? '').trim()) return false
    const list = branchNodeIds.get(branchId)
    if (!list) return false
    list.push(nodeId)
    assignedIds.add(nodeId)
    return true
  }

  for (const node of hiddenNodes) {
    const aspectIndex = conceptMapAspectIndexFromNode(node)
    const branchId =
      aspectIndex !== null ? (branchIdByAspectIndex.get(aspectIndex) ?? null) : null
    assignNodeToBranch(node.id, branchId)
  }

  for (const node of hiddenNodes) {
    if (assignedIds.has(node.id)) continue
    const branchId = assignByParentChain(node, nodeById, rootChildIdSet)
    assignNodeToBranch(node.id, branchId)
  }

  for (const branchId of rootChildIds) {
    for (const nodeId of collectDescendantIds(branchId, childMap, visibleNodeIds)) {
      assignNodeToBranch(nodeId, branchId)
    }
  }

  for (const branchId of rootChildIds) {
    for (const nodeId of collectConnectedDescendantIds(branchId, connections, visibleNodeIds)) {
      assignNodeToBranch(nodeId, branchId)
    }
  }

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

  if (!branches.length || !suggestions.length) return null

  return {
    rootId,
    branches,
    suggestions,
    visibleNodeIds,
    visibleConnectionIds,
  }
}
