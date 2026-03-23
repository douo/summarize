import { shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type { RunStart } from "../../lib/panel-contracts";
import type { Settings } from "../../lib/settings";
import { isYouTubeWatchUrl } from "../../lib/youtube-url";
import type { ExtractResponse } from "./content-script-bridge";
import type { CachedExtract } from "./extract-cache";
import { routeExtract } from "./extractors/router";

type DaemonRecoveryLike = {
  recordFailure: (url: string) => void;
};

type DaemonStatusLike = {
  markReady: () => void;
};

type BackgroundSummarizeSession = {
  windowId: number;
  runController: AbortController | null;
  inflightUrl: string | null;
  lastSummarizedUrl: string | null;
  daemonRecovery: DaemonRecoveryLike;
  daemonStatus: DaemonStatusLike;
};

type StoreLike = {
  isPanelOpen: (session: BackgroundSummarizeSession) => boolean;
  setCachedExtract: (tabId: number, value: CachedExtract) => void;
};

type SendFn = (
  msg:
    | { type: "run:error"; message: string }
    | { type: "run:start"; run: RunStart }
    | { type: "slides:run"; ok: boolean; runId?: string; url?: string; error?: string },
) => void;

function resolveSlidesForLength(
  lengthValue: string,
  durationSeconds: number | null | undefined,
): { maxSlides: number | null; minDurationSeconds: number | null } {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { maxSlides: null, minDurationSeconds: null };
  }
  const normalized = lengthValue.trim().toLowerCase();
  const chunkSeconds =
    normalized === "short"
      ? 600
      : normalized === "medium"
        ? 450
        : normalized === "long"
          ? 300
          : normalized === "xl"
            ? 180
            : normalized === "xxl"
              ? 120
              : 300;
  const target = Math.max(3, Math.round(durationSeconds / chunkSeconds));
  const maxSlides = Math.max(3, Math.min(80, target));
  const minDuration = Math.max(2, Math.floor(durationSeconds / maxSlides));
  return { maxSlides, minDurationSeconds: minDuration };
}

