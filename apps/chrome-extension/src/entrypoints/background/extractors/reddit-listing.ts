/**
 * Reddit Listing Extractor
 *
 * 提取 subreddit 列表页（如 r/GeminiAI、r/GeminiAI/hot 等）中的帖子摘要。
 * JSON 结构为单个 Listing，children 为 t3（帖子）。
 * 仅在 preferUrl === false 时由 Router 调用。
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types";

// ---------------------------------------------------------------------------
// Reddit Listing JSON 类型
// ---------------------------------------------------------------------------

interface RedditListingPost {
  kind: "t3";
  data: {
    title: string;
    selftext: string;
    author: string;
    score: number;
    created_utc: number;
    num_comments: number;
    subreddit: string;
    permalink: string;
    url: string;
    link_flair_text: string | null;
    is_self: boolean;
    stickied: boolean;
    domain: string;
  };
}

interface RedditListing {
  kind: "Listing";
  data: {
    children: (RedditListingPost | { kind: string })[];
    after: string | null;
    dist: number;
  };
}

// ---------------------------------------------------------------------------
// 常量 / 预算
// ---------------------------------------------------------------------------

const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com"]);

/** 匹配 subreddit 列表页路径（排除 /comments/ 帖子详情） */
const REDDIT_SUBREDDIT_RE = /^\/r\/([^/]+)\/?(?:hot|new|rising|top|controversial)?$/;

const MAX_POSTS = 50;
const MAX_SELFTEXT_CHARS = 500;

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function formatDate(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString();
}

function buildJsonUrl(tabUrl: string): string {
  const url = new URL(tabUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith(".json")) {
    url.pathname += ".json";
  }
  return url.toString();
}

function clampText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…[truncated]";
}

function countWords(text: string): number {
  return text.length > 0 ? text.split(/\s+/).filter(Boolean).length : 0;
}

// ---------------------------------------------------------------------------
// Extractor 实现
// ---------------------------------------------------------------------------

export class RedditListingExtractor implements Extractor {
  readonly id = "reddit-listing";

  match(ctx: ExtractorContext): boolean {
    try {
      const url = new URL(ctx.tab.url);
      const host = url.hostname.toLowerCase();
      return REDDIT_HOSTS.has(host) && REDDIT_SUBREDDIT_RE.test(url.pathname);
    } catch {
      return false;
    }
  }

  async extract(ctx: ExtractorContext): Promise<ExtractorResult | null> {
    const jsonUrl = buildJsonUrl(ctx.tab.url);
    ctx.log("extractor.redditListing.fetchStart", { jsonUrl });

    let res: Response;
    try {
      res = await ctx.fetchImpl(jsonUrl, {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
    } catch (err) {
      ctx.log("extractor.redditListing.fetchError", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (!res.ok) {
      ctx.log("extractor.redditListing.httpError", { status: res.status });
      return null;
    }

    let data: RedditListing;
    try {
      data = (await res.json()) as RedditListing;
    } catch {
      ctx.log("extractor.redditListing.parseError");
      return null;
    }

    if (data?.kind !== "Listing" || !data.data?.children) {
      ctx.log("extractor.redditListing.invalidShape");
      return null;
    }

    // 从 URL 提取 subreddit 名称
    const subredditMatch = new URL(ctx.tab.url).pathname.match(REDDIT_SUBREDDIT_RE);
    const subreddit = subredditMatch?.[1] ?? "unknown";

    // 格式化标题
    let text = `r/${subreddit} — ${data.data.dist ?? 0} posts\n\n`;

    const budget = {
      chars: text.length,
      count: 0,
      maxChars: ctx.settings.maxChars,
      truncated: false,
    };

    for (const child of data.data.children) {
      if (child.kind !== "t3") continue;
      if (budget.count >= MAX_POSTS || budget.chars >= budget.maxChars) {
        budget.truncated = true;
        break;
      }

      const post = child as RedditListingPost;
      const d = post.data;
      const date = formatDate(d.created_utc);
      const flair = d.link_flair_text ? ` [${d.link_flair_text}]` : "";
      const pinned = d.stickied ? " 📌" : "";

      let entry = `${budget.count + 1}. ${d.title}${flair}${pinned}\n`;
      entry += `   by u/${d.author} | score: ${d.score} | ${d.num_comments} comments | ${date}\n`;

      // 对 self post 展示 selftext 摘要
      if (d.is_self && d.selftext) {
        const preview = clampText(d.selftext.replace(/\n+/g, " ").trim(), MAX_SELFTEXT_CHARS);
        entry += `   ${preview}\n`;
      } else if (!d.is_self) {
        entry += `   → ${d.url}\n`;
      }
      entry += "\n";

      if (budget.chars + entry.length > budget.maxChars) {
        budget.truncated = true;
        break;
      }

      text += entry;
      budget.chars += entry.length;
      budget.count += 1;
    }

    if (budget.count === 0) {
      ctx.log("extractor.redditListing.noPosts");
      return null;
    }

    const wordCount = countWords(text);

    return {
      url: ctx.tab.url,
      title: `r/${subreddit}`,
      text,
      source: "page",
      truncated: budget.truncated,
      totalCharacters: text.length,
      wordCount,
      media: null,
      transcriptSource: null,
      transcriptionProvider: null,
      transcriptCharacters: null,
      transcriptWordCount: null,
      transcriptLines: null,
      transcriptTimedText: null,
      mediaDurationSeconds: null,
      slides: null,
      diagnostics: { strategy: "reddit-listing-json" },
    };
  }
}
