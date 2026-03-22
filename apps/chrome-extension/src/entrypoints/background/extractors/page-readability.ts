/**
 * Page Readability Extractor
 *
 * 封装现有 content script DOM/Readability 抽取逻辑。
 * 通过 ctx.extractFromTab() 调用 content script 获取页面文本。
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types";

const MIN_CHAT_CHARS = 100;

function countWords(text: string): number {
  return text.length > 0 ? text.split(/\s+/).filter(Boolean).length : 0;
}

export class PageReadabilityExtractor implements Extractor {
  readonly id = "page-readability";

  match(_ctx: ExtractorContext): boolean {
    // 始终可用——作为通用 fallback
    return true;
  }

  async extract(ctx: ExtractorContext): Promise<ExtractorResult | null> {
    const maxChars = ctx.settings.maxChars;

    const attempt = await ctx.extractFromTab(ctx.tab.id, maxChars);

    if (!attempt.ok) {
      const errorMsg = attempt.error;
      // content script 注入被 Chrome 拦截时，直接向上抛出而非返回 null
      if (
        errorMsg.toLowerCase().includes("chrome blocked") ||
        errorMsg.toLowerCase().includes("failed to inject")
      ) {
        throw new Error(errorMsg);
      }
      ctx.log("extractor.pageReadability.extractFailed", { error: errorMsg });
      return null;
    }

    const text = attempt.data.text.trim();
    if (text.length < MIN_CHAT_CHARS) {
      ctx.log("extractor.pageReadability.tooShort", { chars: text.length });
      return null;
    }

    const extracted = attempt.data;
    const wordCount = countWords(text);

    return {
      url: extracted.url,
      title: extracted.title ?? ctx.tab.title?.trim() ?? null,
      text,
      source: "page",
      truncated: extracted.truncated,
      totalCharacters: text.length,
      wordCount,
      media: extracted.media ?? null,
      transcriptSource: null,
      transcriptionProvider: null,
      transcriptCharacters: null,
      transcriptWordCount: null,
      transcriptLines: null,
      transcriptTimedText: null,
      mediaDurationSeconds: extracted.mediaDurationSeconds ?? null,
      slides: null,
      diagnostics: null,
    };
  }
}
