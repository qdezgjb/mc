"""
Concept Map · Text Generation Stream API
=========================================

提供给画布"概念图教学设计"专用的流式生成接口：
- POST /api/concept_map/generate-concept-map-text

为什么不复用 MindMate 的 /api/ai_assistant/stream？
    /api/ai_assistant/stream 走 Dify chatflow 工作流，里面通常含一个
    JSON 抽取 / Code 节点期望前序 LLM 输出 ```json...```。而概念图生成 prompt
    要求 LLM 输出**纯文本**（含【】「」『』 三类括号，且明确"不要返回 JSON"），
    会导致 Dify 工作流报：
        "Run failed: could not find json block in the output."
    本接口绕开 Dify，直接调 MindGraph 自家 LLM 服务（llm_service.chat_stream），
    按 SSE 协议流式返回纯文本 chunk。

字数兜底策略（auto-expand）：
    实测 Qwen 在 700-800 字下限指令下经常只输出 200-300 字就自然停止——
    这是 LLM 普遍弱点（擅长遵守上限不擅长遵守下限）。
    所以本接口在第一遍流式生成后，如果有效正文字符数不足
    _MIN_TARGET_CHARS（480 字），会**追加调一次** LLM 让它在原文基础上
    扩写到 700-800 字之间。扩写阶段：
      1. 先发一条 message 提示用户"正在自动扩充"；
      2. 非流式拿到完整扩写文；
      3. 通过 `message_replace` 事件把前端 streamingBuffer 整段替换为最终版本，
         避免编号 1./2./3./4. 重复污染解析；
      4. 再发 message_end 收尾。

输出协议（SSE）：
    data: {"event":"message","answer":"<chunk>"}\n\n
    ...
    # 仅当触发自动扩写时出现：
    data: {"event":"message_replace","answer":"<full final text>"}\n\n
    data: {"event":"message_end","answer":"<full text>"}\n\n
    或异常时：
    data: {"event":"error","error":"<message>"}\n\n

事件名（message / message_end / error / message_replace）与前端
useMindMate.handleStreamEvent 处理逻辑保持一致：调用方在前端复用同一套
流处理代码路径，不需要为本接口写新分支。

Copyright 2024-2025 北京思源智教科技有限公司 (Beijing Siyuan Zhijiao Technology Co., Ltd.)
All Rights Reserved
Proprietary License
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from models import Messages, get_request_language
from models.domain.auth import User
from services.llm import llm_service
from utils.auth import get_current_user_or_api_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/concept_map", tags=["concept_map"])


# ============================================================================
# Constants
# ============================================================================

# 软上限：避免接口被以超长 prompt 滥用调 LLM。
# 当前最长 i18n 模板 ~9K，加上图片素材最多 ~1.2K，留够缓冲到 16K。
_PROMPT_MAX_CHARS = 16_000

# 概念图层级文本目标 700-800 字（zh/canvas.ts 模板要求），
# 给 max_tokens 留足够缓冲覆盖中文/英文/繁体三语场景。
_GEN_MAX_TOKENS = 2500

# 字数下限阈值。低于该阈值触发自动扩写（带 20 字宽容度，避免在 700 字临界点反复扩写）。
_MIN_TARGET_CHARS = 680
_MAX_TARGET_CHARS = 820

# 扩写阶段 max_tokens（要更宽松，因为是基于已有原文重写补充）。
_EXPAND_MAX_TOKENS = 3000

# Model used only by the concept-map teaching-design text stream.
_CONCEPT_MAP_TEXT_MODEL = "deepseek"

# 提示用户正在扩写的中转文本（按语言分），插入第一次输出与扩写结果之间。
_EXPAND_NOTICE = {
    "zh": "\n\n（内容字数偏少，正在自动扩充至 700-800 字...）\n\n",
    "zh-tw": "\n\n（內容字數偏少，正在自動擴充至 700-800 字...）\n\n",
    "en": "\n\n(Content too short, auto-expanding to 700-800 words...)\n\n",
}


# ============================================================================
# Schemas
# ============================================================================


class GenerateConceptMapTextRequest(BaseModel):
    prompt: str = Field(
        ...,
        description=(
            "完整的 LLM prompt（前端用 i18n 模板拼好，包含焦点问题、参考素材等）。"
            "为避免后端重复维护中/英/繁三套同一段模板，prompt 由前端构造完整传入。"
        ),
    )
    language: str = Field(default="zh", description="期望输出语言，zh / en / zh-tw")


# ============================================================================
# Helpers
# ============================================================================


# 概念图编号行的正则：行首（允许前导空白）+ 1~9 的数字 + 半角点号。
# 用 MULTILINE 模式可以判断段中是否含至少一行编号行。
_NUMBERED_LINE_RE = re.compile(r"^\s*[1-9]\.", re.MULTILINE)

# 段落分隔：一个或多个空行（中间可以有空白）。
_PARAGRAPH_SPLIT_RE = re.compile(r"\n\s*\n+")

# 概念图括号字符集：包括 connectorA/B 用的「」、关键名词用的【】、动宾用的『』。
# 真正的概念图正文段必然包含至少一个这类括号；
# LLM 自己写的"说明段"（即使带 1./2./3./4. 编号）几乎从不塞这些括号。
_CONCEPT_BRACKET_RE = re.compile(r"[「」【】『』]")


# ----------------------------------------------------------------------------
# 连接词补全：LLM 即使按 prompt 工程也偶尔会漏写 connectorA 或 connectorB，
# 漏写处前端会回退到 "请输入关系..." 占位文字 (CurvedEdge.vue placeholder)，
# 严重影响概念图视觉效果。这里在最终输出前做一道字符串后处理：
#   - 编号开头未紧跟 「connectorA」 的，补一个；
#   - 【关键名词】之前最近非空白字符不是 」 的，补一个 「connectorB」。
# 选用一组语义中性的"轮询连接词"，避免全篇都用同一个词显得呆板。
# ----------------------------------------------------------------------------

# 简体 / 繁体共用同一组（繁体显示时这些词都可识读）。
_DEFAULT_CONNECTOR_A_CN = ("涉及", "包括", "源于", "依托于", "体现于", "主要在于")
_DEFAULT_CONNECTOR_B_CN = ("典型是", "包括", "涉及", "依靠", "通过", "以")
_DEFAULT_CONNECTOR_A_EN = ("involves", "includes", "stems from", "relies on", "lies in", "is shown by")
_DEFAULT_CONNECTOR_B_EN = ("such as", "includes", "via", "by means of", "typically", "exemplified by")

# 编号行匹配："1.xxx" / "  2.xxx"，捕获组 1 = 编号前缀含点号， 2 = 后续内容
_NUMBERED_LINE_FILL_RE = re.compile(r"^(\s*[1-9]\.\s*)(.+)$", re.MULTILINE)

# 关键名词节点的全角方括号
_KEY_NOUN_RE = re.compile(r"【[^【】\n]+】")


def _fill_missing_connectors(text: str, language: str) -> str:
    """
    对最终概念图正文做"连接词缺失补全"。

    保证调用后：
        - 每个 1./2./3./4. 编号开头都紧跟一对 `「...」` (connectorA)；
        - 每个 【...】 之前最近的非空白字符都是 `」` (即前面是 connectorB)。

    不动 `『』` 部分（缺 `『』` 的就是 Form B，无需补；多 `『』` 是格式异常
    交给前端解析器处理）。
    """
    if not text:
        return text

    is_cn = language != "en"
    pool_a = _DEFAULT_CONNECTOR_A_CN if is_cn else _DEFAULT_CONNECTOR_A_EN
    pool_b = _DEFAULT_CONNECTOR_B_CN if is_cn else _DEFAULT_CONNECTOR_B_EN

    a_counter = {"i": 0}
    b_counter = {"i": 0}

    # ----- Pass 1: 补编号后缺 connectorA ----------------------------------
    def _fill_connector_a(m: "re.Match[str]") -> str:
        prefix = m.group(1)
        rest = m.group(2)
        if rest.startswith("「"):
            return m.group(0)
        word = pool_a[a_counter["i"] % len(pool_a)]
        a_counter["i"] += 1
        return f"{prefix}「{word}」{rest}"

    text = _NUMBERED_LINE_FILL_RE.sub(_fill_connector_a, text)

    # ----- Pass 2: 补 【】 前缺 connectorB ---------------------------------
    out_parts: list[str] = []
    last_end = 0
    for match in _KEY_NOUN_RE.finditer(text):
        start = match.start()
        # 找 [ 前面最近的非空白字符
        j = start - 1
        while j >= 0 and text[j] in " \t\u3000":
            j -= 1
        prev_char = text[j] if j >= 0 else ""
        out_parts.append(text[last_end:start])
        if prev_char != "」":
            word = pool_b[b_counter["i"] % len(pool_b)]
            b_counter["i"] += 1
            out_parts.append(f"「{word}」")
        out_parts.append(match.group(0))
        last_end = match.end()
    out_parts.append(text[last_end:])
    return "".join(out_parts)


def _strip_meta_paragraphs(text: str) -> str:
    """
    去除 LLM 输出中混入的"说明性段落"，只保留概念图编号正文。

    背景：
        Qwen 在扩写阶段（甚至有时在第一次生成时）会在概念图编号正文之外
        额外输出一段说明，例如：
            "（字数共 547 字。在每个方面增加了详细描述，扩充至要求范围。）"
            "（全文共 768 字。共 4 个方面，关键名词共 12 个：1. xx 2. yy ...）"
            "以上是基于焦点问题的概念图分析..."
            "本次共生成 4 个方面，符合要求。"
        这些段落不属于概念图正文，但被原样推到 streamingBuffer 后既会在
        MindMate 聊天气泡里展示给用户（视觉污染），也会被
        parseDiagramGenerationResponse 当作非编号行丢弃（无功能用途）。

    实现（双重判据）：
        以"空行"做段分隔；只保留**同时**满足：
          1) 段内至少含一行 `^\\s*[1-9]\\.` 编号开头；
          2) 段内至少含一个概念图括号字符（「」/【】/『』）。
        早期版本只判第 1 条，但当 LLM 在说明段里也用 "1. xx 2. yy" 列表式
        子编号时整段会被误保留。加上"必须含括号"这条后，几乎所有"裸文字
        说明段"都会被识别并剥离。

    注意：
        - 不破坏每个编号块内部的换行（同一段内的延续行被原样保留）。
        - 如果整段输出完全没识别到合格的概念图编号块（极少数 LLM 完全没按
          格式回答），为避免清洗成空字符串，原样返回让上层判断。
    """
    if not text or not text.strip():
        return text

    paragraphs = _PARAGRAPH_SPLIT_RE.split(text)
    kept = []
    for p in paragraphs:
        p_stripped = p.strip()
        if not p_stripped:
            continue
        if (
            _NUMBERED_LINE_RE.search(p_stripped)
            and _CONCEPT_BRACKET_RE.search(p_stripped)
        ):
            kept.append(p_stripped)

    if not kept:
        # 没识别到合格编号块，不冒险清洗到空，原样返回让上层判断。
        return text.strip()

    return "\n\n".join(kept)


def _build_expand_prompt(original_text: str, language: str) -> str:
    """
    构造"扩写"阶段的 prompt：要求 LLM 在保留原文格式与方面数量的前提下，
    补足内容到 700-800 字。
    """
    if language == "en":
        return (
            "Below is the concept-map analysis text you just produced:\n\n"
            "---ORIGINAL START---\n"
            f"{original_text}\n"
            "---ORIGINAL END---\n\n"
            "However, it has only "
            f"{len(original_text)} characters, "
            "which is BELOW the 700~800-word HARD requirement.\n\n"
            "Please rewrite the original text under the following STRICT rules:\n"
            "1. **DO NOT** change the number of aspects, the numbering (1./2./3./4.) "
            "or valid existing connector words 「」. If a connector is only a discourse "
            "adverb/sequence word such as 'also', 'further', 'meanwhile', or 'then', "
            "rewrite it as a predicate relation phrase.\n"
            "2. For each aspect, ADD MORE Form-A key-noun chains "
            "(「connectorB」+【key noun】+『verb』+『object』) into the 'details' "
            "section, OR expand the existing 『verb』『object』 phrases with more detail.\n"
            "3. Final TOTAL length MUST fall STRICTLY between 700 and 800 words. "
            "If the expanded text exceeds 800, prune; below 700, expand more.\n"
            "4. All `「」` and `『』` MUST contain real, non-empty content. "
            "No empty brackets, no placeholder like '...', 'TBD', 'input relation'.\n"
            "5. Every edge must pass the proposition test: node A + connector + node B "
            "must read like a complete statement, not a transition phrase.\n"
            "6. Output **ONLY the full rewritten text** in the same format as the "
            "original. No diff, no explanation, no JSON, no introduction.\n"
        )

    if language == "zh-tw":
        return (
            "以下是你剛才輸出的概念圖分析正文：\n\n"
            "---原文開始---\n"
            f"{original_text}\n"
            "---原文結束---\n\n"
            f"但字數只有 {len(original_text)} 字，**未達到 700-800 字的硬性要求**。\n\n"
            "請以下列嚴格規則重寫原文：\n"
            "1. **不要**改變方面數量、不要修改編號 1./2./3./4. 與合格的已有連接詞 「」；若已有連接詞只是「同時」「進一步」等篇章詞，必須改成謂語/關係短語；\n"
            "2. 在每個方面的「具體內容」段中，**追加更多形態A 關鍵名詞鏈**\n"
            "   （即 「連接詞B」+【關鍵名詞】+『動詞』+『賓語』），\n"
            "   或對現有 『動詞』『賓語』 寫得更詳細；\n"
            "3. 整體字數**嚴格 700-800 字之間**，超 800 字必須精簡，低於 700 字必須再擴；\n"
            "4. 所有 `「」` 與 `『』` 必須有真實非空內容，禁止空括號、禁止 「…」「待補充」等占位；\n"
            "5. 每條邊都必須通過命題自檢：節點A + 連接詞 + 節點B 要能讀成完整句子，不能只是過渡詞；\n"
            "6. **只輸出**重寫後的完整正文，格式與原文一致，不要返回 diff、不要解釋、"
            "不要返回 JSON、不要任何前後綴說明。\n"
        )

    # default 简体中文
    return (
        "以下是你刚才输出的概念图分析正文：\n\n"
        "---原文开始---\n"
        f"{original_text}\n"
        "---原文结束---\n\n"
        f"但字数只有 {len(original_text)} 字，**未达到 700-800 字的硬性要求**。\n\n"
        "请以下列严格规则重写原文：\n"
        "1. **不要**改变方面数量、不要修改编号 1./2./3./4. 与合格的已有连接词 「」；若已有连接词只是“同时”“进一步”等篇章词，必须改成谓语/关系短语；\n"
        "2. 在每个方面的「具体内容」段中，**追加更多形态A 关键名词链**\n"
        "   （即 「连接词B」+【关键名词】+『动词』+『宾语』），\n"
        "   或对现有 『动词』『宾语』 写得更详细；\n"
        "3. 整体字数**严格 700-800 字之间**，超 800 字必须精简，低于 700 字必须再扩；\n"
        "4. 所有 `「」` 与 `『』` 必须有真实非空内容，禁止空括号、禁止「…」「待补充」等占位；\n"
        "5. 每条边都必须通过命题自检：节点A + 连接词 + 节点B 要能读成完整句子，不能只是过渡词；\n"
        "6. **只输出**重写后的完整正文，格式与原文一致，不要返回 diff、不要解释、"
        "不要返回 JSON、不要任何前后缀说明。\n"
    )


def _sse_event(event: str, **fields: object) -> str:
    """构造一条 SSE message，event 名 + 任意 JSON 字段。"""
    payload: dict = {"event": event, "timestamp": int(time.time() * 1000)}
    payload.update(fields)
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


# ============================================================================
# Endpoint
# ============================================================================


@router.post("/generate-concept-map-text")
async def generate_concept_map_text(
    payload: GenerateConceptMapTextRequest,
    _user: Optional[User] = Depends(get_current_user_or_api_key),
):
    """流式生成概念图层级文本（绕开 Dify，直接调自家 LLM）。"""
    lang = get_request_language(payload.language) if payload.language else "zh"

    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    if len(prompt) > _PROMPT_MAX_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"prompt too long (>{_PROMPT_MAX_CHARS} chars)",
        )

    logger.info(
        "[ConceptMapText] start: lang=%s prompt_chars=%d",
        lang,
        len(prompt),
    )

    async def generate():
        first_pass_text = ""
        final_text = ""
        expanded = False
        try:
            # =========================================================
            # Pass 1: 流式生成（用户实时看到正文逐字流出）
            # =========================================================
            async for chunk in llm_service.chat_stream(
                prompt=prompt,
                model=_CONCEPT_MAP_TEXT_MODEL,
                max_tokens=_GEN_MAX_TOKENS,
                temperature=0.7,
                request_type="concept_map_text_generation",
                endpoint_path="/api/concept_map/generate-concept-map-text",
                use_knowledge_base=False,
            ):
                if not chunk:
                    continue
                text_chunk = chunk if isinstance(chunk, str) else str(chunk)
                if not text_chunk:
                    continue
                first_pass_text += text_chunk
                yield _sse_event("message", answer=text_chunk)

            # 清洗 pass1 输出：
            #   1) 去除"说明段"（_strip_meta_paragraphs）
            #   2) 补齐缺失的 connectorA / connectorB（_fill_missing_connectors）
            # 只要清洗后的文本与原文不同（被剥说明段或被补连接词），就发一次
            # message_replace 让前端聊天气泡显示干净 + 完整连接词的版本。
            stripped_first = first_pass_text.strip()
            cleaned_first = _strip_meta_paragraphs(stripped_first)
            cleaned_first = _fill_missing_connectors(cleaned_first, lang)
            first_dirty = cleaned_first != stripped_first
            final_text = cleaned_first
            logger.info(
                "[ConceptMapText] pass1 done: raw=%d cleaned=%d dirty=%s (target=%d~%d)",
                len(stripped_first),
                len(cleaned_first),
                first_dirty,
                _MIN_TARGET_CHARS,
                _MAX_TARGET_CHARS,
            )

            # =========================================================
            # Pass 2 (可选): 字数不足时自动扩写。判断字数用清洗后的字符数，
            # 避免 LLM 用大段说明文字"凑字数"绕过下限。
            # =========================================================
            if (
                len(cleaned_first) < _MIN_TARGET_CHARS
                and len(cleaned_first) > 50  # 太短的输出更可能是 LLM 报错，不扩写
            ):
                expanded = True
                # 给用户一个可见提示
                notice = _EXPAND_NOTICE.get(lang, _EXPAND_NOTICE["zh"])
                yield _sse_event("message", answer=notice)

                # 扩写以"已清洗的 pass1"作为参考，免得 LLM 把说明段当成正文一起改写
                expand_prompt = _build_expand_prompt(cleaned_first, lang)
                expanded_text = ""
                async for chunk in llm_service.chat_stream(
                    prompt=expand_prompt,
                    model=_CONCEPT_MAP_TEXT_MODEL,
                    max_tokens=_EXPAND_MAX_TOKENS,
                    temperature=0.6,
                    request_type="concept_map_text_expand",
                    endpoint_path="/api/concept_map/generate-concept-map-text",
                    use_knowledge_base=False,
                ):
                    if not chunk:
                        continue
                    text_chunk = chunk if isinstance(chunk, str) else str(chunk)
                    if not text_chunk:
                        continue
                    expanded_text += text_chunk

                cleaned_expanded = _strip_meta_paragraphs(expanded_text.strip())
                cleaned_expanded = _fill_missing_connectors(cleaned_expanded, lang)
                if len(cleaned_expanded) >= len(cleaned_first):
                    final_text = cleaned_expanded
                    yield _sse_event("message_replace", answer=final_text)
                    logger.info(
                        "[ConceptMapText] pass2 expanded: raw=%d cleaned=%d (was %d)",
                        len(expanded_text.strip()),
                        len(cleaned_expanded),
                        len(cleaned_first),
                    )
                else:
                    # 扩写后反而更短，回退到 pass1 清洗版；如果 pass1 本身脏，仍发 replace
                    logger.warning(
                        "[ConceptMapText] pass2 shorter (cleaned=%d < %d), keep pass1 cleaned",
                        len(cleaned_expanded),
                        len(cleaned_first),
                    )
                    if first_dirty:
                        yield _sse_event("message_replace", answer=cleaned_first)
            elif first_dirty:
                # 字数够但 pass1 输出含说明段：只清洗，不扩写
                yield _sse_event("message_replace", answer=cleaned_first)

            # =========================================================
            # 收尾
            # =========================================================
            yield _sse_event("message_end", answer=final_text)
            logger.info(
                "[ConceptMapText] stream completed: final_chars=%d expanded=%s first_dirty=%s",
                len(final_text),
                expanded,
                first_dirty,
            )
        except Exception as e:
            logger.error(
                "[ConceptMapText] generation failed: %s", e, exc_info=True
            )
            try:
                err_msg = Messages.error("ai_error", lang=lang)  # type: ignore[arg-type]
            except Exception:
                err_msg = "AI service error"
            yield _sse_event("error", error=err_msg or str(e))

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
