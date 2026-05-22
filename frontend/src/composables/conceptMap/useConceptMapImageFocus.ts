/**
 * useConceptMapImageFocus
 * ========================
 *
 * 把当前画布迷你 MindMate 面板里上传的图片，通过后端 Qwen-VL 接口提炼成
 * **问句形式的焦点问题**，供"概念图生成"流程直接消费。
 *
 * 触发时机：
 *   用户在概念图模式下输入"生成概念图"类指令 + 当前 pendingFiles 里有图片，
 *   此时 MindmatePanel 在调 handleDiagramGeneration 之前先调用本 composable，
 *   拿到的 question 直接通过 eventBus 发给 CanvasToolbar 写入"焦点问题"框。
 */
import { authFetch } from '@/utils/api'

export interface ExtractFocusQuestionFromImagesResult {
  success: boolean
  question: string
  /**
   * 从图片中忠实提取的关键文本/术语/关系，作为概念图生成 prompt 的"参考素材"。
   * 调用方将其与焦点问题一起传给生成流程，让 LLM 优先基于图片实际内容组织节点；
   * 不足处再用模型常识补充。可能为空（图片里几乎没有文字时）。
   */
  imageContent?: string
  raw?: string
  error?: string
}

interface ExtractParams {
  /**
   * Dify 文件 ID 列表（兜底通道）。仅在传入了 imagesBase64 时可省略。
   * 后端在缺少 base64 时会回退到 Dify `/files/{id}/preview` 反向下载，但该接口
   * 在文件未参与 chat 上下文时会 404，所以**优先传 base64**。
   */
  fileIds?: string[]
  /**
   * 图片 base64 data URL 列表（形如 `data:image/png;base64,...`）。
   * 这是首选通道：本地直接 base64 编码，避免依赖 Dify 反向下载。
   */
  imagesBase64?: string[]
  fileDataUrls?: string[]
  fileNames?: string[]
  userMessage?: string
  language?: string
  signal?: AbortSignal
}

/**
 * 调用后端从图片提取焦点问题。
 *
 * 后端会做以下保障：
 *   - 一定返回问句形式（强制以 "?"/"？" 结尾）
 *   - 长度受限，避免把整段说明塞回来
 *   - 自动剥离"焦点问题:"等前缀
 *
 * 失败时 success=false，error 给一段可展示给用户的简短文案；调用方需要兜底
 * （例如改用工具栏的默认生成流程）。
 */
export async function extractFocusQuestionFromImages(
  params: ExtractParams
): Promise<ExtractFocusQuestionFromImagesResult> {
  const fileIds = (params.fileIds || []).filter(Boolean)
  const imagesBase64 = (params.imagesBase64 || []).filter(Boolean)
  const fileDataUrls = (params.fileDataUrls || []).filter(Boolean)
  const fileNames = params.fileNames || []
  if (fileDataUrls.length === 0 && imagesBase64.length === 0 && fileIds.length === 0) {
    return { success: false, question: '', error: 'no files provided' }
  }

  try {
    const resp = await authFetch('/api/concept_map/extract-focus-question-from-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_ids: fileIds,
        images_base64: imagesBase64,
        file_data_urls: fileDataUrls,
        file_names: fileNames,
        user_message: params.userMessage || '',
        language: params.language || 'zh',
      }),
      signal: params.signal,
    })

    if (!resp.ok) {
      const detail = await resp
        .json()
        .then((j) => (typeof j?.detail === 'string' ? j.detail : ''))
        .catch(() => '')
      return {
        success: false,
        question: '',
        error: detail || `HTTP ${resp.status}`,
      }
    }

    const data = (await resp.json()) as {
      success?: boolean
      question?: string
      image_content?: string
      raw?: string
      error?: string
    }
    if (!data?.success || !data.question) {
      return {
        success: false,
        question: '',
        error: data?.error || 'empty question',
      }
    }
    return {
      success: true,
      question: data.question,
      imageContent: typeof data.image_content === 'string' ? data.image_content : '',
      raw: data.raw,
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { success: false, question: '', error: 'aborted' }
    }
    const msg = e instanceof Error ? e.message : 'unknown error'
    return { success: false, question: '', error: msg }
  }
}
