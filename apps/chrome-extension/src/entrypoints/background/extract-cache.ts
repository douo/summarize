import { shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type { ExtractResponse } from "./content-script-bridge";
import { routeExtract } from "./extractors/router";
import type { SlidesPayload } from "./panel-utils";

export type CachedExtract = {
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

type CachedExtractStore = {
  getCachedExtract(tabId: number, url: string): CachedExtract | null | undefined;
  setCachedExtract(tabId: number, value: CachedExtract): void;
  getLastMediaProbe(tabId: number): string | null | undefined;
  rememberMediaProbe(tabId: number, url: string): void;
};

type LoadSettingsResult = {
  slidesEnabled: boolean;
  token: string;
  maxChars: number;
  extendedLogging: boolean;
};

function countWords(text: string): number {
  return text.length > 0 ? text.split(/\s+/).filter(Boolean).length : 0;
}

function fromPageExtract({
  extracted,
  title,
}: {
  extracted: {
    url: string;
    title?: string | null;
    text: string;
    truncated: boolean;
    media?: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
    mediaDurationSeconds?: number | null;
  };
  title: string | null;
}): CachedExtract {
  return {
    url: extracted.url,
    title: extracted.title ?? title,
    text: extracted.text,
    source: "page",
    truncated: extracted.truncated,
    totalCharacters: extracted.text.length,
    wordCount: countWords(extracted.text),
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

export async function ensureChatExtract({
  session,
  tab,
  settings,
  panelSessionStore,
  sendStatus,
  extractFromTab,
  fetchImpl,
  log,
}: {
  session: { windowId: number };
  tab: chrome.tabs.Tab;
  settings: LoadSettingsResult;
  panelSessionStore: CachedExtractStore;
  sendStatus: (status: string) => void;
  extractFromTab: (tabId: number, maxCharacters: number) => Promise<ExtractResponse>;
  fetchImpl: typeof fetch;
  log: (event: string, detail?: Record<string, unknown>) => void;
}): Promise<CachedExtract> {
  if (!tab.id || !tab.url) {
    throw new Error("Cannot chat on this page");
  }

  const preferUrl = shouldPreferUrlMode(tab.url);
  const cached = panelSessionStore.getCachedExtract(tab.id, tab.url);
  if (cached && (!preferUrl || cached.source === "url")) return cached;

  // 委托给 Extractor Router 进行抽取
  const result = await routeExtract({
    tab,
    settings,
    extractFromTab,
    fetchImpl,
    log,
    sendStatus,
  });

  const next: CachedExtract = {
    url: result.url,
    title: result.title,
    text: result.text,
    source: result.source,
    truncated: result.truncated,
    totalCharacters: result.totalCharacters,
    wordCount: result.wordCount,
    media: result.media,
    transcriptSource: result.transcriptSource,
    transcriptionProvider: result.transcriptionProvider,
    transcriptCharacters: result.transcriptCharacters,
    transcriptWordCount: result.transcriptWordCount,
    transcriptLines: result.transcriptLines,
    transcriptTimedText: result.transcriptTimedText,
    mediaDurationSeconds: result.mediaDurationSeconds,
    slides: result.slides,
    diagnostics: result.diagnostics ?? null,
  };
  panelSessionStore.setCachedExtract(tab.id, next);
  return next;
}

export async function primeMediaHint({
  session,
  tabId,
  url,
  title,
  panelSessionStore,
  urlsMatch,
  extractFromTab,
  emitState,
}: {
  session: unknown;
  tabId: number;
  url: string;
  title: string | null;
  panelSessionStore: CachedExtractStore;
  urlsMatch: (left: string, right: string) => boolean;
  extractFromTab: (tabId: number, maxCharacters: number) => Promise<ExtractResponse>;
  emitState: (session: unknown, status: string) => void;
}): Promise<void> {
  const lastProbeUrl = panelSessionStore.getLastMediaProbe(tabId);
  if (lastProbeUrl && urlsMatch(lastProbeUrl, url)) return;
  const existing = panelSessionStore.getCachedExtract(tabId, url);
  if (existing?.media) {
    panelSessionStore.rememberMediaProbe(tabId, url);
    return;
  }

  panelSessionStore.rememberMediaProbe(tabId, url);
  const attempt = await extractFromTab(tabId, 1200);
  if (!attempt.ok || !attempt.data.media) return;

  panelSessionStore.setCachedExtract(
    tabId,
    fromPageExtract({
      extracted: attempt.data,
      title,
    }),
  );
  emitState(session, "");
}
