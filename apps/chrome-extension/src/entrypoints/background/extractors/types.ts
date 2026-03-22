/**
 * Extractor Router 框架——类型定义
 *
 * 定义 Extractor 统一接口、上下文与输出类型。
 */

import type { ExtractResponse } from "../content-script-bridge";
import type { SlidesPayload } from "../panel-utils";

// ---------------------------------------------------------------------------
// Extractor 上下文 —— 由 Router 构造后传入各 Extractor
// ---------------------------------------------------------------------------

export type ExtractorContext = {
  /** 当前标签页。router 已保证 tab.id / tab.url 非空。 */
  tab: chrome.tabs.Tab & { id: number; url: string };

  /** 精简设置，仅包含 Extractor 需要的字段 */
  settings: {
    token: string;
    maxChars: number;
    slidesEnabled: boolean;
    extendedLogging: boolean;
  };

  /** 通过 content script 从标签页提取（即现有 Readability 路径） */
  extractFromTab: (
    tabId: number,
    maxChars: number,
  ) => Promise<ExtractResponse>;

  /** fetch 实现（便于测试注入） */
  fetchImpl: typeof fetch;

  /** 结构化日志回调 */
  log: (event: string, detail?: Record<string, unknown>) => void;

  /** 状态消息回调 */
  sendStatus: (status: string) => void;
};

// ---------------------------------------------------------------------------
// Extractor 输出 —— 与 CachedExtract 对齐
// ---------------------------------------------------------------------------

export type ExtractorResult = {
  url: string;
  title: string | null;
  text: string;
  source: "page" | "url";
  truncated: boolean;
  totalCharacters: number;
  wordCount: number | null;
  media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
  transcriptSource: string | null;
  transcriptionProvider: string | null;
  transcriptCharacters: number | null;
  transcriptWordCount: number | null;
  transcriptLines: number | null;
  transcriptTimedText: string | null;
  mediaDurationSeconds: number | null;
  slides: SlidesPayload | null;
  diagnostics?: {
    strategy: string;
    markdown?: { used?: boolean; provider?: string | null } | null;
    firecrawl?: { used?: boolean } | null;
    transcript?: {
      provider?: string | null;
      cacheStatus?: string | null;
      attemptedProviders?: string[] | null;
    } | null;
  } | null;
};

// ---------------------------------------------------------------------------
// Extractor 统一接口
// ---------------------------------------------------------------------------

export interface Extractor {
  /** 唯一标识，用于日志和调试 */
  readonly id: string;

  /** 判断当前标签页是否适用此 Extractor（纯同步判断） */
  match(ctx: ExtractorContext): boolean;

  /** 执行提取。返回 null 表示失败，Router 将尝试下一个 Extractor。 */
  extract(ctx: ExtractorContext): Promise<ExtractorResult | null>;
}
