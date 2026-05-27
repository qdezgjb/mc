"""
Concept Map · Text Generation Stream API
=========================================

提供给画布"概念图教学设计"专用的流式生成接口：
- POST /api/concept_map/generate-concept-map-text

为什么直接调 Qwen Dashscope 兼容接口（不走 Dify 也不走 llm_service）？
    1. /api/ai_assistant/stream 走 Dify chatflow 工作流，里面通常含一个
       JSON 抽取 / Code 节点期望前序 LLM 输出 ```json...```。而概念图生成
       prompt 要求 LLM 输出**纯文本**（含【】「」『』 三类括号，且明确
       "不要返回 JSON"），会导致 Dify 报：
           "Run failed: could not find json block in the output."
    2. 项目内的 llm_service 走负载均衡 / 速率限制 / 知识库注入 / Token
       计费等通用链路，不便在这种需要硬约束 prompt + SSE 长连接的场景里
       做精细控制（例如温度、超时、流式 reasoning 分流）。
    本接口因此**直接调 Qwen 的 Dashscope OpenAI 兼容 chat completions**
    （默认模型 `qwen-plus-latest`），按 SSE 协议流式返回纯文本 chunk。
    配置见 .env 中 QWEN_API_KEY / QWEN_API_URL / QWEN_MODEL_GENERATION。

输出清洗策略：
    本接口不再做字数不足后的二次扩写。第一遍生成后只做两类收口：
      1. 剥离 LLM 误写出的字数统计、关键名词统计、自检/校验修正等说明性内容；
      2. 必要时补齐缺失的连接词，或执行一次五层结构修复。
    清洗或结构修复后的完整结果会通过 `message_replace` 覆盖前端缓冲区。

输出协议（SSE）：
    data: {"event":"message","answer":"<chunk>"}\n\n
    ...
    # 仅当清洗或结构修复需要覆盖已显示内容时出现：
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
import os
import re
import time
from typing import AsyncGenerator, Optional, TypedDict

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from models import Messages, get_request_language
from models.domain.auth import User
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

# 字数目标范围仅用于日志观察；低于下限不再触发自动扩写。
_MIN_TARGET_CHARS = 680
_MAX_TARGET_CHARS = 820

# 结构修复阶段 max_tokens。这里只用于必要的五层链条修复，不再做字数扩写。
_REPAIR_MAX_TOKENS = 3000

# 日志中文本预览的头/尾字符数。整段太长时只显示头尾；中间用占位符。
# 实际生产环境一段概念图正文 ~700-800 字，加上 prompt 拼接 ~9K 字，全部
# 打到日志会让单次请求日志膨胀，用 head+tail 截断可读性更好。
_LOG_PREVIEW_HEAD = 800
_LOG_PREVIEW_TAIL = 400


def _preview(text: object, head: int = _LOG_PREVIEW_HEAD, tail: int = _LOG_PREVIEW_TAIL) -> str:
    """
    把任意文本/对象截断为"头部 + ... 中间省略 ... + 尾部"的预览字符串，方便
    打到日志而不爆炸。返回值只用于日志展示，不参与业务计算。

    短文本（≤ head + tail + 50）直接原样返回；长文本只显示头尾。
    把换行替换为 ⏎ 字面量，避免单条日志被换行打散。
    """
    if text is None:
        return "<None>"
    s = str(text)
    if not s:
        return "<empty>"
    n = len(s)

    def _flatten(seg: str) -> str:
        return seg.replace("\r\n", "⏎").replace("\n", "⏎").replace("\r", "⏎")

    if n <= head + tail + 50:
        return _flatten(s)
    head_part = _flatten(s[:head])
    tail_part = _flatten(s[-tail:])
    return f"{head_part} … <省略 {n - head - tail} 字> … {tail_part}"

# ----------------------------------------------------------------------------
# Qwen Dashscope (OpenAI 兼容) 直连配置
#
# 概念图教学设计文本生成专用通道：直接调阿里云 Dashscope OpenAI 兼容
# chat completions（即通义千问 Qwen 系列），绕开本项目内部的负载均衡 /
# 速率限制 / 知识库注入 / Dify 工作流。原因：
#   1. 概念图 prompt 中含大量复杂硬约束（5 层结构、3-4 方面、L5 占比等），
#      后端还要做结构修复和输出清洗，链路必须能精细控制
#      temperature、max_tokens、超时和 SSE 长连接。
#   2. 项目内 llm_service 的"qwen"别名会经过额外的负载均衡、QPM 限速和
#      统一缓存，不适合本接口"长 prompt + 严格格式 + 多次重试"的场景。
#   3. Qwen Dashscope 兼容接口直接复用 OpenAI 的 chat completions schema
#      （payload/SSE 一致），可以最大程度复用通用流式解析代码。
#
# 兼容说明：
#   - 若以后切换到 Qwen 的推理模型（如 qwen-plus 启用 enable_thinking，或
#     qwq 系列），返回流里会出现 delta.reasoning_content。本通道仍然只把
#     content 推给前端，reasoning_content 仅做日志聚合，不会污染正文解析。
#   - QWEN_API_URL 既可以填**完整的** chat completions URL，也可以填
#     **base URL**（自动追加 /chat/completions），两者都兼容。
# ----------------------------------------------------------------------------
_QWEN_API_KEY_ENV = "QWEN_API_KEY"
_QWEN_API_URL_ENV = "QWEN_API_URL"
_QWEN_MODEL_ENV = "QWEN_MODEL_GENERATION"
_QWEN_DEFAULT_API_URL = (
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
)
_QWEN_DEFAULT_MODEL = "qwen-plus-latest"
# Qwen-plus 非推理模型一般 10~60 秒就能跑完；推理变种（qwq / thinking 模式）
# 可能 1~3 分钟。统一给到 5 分钟，足够覆盖最坏情况。
_QWEN_STREAM_TIMEOUT = 300.0


def _resolve_qwen_chat_completions_url(raw: str) -> str:
    """
    把环境变量里的 URL 归一化为最终 chat completions endpoint。

    用户在 .env 里可能写两种：
      - 完整 URL：".../compatible-mode/v1/chat/completions"
      - base URL：".../compatible-mode/v1"
    都要能直接 POST，不能让用户填错一种就 404。
    """
    url = (raw or "").strip().rstrip("/")
    if not url:
        return _QWEN_DEFAULT_API_URL
    if url.endswith("/chat/completions"):
        return url
    return f"{url}/chat/completions"


async def _qwen_chat_stream(
    prompt: str,
    *,
    temperature: float,
    max_tokens: int,
    request_type: str,
) -> AsyncGenerator[str, None]:
    """
    流式调用 Qwen Dashscope OpenAI 兼容 chat completions。

    只 yield 最终答案（`delta.content`）。若返回里出现 `delta.reasoning_content`
    （Qwen 推理变种），仅做日志聚合，不推送到前端，避免污染概念图正文解析。

    NOTE on temperature: qwen-plus / qwen-max 等非推理模型会响应 temperature；
    qwq / qwen-plus(thinking) 等推理模型可能忽略它。我们在调用层无差别传入，
    具体由 QWEN_MODEL_GENERATION 环境变量切换决定。
    """
    api_key = (os.getenv(_QWEN_API_KEY_ENV) or "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                f"{_QWEN_API_KEY_ENV} is not configured; "
                "concept-map text generation requires Qwen API."
            ),
        )

    url = _resolve_qwen_chat_completions_url(os.getenv(_QWEN_API_URL_ENV) or "")
    model = (os.getenv(_QWEN_MODEL_ENV) or _QWEN_DEFAULT_MODEL).strip()

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    # 调用入口日志：记录模型/URL/温度/max_tokens 和 prompt 头部预览，方便排查
    # "送进去的 prompt 是不是预期的"，以及"参数有没有被改过"。
    logger.info(
        "[ConceptMapText:%s] >>> CALL Qwen model=%s url=%s temperature=%s "
        "max_tokens=%s prompt_chars=%d prompt_preview=%s",
        request_type,
        model,
        url,
        temperature,
        max_tokens,
        len(prompt),
        _preview(prompt),
    )

    reasoning_buf: list[str] = []
    content_buf: list[str] = []
    content_started = False
    request_started = time.time()

    try:
        async with httpx.AsyncClient(timeout=_QWEN_STREAM_TIMEOUT) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode("utf-8", errors="replace")
                    logger.error(
                        "[ConceptMapText:%s] Qwen API HTTP %s: %s",
                        request_type,
                        resp.status_code,
                        body[:500],
                    )
                    raise HTTPException(
                        status_code=502,
                        detail=f"Qwen API error ({resp.status_code})",
                    )

                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    # SSE 协议：每个事件以 "data: " 开头；Dashscope 也用
                    # "data: [DONE]" 收尾（OpenAI 兼容）。
                    if not line.startswith("data:"):
                        continue
                    data_str = line[5:].strip()
                    if not data_str:
                        continue
                    if data_str == "[DONE]":
                        break

                    try:
                        chunk = json.loads(data_str)
                    except json.JSONDecodeError:
                        logger.debug(
                            "[ConceptMapText:%s] non-JSON SSE line skipped: %r",
                            request_type,
                            data_str[:200],
                        )
                        continue

                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}

                    # Qwen 推理变种（qwq / thinking 模式）会先输出 reasoning_content；
                    # qwen-plus / qwen-max 默认不会有这段。统一只做日志聚合，不发前端，
                    # 避免污染概念图正文解析。
                    reasoning_piece = delta.get("reasoning_content")
                    if reasoning_piece:
                        reasoning_buf.append(reasoning_piece)
                        continue

                    content_piece = delta.get("content")
                    if content_piece:
                        if not content_started:
                            content_started = True
                            elapsed = time.time() - request_started
                            logger.info(
                                "[ConceptMapText:%s] first content token: "
                                "thinking_chars=%d elapsed=%.1fs, content stream begins",
                                request_type,
                                sum(len(p) for p in reasoning_buf),
                                elapsed,
                            )
                        content_buf.append(content_piece)
                        yield content_piece
        # 流结束后完整记录 reasoning + content 两段的字符数和内容预览，
        # 便于诊断模型是否在 reasoning 里完成了任务但 content 输出失败/被截断。
        reasoning_full = "".join(reasoning_buf)
        content_full = "".join(content_buf)
        logger.info(
            "[ConceptMapText:%s] <<< CALL DONE elapsed=%.1fs reasoning_chars=%d "
            "content_chars=%d",
            request_type,
            time.time() - request_started,
            len(reasoning_full),
            len(content_full),
        )
        if reasoning_full:
            logger.info(
                "[ConceptMapText:%s] reasoning_preview=%s",
                request_type,
                _preview(reasoning_full),
            )
        logger.info(
            "[ConceptMapText:%s] content_preview=%s",
            request_type,
            _preview(content_full),
        )
    except HTTPException:
        raise
    except httpx.TimeoutException as e:
        logger.error(
            "[ConceptMapText:%s] Qwen API timeout: %s", request_type, e
        )
        raise HTTPException(status_code=504, detail="Qwen API timeout")
    except httpx.HTTPError as e:
        logger.error(
            "[ConceptMapText:%s] Qwen API transport error: %s",
            request_type,
            e,
        )
        raise HTTPException(status_code=502, detail="Qwen API transport error")

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

# LLM 偶尔会把自检、字数统计、关键名词统计或“校验修正”过程写进最终回答。
# 这些内容不是概念图正文，既不应展示给用户，也不应参与前端解析。
_META_TAIL_MARKER_RE = re.compile(
    r"(?is)(?:\s*(?:[（(][^）)]*)?"
    r"(?:全文共|字数[:：共]?|关键名词共|关键词共|形态A|形态B|"
    r"校验发现|立即修正|调整后|本次共|以上是|注[:：]|"
    r"word\s*count|keywords?\s*:|aspects?\s*:|form\s*a|form\s*b))"
)
_META_LINE_RE = re.compile(
    r"(?is)^\s*(?:[（(])?\s*"
    r"(?:全文共|字数[:：共]?|关键名词共|关键词共|形态A|形态B|"
    r"校验发现|立即修正|调整后|本次共|以上是|注[:：]|"
    r"word\s*count|keywords?\s*:|aspects?\s*:|form\s*a|form\s*b)"
)
_STREAM_META_LOOKBEHIND_CHARS = 16


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

# 一个关键名词后面最多允许 6 段 `『...』`：
#   1/2 = level-3 -> level-4 的动词/宾语
#   3/4 = 第一条 level-4 -> level-5 分支
#   5/6 = 第二条 level-4 -> level-5 分支
_KEY_NOUN_CHAIN_RE = re.compile(
    r"【[^【】\n]+】((?:\s*『\s*[^『』\n]+?\s*』){0,6})"
)
_BRACKET_QUOTE_RE = re.compile(r"『\s*([^『』\n]+?)\s*』")
_DEPTH_PLACEHOLDER_RE = re.compile(
    r"^(?:\.{1,3}|…|——|-|输入关系|请输入关系|关系|待补充|请填写|placeholder|todo|tbd|none|null)$",
    re.IGNORECASE,
)


class _DepthStats(TypedDict):
    total_key_nouns: int
    form_a_key_nouns: int
    stub_form_a_key_nouns: int
    level5_key_nouns: int
    required_level5_key_nouns: int
    double_branch_key_nouns: int
    required_double_branch_min: int
    required_double_branch_max: int
    valid: bool


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


def _clean_depth_piece(piece: str) -> str:
    """Normalize one `『...』` segment before structural validation."""
    return piece.strip(" \t\r\n，,。.；;：:、\"'“”‘’「」『』（）()")


def _is_meaningful_depth_piece(piece: str) -> bool:
    cleaned = _clean_depth_piece(piece)
    return bool(cleaned) and _DEPTH_PLACEHOLDER_RE.fullmatch(cleaned) is None


def _concept_map_depth_stats(text: str) -> _DepthStats:
    """
    Count whether generated concept chains produce the desired L5 layer shape.

    Segment count semantics for a key noun (after `_is_meaningful_depth_piece`
    truncation):
        0 segments        -> Form B (no L4, no L5)
        2 segments        -> "stub" Form A (L4 only, NO L5) — FORBIDDEN by spec
        4 segments        -> Form A with ONE L5 branch (single)
        ≥6 segments       -> Form A with TWO L5 branches (double)

    Strict health check (all must pass for `valid=True`):
        1. There is at least one Form-A key noun.
        2. EVERY Form-A key noun MUST extend to L5 (level5 == form_a).
           In other words, "stub" Form A with only 2 segments is treated as a
           violation. This guarantees that no L4 node on the canvas is left
           without any L5 children.
        3. **EXACTLY half of Form-A key nouns must use the full 6 segments**
           (double-branch). The valid range is
           `double_branch ∈ [floor(level5/2), ceil(level5/2)]`. This is a
           BOTH-sided check (not just ≥50%): "all 6 segments" or "all 4 segments"
           are BOTH unacceptable. The intent is a roughly 50/50 mix of single
           and double branch L5 nodes on the canvas.

           Examples:
               level5=4 → double_branch must be exactly 2
               level5=5 → double_branch must be 2 or 3
               level5=6 → double_branch must be exactly 3
    """
    total = 0
    form_a = 0
    stub_form_a = 0
    level5 = 0
    double_branch = 0
    for match in _KEY_NOUN_CHAIN_RE.finditer(text or ""):
        total += 1
        pieces = [
            _clean_depth_piece(piece)
            for piece in _BRACKET_QUOTE_RE.findall(match.group(1) or "")
        ]
        meaningful_count = 0
        for piece in pieces:
            if not _is_meaningful_depth_piece(piece):
                break
            meaningful_count += 1
        if meaningful_count >= 2:
            form_a += 1
        if 2 <= meaningful_count < 4:
            stub_form_a += 1  # 仅 2 段——L4 没有 L5 子节点的"残缺形态A"
        if meaningful_count >= 4:
            level5 += 1
        if meaningful_count >= 6:
            double_branch += 1

    # required_level5 = form_a：所有形态A 必须扩到 L5（stub form A 必须为 0）
    required_level5 = form_a
    # 双分支必须**恰好**占 L5 的一半（带 floor/ceil 容差吸收奇偶性）：
    #   level5=4 → 必须正好 2 个双分支
    #   level5=5 → 2 或 3 个双分支均可
    #   level5=6 → 必须正好 3 个双分支
    # 这条上下限双向校验，目的是阻止 LLM 偷懒选"全 4 段"或"全 6 段"两个极端。
    required_double_min = level5 // 2
    required_double_max = (level5 + 1) // 2
    return {
        "total_key_nouns": total,
        "form_a_key_nouns": form_a,
        "stub_form_a_key_nouns": stub_form_a,
        "level5_key_nouns": level5,
        "required_level5_key_nouns": required_level5,
        "double_branch_key_nouns": double_branch,
        "required_double_branch_min": required_double_min,
        "required_double_branch_max": required_double_max,
        "valid": (
            form_a > 0
            and stub_form_a == 0
            and level5 >= required_level5
            and required_double_min <= double_branch <= required_double_max
        ),
    }


def _build_depth_repair_prompt(original_text: str, language: str, stats: _DepthStats) -> str:
    """Ask the LLM to repair only the depth/bracketing structure."""
    if language == "en":
        return (
            "Rewrite the concept-map analysis text below so its bracketed chains can "
            "produce a valid five-level map.\n\n"
            "---ORIGINAL START---\n"
            f"{original_text}\n"
            "---ORIGINAL END---\n\n"
            "Hard requirements:\n"
            "1. Keep exactly 3 or 4 numbered aspects (2 is forbidden; 5+ is forbidden) and the same overall topic.\n"
            "2. Every Form-A key noun MUST follow this four- or six-segment pattern:\n"
            "   `「connectorB」【key noun】『verb1』『object1』『verb2』『object2』` (4 segments, 1 L5 branch)\n"
            "   OR `「connectorB」【key noun】『verb1』『object1』『verb2』『object2』『verb3』『object3』` (6 segments, 2 L5 branches)\n"
            "3. **EVERY Form-A key noun (i.e. any noun followed by ANY 『』) MUST extend down to level 5** — "
            "MUST have at least four 『』 segments. **A 'stub' Form A with only TWO segments is ABSOLUTELY "
            "FORBIDDEN**: every L4 node on the canvas MUST have at least one L5 child. If you cannot fill "
            "the second pair `『verb2』『object2』`, switch the noun to Form B (drop ALL 『』) instead.\n"
            "4. **EXACTLY HALF of all Form-A key nouns MUST use 6 segments and HALF MUST use 4 segments** "
            "(roughly 50/50 split, with at most 1 difference for odd totals). "
            "**FORBIDDEN: making ALL Form-A nouns 6 segments OR ALL 4 segments** — both extremes are unacceptable. "
            "Concretely: if there are 4 Form-A nouns, exactly 2 must be 6 segments and exactly 2 must be 4 segments. "
            "If there are 5, then 2 or 3 must be 6 segments and the rest 4 segments. "
            "If there are 6, exactly 3 must be 6 segments and exactly 3 must be 4 segments.\n"
            "5. Every connector/verb must read as a predicate relation between adjacent nodes. "
            "Do not use discourse words like also, furthermore, then, meanwhile. Do not use "
            "placeholder text.\n"
            "6. The object segments must be short noun phrases, not clauses.\n"
            "7. Output only the rewritten numbered text. No explanation, no JSON.\n\n"
            f"Current stats (target: stub_form_a_key_nouns == 0 AND "
            f"level5_key_nouns == form_a_key_nouns AND "
            f"required_double_branch_min <= double_branch_key_nouns <= required_double_branch_max): "
            f"{json.dumps(stats, ensure_ascii=False)}"
        )

    if language == "zh-tw":
        return (
            "請重寫下面的概念圖分析正文，使其括號鏈條能生成合格的五層概念圖。\n\n"
            "---原文開始---\n"
            f"{original_text}\n"
            "---原文結束---\n\n"
            "硬性要求：\n"
            "1. 保留 3 條或 4 條編號方面（**禁止 2 條**，也禁止 5 條及以上）與同一主題，不要增加說明段；\n"
            "2. 每個形態A 關鍵名詞必須採用四段或六段格式之一：\n"
            "   `「連接詞B」【關鍵名詞】『第一層動詞』『第一層賓語』『第二層動詞』『第二層賓語』`（四段，1 個第 5 層分支）；或\n"
            "   `「連接詞B」【關鍵名詞】『第一層動詞』『第一層賓語』『第二層動詞』『第二層賓語』『第三層動詞』『第三層賓語』`（六段，2 個第 5 層分支）；\n"
            "3. **所有形態A 關鍵名詞（即任何帶 『』 的名詞）必須向下展開到第 5 層**，"
            "**嚴禁**只給兩段的「殘缺形態A」（兩段意味著第 4 層節點沒有第 5 層子節點，畫布稀疏）。"
            "如果第二組『動詞』『賓語』填不出來，請把該名詞改用形態B（去掉**所有** 『』），不要保留兩段；\n"
            "4. **所有形態A 關鍵名詞中恰好一半使用六段、恰好另一半使用四段**（大約 50/50 分布，奇數總數時相差至多 1 個）。"
            "**嚴禁全部都用六段**，**也嚴禁全部都用四段**，兩種極端情況都不合格。"
            "舉例：4 個形態A → 必須 2 個六段 + 2 個四段；"
            "5 個形態A → 2~3 個六段 + 對應 3~2 個四段；"
            "6 個形態A → 必須 3 個六段 + 3 個四段。"
            "務必確保畫布上「一半 L4 有兩個 L5 分支、一半 L4 只有一個 L5 分支」的視覺平衡；\n"
            "5. 每個連接詞/動詞都必須能放在相鄰兩個節點中間讀成命題，"
            "禁止「同時」「進一步」「另外」「然後」等篇章詞，禁止占位詞；\n"
            "6. 每個賓語段要是短名詞短語，不要寫成完整句子；\n"
            "7. 只輸出重寫後的編號正文，不要解釋，不要 JSON。\n\n"
            f"當前結構統計（目標：stub_form_a_key_nouns == 0 且 "
            f"level5_key_nouns == form_a_key_nouns 且 "
            f"required_double_branch_min ≤ double_branch_key_nouns ≤ required_double_branch_max）："
            f"{json.dumps(stats, ensure_ascii=False)}"
        )

    return (
        "请重写下面的概念图分析正文，使其括号链条能生成合格的五层概念图。\n\n"
        "---原文开始---\n"
        f"{original_text}\n"
        "---原文结束---\n\n"
        "硬性要求：\n"
        "1. 保留 3 条或 4 条编号方面（**禁止 2 条**，也禁止 5 条及以上）与同一主题，不要增加说明段；\n"
        "2. 每个形态A 关键名词必须采用四段或六段格式之一：\n"
        "   `「连接词B」【关键名词】『第一层动词』『第一层宾语』『第二层动词』『第二层宾语』`（四段，1 个第 5 层分支）；或\n"
        "   `「连接词B」【关键名词】『第一层动词』『第一层宾语』『第二层动词』『第二层宾语』『第三层动词』『第三层宾语』`（六段，2 个第 5 层分支）；\n"
        "3. **所有形态A 关键名词（即任何带 『』 的名词）必须向下展开到第 5 层**，"
        "**严禁**只给两段的“残缺形态A”（两段意味着第 4 层节点没有第 5 层子节点，画布稀疏）。"
        "如果第二组『动词』『宾语』填不出来，请把该名词改用形态B（去掉**所有** 『』），不要保留两段；\n"
        "4. **所有形态A 关键名词中恰好一半使用六段、恰好另一半使用四段**（大约 50/50 分布，奇数总数时相差至多 1 个）。"
        "**严禁全部都用六段**，**也严禁全部都用四段**，两种极端情况都不合格。"
        "举例：4 个形态A → 必须 2 个六段 + 2 个四段；"
        "5 个形态A → 2~3 个六段 + 对应 3~2 个四段；"
        "6 个形态A → 必须 3 个六段 + 3 个四段。"
        "务必确保画布上“一半 L4 有两个 L5 分支、一半 L4 只有一个 L5 分支”的视觉平衡；\n"
        "5. 每个连接词/动词都必须能放在相邻两个节点中间读成命题，"
        "禁止“同时”“进一步”“另外”“然后”等篇章词，禁止占位词；\n"
        "6. 每个宾语段要是短名词短语，不要写成完整句子；\n"
        "7. 只输出重写后的编号正文，不要解释，不要 JSON。\n\n"
        f"当前结构统计（目标：stub_form_a_key_nouns == 0 且 "
        f"level5_key_nouns == form_a_key_nouns 且 "
        f"required_double_branch_min ≤ double_branch_key_nouns ≤ required_double_branch_max）："
        f"{json.dumps(stats, ensure_ascii=False)}"
    )


async def _repair_depth_structure(text: str, language: str) -> tuple[str, bool, _DepthStats]:
    """Repair final text once if it cannot satisfy the level-5 branch contract."""
    stats = _concept_map_depth_stats(text)
    if stats["valid"]:
        return text, False, stats

    logger.info(
        "[ConceptMapText] pass3 repair input_stats=%s",
        json.dumps(stats, ensure_ascii=False),
    )

    repair_prompt = _build_depth_repair_prompt(text, language, stats)
    repaired_raw = ""
    async for chunk in _qwen_chat_stream(
        prompt=repair_prompt,
        max_tokens=_REPAIR_MAX_TOKENS,
        # Pass 3 修复：必须严守"必须六段『』、双分支占比、L5 占比"等结构性硬
        # 约束，禁止任何遣词造句的随机性。temperature=0.0（贪婪解码）让 LLM
        # 在每个 token 位置都选概率最高的候选，最大化对 prompt 的服从度。
        # 注：qwen-plus / qwen-max 等非推理模型会响应该参数；qwq 等推理模型
        # 可能忽略它（具体由 QWEN_MODEL_GENERATION 切换决定）。
        temperature=0.0,
        request_type="concept_map_text_depth_repair",
    ):
        if not chunk:
            continue
        repaired_raw += chunk if isinstance(chunk, str) else str(chunk)

    repaired = _strip_meta_paragraphs(repaired_raw.strip())
    repaired = _fill_missing_connectors(repaired, language)
    repaired_stats = _concept_map_depth_stats(repaired)
    logger.info(
        "[ConceptMapText] pass3 repair raw_chars=%d cleaned_chars=%d post_stats=%s",
        len(repaired_raw.strip()),
        len(repaired),
        json.dumps(repaired_stats, ensure_ascii=False),
    )
    logger.info(
        "[ConceptMapText] pass3 repair raw_text=%s",
        _preview(repaired_raw.strip()),
    )
    if repaired_stats["valid"]:
        return repaired, True, repaired_stats

    logger.warning(
        "[ConceptMapText] pass3 repair FAILED to satisfy structure: before=%s after=%s",
        json.dumps(stats, ensure_ascii=False),
        json.dumps(repaired_stats, ensure_ascii=False),
    )
    return text, False, stats


def _strip_meta_tail(text: str) -> str:
    """Remove self-check/statistics tail text from an otherwise valid answer."""
    if not text:
        return text

    marker = _META_TAIL_MARKER_RE.search(text)
    if marker:
        return text[: marker.start()].rstrip()

    kept_lines = []
    for line in text.splitlines():
        if _META_LINE_RE.search(line):
            break
        kept_lines.append(line)
    return "\n".join(kept_lines).rstrip()


def _strip_meta_paragraphs(text: str) -> str:
    """
    去除 LLM 输出中混入的"说明性段落"，只保留概念图编号正文。

    背景：
        Qwen 有时会在概念图编号正文之外
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

    text = _strip_meta_tail(text.strip())
    if not text:
        return ""

    paragraphs = _PARAGRAPH_SPLIT_RE.split(text)
    kept = []
    for p in paragraphs:
        p_stripped = _strip_meta_tail(p.strip())
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
        "============================================================"
        "============================================================"
    )
    logger.info(
        "[ConceptMapText] >>>>> NEW REQUEST lang=%s prompt_chars=%d",
        lang,
        len(prompt),
    )
    logger.info(
        "[ConceptMapText] incoming_prompt_preview=%s",
        _preview(prompt),
    )

    async def generate():
        first_pass_text = ""
        final_text = ""
        visible_sent_len = 0
        try:
            # =========================================================
            # Pass 1: 流式生成（用户实时看到正文逐字流出）
            # =========================================================
            async for chunk in _qwen_chat_stream(
                prompt=prompt,
                max_tokens=_GEN_MAX_TOKENS,
                # Pass 1 首次生成：本接口 prompt 包含 7~8 条互相耦合的硬约束
                # （3-4 方面 / Form-A 占比 / L5 占比 / 双分支占比 / 700-800
                # 字 / 连接词非空 / 占位词禁用 等）。**约束越多，温度越低**。
                # 设为 0.0 让 LLM 在每个 token 都走贪婪解码，最大化格式服从度。
                # 副作用：同一焦点问题反复生成会得到几乎相同的结果（无多样性）—
                # 这是用户明确要求的取舍。Qwen 非推理模型会响应该参数；qwq
                # 等推理模型可能忽略它。
                temperature=0.0,
                request_type="concept_map_text_generation",
            ):
                if not chunk:
                    continue
                text_chunk = chunk if isinstance(chunk, str) else str(chunk)
                if not text_chunk:
                    continue
                first_pass_text += text_chunk
                visible_text = _strip_meta_tail(first_pass_text)
                safe_visible_len = max(
                    0,
                    len(visible_text) - _STREAM_META_LOOKBEHIND_CHARS,
                )
                if safe_visible_len > visible_sent_len:
                    delta = visible_text[visible_sent_len:safe_visible_len]
                    visible_sent_len = safe_visible_len
                    yield _sse_event("message", answer=delta)

            visible_text = _strip_meta_tail(first_pass_text)
            if len(visible_text) > visible_sent_len:
                yield _sse_event("message", answer=visible_text[visible_sent_len:])
                visible_sent_len = len(visible_text)

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
                "[ConceptMapText] ----- PASS 1 DONE -----"
            )
            logger.info(
                "[ConceptMapText] pass1 raw_chars=%d cleaned_chars=%d dirty=%s (target_range=%d~%d)",
                len(stripped_first),
                len(cleaned_first),
                first_dirty,
                _MIN_TARGET_CHARS,
                _MAX_TARGET_CHARS,
            )
            logger.info(
                "[ConceptMapText] pass1 raw_text=%s",
                _preview(stripped_first),
            )
            if first_dirty:
                logger.info(
                    "[ConceptMapText] pass1 cleaned_text=%s",
                    _preview(cleaned_first),
                )
            # 立刻算一次 pass1 的结构 stats，方便看 pass1 出来的就达标 vs 触发 pass3
            pass1_stats = _concept_map_depth_stats(cleaned_first)
            logger.info(
                "[ConceptMapText] pass1 depth_stats=%s",
                json.dumps(pass1_stats, ensure_ascii=False),
            )

            # =========================================================
            # Pass 2 removed: no automatic word-count expansion.
            # Only replace the visible stream when pass1 needed cleanup
            # (metadata/self-check text removed or connectors filled).
            # =========================================================
            if first_dirty:
                yield _sse_event("message_replace", answer=cleaned_first)
                logger.info(
                    "[ConceptMapText] pass2 REMOVED; pass1 was dirty: "
                    "sent message_replace with cleaned pass1"
                )
            else:
                logger.info(
                    "[ConceptMapText] pass2 REMOVED; pass1 clean"
                )

            # =========================================================
            # Pass 3 (可选): 结构修复。前端不再用“表现/影响”伪造第 5 层，
            # 因此最终文本必须自己提供 level-5 的动词/宾语链，并保证 50/50
            # 的双分支占比。
            # =========================================================
            depth_stats = _concept_map_depth_stats(final_text)
            logger.info(
                "[ConceptMapText] ----- PASS 3 CHECKING ----- depth_stats=%s",
                json.dumps(depth_stats, ensure_ascii=False),
            )
            if not depth_stats["valid"]:
                logger.info(
                    "[ConceptMapText] PASS 3 TRIGGERED (depth_stats.valid=False)"
                )
                final_text, repaired_depth, depth_stats = await _repair_depth_structure(
                    final_text,
                    lang,
                )
                logger.info(
                    "[ConceptMapText] pass3 repaired=%s, post_stats=%s",
                    repaired_depth,
                    json.dumps(depth_stats, ensure_ascii=False),
                )
                logger.info(
                    "[ConceptMapText] pass3 final_text=%s",
                    _preview(final_text),
                )
                if repaired_depth:
                    yield _sse_event("message_replace", answer=final_text)
            else:
                logger.info(
                    "[ConceptMapText] PASS 3 SKIPPED (already valid)"
                )

            final_clean = _fill_missing_connectors(_strip_meta_paragraphs(final_text), lang)
            if final_clean != final_text:
                final_text = final_clean
                yield _sse_event("message_replace", answer=final_text)
                logger.info(
                    "[ConceptMapText] final cleanup replaced visible answer"
                )

            # =========================================================
            # 收尾
            # =========================================================
            yield _sse_event("message_end", answer=final_text)
            logger.info(
                "[ConceptMapText] <<<<< REQUEST COMPLETED final_chars=%d "
                "first_dirty=%s final_depth_stats=%s",
                len(final_text),
                first_dirty,
                json.dumps(depth_stats, ensure_ascii=False),
            )
            logger.info(
                "[ConceptMapText] final_text=%s",
                _preview(final_text),
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
