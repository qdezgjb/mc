"""
Concept Map · Image → Focus Question API
=========================================

提供给画布迷你 MindMate 面板调用的接口：
- POST /api/concept_map/extract-focus-question-from-files

入参里携带用户在 MindMate 面板里上传过的图片（Dify 文件 ID）以及用户原话，
后端用 Qwen-VL（DashScope 兼容模式）读图，提炼出**问句形式**的焦点问题，
直接返回给前端写入"焦点问题"框并触发概念图生成流程。

为什么不复用 MindMate 聊天侧的输出？
    MindMate 侧 SSE 流是给"开放对话"用的；这里需要一个紧凑、确定结尾是问号的
    单句结果，且需要在前端"工具栏触发生成前"就能拿到，因此走独立的非流式接口。

Copyright 2024-2025 北京思源智教科技有限公司 (Beijing Siyuan Zhijiao Technology Co., Ltd.)
All Rights Reserved
Proprietary License
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from clients.dify import (
    AsyncDifyClient,
    DifyAPIError,
    DifyFileAccessDeniedError,
    DifyFileNotFoundError,
)
from models import Messages, get_request_language
from models.domain.auth import User
from services.llm import llm_service
from services.knowledge.document_processor import get_document_processor
from utils.auth import get_current_user_or_api_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/concept_map", tags=["concept_map"])


# ============================================================================
# Constants
# ============================================================================

# 视觉模型选择：用 Qwen-VL Max（图像理解能力较强，DashScope 兼容模式直接调用）。
# 如果用户希望更快/便宜，可改为 qwen-vl-plus-latest。
_UPLOAD_ANALYSIS_MODEL = "deepseek"

# Dify 一次允许下载的最大文件字节数；超出直接拒绝以免占内存。
_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10MB

# 焦点问题最长字符数（避免模型啰嗦把整段说明塞进来）。
_QUESTION_MAX_LEN = 80

# 图片内容（文字/术语/关系）最大长度，避免模型把所有 OCR 都塞进来。
# 600 字足够覆盖一张教学图、流程图、笔记照片中的核心信息。
_IMAGE_CONTENT_MAX_LEN = 1200


# ============================================================================
# Schemas
# ============================================================================

_MAX_UPLOAD_BYTES = 20 * 1024 * 1024
_MAX_EXTRACTED_TEXT_CHARS = 12000


class ExtractFocusQuestionRequest(BaseModel):
    file_ids: List[str] = Field(
        default_factory=list,
        description=(
            "Dify file IDs of images uploaded by the user. 仅在 images_base64 为空时使用，"
            "通过 Dify /files/{id}/preview 反向下载（注意：Dify 对未参与 chat 上下文的文件会 404）。"
        ),
    )
    images_base64: List[str] = Field(
        default_factory=list,
        description=(
            "图片 base64 data URL 列表（首选通道）。形如 data:image/png;base64,...；"
            "前端在用户上传时本地读取得到，避免依赖 Dify 反向下载。"
        ),
    )
    file_data_urls: List[str] = Field(
        default_factory=list,
        description=(
            "Concept-map upload files as data URLs. Supports images and common documents. "
            "Documents are converted to extracted text before DeepSeek is called."
        ),
    )
    file_names: List[str] = Field(
        default_factory=list,
        description="Original file names aligned with file_data_urls.",
    )
    user_message: Optional[str] = Field(
        default=None, description="用户原始输入，作为辅助上下文（如'根据这张图生成概念图'）"
    )
    language: str = Field(default="zh", description="期望输出语言，zh / en")


class ExtractFocusQuestionResponse(BaseModel):
    success: bool
    question: str = ""
    image_content: str = Field(
        default="",
        description=(
            "从图片中提炼出的关键文本/术语/关系列表（中文或英文，按 language 决定）。"
            "供概念图生成 prompt 作为参考素材，让 LLM 优先基于图片实际内容组织概念。"
        ),
    )
    raw: str = ""
    error: Optional[str] = None


# ============================================================================
# Helpers
# ============================================================================


def _get_dify_client() -> AsyncDifyClient:
    api_key = os.getenv("DIFY_API_KEY")
    api_url = os.getenv("DIFY_API_URL", "https://api.dify.ai/v1")
    timeout = int(os.getenv("DIFY_TIMEOUT", "300"))
    if not api_key:
        raise HTTPException(status_code=500, detail="Dify is not configured")
    return AsyncDifyClient(api_key=api_key, api_url=api_url, timeout=timeout)


def _build_data_url(image_bytes: bytes, mime_type: str) -> str:
    """把图片二进制转成 data: URL，DashScope 兼容模式可直接吃。"""
    if not mime_type or not mime_type.startswith("image/"):
        # 兜底：如果 Dify 没回正确 content-type，假定 png 总能解码
        mime_type = "image/png"
    b64 = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def _build_messages(data_urls: List[str], user_message: str, language: str) -> List[dict]:
    """
    构造多模态 messages：让模型一次性给出
    - focus_question：问句形式的焦点问题（用作画布顶部"焦点问题"框）
    - image_content：图片中能识别出的关键文本/术语/关系（作为概念图生成的参考素材）

    输出严格使用 JSON，方便后端鲁棒解析。
    """
    if language == "en":
        system_prompt = (
            "You analyse images for concept-map authoring. "
            "Look carefully at the image(s) and produce TWO things in ONE JSON object:\n"
            "  - focus_question: a SINGLE question that captures the central topic of the image, "
            "ending with '?'. It must be answerable by building a concept map "
            f"(about how/why/what relations, not yes/no). Length <= {_QUESTION_MAX_LEN} chars. "
            "Do NOT include any prefix like 'Focus question:' or quotes.\n"
            "  - image_content: a faithful extraction of the textual/conceptual content visible "
            "in the image(s). Include OCR'd text, key terms, relationships, structural lists, "
            f"data points or labels. Use plain text with line breaks or bullets. "
            f"Length <= {_IMAGE_CONTENT_MAX_LEN} chars. Do NOT invent facts that are not in the image; "
            "if the image contains little textual information, describe the visible structure briefly.\n"
            "OUTPUT FORMAT: a single JSON object, no markdown fences, no commentary. Example:\n"
            '{"focus_question": "...?", "image_content": "..."}'
        )
        user_text = (
            f"User said: {user_message or '(no extra text)'}\n"
            "Return the JSON now."
        )
    else:
        system_prompt = (
            "你是为概念图采集素材的专家。请仔细看图，并在一次回答中同时给出两项内容：\n"
            "  - focus_question：能代表图片核心主题的**一个问句**，必须以中文问号'？'或英文问号'?'结尾，"
            "必须是能用一张概念图回答的问题（关注关系/过程/原因/作用，避免是非问）；"
            f"长度不超过 {_QUESTION_MAX_LEN} 个字符；不要任何'焦点问题：'之类的前缀，也不要引号。\n"
            "  - image_content：忠实提取图片中**实际包含的文本与概念**，包括标题/术语/列表/箭头关系/"
            "数据/图例/标注等。允许使用换行或短横线列表组织。**只能基于图片实际可见内容**，"
            f"不要凭空编造图中没有的事实；长度不超过 {_IMAGE_CONTENT_MAX_LEN} 个字符。"
            "如果图片中文字信息很少，可以用一两句话描述图中的结构与符号。\n"
            "输出格式：**只输出一个 JSON 对象**，不要任何额外说明、不要 ```json 围栏。示例：\n"
            '{"focus_question": "……？", "image_content": "……"}'
        )
        user_text = (
            f"用户的话：{user_message or '（未提供额外说明）'}\n"
            "现在请按上述要求输出 JSON："
        )

    user_content: List[dict] = []
    for url in data_urls:
        user_content.append({"type": "image_url", "image_url": {"url": url}})
    user_content.append({"type": "text", "text": user_text})

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]


_QUESTION_LABEL_RE = re.compile(
    r"^\s*(焦点问题|焦點問題|focus[\s\-]*question)\s*[:：]?\s*",
    re.IGNORECASE,
)

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)


def _extract_json_payload(raw: str) -> Optional[dict]:
    """
    从模型输出里提取 JSON 对象。
    依次尝试：
      1) 直接 json.loads（最理想）
      2) 剥掉 ```json``` 围栏后再 json.loads
      3) 找到第一个 { 与最后一个 } 配对再 json.loads（兜底，模型偶尔在 JSON 前后加废话）
    全部失败返回 None，由调用方走"无 JSON"分支。
    """
    if not raw or not raw.strip():
        return None

    text = raw.strip()

    # 1) 直接 parse
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass

    # 2) 剥围栏
    m = _JSON_FENCE_RE.search(text)
    if m:
        candidate = m.group(1).strip()
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            pass

    # 3) 找最外层 { ... }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = text[start : end + 1]
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            pass

    return None


def _clean_question(raw: str, language: str) -> str:
    """裁剪模型输出，确保是单句、以问号结尾、长度受限。"""
    if not raw:
        return ""
    text = raw.strip()

    # 模型偶尔会用 ``` 或 " 包裹，剥掉
    text = text.strip("`").strip().strip('"').strip("'").strip("“”‘’")

    # 去掉可能的"焦点问题:"前缀（中英冒号）
    text = _QUESTION_LABEL_RE.sub("", text).strip()

    # 多行 → 取第一行非空
    for line in text.splitlines():
        line = line.strip()
        if line:
            text = line
            break

    # 截断到第一个问号（含中英）后面
    m = re.search(r"[?？]", text)
    if m:
        text = text[: m.end()]
    else:
        # 模型没有输出问号 → 强制补一个，按语言选标点
        text = text + ("?" if language == "en" else "？")

    # 长度兜底
    if len(text) > _QUESTION_MAX_LEN * 2:  # 防御性截断
        text = text[: _QUESTION_MAX_LEN * 2].rstrip()
        if not text.endswith(("?", "？")):
            text += "？" if language != "en" else "?"

    return text


def _clean_image_content(raw: str) -> str:
    """裁剪图片内容输出：去引号/围栏、统一空白、限制最大长度。"""
    if not raw:
        return ""
    text = raw.strip()
    # 剥常见围栏
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"```\s*$", "", text)
    # 折叠 3+ 连续换行
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 长度兜底
    if len(text) > _IMAGE_CONTENT_MAX_LEN:
        text = text[:_IMAGE_CONTENT_MAX_LEN].rstrip() + "…"
    return text


def _parse_vl_output(raw_text: str, language: str) -> Tuple[str, str]:
    """
    解析 Qwen-VL 输出，返回 (focus_question, image_content)。

    优先按 JSON 解析；失败则把整段当作焦点问题原料、image_content 留空，
    保证调用方至少拿到一个可用的焦点问题（保留旧行为兼容）。
    """
    payload = _extract_json_payload(raw_text)
    if payload and isinstance(payload, dict):
        question_raw = payload.get("focus_question") or payload.get("question") or ""
        content_raw = payload.get("image_content") or payload.get("content") or ""
        return (
            _clean_question(str(question_raw), language),
            _clean_image_content(str(content_raw)),
        )

    # JSON 解析失败 → 老行为兜底：整段视为焦点问题原料
    return _clean_question(raw_text, language), ""


_DATA_URL_RE = re.compile(r"^data:([^;,]+)?(;base64)?,(.*)$", re.DOTALL)

_MIME_SUFFIX = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/html": ".html",
    "text/csv": ".csv",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
}

_TEXT_MIME_PREFIXES = ("text/",)
_TEXT_MIME_TYPES = {
    "application/json",
    "application/xml",
    "application/xhtml+xml",
    "text/html",
    "text/csv",
    "text/markdown",
}


def _decode_data_url(raw: str) -> Tuple[bytes, str]:
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty data URL")

    m = _DATA_URL_RE.match(text)
    if not m:
        try:
            return base64.b64decode(text, validate=False), "image/png"
        except (binascii.Error, ValueError) as exc:
            raise ValueError("invalid data URL") from exc

    mime = (m.group(1) or "application/octet-stream").lower()
    is_base64 = bool(m.group(2))
    data = m.group(3)
    if is_base64:
        try:
            return base64.b64decode(data, validate=False), mime
        except (binascii.Error, ValueError) as exc:
            raise ValueError("invalid base64 payload") from exc

    from urllib.parse import unquote_to_bytes

    return unquote_to_bytes(data), mime


def _safe_suffix(mime_type: str, file_name: str = "") -> str:
    if file_name:
        suffix = Path(file_name).suffix.lower()
        if suffix and len(suffix) <= 12:
            return suffix
    return _MIME_SUFFIX.get((mime_type or "").lower(), ".bin")


def _decode_text_bytes(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gbk", "gb2312", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="ignore")


def _extract_text_from_upload(data_url: str, file_name: str, index: int) -> Tuple[str, str, str]:
    content, mime = _decode_data_url(data_url)
    if len(content) > _MAX_UPLOAD_BYTES:
        raise ValueError(f"file too large: {file_name or index} ({len(content)} bytes)")

    display_name = file_name or f"upload_{index + 1}{_safe_suffix(mime)}"
    mime = (mime or "application/octet-stream").split(";")[0].strip().lower()

    if mime.startswith(_TEXT_MIME_PREFIXES) or mime in _TEXT_MIME_TYPES:
        text = _decode_text_bytes(content)
    else:
        suffix = _safe_suffix(mime, display_name)
        tmp_path = ""
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(content)
                tmp_path = tmp.name
            text = get_document_processor().extract_text(tmp_path, mime)
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    text = (text or "").strip()
    if not text:
        raise ValueError(f"no text extracted: {display_name}")
    if len(text) > _MAX_EXTRACTED_TEXT_CHARS:
        text = text[:_MAX_EXTRACTED_TEXT_CHARS].rstrip() + "..."
    return display_name, mime, text


def _build_text_messages(files: List[Tuple[str, str, str]], user_message: str, language: str) -> List[dict]:
    if language == "en":
        system_prompt = (
            "You analyse uploaded file text for concept-map authoring. Return ONE JSON object with "
            "focus_question and image_content. focus_question must be one concise question ending with '?'. "
            f"Keep focus_question <= {_QUESTION_MAX_LEN} characters. image_content should faithfully summarize "
            "the uploaded source text as key terms, relationships, headings, lists, and data points for a concept map. "
            f"Keep image_content <= {_IMAGE_CONTENT_MAX_LEN} characters. Do not invent facts. No markdown fences."
        )
        source_label = "Uploaded source text"
    else:
        system_prompt = (
            "你是为概念图采集素材的专家。请阅读用户上传文件中提取出的文本，只返回一个 JSON 对象："
            "focus_question 和 image_content。focus_question 必须是一个适合用概念图回答的简洁问句，"
            f"长度不超过 {_QUESTION_MAX_LEN} 个字符；image_content 要忠实提炼文件里的核心术语、标题、"
            f"层级、关系、列表和数据，长度不超过 {_IMAGE_CONTENT_MAX_LEN} 个字符。不要编造文件中没有的事实，"
            "不要输出 markdown 代码围栏。"
        )
        source_label = "上传文件提取文本"

    parts = []
    for name, mime, text in files:
        parts.append(f"### {name} ({mime})\n{text}")
    user_text = (
        f"User message: {user_message or '(none)'}\n\n"
        f"{source_label}:\n" + "\n\n".join(parts) + "\n\n"
        'Return JSON only, for example: {"focus_question": "...?", "image_content": "..."}'
    )
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_text},
    ]


# ============================================================================
# Endpoint
# ============================================================================


@router.post("/extract-focus-question-from-files", response_model=ExtractFocusQuestionResponse)
async def extract_focus_question_from_files(
    payload: ExtractFocusQuestionRequest,
    _user: Optional[User] = Depends(get_current_user_or_api_key),
) -> ExtractFocusQuestionResponse:
    """
    从用户上传的图片（已存在 Dify 上）中提炼一个问句形式的焦点问题。
    """
    lang = get_request_language(payload.language) if payload.language else "zh"

    file_ids = [fid.strip() for fid in (payload.file_ids or []) if fid and fid.strip()]
    incoming_b64 = [b for b in (payload.images_base64 or []) if b and b.strip()]
    incoming_files = [b for b in (payload.file_data_urls or []) if b and b.strip()]
    file_names = payload.file_names or []

    if not file_ids and not incoming_b64 and not incoming_files:
        raise HTTPException(
            status_code=400,
            detail="either file_ids, images_base64, or file_data_urls is required",
        )

    data_urls: List[str] = []
    skip_reasons: List[str] = []
    extracted_files: List[Tuple[str, str, str]] = []

    # 1a) Preferred path for concept-map uploads: local data URLs.
    # DeepSeek is text-only here, so uploaded files are first converted to extracted text.
    upload_data_urls = incoming_files or incoming_b64
    for idx, raw in enumerate(upload_data_urls):
        url = raw.strip()
        if not url.startswith("data:"):
            url = f"data:image/png;base64,{url}"
        try:
            extracted_files.append(
                _extract_text_from_upload(
                    url,
                    file_names[idx] if idx < len(file_names) else "",
                    idx,
                )
            )
        except Exception as e:
            skip_reasons.append(str(e))

    # 1b) Fallback: download Dify files, then extract text before calling DeepSeek.
    if not extracted_files and file_ids:
        dify = _get_dify_client()

        async def _download_one(fid: str):
            try:
                content, headers = await dify.download_file(fid)
            except DifyFileNotFoundError:
                return None, f"file not found: {fid}"
            except DifyFileAccessDeniedError:
                return None, f"file access denied: {fid}"
            except DifyAPIError as e:
                return None, f"dify error for {fid}: {e}"
            except asyncio.TimeoutError:
                return None, f"timeout downloading {fid}"

            if len(content) > _MAX_UPLOAD_BYTES:
                return None, f"file too large: {fid} ({len(content)} bytes)"

            mime = (headers.get("Content-Type") or "").split(";")[0].strip().lower()
            return (content, mime), None

        results = await asyncio.gather(*[_download_one(fid) for fid in file_ids])
        for idx, (ok, err) in enumerate(results):
            if ok:
                content, mime = ok
                try:
                    downloaded_url = (
                        f"data:{mime or 'application/octet-stream'};base64,"
                        f"{base64.b64encode(content).decode('ascii')}"
                    )
                    extracted_files.append(
                        _extract_text_from_upload(
                            downloaded_url,
                            file_ids[idx] if idx < len(file_ids) else "",
                            idx,
                        )
                    )
                except Exception as e:
                    skip_reasons.append(str(e))
            elif err:
                skip_reasons.append(err)

    if not extracted_files:
        detail = "; ".join(skip_reasons) or "no usable uploaded files"
        logger.warning("[ConceptMapImageFocus] No usable upload text: %s", detail)
        raise HTTPException(status_code=400, detail=detail)

    # 2) Use the concept-map upload analysis model to extract the focus question.
    messages = _build_text_messages(extracted_files, payload.user_message or "", lang)
    try:
        raw_answer = await llm_service.chat(
            model=_UPLOAD_ANALYSIS_MODEL,
            messages=messages,
            max_tokens=1500,
            temperature=0.4,
            request_type="concept_map_focus_from_upload",
            endpoint_path="/api/concept_map/extract-focus-question-from-files",
            use_knowledge_base=False,
        )
    except Exception as e:
        logger.error(
            "[ConceptMapImageFocus] LLM call failed: %s (model=%s)",
            e,
            _UPLOAD_ANALYSIS_MODEL,
            exc_info=True,
        )
        try:
            err_msg = Messages.error("ai_error", lang)  # type: ignore[arg-type]
        except Exception:
            err_msg = "AI service error"
        raise HTTPException(status_code=502, detail=err_msg or str(e)) from e

    raw_text = raw_answer if isinstance(raw_answer, str) else str(raw_answer or "")
    question, image_content = _parse_vl_output(raw_text, lang)

    if not question:
        logger.warning(
            "[ConceptMapImageFocus] Empty question after cleaning. raw=%r", raw_text[:300]
        )
        raise HTTPException(status_code=502, detail="LLM returned no usable focus question")

    logger.info(
        "[ConceptMapImageFocus] Extracted from %d upload(s): question=%r, image_content_len=%d",
        len(extracted_files),
        question,
        len(image_content),
    )

    return ExtractFocusQuestionResponse(
        success=True,
        question=question,
        image_content=image_content,
        raw=raw_text,
    )
