/**
 * Extractor Router
 *
 * 核心路由逻辑：
 * - preferUrl === true → 仅走 url-daemon（硬切换，不尝试 reddit-* / page-readability）
 * - preferUrl === false → 依序尝试 [reddit-thread, reddit-listing, page-readability, url-daemon]
 *
 * 绝不修改 shouldPreferUrlMode 的判断逻辑。
 */

import { shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type { ExtractResponse } from "../content-script-bridge";
import { PageReadabilityExtractor } from "./page-readability";
import { RedditListingExtractor } from "./reddit-listing";
import { RedditThreadExtractor } from "./reddit-thread";
import type { ExtractorContext, ExtractorResult } from "./types";
import { UrlDaemonExtractor } from "./url-daemon";

// ---------------------------------------------------------------------------
// Extractor 实例（单例）
// ---------------------------------------------------------------------------

const redditThread = new RedditThreadExtractor();
const redditListing = new RedditListingExtractor();
const pageReadability = new PageReadabilityExtractor();
const urlDaemon = new UrlDaemonExtractor();

/** preferUrl === false 时的尝试顺序 */
const PAGE_EXTRACTORS = [redditThread, redditListing, pageReadability, urlDaemon] as const;

// ---------------------------------------------------------------------------
// Router 入口
// ---------------------------------------------------------------------------

export async function routeExtract({
  tab,
  settings,
  extractFromTab,
  fetchImpl,
  log,
  sendStatus,
}: {
  tab: chrome.tabs.Tab;
  settings: {
    token: string;
    maxChars: number;
    slidesEnabled: boolean;
    extendedLogging: boolean;
  };
  extractFromTab: (
    tabId: number,
    maxChars: number,
  ) => Promise<ExtractResponse>;
  fetchImpl: typeof fetch;
  log: (event: string, detail?: Record<string, unknown>) => void;
  sendStatus: (status: string) => void;
}): Promise<ExtractorResult> {
  // 流程 0：入口校验
  if (!tab.id || !tab.url) {
    throw new Error("Cannot chat on this page");
  }

  const typedTab = tab as chrome.tabs.Tab & { id: number; url: string };
  const preferUrl = shouldPreferUrlMode(typedTab.url);

  log("extractor.route.start", { url: typedTab.url, preferUrl });

  const ctx: ExtractorContext = {
    tab: typedTab,
    settings,
    extractFromTab,
    fetchImpl,
    log,
    sendStatus,
  };

  // 流程 1：preferUrl 硬切换——不可绕过
  if (preferUrl) {
    log("extractor.route.preferUrlHardSwitch", { url: typedTab.url });
    log("extractor.try", { extractorId: urlDaemon.id });
    try {
      const result = await urlDaemon.extract(ctx);
      if (result) {
        log("extractor.success", {
          extractorId: urlDaemon.id,
          chars: result.totalCharacters,
          truncated: result.truncated,
          textPreview: result.text.slice(0, 500),
        });
        return result;
      }
      log("extractor.fail", { extractorId: urlDaemon.id, reason: "returned null" });
    } catch (err) {
      log("extractor.fail", {
        extractorId: urlDaemon.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    throw new Error("URL daemon extraction failed");
  }

  // 流程 2：非 preferUrl 的 router 链
  for (const extractor of PAGE_EXTRACTORS) {
    if (!extractor.match(ctx)) continue;

    log("extractor.try", { extractorId: extractor.id });
    try {
      const result = await extractor.extract(ctx);
      if (result) {
        log("extractor.success", {
          extractorId: extractor.id,
          chars: result.totalCharacters,
          truncated: result.truncated,
          textPreview: result.text.slice(0, 500),
        });
        return result;
      }
      log("extractor.fail", { extractorId: extractor.id, reason: "returned null" });
    } catch (err) {
      // page-readability 的 Chrome-blocked 错误需要向上抛出
      if (
        extractor.id === "page-readability" &&
        err instanceof Error &&
        (err.message.toLowerCase().includes("chrome blocked") ||
          err.message.toLowerCase().includes("failed to inject"))
      ) {
        throw err;
      }
      log("extractor.fail", {
        extractorId: extractor.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      // 继续尝试下一个 extractor
    }
  }

  throw new Error("No extractor succeeded for this page");
}
