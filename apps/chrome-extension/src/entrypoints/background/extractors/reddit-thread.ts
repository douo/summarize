/**
 * Reddit Thread Extractor
 *
 * 通过 Reddit JSON API（URL 末尾加 .json）提取帖子 + 评论的结构化纯文本。
 * 仅在 preferUrl === false 时由 Router 调用。
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types";

// ---------------------------------------------------------------------------
// Reddit JSON API 类型
// ---------------------------------------------------------------------------

interface RedditComment {
  kind: "t1";
  data: {
    body: string;
    author: string;
    score: number;
    created_utc: number;
    replies: RedditListing | "";
    depth: number;
  };
}

interface RedditPost {
  kind: "t3";
  data: {
    title: string;
    selftext: string;
    author: string;
    score: number;
    created_utc: number;
    num_comments: number;
    subreddit: string;
  };
}

interface RedditListing {
  kind: "Listing";
  data: {
    children: (RedditPost | RedditComment | { kind: string })[];
  };
}

// ---------------------------------------------------------------------------
// 常量 / 预算限制
// ---------------------------------------------------------------------------

const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com"]);
const REDDIT_THREAD_RE = /\/r\/([^/]+)\/comments\/([^/]+)/;

const MAX_DEPTH = 4;
const MAX_COMMENTS = 200;
const MAX_COMMENT_CHARS = 2000;

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function formatDate(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString();
}

/** 构建 JSON API URL */
function buildJsonUrl(tabUrl: string): string {
  const url = new URL(tabUrl);
  // 去掉末尾斜杠
  url.pathname = url.pathname.replace(/\/+$/, "");
  // 若不以 .json 结尾则追加
  if (!url.pathname.endsWith(".json")) {
    url.pathname += ".json";
  }
  return url.toString();
}

/** 截断单条评论正文 */
function clampBody(body: string, maxLen: number): string {
  if (body.length <= maxLen) return body;
  return body.slice(0, maxLen) + "…[truncated]";
}

/** 递归格式化评论 */
function formatComments(
  children: (RedditPost | RedditComment | { kind: string })[],
  depth: number,
  budget: { chars: number; count: number; maxChars: number; truncated: boolean },
): string {
  if (depth > MAX_DEPTH || budget.count >= MAX_COMMENTS || budget.chars >= budget.maxChars) {
    budget.truncated = true;
    return "";
  }

  const parts: string[] = [];
  for (const child of children) {
    if (child.kind !== "t1") continue;
    if (budget.count >= MAX_COMMENTS || budget.chars >= budget.maxChars) {
      budget.truncated = true;
      break;
    }

    const comment = child as RedditComment;
    const indent = "  ".repeat(depth);
    const date = formatDate(comment.data.created_utc);
    const body = clampBody(comment.data.body, MAX_COMMENT_CHARS);
    const line = `${indent}[${date}] ${comment.data.author} (score: ${comment.data.score}):\n${indent}${body}\n`;

    if (budget.chars + line.length > budget.maxChars) {
      budget.truncated = true;
      break;
    }

    parts.push(line);
    budget.chars += line.length;
    budget.count += 1;

    // 递归 replies
    if (comment.data.replies && typeof comment.data.replies !== "string") {
      const repliesText = formatComments(
        comment.data.replies.data.children,
        depth + 1,
        budget,
      );
      if (repliesText) {
        parts.push(repliesText);
      }
    }
  }

  return parts.join("\n");
}

function countWords(text: string): number {
  return text.length > 0 ? text.split(/\s+/).filter(Boolean).length : 0;
}

// ---------------------------------------------------------------------------
// Extractor 实现
// ---------------------------------------------------------------------------

export class RedditThreadExtractor implements Extractor {
  readonly id = "reddit-thread";

  match(ctx: ExtractorContext): boolean {
    try {
      const url = new URL(ctx.tab.url);
      const host = url.hostname.toLowerCase();
      return REDDIT_HOSTS.has(host) && REDDIT_THREAD_RE.test(url.pathname);
    } catch {
      return false;
    }
  }

  async extract(ctx: ExtractorContext): Promise<ExtractorResult | null> {
    const jsonUrl = buildJsonUrl(ctx.tab.url);
    ctx.log("extractor.reddit.fetchStart", { jsonUrl });

    let res: Response;
    try {
      res = await ctx.fetchImpl(jsonUrl, {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
    } catch (err) {
      ctx.log("extractor.reddit.fetchError", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (!res.ok) {
      ctx.log("extractor.reddit.httpError", { status: res.status });
      return null;
    }

    let data: [RedditListing, RedditListing];
    try {
      data = (await res.json()) as [RedditListing, RedditListing];
    } catch {
      ctx.log("extractor.reddit.parseError");
      return null;
    }

    // 基本校验
    if (
      !Array.isArray(data) ||
      data.length < 2 ||
      data[0]?.kind !== "Listing" ||
      data[1]?.kind !== "Listing"
    ) {
      ctx.log("extractor.reddit.invalidShape");
      return null;
    }

    const postChild = data[0].data.children[0];
    if (!postChild || postChild.kind !== "t3") {
      ctx.log("extractor.reddit.noPost");
      return null;
    }
    const post = postChild as RedditPost;

    // 格式化帖子头部
    const postDate = formatDate(post.data.created_utc);
    let text = `[${postDate}] ${post.data.author} posted in r/${post.data.subreddit} (score: ${post.data.score}):\n`;
    text += `Title: ${post.data.title}\n\n`;
    if (post.data.selftext) {
      text += `${post.data.selftext}\n\n`;
    }
    text += `--- ${post.data.num_comments} comments ---\n\n`;

    // 格式化评论
    const budget = {
      chars: text.length,
      count: 0,
      maxChars: ctx.settings.maxChars,
      truncated: false,
    };

    const commentsText = formatComments(data[1].data.children, 0, budget);
    text += commentsText;

    const wordCount = countWords(text);

    return {
      url: ctx.tab.url,
      title: post.data.title,
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
      diagnostics: { strategy: "reddit-thread-json" },
    };
  }
}
