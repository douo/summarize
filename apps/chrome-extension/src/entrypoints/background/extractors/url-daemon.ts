/**
 * URL Daemon Extractor
 *
 * 封装现有 daemon `POST /v1/summarize { mode: "url", extractOnly: true }` 逻辑。
 * 当 preferUrl === true 时由 Router 直接调用；
 * 当 preferUrl === false 时作为 fallback 链的最后一环。
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types";

/** daemon extractOnly 响应结构 */
interface DaemonExtractResponse {
  ok: boolean;
  extracted?: {
    content: string;
    title: string | null;
    url: string;
    wordCount: number;
    totalCharacters: number;
    truncated: boolean;
    transcriptSource: string | null;
    transcriptCharacters?: number | null;
    transcriptWordCount?: number | null;
    transcriptLines?: number | null;
    transcriptionProvider?: string | null;
    transcriptTimedText?: string | null;
    mediaDurationSeconds?: number | null;
    diagnostics?: ExtractorResult["diagnostics"];
  };
  slides?: unknown;
  error?: string;
}

export class UrlDaemonExtractor implements Extractor {
  readonly id = "url-daemon";

  match(_ctx: ExtractorContext): boolean {
    // 始终可用——作为终极 fallback 或 preferUrl 模式的唯一提取器
    return true;
  }

  async extract(ctx: ExtractorContext): Promise<ExtractorResult | null> {
    const wantsSlides = ctx.settings.slidesEnabled && true; // 在 url-daemon 路径中保持原有逻辑
    ctx.sendStatus(wantsSlides ? "Extracting video + thumbnails…" : "Extracting video transcript…");

    const extractTimeoutMs = wantsSlides ? 6 * 60_000 : 3 * 60_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), extractTimeoutMs);

    let res: Response;
    let json: DaemonExtractResponse;
    try {
      res = await ctx.fetchImpl("http://127.0.0.1:8787/v1/summarize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.settings.token.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: ctx.tab.url,
          mode: "url",
          extractOnly: true,
          timestamps: true,
          ...(wantsSlides ? { slides: true } : {}),
          maxCharacters: null,
        }),
        signal: controller.signal,
      });
      json = (await res.json()) as DaemonExtractResponse;
    } catch (err) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new Error("Video extraction timed out. The daemon may be stuck.");
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!res.ok || !json.ok || !json.extracted) {
      ctx.log("extractor.urlDaemon.error", {
        status: res.status,
        error: json.error ?? null,
      });
      return null;
    }

    const extracted = json.extracted;

    // 尝试从 content script 获取 mediaDuration 的 fallback
    let mediaDurationSeconds = extracted.mediaDurationSeconds ?? null;
    let media: ExtractorResult["media"] = null;

    if (!mediaDurationSeconds) {
      const fallback = await ctx.extractFromTab(ctx.tab.id, Number.MAX_SAFE_INTEGER);
      if (fallback.ok) {
        const dur = fallback.data.mediaDurationSeconds;
        if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
          mediaDurationSeconds = dur;
        }
        if (fallback.data.media) {
          media = fallback.data.media;
        }
      }
    }

    return {
      url: extracted.url,
      title: extracted.title,
      text: extracted.content,
      source: "url",
      truncated: extracted.truncated,
      totalCharacters: extracted.totalCharacters,
      wordCount: extracted.wordCount,
      media,
      transcriptSource: extracted.transcriptSource ?? null,
      transcriptionProvider: extracted.transcriptionProvider ?? null,
      transcriptCharacters: extracted.transcriptCharacters ?? null,
      transcriptWordCount: extracted.transcriptWordCount ?? null,
      transcriptLines: extracted.transcriptLines ?? null,
      transcriptTimedText: extracted.transcriptTimedText ?? null,
      mediaDurationSeconds,
      slides: null, // slides 在 router 外层处理
      diagnostics: extracted.diagnostics ?? null,
    };
  }
}
