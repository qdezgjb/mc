/**
 * conceptMapExtraction
 *
 * 将 "生成图示" 的大模型回答解析成层级结构：
 *   焦点问题 (topic) -> 根概念 (root) -> 方面/子主题 (level-2) -> 具体名词 (level-3)
 *
 * 约定：每一条以 "数字." 开头，随后是 "方面标题：具体内容" 的形式；
 * 例如：
 *   1.政治背景：清政府腐败无能，革命党人四起……
 *   2.经济背景：自然经济瓦解，民族资本主义发展……
 *
 * 名词性节点提取采用启发式分词：以常见标点、动词、连词、介词等作为分隔符，
 * 仅保留 2~8 字的、纯汉字/字母数字组成的片段作为名词候选。
 */

/**
 * 单个关键名词节点（level-3）及其可选的"前置连接词 + 动词 + 具体内容"。
 *
 * LLM 约定的输出格式为：
 *   「入边连接词」【名词】『动词』『具体内容』
 * 其中：
 *   - 前置的 `「 」`（方括号引号，`incomingConnector`）是 level-2 → level-3
 *     边上的 label，例如"以""通过""包括"。
 *   - `【 】` 里是名词主体，作为 level-3 节点文本。
 *   - 紧跟的第一对 `『 』`（直角引号，`connectorLabel`）是动词/谓语短语，
 *     作为 level-3 → level-4 边上的 label，例如"领导""使……沦为"。
 *   - 紧跟的第二对 `『 』`（`description`）是纯名词性宾语，作为 level-4
 *     节点文本，例如"全国反清革命运动"。
 *
 * 兼容旧格式 `【名词】『单段内容』`：只给一对 `『 』` 时，作为 `description`
 * 使用（没有 connectorLabel）；前置 `「 」` 缺失时 `incomingConnector` 留空。
 */
export interface ParsedNounItem {
  /** 名词文本（已去除【】与首尾助词）。 */
  text: string
  /** 该名词对当前方面的具体说明/宾语（去除『』后）。缺失时不生成 level-4 节点。 */
  description?: string
  /** level-3 → level-4 边上的连接词/动词短语；缺失时边无标签。 */
  connectorLabel?: string
  /** level-4 → level-5 边上的连接词/动词短语；缺失时不生成 level-5 节点。 */
  detailConnectorLabel?: string
  /** level-5 节点文本，用于把 level-4 再向下展开一层。 */
  detailDescription?: string
  /** 第二个 level-4 → level-5 分支的连接词/动词短语。 */
  secondaryDetailConnectorLabel?: string
  /** 第二个 level-5 分支节点文本。 */
  secondaryDetailDescription?: string
  /** level-2 → level-3 边上的连接词（来自紧邻【】之前的 `「...」`）；缺失时边无标签。 */
  incomingConnector?: string
}

export interface ParsedAspect {
  /** 方面标题，如 "政治背景"。若未找到冒号，则与整段首个片段相同。 */
  heading: string
  /** 冒号后的正文主体。 */
  body: string
  /** 从 body 中提取出的名词节点（含可选说明），已去重，按出现顺序。 */
  nouns: ParsedNounItem[]
  /** level-1 (root) → level-2 (aspect) 边上的连接词；缺失时边无标签。 */
  incomingConnector?: string
}

export interface ParsedConceptMapResponse {
  aspects: ParsedAspect[]
}

/**
 * 用作句内切分的"非名词"词汇/助词/动词/连词/副词。
 *
 * 这些词本身在生成的句子中通常担任"连接词 / 谓语 / 修饰语"的角色，
 * 切分后剩下的两侧更可能是名词短语。
 */
