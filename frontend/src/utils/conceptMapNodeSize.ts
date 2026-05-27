/**
 * 概念图（concept_map）非 topic 节点的统一尺寸 / 字号常量。
 *
 * 设计目的：让画布上**所有**概念图节点（无论来自哪条路径）视觉一致——
 *   1. 通过 CanvasToolbar "生成概念图" 流程批量构建的节点；
 *   2. 通过专家骨架图面板从 suggestion 卡片拖入画布的节点；
 *   3. 用户手动 addNode（双击空白、点击工具栏 +、复制粘贴等）的节点。
 *
 * 历史背景：之前只有路径 1 通过 `getGeneratedConceptNodeStyle` 给每个新
 * 节点显式设置了 `width / height / fontSize / fontWeight`；路径 2、3 完全
 * 不传 style，节点最终只继承 CSS 的 `.concept-node { min-width: 80px;
 * min-height: 36px }`，渲染出来明显比"生成"节点小，视觉割裂。
 *
 * 解决：把"生成"路径的非 isMajor 默认值（高 70 / 字号 22）作为概念图
 * 非 topic 节点的**全局缺省值**——`ConceptNode.vue` 在 `style.width`、
 * `style.height`、`style.fontSize`、`style.fontWeight` 缺失时从这里读，
 * 与 CanvasToolbar.vue 中的 isMajor 节点（高 78 / 字号 24 / bold）一起
 * 由同一组常量驱动，避免再次出现"两边数字漂移"。
 *
 * **不影响焦点问题（topic）节点**——它在 ConceptNode.vue 里有专属的
 * `topicDefaults = { width: 760, height: 104 }` 和字号 30，与本模块无关。
 */

/** 估算节点宽度的下限：再短的文本也至少这么宽，避免节点蜷缩成小气泡。 */
export const CONCEPT_MAP_NODE_WIDTH_MIN = 220

/** 估算节点宽度的上限：超过此值就不再增长，避免长文本节点把画布撑变形。 */
export const CONCEPT_MAP_NODE_WIDTH_MAX = 420

/** 概念图非 topic 节点的默认高度（与 CanvasToolbar 非 isMajor 路径一致）。 */
export const CONCEPT_MAP_NODE_HEIGHT = 70

/** 概念图非 topic 节点的默认字号（与 CanvasToolbar 非 isMajor 路径一致）。 */
export const CONCEPT_MAP_NODE_FONT_SIZE = 22

/** 概念图非 topic 节点的默认字重。'normal' 与 CanvasToolbar 非 isMajor 一致。 */
export const CONCEPT_MAP_NODE_FONT_WEIGHT = 'normal' as const

/**
 * 根据文本内容估算节点宽度。
 *
 * 经验拟合：90 px 基础宽 + 19 px/CJK + 12 px/拉丁字符；空白字符不计入。
 * 最终 clamp 到 `[CONCEPT_MAP_NODE_WIDTH_MIN, CONCEPT_MAP_NODE_WIDTH_MAX]`。
 *
 * 这跟 CanvasToolbar.vue 的旧版 `estimateGeneratedConceptNodeWidth` 行为
 * 完全一致，仅做了模块化迁移与常量抽取。
 */
export function estimateConceptMapNodeWidth(text: string | undefined | null): number {
  const plain = String(text ?? '')
    .replace(/\s+/gu, '')
    .trim()
  const chars = Array.from(plain)
  const cjkCount = chars.filter((ch) => /[\u4e00-\u9fff]/u.test(ch)).length
  const otherCount = Math.max(0, chars.length - cjkCount)
  const estimated = 90 + cjkCount * 19 + otherCount * 12
  return Math.max(
    CONCEPT_MAP_NODE_WIDTH_MIN,
    Math.min(estimated, CONCEPT_MAP_NODE_WIDTH_MAX)
  )
}