export async function summarizeActiveTab({
  session,
  reason,
  opts,
  loadSettings,
  emitState,
  getActiveTab,
  canSummarizeUrl,
  panelSessionStore,
  sendStatus,
  send,
  fetchImpl,
  extractFromTab,
  urlsMatch,
  buildSummarizeRequestBody,
  friendlyFetchError,
  isDaemonUnreachableError,
  logPanel,
}: {
  session: BackgroundSummarizeSession;
  reason: string;
  opts?: { refresh?: boolean; inputMode?: "page" | "video" };
  loadSettings: () => Promise<Settings>;
  emitState: (session: BackgroundSummarizeSession, status: string) => Promise<void>;
  getActiveTab: (windowId?: number) => Promise<chrome.tabs.Tab | null>;
  canSummarizeUrl: (url?: string | null) => boolean;
  panelSessionStore: StoreLike;
  sendStatus: (status: string) => void;
  send: SendFn;
  fetchImpl: typeof fetch;
  extractFromTab: (
    tabId: number,
    maxChars: number,
    opts?: {
      timeoutMs?: number;
      log?: (event: string, detail?: Record<string, unknown>) => void;
    },
  ) => Promise<ExtractResponse>;
  urlsMatch: (left: string, right: string) => boolean;
  buildSummarizeRequestBody: (args: {
    extracted: ExtractResponse & { ok: true };
    settings: Settings;
    noCache: boolean;
    inputMode?: "page" | "video";
    timestamps: boolean;
    slides:
      | { enabled: false }
      | {
          enabled: true;
          ocr: boolean;
          maxSlides: number | null;
          minDurationSeconds: number | null;
        };
  }) => Record<string, unknown>;
  friendlyFetchError: (error: unknown, fallback: string) => string;
  isDaemonUnreachableError: (error: unknown) => boolean;
  logPanel: (event: string, detail?: Record<string, unknown>) => void;
}) {
  if (!panelSessionStore.isPanelOpen(session)) return;

  const settings = await loadSettings();
  const isManual = reason === "manual" || reason === "refresh" || reason === "length-change";
  if (!isManual && !settings.autoSummarize) return;
  if (!settings.token.trim()) {
    await emitState(session, "Setup required (missing token)");
    return;
  }

  if (reason === "spa-nav" || reason === "tab-url-change") {
    await new Promise((resolve) => setTimeout(resolve, 220));
  }

  const tab = await getActiveTab(session.windowId);
  if (!tab?.id || !canSummarizeUrl(tab.url)) return;

  session.runController?.abort();
  const controller = new AbortController();
  session.runController = controller;

  let extracted: ExtractResponse & { ok: true };
  try {
    const result = await routeExtract({
      tab: tab as chrome.tabs.Tab & { id: number; url: string },
      settings: {
        token: settings.token,
        maxChars: settings.maxChars,
        slidesEnabled: settings.slidesEnabled,
        extendedLogging: settings.extendedLogging,
      },
      noCache: Boolean(opts?.refresh),
      extractFromTab,
      fetchImpl,
      log: logPanel,
      sendStatus,
    });

    extracted = {
      ok: true,
      url: result.url,
      title: result.title,
      text: result.text,
      truncated: result.truncated,
      media: result.media,
      mediaDurationSeconds: result.mediaDurationSeconds,
    };

    // 对于 URL 提取器（如 YouTube/url-daemon），预先更新缓存以匹配之前的 FastPath 逻辑。
    if (result.source === "url") {
      panelSessionStore.setCachedExtract(tab.id, {
        url: result.url,
        title: result.title,
        text: result.text,
        source: "url",
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
      });
      session.daemonStatus.markReady();
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logPanel("extract:failed", { error: errorMsg });

    // 提取彻底失败时回退到空外壳。
    extracted = {
      ok: true,
      url: tab.url,
      title: tab.title ?? null,
      text: "",
      truncated: false,
      media: null,
    };
  }

  if (tab.url && extracted.url && !urlsMatch(tab.url, extracted.url)) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    logPanel("extract:retry", { tabId: tab.id, maxChars: settings.maxChars });
    const retry = await extractFromTab(tab.id, settings.maxChars, {
      timeoutMs: 8_000,
      log: (event, detail) => logPanel(event, detail),
    });
    if (retry.ok) {
      extracted = retry.data;
    }
  }

  const extractedMatchesTab = tab.url && extracted.url ? urlsMatch(tab.url, extracted.url) : true;
  const resolvedExtracted =
    tab.url && !extractedMatchesTab
      ? {
          ok: true,
          url: tab.url,
          title: tab.title ?? null,
          text: "",
          truncated: false,
          media: null,
        }
      : extracted;

  if (
    settings.autoSummarize &&
    ((session.lastSummarizedUrl && urlsMatch(session.lastSummarizedUrl, resolvedExtracted.url)) ||
      (session.inflightUrl && urlsMatch(session.inflightUrl, resolvedExtracted.url))) &&
    !isManual
  ) {
    sendStatus("");
    return;
  }

  const resolvedTitle = tab.title?.trim() || resolvedExtracted.title || null;
  const resolvedPayload = { ...resolvedExtracted, title: resolvedTitle };
  const effectiveInputMode =
    opts?.inputMode ??
    (resolvedPayload.url && shouldPreferUrlMode(resolvedPayload.url) ? "video" : undefined);
  const wordCount =
    resolvedPayload.text.length > 0 ? resolvedPayload.text.split(/\s+/).filter(Boolean).length : 0;
  const wantsSummaryTimestamps =
    settings.summaryTimestamps &&
    (effectiveInputMode === "video" ||
      resolvedPayload.media?.hasVideo === true ||
      resolvedPayload.media?.hasAudio === true ||
      resolvedPayload.media?.hasCaptions === true ||
      shouldPreferUrlMode(resolvedPayload.url));
  const wantsSlides =
    settings.slidesEnabled &&
    (effectiveInputMode === "video" ||
      resolvedPayload.media?.hasVideo === true ||
      shouldPreferUrlMode(resolvedPayload.url));
  const wantsParallelSlides = wantsSlides && settings.slidesParallel;
  const summaryTimestamps = wantsSummaryTimestamps || (wantsSlides && !wantsParallelSlides);
  const slidesTimestamps = wantsSummaryTimestamps || wantsSlides;

  logPanel("summarize:start", {
    reason,
    url: resolvedPayload.url,
    inputMode: effectiveInputMode ?? null,
    wantsSummaryTimestamps: summaryTimestamps,
    wantsSlides,
    wantsParallelSlides,
  });

  panelSessionStore.setCachedExtract(tab.id, {
    url: resolvedPayload.url,
    title: resolvedTitle,
    text: resolvedPayload.text,
    source: "page",
    truncated: resolvedPayload.truncated,
    totalCharacters: resolvedPayload.text.length,
    wordCount,
    media: resolvedPayload.media ?? null,
    transcriptSource: null,
    transcriptionProvider: null,
    transcriptCharacters: null,
    transcriptWordCount: null,
    transcriptLines: null,
    transcriptTimedText: null,
    mediaDurationSeconds: resolvedPayload.mediaDurationSeconds ?? null,
    slides: null,
    diagnostics: null,
  });

  sendStatus("Connecting…");
  session.inflightUrl = resolvedPayload.url;
  const slideAuto = wantsSlides
    ? resolveSlidesForLength(settings.length, resolvedPayload.mediaDurationSeconds)
    : { maxSlides: null, minDurationSeconds: null };
  const slidesConfig = wantsSlides
    ? {
        enabled: true as const,
        ocr: settings.slidesOcrEnabled,
        maxSlides: slideAuto.maxSlides,
        minDurationSeconds: slideAuto.minDurationSeconds,
      }
    : { enabled: false as const };
  const summarySlides = wantsParallelSlides ? { enabled: false as const } : slidesConfig;

  let id: string;
  try {
    const body = buildSummarizeRequestBody({
      extracted: resolvedPayload,
      settings,
      noCache: Boolean(opts?.refresh),
      inputMode: effectiveInputMode,
      timestamps: summaryTimestamps,
      slides: summarySlides,
    });
    logPanel("summarize:request", {
      url: resolvedPayload.url,
      slides: wantsSlides && !wantsParallelSlides,
      slidesParallel: wantsParallelSlides,
      timestamps: summaryTimestamps,
    });
    const res = await fetchImpl("http://127.0.0.1:8787/v1/summarize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.token.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json()) as { ok: boolean; id?: string; error?: string };
    if (!res.ok || !json.ok || !json.id) {
      throw new Error(json.error || `${res.status} ${res.statusText}`);
    }
    session.daemonStatus.markReady();
    id = json.id;
  } catch (err) {
    if (controller.signal.aborted) return;
    const message = friendlyFetchError(err, "Daemon request failed");
    send({ type: "run:error", message });
    sendStatus(`Error: ${message}`);
    session.inflightUrl = null;
    if (!isManual && isDaemonUnreachableError(err)) {
      session.daemonRecovery.recordFailure(resolvedPayload.url);
    }
    return;
  }

  send({
    type: "run:start",
    run: { id, url: resolvedPayload.url, title: resolvedTitle, model: settings.model, reason },
  });

  if (!wantsParallelSlides) return;

  void (async () => {
    try {
      const slidesBody = buildSummarizeRequestBody({
        extracted: resolvedPayload,
        settings,
        noCache: Boolean(opts?.refresh),
        inputMode: effectiveInputMode,
        timestamps: slidesTimestamps,
        slides: slidesConfig,
      });
      logPanel("slides:request", { url: resolvedPayload.url });
      const res = await fetchImpl("http://127.0.0.1:8787/v1/summarize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.token.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(slidesBody),
        signal: controller.signal,
      });
      const json = (await res.json()) as { ok: boolean; id?: string; error?: string };
      if (!res.ok || !json.ok || !json.id) {
        throw new Error(json.error || `${res.status} ${res.statusText}`);
      }
      session.daemonStatus.markReady();
      if (
        controller.signal.aborted ||
        session.runController !== controller ||
        (session.inflightUrl && !urlsMatch(session.inflightUrl, resolvedPayload.url))
      ) {
        return;
      }
      send({ type: "slides:run", ok: true, runId: json.id, url: resolvedPayload.url });
    } catch (err) {
      if (
        controller.signal.aborted ||
        session.runController !== controller ||
        (session.inflightUrl && !urlsMatch(session.inflightUrl, resolvedPayload.url))
      ) {
        return;
      }
      const message = friendlyFetchError(err, "Slides request failed");
      logPanel("slides:request:error", { error: message });
      send({ type: "slides:run", ok: false, error: message });
    }
  })();
}