const NON_NOUN_WORDS: readonly string[] = [
  // 助词、副词、高频虚词
  '的',
  '了',
  '着',
  '过',
  '吗',
  '呢',
  '吧',
  '啊',
  '也',
  '就',
  '都',
  '又',
  '仍',
  '再',
  '将',
  '已',
  '要',
  '会',
  '能',
  '可',
  '还',
  '才',
  '更',
  '很',
  '太',
  '最',
  '颇',
  '甚',
  '愈',
  '尚',
  '乃',
  '即',
  '但',
  '而',
  '却',
  '则',
  '且',
  // 介词 / 连词
  '是',
  '有',
  '被',
  '让',
  '使',
  '由',
  '从',
  '到',
  '对',
  '向',
  '在',
  '以',
  '于',
  '为',
  '和',
  '与',
  '及',
  '并',
  '或',
  '如',
  '若',
  '则',
  '而',
  '之',
  '其',
  '所',
  '因',
  '若干',
  '因为',
  '由于',
  '所以',
  '因此',
  '然而',
  '但是',
  '不过',
  '而且',
  '并且',
  '以及',
  '以至',
  '以致',
  '尽管',
  '虽然',
  '同时',
  '随即',
  '随着',
  '伴随',
  '通过',
  '经由',
  '根据',
  '依据',
  '按照',
  '关于',
  '对于',
  '至于',
  '作为',
  '不仅',
  '不但',
  '一方面',
  '另一方面',
  '首先',
  '其次',
  '再次',
  '最后',
  '另外',
  '此外',
  '其中',
  '之中',
  '之间',
  '之后',
  '之前',
  '之下',
  '之上',
  // 常见动词（避免被误当名词）
  '进行',
  '实施',
  '实行',
  '实现',
  '开展',
  '展开',
  '开始',
  '结束',
  '停止',
  '发生',
  '出现',
  '产生',
  '形成',
  '构成',
  '成为',
  '变为',
  '转变',
  '演变',
  '变化',
  '改变',
  '改革',
  '推动',
  '促进',
  '带动',
  '带来',
  '引起',
  '引发',
  '导致',
  '造成',
  '致使',
  '使得',
  '让人',
  '迫使',
  '面临',
  '面对',
  '遭受',
  '遭到',
  '受到',
  '得到',
  '获得',
  '取得',
  '丧失',
  '失去',
  '掀起',
  '兴起',
  '蓬勃',
  '萌发',
  '萌生',
  '孕育',
  '激发',
  '激起',
  '推翻',
  '颠覆',
  '建立',
  '创立',
  '创建',
  '成立',
  '组建',
  '结盟',
  '联合',
  '瓦解',
  '破产',
  '动摇',
  '破坏',
  '破裂',
  '恶化',
  '加剧',
  '加深',
  '加大',
  '加重',
  '加强',
  '削弱',
  '扩大',
  '缩小',
  '发展',
  '壮大',
  '崛起',
  '扩张',
  '扩展',
  '增加',
  '增长',
  '减少',
  '下降',
  '上升',
  '提高',
  '降低',
  '落后',
  '腐败',
  '腐朽',
  '无能',
  '严峻',
  '严重',
  '严厉',
  '激烈',
  '剧烈',
  '强烈',
  '日益',
  '不断',
  '逐步',
  '逐渐',
  '迅速',
  '迅猛',
  '缓慢',
  '持续',
  '继续',
  '不再',
  '主要',
  '重要',
  '巨大',
  '庞大',
  '重大',
  '深刻',
  '广泛',
  '全面',
  '彻底',
  '直接',
  '间接',
  '积极',
  '消极',
  '迫切',
  '孕育',
  '萌芽',
  '活跃',
  '兴盛',
  '繁荣',
  '衰败',
  '衰落',
  '衰退',
  '需要',
  '要求',
  '确认',
  '实现',
  '证明',
  '缓解',
  '拓展',
  '提出',
  '提供',
  '带有',
  '具有',
  '拥有',
  '存在',
  '意识到',
  '认识到',
  '看到',
  '认为',
  '觉得',
  '认可',
  // 数量词
  '许多',
  '很多',
  '一些',
  '各种',
  '各类',
  '大量',
  '大批',
  '少量',
  '部分',
  '整个',
  '一切',
  '所有',
  // 其它常见非名词（避免漏到节点里）
  '激化',
  '初步',
  '初期',
  '消亡',
  '消失',
  '衰微',
  '衰亡',
  '式微',
  '蓬勃',
  '猛烈',
  '猛然',
  '普遍',
  '相继',
  '先后',
  '之后',
  '以往',
  '以前',
  '当时',
  '现今',
  '如今',
  '当下',
  '日前',
  '近期',
  '早期',
  '中期',
  '晚期',
  '末期',
  '整体',
  '总体',
  '综合',
  '根源',
  '源头',
  '背景',
  '原因',
  '结果',
  '后果',
  '影响',
  '意义',
  '作用',
  '价值',
  '特点',
  '特征',
  '方面',
  '层面',
  '角度',
  '方式',
  '方法',
  '措施',
  '手段',
  '过程',
  '阶段',
  '情况',
  '状况',
  '现状',
  '局面',
  '形势',
  '态势',
  '趋势',
  '方向',
  '关系',
  '联系',
  '基础',
  '条件',
  '前提',
  '核心',
  '重点',
  '关键',
  '主体',
  '主要',
  '次要',
  '问题',
  '挑战',
  '机遇',
  '机会',
] as const

/** 完全禁止作为名词输出的片段（即使通过了其它规则）。 */
const NON_NOUN_EXACT_BLOCK = new Set<string>(NON_NOUN_WORDS)

/** 用作分隔符的标点正则（中英文）。 */
const PUNCTUATION_SPLIT_RE =
  // eslint-disable-next-line no-useless-escape
  /[，。；、,;.\s:：()（）【】\[\]""''""「」《》—\-…~\?？!！\/\\|]+/u

/**
 * 以 NON_NOUN_WORDS 为分隔符切分字符串。
 * 最长词优先，避免将 "发展" 拆成 "发" + "展"。
 */
function splitByStopWords(text: string): string[] {
  // 按词长倒序，构造一个交替正则
  const sorted = [...NON_NOUN_WORDS].sort((a, b) => b.length - a.length)
  const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(?:${escaped.join('|')})+`, 'gu')
  return text.split(re).map((s) => s.trim()).filter(Boolean)
}

/** 仅保留由汉字 / 英文字母 / 数字构成的片段。 */
function isPlainCjkAlnum(s: string): boolean {
  return /^[\p{Script=Han}A-Za-z0-9]+$/u.test(s)
}

/**
 * 从文本中抽取被中文方括号 【…】 标记的名词（提示词显式约定用此作为名词标签），
 * 并同时抓取紧跟其后的中文直角引号 『…』 内的"具体说明"（level-4 节点内容）。
 *
 * 规则：
 *   - `【名词】` 与 `『说明』` 之间只允许出现 0~4 个空白字符；中间若出现任何
 *     其它字符（包括标点或下一个【），则视为该名词没有说明，`description`
 *     留空，避免把正文错当成说明。
 *   - 兼容半角 `[ ]` 作为名词次选、半角 `"…"` / 中文「…」作为说明次选。
 *   - 名词本身沿用原有的清洗与白名单；说明只做首尾空白/引号/标点的修剪，
 *     保留内部标点以便完整展示。
 */
export function extractMarkedNouns(text: string, maxCount: number = 4): ParsedNounItem[] {
  if (!text) return []
  const result: ParsedNounItem[] = []
  const seen = new Set<string>()
  // 整体格式（三段括号、按方向区分）：
  //   「aspect→noun 连接词」 【名词】 『noun→desc 动词』 『desc 具体内容(宾语)』
  //
  // - 前缀 `「...」`（方括号引号）：可选，作为 level-2→level-3 的 incomingConnector
  // - 主体 `【...】` 或半角 `[...]`：必须，为名词本身
  // - 后缀 `『...』`（直角引号）最多六对：第一/三/五对=动词，第二/四/六对=宾语
  //
  // 注意：前缀和后缀使用**不同**的引号家族（「」 vs 『』），避免把上一个名词
  // 的尾部宾语误判为下一个名词的前置连接词。
  const re =
    /(?:「\s*([^「」\n]{1,10}?)\s*」)?\s{0,4}(?:【\s*([^【】\n]+?)\s*】|\[\s*([^[\]\n]+?)\s*\])(?:\s{0,4}『\s*([^『』\n]{1,20}?)\s*』)?(?:\s{0,4}『\s*([^『』\n]{1,40}?)\s*』)?(?:\s{0,4}『\s*([^『』\n]{1,20}?)\s*』)?(?:\s{0,4}『\s*([^『』\n]{1,40}?)\s*』)?(?:\s{0,4}『\s*([^『』\n]{1,20}?)\s*』)?(?:\s{0,4}『\s*([^『』\n]{1,40}?)\s*』)?/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const rawNoun = (m[2] ?? m[3] ?? '').trim()
    if (!rawNoun) continue
    const clean = rawNoun
      .replace(/^[的了着过之其所也即就"'""'']+/u, '')
      .replace(/[的了着过,，。；;、.:："'""'']+$/u, '')
      .trim()
    if (!clean) continue
    if (clean.length < 1 || clean.length > 10) continue
    if (!/^[\p{Script=Han}A-Za-z0-9·\-·《》]+$/u.test(clean)) continue
    if (NON_NOUN_EXACT_BLOCK.has(clean)) continue
    if (seen.has(clean)) continue
    seen.add(clean)

    const rawIncoming = (m[1] ?? '').trim()
    const rawFirst = (m[4] ?? '').trim()
    const rawSecond = (m[5] ?? '').trim()
    const rawThird = (m[6] ?? '').trim()
    const rawFourth = (m[7] ?? '').trim()
    const rawFifth = (m[8] ?? '').trim()
    const rawSixth = (m[9] ?? '').trim()

    const incomingConnector = cleanConnector(rawIncoming)

    // 双段：第一段=动词（边 label）、第二段=宾语（level-4 节点）
    // 单段：模型偷工只给了一段；无法可靠区分是动词还是宾语
    //   → 把这一段合并进名词节点文本（如 "参数化（轨迹方程化简）"）
    //     这样既不丢失 LLM 给出的信息，又不会让 level-3→level-4 的边
    //     出现 label='' 时的 "请输入关系" 占位文本。
    let nodeText = clean
    let connectorLabel = ''
    let description = ''
    let detailConnectorLabel = ''
    let detailDescription = ''
    let secondaryDetailConnectorLabel = ''
    let secondaryDetailDescription = ''
    if (rawFirst && rawSecond) {
      connectorLabel = cleanConnector(rawFirst)
      description = cleanDescription(rawSecond, clean)
      if (description && rawThird && rawFourth) {
        detailConnectorLabel = cleanConnector(rawThird)
        detailDescription = cleanDescription(rawFourth, description)
        if (detailDescription && rawFifth && rawSixth) {
          secondaryDetailConnectorLabel = cleanConnector(rawFifth)
          secondaryDetailDescription = cleanDescription(rawSixth, description)
        }
      }
    } else if (rawFirst) {
      const tail = cleanDescription(rawFirst, clean)
      if (tail) {
        const combined = `${clean}（${tail}）`
        // 控制节点文本长度，避免超出节点框；超过阈值则直接丢弃 tail，
        // 宁可少一点信息也不画"无关系"的子节点。
        if (combined.length <= 28) nodeText = combined
      }
    }

    // 防止两个同义节点被合并文本后撞名（如"参数化（…）"出现两次）
    if (nodeText !== clean && seen.has(nodeText)) {
      // 同义合并已存在，回退到纯名词
      nodeText = clean
    }
    if (nodeText !== clean) seen.add(nodeText)

    const item: ParsedNounItem = { text: nodeText }
    if (description) item.description = description
    if (connectorLabel) item.connectorLabel = connectorLabel
    if (detailDescription) item.detailDescription = detailDescription
    if (detailConnectorLabel) item.detailConnectorLabel = detailConnectorLabel
    if (secondaryDetailDescription) item.secondaryDetailDescription = secondaryDetailDescription
    if (secondaryDetailConnectorLabel) item.secondaryDetailConnectorLabel = secondaryDetailConnectorLabel
    if (incomingConnector) item.incomingConnector = incomingConnector
    result.push(item)
    if (result.length >= maxCount) break
  }
  return result
}

/**
 * 清洗 level-4 具体内容文本（纯名词性宾语）。
 *
 * 现在 level-4 节点要求是**不含动词的纯名词短语**（如"革命运动""半殖民地社会"），
 * 与父名词之间的动词放在边上的 connectorLabel 上；因此除了基础的首尾清洗外，
 * 还会去除开头偶尔混入的动词/助词/副词，保证节点文本是干净的名词短语。
 *
 *   - 去掉首尾空白、常见标点、残留引号。
 *   - 去掉开头的动词 / 助词 / 副词（如"是/为/成为/推动/使/领导"等）。
 *   - 过滤过短（<2 字）或与名词完全相同的内容。
 *   - 过长（>24 字）的截断到 24 字。
 */
function cleanDescription(raw: string, nounText: string): string {
  if (!raw) return ''
  let s = raw
    .replace(/^[\s，,。.；;：:、"'""''「」『』（）()]+/u, '')
    .replace(/[\s，,。.；;：:、"'""''「」『』（）()]+$/u, '')
    .trim()
  if (!s) return ''

  // 去除开头的动词 / 助词 / 副词（LLM 偶尔会把动词塞进来）
  // 使用 NON_NOUN_WORDS 按最长优先逐步剥离，直到剩下的片段以名词开头。
  const sorted = [...NON_NOUN_WORDS].sort((a, b) => b.length - a.length)
  const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const leadRe = new RegExp(`^(?:${escaped.join('|')})+`, 'u')
  let prev: string
  do {
    prev = s
    s = s.replace(leadRe, '').replace(/^[\s，,。.；;：:、]+/u, '').trim()
  } while (s && s !== prev)

  if (!s) return ''
  if (s === nounText) return ''
  if (s.length < 2) return ''
  return s
}

/**
 * 清洗 level-3 → level-4 边上的连接词（动词短语）。
 * - 去除首尾空白、标点、引号。
 * - 限制长度 1~8 字；过长截断。
 */
function cleanConnector(raw: string): string {
  if (!raw) return ''
  let s = raw
    .replace(/^[\s，,。.；;：:、"'""''「」『』（）()]+/u, '')
    .replace(/[\s，,。.；;：:、"'""''「」『』（）()]+$/u, '')
    .trim()
  if (!s) return ''
  return s
}

const PLACEHOLDER_CONNECTOR_RE =
  /^(输入关系|请输入关系|关系|待补充|placeholder|todo|tbd|none|null)$/iu

const DISCOURSE_CONNECTOR_WORDS = new Set([
  '同时',
  '同时也',
  '进一步',
  '进一步地',
  '并且',
  '而且',
  '另外',
  '此外',
  '再者',
  '然后',
  '接着',
  '随后',
  '首先',
  '其次',
  '再次',
  '最后',
  '一方面',
  '另一方面',
  '总之',
  '综上',
  '因此',
  '所以',
  '然而',
  '但是',
  '不过',
])

const DISCOURSE_CONNECTOR_PREFIX_RE =
  /^(?:同时|进一步|并且|而且|另外|此外|再者|然后|接着|随后|首先|其次|再次|最后|一方面|另一方面|总之|综上|因此|所以|然而|但是|不过)(?:也|地)?/u

function repairConnector(cleaned: string): string {
  if (!cleaned) return ''
  if (PLACEHOLDER_CONNECTOR_RE.test(cleaned)) return ''
  const repaired = cleanConnector(cleaned.replace(DISCOURSE_CONNECTOR_PREFIX_RE, ''))
  if (repaired !== cleaned) {
    if (!repaired || PLACEHOLDER_CONNECTOR_RE.test(repaired)) return ''
    if (DISCOURSE_CONNECTOR_WORDS.has(repaired)) return ''
    return repaired
  }
  if (DISCOURSE_CONNECTOR_WORDS.has(cleaned)) return ''
  return cleaned
}

/**
 * 从一段句子中提取名词性节点（启发式回退方案）。
 * - 先按标点切分为短语
 * - 再用停用词表（动词/介词/连词/副词）切分
 * - 过滤 2~8 字、仅汉字/字母/数字、非停用词
 * - 按出现顺序去重
 *
 * @param text 原始句子
 * @param maxCount 每段最多保留的名词数（避免层级过宽）
 */
export function extractNounTokens(text: string, maxCount: number = 4): ParsedNounItem[] {
  if (!text) return []

  const result: ParsedNounItem[] = []
  const seen = new Set<string>()

  const phrases = text.split(PUNCTUATION_SPLIT_RE).filter(Boolean)

  for (const phrase of phrases) {
    const segments = splitByStopWords(phrase)
    for (const raw of segments) {
      let seg = raw.trim()
      // 去掉前后残留的助词/常见虚字
      seg = seg.replace(/^[的了着过之其所也即就]+/u, '')
      seg = seg.replace(/[的了着过]+$/u, '')
      if (!seg) continue
      if (seg.length < 2 || seg.length > 8) continue
      if (!isPlainCjkAlnum(seg)) continue
      if (NON_NOUN_EXACT_BLOCK.has(seg)) continue
      if (seen.has(seg)) continue
      seen.add(seg)
      result.push({ text: seg })
      if (result.length >= maxCount) return result
    }
  }

  return result
}

/**
 * 将 "生成图示" 返回的大段文本解析为若干 "方面"。
 * 兼容 "1." "1、" "1）" "一、" 等编号形式，以及 "政治背景：xxx" / "政治背景（xxx）" 结构。
 */
export function parseDiagramGenerationResponse(text: string): ParsedConceptMapResponse {
  if (!text) return { aspects: [] }

  const normalized = text.replace(/\r\n?/g, '\n').trim()

  // 兼容阿拉伯数字 / 中文数字 / 括号式编号；允许行首、换行或常见句末标点后出现
  // 例如： "1." "2、" "3）" "(4)" "一、" "二、"
  // 之所以放宽到 [。．！!？?；;]，是因为不少 LLM 返回的文本把 4 条内容串在一行，
  // 仅用句号/分号分隔，若强制要求 \n 会导致只能识别第 1 条。
  const itemStartRe =
    /(?:^|[\n。．！!？?；;])\s*(?:[（(]?\s*(?:\d{1,2}|[一二三四五六七八九十])\s*[.．、)）])\s*/gu

  const collectParts = (re: RegExp): string[] => {
    const out: string[] = []
    const ms = Array.from(normalized.matchAll(re))
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]
      const contentStart = (m.index ?? 0) + m[0].length
      const contentEnd =
        i + 1 < ms.length ? (ms[i + 1].index ?? normalized.length) : normalized.length
      const piece = normalized.slice(contentStart, contentEnd).trim()
      if (piece) out.push(piece)
    }
    return out
  }

  let parts = collectParts(itemStartRe)

  // 再退一步：仍然只有 0/1 条时，使用"非数字字符 + 数字编号"的宽松切分，
  // 以适配 LLM 把四条内容紧挨在一行的场景。
  if (parts.length < 2) {
    const looseRe =
      /(?:^|[^0-9A-Za-z])\s*(?:[（(]?\s*(?:\d{1,2}|[一二三四五六七八九十])\s*[.．、)）])\s*/gu
    const loose = collectParts(looseRe)
    if (loose.length > parts.length) parts = loose
  }

  if (parts.length === 0) {
    for (const line of normalized.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
      parts.push(line)
    }
  }

  const aspects: ParsedAspect[] = []
  for (const rawPart of parts) {
    if (!rawPart) continue

    // 1) 优先剥离开头的 `「...」`——这是 root→aspect 的连接词（连接词A）。
    //    形如 `「体现为」政治背景：xxx` → incomingConnector = "体现为"，
    //    剩余文本 `政治背景：xxx` 进入标题/正文拆分。
    let remainder = rawPart
    let aspectIncomingConnector = ''
    const leadRe = /^\s*「\s*([^「」\n]{1,10}?)\s*」\s*/u
    const leadMatch = remainder.match(leadRe)
    if (leadMatch) {
      aspectIncomingConnector = cleanConnector(leadMatch[1].trim())
      remainder = remainder.slice(leadMatch[0].length)
    }

    // 2) 拆 "标题：正文"；兼容全角/半角冒号、括号等
    const { heading, body } = splitHeadingAndBody(remainder)
    if (!heading && !body) continue

    const source = body || remainder

    // 3) 优先抽取 LLM 显式用【】标出的名词；未标注时退化到启发式切词。
    //    关键名词只信任【】的结果，避免把"激化/初步/消亡"这类非名词漏进来。
    let nouns = extractMarkedNouns(source, 4)
    if (nouns.length === 0) {
      nouns = extractNounTokens(source, 4)
    }
    if (nouns.length === 0) {
      const fallbackNoun = normalizeAspectHeading(heading, source) || '核心概念'
      nouns = [{ text: fallbackNoun }]
    }

    const aspect: ParsedAspect = {
      heading: normalizeAspectHeading(heading, source),
      body: source,
      nouns,
    }
    if (aspectIncomingConnector) aspect.incomingConnector = aspectIncomingConnector
    aspects.push(aspect)
  }

  return { aspects }
}

/** 标题若被意外带上了【】或首尾标点，清理一下。 */
function cleanHeading(heading: string): string {
  return heading
    .replace(/【\s*([^【】]+?)\s*】/gu, '$1')
    .replace(/^[\s"'""''「」]+|[\s"'""''「」]+$/gu, '')
    .trim()
}

function normalizeAspectHeading(heading: string, source: string): string {
  const cleaned = cleanHeading(heading)
  if (cleaned) return cleaned

  const nouns = extractMarkedNouns(source, 1)
  if (nouns[0]?.text) return nouns[0].text

  const fallbackNouns = extractNounTokens(source, 1)
  if (fallbackNouns[0]?.text) return fallbackNouns[0].text

  return '核心方面'
}

/**
 * 拆分 "政治背景：xxxxxx" / "政治背景（xxxxxx）" / "政治背景 xxx"。
 */
function splitHeadingAndBody(text: string): { heading: string; body: string } {
  const t = text.trim()
  if (!t) return { heading: '', body: '' }

  // 先尝试中英文冒号
  const colonMatch = t.match(/^([^:：()（）\n]{2,28})[\s]*[:：]\s*([\s\S]+)$/u)
  if (colonMatch) {
    return { heading: colonMatch[1].trim(), body: colonMatch[2].trim() }
  }

  // 再尝试括号形式： "政治背景（xxx）..."
  const bracketMatch = t.match(/^([^\s:：()（）]{2,12})[\s]*[（(](.+)$/u)
  if (bracketMatch) {
    const body = bracketMatch[2].replace(/[）)]\s*$/u, '').trim()
    return { heading: bracketMatch[1].trim(), body }
  }

  // 取前 2~8 字作为标题，余下为 body
  // 先以空格/标点分第一段
  const firstChunk = t.split(/[\s,，。；;、.:：()（）]/u).find(Boolean) || t
  if (firstChunk.length >= 2 && firstChunk.length <= 12) {
    const body = t.slice(firstChunk.length).replace(/^[\s,，。；;、.:：()（）]+/u, '').trim()
    return { heading: firstChunk, body }
  }

  return { heading: '', body: t }
}

// ============================================================================
// 根节点关键词提取（从焦点问题中提炼宏观主题）
// ============================================================================

/**
 * 从焦点问题中提取根节点文本。
 *   "辛亥革命的背景是什么？" → "辛亥革命的背景"
 *   "什么是光合作用？"       → "光合作用"
 *   "如何理解相对论"         → "相对论"
 */
export function extractRootFromFocusQuestion(question: string): string {
  let q = question.trim()
  if (!q) return ''

  q = q.replace(/[？?。．.！!,，、；;:：\s]+$/u, '')

  const zhTailRegex =
    /(是什么|是什麼|有哪些|有哪幾種|有什麼|有什么|为什么|為什麼|怎么样|怎麼樣|怎么办|怎麼辦|怎么|怎麼|如何|呢|吗|嗎)$/u
  for (let i = 0; i < 3; i++) {
    const next = q.replace(zhTailRegex, '').trim()
    if (next === q) break
    q = next
  }

  q = q.replace(/^(什么是|什麼是|怎样|怎樣|怎么|怎麼|如何|为何|為何)\s*/u, '').trim()
  q = q.replace(/的$/u, '').trim()

  q = q.replace(/^(what\s+is|what\s+are|how\s+(does|do|can)|why\s+(does|do|is|are))\s+/iu, '')
  q = q.replace(/\?+$/u, '').trim()

  if (q.length < 2) {
    return question.trim().replace(/[？?。．.！!]+$/u, '')
  }
  return q
}

// ============================================================================
// 层级布局：焦点问题 → 根 → 方面 → 名词 → 说明
// ============================================================================

/** 每一层之间的纵向间距（保持一致）。 */
export const HIERARCHY_LEVEL_GAP = 270

/**
 * 名词节点（level-3）/说明节点（level-4）之间的横向最小间距。
 *
 * level-4 节点承载 6~12 字的"短谓语说明"（与父名词连读成一句话），
 * 宽度较 level-3 略大但仍可控，200 px 足以避免相邻说明节点水平重叠。
 */
export const HIERARCHY_CHILD_H_SPACING = 390

/** 方面（level-2）列之间的额外留白。 */
export const HIERARCHY_SECTION_GAP = 190

/** 生成概念图节点的基础宽度。实际渲染会按文本再放大。 */
const HIERARCHY_NODE_WIDTH = 220
const HIERARCHY_NODE_HEIGHT = 70
const HIERARCHY_NODE_MIN_GAP = 70
const HIERARCHY_DETAIL_BRANCH_X_GAP = 190
const HIERARCHY_DETAIL_SINGLE_X_GAP = 96

const MAX_NODE_TEXT_BY_LEVEL = {
  1: 12,
  2: 8,
  3: 9,
  4: 10,
  5: 10,
} as const

const STAGGER_X = 36

/**
 * 同层节点的 Y 抖动量（"上下起伏"）。
 *
 * 用一个简单的伪随机相位把同层节点的 Y 坐标分散到 [-68, -34, 0, +34, +68]
 * 这 5 个挡位上，产生视觉错落感、避免整层节点像被尺子拉成一条直线。
 *
 * 选 ±68 的上限是因为：
 *   - HIERARCHY_NODE_HEIGHT (70) + HIERARCHY_NODE_MIN_GAP (70) = 140 是
 *     `avoidSameLayerOverlaps` 用来判断"同层水平推开"的阈值；
 *   - 任意两节点 Y 差最大 136 (< 140)，仍能触发同层水平避让；
 *   - 同时离上下层 (HIERARCHY_LEVEL_GAP=270) 的距离仍有 >200 px，
 *     不会让某一层的节点视觉上"跑进"上一层或下一层。
 *
 * 不同层使用不同的 seed 配方（见调用点），让父子节点不会同向偏移成
 * "整列平移"，从而真的产生层与层之间的错落感。
 */
function staggerY(seed: number): number {
  const slot = ((seed % 5) + 5) % 5
  return (slot - 2) * 34
}

function estimateNodeWidth(text: string): number {
  const plain = compactNodeText(text, 0)
  const cjkCount = Array.from(plain).filter((ch) => /[\u4e00-\u9fff]/u.test(ch)).length
  const otherCount = Math.max(0, Array.from(plain).length - cjkCount)
  const estimated = 90 + cjkCount * 19 + otherCount * 12
  return Math.max(HIERARCHY_NODE_WIDTH, Math.min(estimated, 420))
}

function positionXForCenter(centerX: number, text: string): number {
  return centerX - estimateNodeWidth(text) / 2
}

function avoidSameLayerOverlaps(nodes: HierarchyNodeLayout[]): void {
  for (const level of [1, 2, 3, 4, 5] as const) {
    const layerNodes = nodes
      .filter((node) => node.level === level)
      .sort((a, b) => a.position.x - b.position.x)

    for (let i = 0; i < layerNodes.length; i++) {
      const current = layerNodes[i]
      const currentWidth = estimateNodeWidth(current.text)
      let requiredX = current.position.x

      for (let j = 0; j < i; j++) {
        const previous = layerNodes[j]
        const previousWidth = estimateNodeWidth(previous.text)
        const verticallyClose =
          Math.abs(previous.position.y - current.position.y) <
          HIERARCHY_NODE_HEIGHT + HIERARCHY_NODE_MIN_GAP
        if (!verticallyClose) continue

        const previousRight = previous.position.x + previousWidth
        requiredX = Math.max(requiredX, previousRight + HIERARCHY_NODE_MIN_GAP)
      }

      current.position.x = requiredX
    }
  }
}

function compactNodeText(text: string, maxChars: number): string {
  const s = (text || '')
    .replace(/[「」『』【】[\]（）()]/gu, '')
    .replace(/\s+/gu, '')
    .trim()
  if (!s) return ''
  // Do not hard-cut generated concepts. A raw slice can turn "人工智能" into
  // "人工智", which is worse than a slightly longer node. Shortness is enforced
  // in the generation prompt; this function only removes wrapper punctuation.
  void maxChars
  return s
}

function ensureConnector(label: string | undefined, fallback: string): string {
  const repaired = repairConnector(cleanConnector(label || ''))
  return repaired || fallback
}

function conciseFallbackBase(text: string): string {
  const cleaned = compactNodeText(text, MAX_NODE_TEXT_BY_LEVEL[4])
  if (!cleaned) return ''
  const parts = cleaned.split(/[与和及、并]/u).map((part) => part.trim()).filter(Boolean)
  const shortPart = parts.find((part) => part.length >= 2 && part.length <= 10)
  return shortPart || (cleaned.length <= 10 ? cleaned : '')
}

function fallbackLevel4Text(nounText: string, aspectHeading: string): string {
  const base = conciseFallbackBase(aspectHeading) || conciseFallbackBase(nounText)
  return compactNodeText(`${base}要点`, MAX_NODE_TEXT_BY_LEVEL[4]) ||
    compactNodeText(`${nounText}作用`, MAX_NODE_TEXT_BY_LEVEL[4]) ||
    '核心要点'
}

function resolvedLevel5Connector(nounItem: ParsedNounItem): string {
  return ensureConnector(nounItem.detailConnectorLabel, '表现为')
}

function resolvedSecondaryLevel5Connector(nounItem: ParsedNounItem): string {
  return ensureConnector(nounItem.secondaryDetailConnectorLabel, '表现为')
}

export interface HierarchyInput {
  /** 焦点问题节点的 position.x（左上角）。 */
  topicX: number
  /** 焦点问题节点的 position.y（左上角）。 */
  topicY: number
  /** 焦点问题节点的实际宽度（用于计算 X 中心）。未提供则用默认。 */
  topicWidth?: number
  /** 根节点文本。 */
  rootText: string
  /** 从回答中解析出的方面。 */
  aspects: ParsedAspect[]
}

export interface HierarchyNodeLayout {
  id: string
  text: string
  position: { x: number; y: number }
  parentId: string | null
  /** 1=根概念，2=方面，3=关键名词，4=名词的具体说明，5=说明的再展开。 */
  level: 1 | 2 | 3 | 4 | 5
}

export interface HierarchyLayoutResult {
  nodes: HierarchyNodeLayout[]
  /** (sourceId, targetId) 列表；可选 label（仅 level-3→level-4 会带）。 */
  edges: Array<{ source: string; target: string; label?: string }>
}

/**
 * 按 "焦点(顶) → 根 → 方面 → 名词 → 具体说明(底)" 的顺序，上下排布所有节点。
 * 各层纵向间距相同；同层水平居中排布；level-4 说明节点与其 level-3 父名词
 * 在同一 X 居中位置，直接垂直向下一层。
 */
export function computeHierarchyLayout(input: HierarchyInput): HierarchyLayoutResult {
  const { topicX, topicY, rootText, aspects } = input
  const topicWidth = input.topicWidth ?? HIERARCHY_NODE_WIDTH
  const nodeHalf = HIERARCHY_NODE_WIDTH / 2
  const topicCenterX = topicX + topicWidth / 2

  // 层级 Y（左上角坐标；各节点默认 50 左右高度，间距一致即可）
  const rootY = topicY + HIERARCHY_LEVEL_GAP
  const aspectY = rootY + HIERARCHY_LEVEL_GAP
  const nounY = aspectY + HIERARCHY_LEVEL_GAP
  const descY = nounY + HIERARCHY_LEVEL_GAP
  const detailY = descY + HIERARCHY_LEVEL_GAP

  const nodes: HierarchyNodeLayout[] = []
  const edges: Array<{ source: string; target: string; label?: string }> = []
  let detailIndex = 0

  // ---- 根节点（仅 1 个）
  // 注意：焦点问题（topic）与根节点（root）之间**不建立连线**，
  // 只做空间位置上的层级关系；避免视觉上顶部出现多余的一条长线。
  nodes.push({
    id: 'root',
    text: compactNodeText(rootText, MAX_NODE_TEXT_BY_LEVEL[1]) || rootText,
    position: { x: topicCenterX - nodeHalf, y: rootY },
    parentId: null,
    level: 1,
  })

  if (aspects.length === 0) {
    return { nodes, edges }
  }

  // ---- 计算每个方面的列宽：按其子名词数量分配水平空间
  const sectionWidths = aspects.map((a) => {
    const n = Math.max(1, a.nouns.length)
    return n * HIERARCHY_CHILD_H_SPACING
  })
  const totalWidth =
    sectionWidths.reduce((s, w) => s + w, 0) +
    Math.max(0, aspects.length - 1) * HIERARCHY_SECTION_GAP

  // 水平整体居中于根节点 / 焦点节点
  const startX = topicCenterX - totalWidth / 2

  let cursor = startX
  aspects.forEach((aspect, aIdx) => {
    const width = sectionWidths[aIdx]
    const sectionCenterX = cursor + width / 2
    const aspectCenterX = sectionCenterX + (aIdx % 2 === 0 ? -STAGGER_X : STAGGER_X)

    const aspectId = `aspect-${aIdx}`
    const aspectYOffset = staggerY(aIdx * 2)
    nodes.push({
      id: aspectId,
      text: compactNodeText(aspect.heading, MAX_NODE_TEXT_BY_LEVEL[2]) || aspect.heading,
      position: { x: aspectCenterX - nodeHalf, y: aspectY + aspectYOffset },
      parentId: 'root',
      level: 2,
    })
    {
      const e: { source: string; target: string; label?: string } = {
        source: 'root',
        target: aspectId,
        label: ensureConnector(aspect.incomingConnector, '体现为'),
      }
      edges.push(e)
    }

    // 子名词（level-3）及其可选说明（level-4）
    const childCount = aspect.nouns.length
    if (childCount > 0) {
      // 子节点在 [cursor, cursor+width] 区间内等间距居中
      for (let i = 0; i < childCount; i++) {
        const childCenterX = cursor + HIERARCHY_CHILD_H_SPACING * (i + 0.5)
        const rowOffset = (aIdx + i) % 2 === 0 ? -STAGGER_X : STAGGER_X
        const nounCenterX = childCenterX - rowOffset
        const descCenterX = childCenterX + rowOffset
        const nounItem = aspect.nouns[i]
        const nounId = `noun-${aIdx}-${i}`
        const nounText = compactNodeText(nounItem.text, MAX_NODE_TEXT_BY_LEVEL[3]) || nounItem.text
        const nounYOffset = staggerY(aIdx * 3 + i * 2)
        nodes.push({
          id: nounId,
          text: nounText,
          position: { x: nounCenterX - nodeHalf, y: nounY + nounYOffset },
          parentId: aspectId,
          level: 3,
        })
        {
          const e: { source: string; target: string; label?: string } = {
            source: aspectId,
            target: nounId,
            label: ensureConnector(nounItem.incomingConnector, '包含'),
          }
          edges.push(e)
        }

        // level-4：该名词对应的"具体内容"节点（纯名词短语），
        // level-3→level-4 的连接词（动词）作为边 label 显示。
        const rawDesc = nounItem.description || fallbackLevel4Text(nounText, aspect.heading)
        const descText = compactNodeText(rawDesc, MAX_NODE_TEXT_BY_LEVEL[4]) || rawDesc
        const descId = `desc-${aIdx}-${i}`
        const descYOffset = staggerY(aIdx * 5 + i * 3 + 1)
        nodes.push({
          id: descId,
          text: descText,
          position: { x: descCenterX - nodeHalf, y: descY + descYOffset },
          parentId: nounId,
          level: 4,
        })
        const edge: { source: string; target: string; label?: string } = {
          source: nounId,
          target: descId,
          label: ensureConnector(nounItem.connectorLabel, '表现为'),
        }
        edges.push(edge)

        if (nounItem.detailDescription) {
          const detailYOffset = staggerY(detailIndex * 3 + aIdx + i)
          const shouldAddSecondDetail = Boolean(nounItem.secondaryDetailDescription)
          const rawDetail = nounItem.detailDescription
          const detailText = compactNodeText(rawDetail, MAX_NODE_TEXT_BY_LEVEL[5]) || rawDetail
          const descVisualCenterX = descCenterX
          const singleDetailSide = detailIndex % 2 === 0 ? -1 : 1
          const firstDetailCenterX = shouldAddSecondDetail
            ? descVisualCenterX - HIERARCHY_DETAIL_BRANCH_X_GAP
            : descVisualCenterX + singleDetailSide * HIERARCHY_DETAIL_SINGLE_X_GAP
          const detailId = `detail-${aIdx}-${i}`
          nodes.push({
            id: detailId,
            text: detailText,
            position: {
              x: positionXForCenter(firstDetailCenterX, detailText),
              y: detailY + detailYOffset,
            },
            parentId: descId,
            level: 5,
          })
          const detailEdge: { source: string; target: string; label?: string } = {
            source: descId,
            target: detailId,
            label: resolvedLevel5Connector(nounItem),
          }
          edges.push(detailEdge)

          if (shouldAddSecondDetail) {
            const rawSecondDetail = nounItem.secondaryDetailDescription || ''
            const secondDetailText =
              compactNodeText(rawSecondDetail, MAX_NODE_TEXT_BY_LEVEL[5]) || rawSecondDetail
            const secondDetailId = `detail-${aIdx}-${i}-b`
            const secondDetailCenterX = descVisualCenterX + HIERARCHY_DETAIL_BRANCH_X_GAP
            nodes.push({
              id: secondDetailId,
              text: secondDetailText,
              position: {
                x: positionXForCenter(secondDetailCenterX, secondDetailText),
                y: detailY + detailYOffset + 116,
              },
              parentId: descId,
              level: 5,
            })
            const secondDetailEdge: { source: string; target: string; label?: string } = {
              source: descId,
              target: secondDetailId,
              label: resolvedSecondaryLevel5Connector(nounItem),
            }
            edges.push(secondDetailEdge)
          }
          detailIndex += 1
        }
      }
    }

    cursor += width + HIERARCHY_SECTION_GAP
  })

  avoidSameLayerOverlaps(nodes)

  return { nodes, edges }
}
