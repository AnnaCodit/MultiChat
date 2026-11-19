/**
 * YouTube Live Chat Connector for MultiChat.
 *
 * The connector intentionally uses the public live_chat HTML endpoint. Initial
 * data and subsequent continuation pages can therefore be fetched through the
 * existing GET-only transport without an API key or an authenticated session.
 */

// Static connector settings. Change these values in code; they are intentionally
// not exposed in the user-facing settings window.
const YOUTUBE_CONNECTOR_CONFIG = Object.freeze({
  minimumChatPollIntervalMs: 5000
});

class YoutubeConnector {
  constructor(onMessageCallback, onStatusCallback, options = {}) {
    this.onMessage = onMessageCallback;
    this.onStatus = onStatusCallback;
    this.fetcher = options.fetcher;
    this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
    this.logger = options.logger || console;
    this.requestTimeoutMs = options.requestTimeoutMs || 30000;
    this.minimumPollIntervalMs = Number.isFinite(options.minimumPollIntervalMs)
      ? Math.max(1000, options.minimumPollIntervalMs)
      : YOUTUBE_CONNECTOR_CONFIG.minimumChatPollIntervalMs;

    this.channelOrVideo = '';
    this.currentVideoId = null;
    this.isDirectVideo = false;
    this.ambiguousVideoId = null;
    this.pollTimer = null;
    this.retryTimer = null;
    this.abortController = null;
    this.connectionId = 0;
    this.continuationToken = null;
    this.consecutiveErrors = 0;
    this.isOnline = false;
    this.seenMessageIds = new Set();
    this.maxSeenMessageIds = 5000;
  }

  connect(channelOrVideo) {
    this.stopCurrentConnection(false);

    if (!channelOrVideo || !String(channelOrVideo).trim()) {
      this.onStatus('youtube', false, 'Канал/Видео не указано');
      return;
    }

    this.channelOrVideo = String(channelOrVideo).trim();
    this.abortController = new AbortController();
    const connectionId = this.connectionId;
    const videoId = this.extractVideoId(this.channelOrVideo);
    this.ambiguousVideoId = videoId === this.channelOrVideo ? videoId : null;
    this.isDirectVideo = Boolean(videoId && !this.ambiguousVideoId);

    this.logger.info(`[YouTube Connector] Connecting by ${this.isDirectVideo ? 'video URL' : 'channel input'}.`);
    this.onStatus('youtube', false, 'Поиск трансляции YouTube...');

    if (this.isDirectVideo) {
      void this.startChatPollingByVideoId(videoId, connectionId);
    } else {
      void this.resolveChannelLiveVideo(this.channelOrVideo, connectionId);
    }
  }

  extractVideoId(input) {
    const value = String(input || '').trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

    let url;
    try {
      url = new URL(value);
    } catch (error) {
      return null;
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
    }

    if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return null;

    const queryId = url.searchParams.get('v');
    if (/^[a-zA-Z0-9_-]{11}$/.test(queryId || '')) return queryId;

    const pathMatch = url.pathname.match(/\/(?:embed|live|shorts)\/([a-zA-Z0-9_-]{11})(?:\/|$)/);
    return pathMatch ? pathMatch[1] : null;
  }

  buildChannelLiveUrl(input) {
    const value = String(input || '').trim();

    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        const path = url.pathname.replace(/\/+$/, '');
        const channelPath = path.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/)?.[0];
        if (channelPath) {
          return `https://www.youtube.com${channelPath}/live`;
        }
      }
    } catch (error) {
      // A plain handle or channel ID is expected in the common case.
    }

    const cleanValue = value.replace(/^@+/, '').trim();
    if (/^UC[a-zA-Z0-9_-]{22}$/.test(cleanValue)) {
      return `https://www.youtube.com/channel/${cleanValue}/live`;
    }

    return `https://www.youtube.com/@${encodeURIComponent(cleanValue)}/live`;
  }

  async resolveChannelLiveVideo(channelInput, connectionId) {
    if (!this.isConnectionActive(connectionId)) return;
    this.isDirectVideo = false;

    let videoId;
    try {
      this.onStatus('youtube', false, 'Проверка Live стрима...');
      const url = this.buildChannelLiveUrl(channelInput);
      videoId = await this.fetchText(url, connectionId, 'youtube-live', html => this.readChannelLivePage(html));
      if (!this.isConnectionActive(connectionId)) return;
    } catch (error) {
      if (this.isAbortError(error) || !this.isConnectionActive(connectionId)) return;

      this.logRequestFailure('Unable to resolve live stream', error);
      if (this.ambiguousVideoId) {
        // Bare Video IDs remain supported when the input cannot be resolved as a channel.
        this.isDirectVideo = true;
        await this.startChatPollingByVideoId(this.ambiguousVideoId, connectionId);
        return;
      }
      const formatError = (error.cause || error).code === 'LIVE_RESPONSE_INVALID';
      this.onStatus('youtube', false, formatError ? 'Не удалось распознать ответ YouTube' : 'Ошибка поиска эфира YouTube');
      this.scheduleChannelRetry(connectionId, 30000);
      return;
    }

    this.ambiguousVideoId = null;
    if (videoId) {
      this.logger.info(`[YouTube Connector] Found live video ID: ${videoId}`);
      await this.startChatPollingByVideoId(videoId, connectionId);
      return;
    }
    this.onStatus('youtube', false, 'Офлайн (ожидание стрима)');
    this.scheduleChannelRetry(connectionId, 30000);
  }

  readChannelLivePage(html) {
    const playerResponse = this.extractAssignedJson(html, [
      'window["ytInitialPlayerResponse"]',
      'var ytInitialPlayerResponse',
      'ytInitialPlayerResponse'
    ]);
    const broadcast = playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
    if (playerResponse?.playabilityStatus?.status === 'LIVE_STREAM_OFFLINE'
      || playerResponse?.videoDetails?.isLiveContent === false || broadcast?.endTimestamp) {
      return null;
    }

    const videoId = this.extractLiveVideoIdFromHtml(html, playerResponse);
    if (videoId) return videoId;
    if (this.extractYtInitialData(html)?.metadata?.channelMetadataRenderer) return null;

    throw Object.assign(new Error('Не удалось распознать страницу канала YouTube'), { code: 'LIVE_RESPONSE_INVALID' });
  }

  extractLiveVideoIdFromHtml(html, playerResponse) {
    const playerVideoId = playerResponse?.videoDetails?.videoId;
    if (/^[a-zA-Z0-9_-]{11}$/.test(playerVideoId || '')) {
      return playerVideoId;
    }

    const canonicalMatch = String(html || '').match(
      /<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["'][^"']*[?&]v=([a-zA-Z0-9_-]{11})[^"']*["']/i
    ) || String(html || '').match(
      /<link\b[^>]*\bhref=["'][^"']*[?&]v=([a-zA-Z0-9_-]{11})[^"']*["'][^>]*\brel=["']canonical["']/i
    ) || String(html || '').match(
      /"canonicalUrl":"[^"]*watch\?v=([a-zA-Z0-9_-]{11})/
    );

    return canonicalMatch ? canonicalMatch[1] : null;
  }

  async startChatPollingByVideoId(videoId, connectionId = this.connectionId) {
    if (!this.isConnectionActive(connectionId)) return;

    if (this.currentVideoId !== videoId) {
      this.currentVideoId = videoId;
      this.seenMessageIds.clear();
    }

    this.continuationToken = null;
    this.consecutiveErrors = 0;
    this.isOnline = false;
    this.onStatus('youtube', false, `Подключение к чату (${videoId})...`);
    await this.pollChat(videoId, connectionId);
  }

  async pollChat(videoId, connectionId) {
    if (!this.isConnectionActive(connectionId)) return;

    try {
      const result = await this.fetchChatStep(videoId, connectionId);
      if (!this.isConnectionActive(connectionId)) return;

      this.consecutiveErrors = 0;
      if (this.isDirectVideo) this.ambiguousVideoId = null;
      if (result.ended) {
        this.handleChatEnded(connectionId);
        return;
      }
      if (!this.isOnline) {
        this.isOnline = true;
        this.onStatus('youtube', true, `Онлайн (Video ID: ${videoId})`);
      }

      this.schedulePoll(videoId, connectionId, result.timeoutMs);
    } catch (error) {
      if (this.isAbortError(error) || !this.isConnectionActive(connectionId)) return;

      this.consecutiveErrors += 1;
      const upstreamNotFound = error.cause?.proxyCode === 'upstream_not_found';
      const chatUnavailable = error.code === 'CHAT_UNAVAILABLE' || (upstreamNotFound && !this.continuationToken);
      const invalidChatResponse = (error.cause || error).code === 'CHAT_RESPONSE_INVALID' || upstreamNotFound;
      const retryDelay = chatUnavailable
        ? 30000
        : Math.min(30000, 1000 * (2 ** Math.min(this.consecutiveErrors - 1, 5)));
      this.logRequestFailure('Polling failed', error);

      const retryAmbiguousChannel = this.ambiguousVideoId && (chatUnavailable || this.consecutiveErrors >= 3);
      const rediscoverChannel = !this.isDirectVideo && (chatUnavailable || this.consecutiveErrors >= 5
        || (invalidChatResponse && this.consecutiveErrors >= 3));
      if (retryAmbiguousChannel || rediscoverChannel) {
        this.isOnline = false;
        this.continuationToken = null;
        this.onStatus('youtube', false, chatUnavailable ? 'Чат недоступен (повтор поиска...)' : 'Ошибка чата (повтор поиска...)');
        this.scheduleChannelRetry(connectionId, 30000);
        return;
      }

      if (this.consecutiveErrors >= 3) {
        this.isOnline = false;
        this.onStatus('youtube', false, 'Ошибка чата (переподключение...)');
      }

      // A fresh page produces a new continuation after an invalid cursor or
      // repeated transport failures. Keep message IDs when reopening the same video.
      if (this.consecutiveErrors >= 5 || invalidChatResponse) {
        this.continuationToken = null;
      }

      this.schedulePoll(videoId, connectionId, retryDelay);
    }
  }

  async fetchChatStep(videoId, connectionId) {
    const token = this.continuationToken;
    const chatUrl = token
      ? `https://www.youtube.com/live_chat?continuation=${encodeURIComponent(token)}&is_popout=1`
      : `https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}&is_popout=1`;

    let partial;
    let page;
    try {
      page = await this.fetchText(chatUrl, connectionId, 'youtube-chat', html => {
        const data = this.extractYtInitialData(html);
        const renderer = this.getLiveChatRenderer(data);
        if (renderer) {
          const progress = this.getChatProgress(renderer);
          if (progress.continuation || progress.ended) return { data, progress };
          partial ??= { data, progress };
        } else if (!token && this.extractUnavailableMessage(data)) {
          return { data };
        }
        throw Object.assign(new Error('Не удалось распознать ответ чата YouTube'), { code: 'CHAT_RESPONSE_INVALID' });
      });
    } catch (error) {
      // Keep usable messages from a partial page only if every route failed.
      if (partial && this.isConnectionActive(connectionId) && !this.isAbortError(error)) {
        this.parseYtLiveChatData(partial.data, partial.progress);
        this.continuationToken = token;
      }
      throw error;
    }
    if (!this.isConnectionActive(connectionId)) {
      const error = new Error('YouTube connection was replaced');
      error.name = 'AbortError';
      throw error;
    }

    if (!page.progress) {
      const message = this.extractUnavailableMessage(page.data) || 'Live Chat недоступен';
      const error = new Error(message);
      error.code = 'CHAT_UNAVAILABLE';
      throw error;
    }

    return this.parseYtLiveChatData(page.data, page.progress);
  }

  getChatProgress(renderer) {
    const actions = Array.isArray(renderer.actions) ? renderer.actions : [];
    const filterToken = this.extractLiveFilterContinuation(renderer);
    const continuation = filterToken
      ? { token: filterToken, timeoutMs: 1000 }
      : this.extractContinuation(renderer.continuations);
    const ended = actions.some(action => this.expandAction(action).some(nested => Boolean(nested?.closeLiveChatAction)));
    return { actions, continuation, ended };
  }

  parseYtLiveChatData(ytData, progress) {
    const renderer = this.getLiveChatRenderer(ytData);
    if (!renderer) {
      return { messageCount: 0, timeoutMs: 30000, ended: false };
    }

    const { actions, continuation, ended } = progress || this.getChatProgress(renderer);
    let messageCount = 0;
    actions.forEach((action) => {
      this.expandAction(action).forEach((nestedAction) => {
        const deletionEvent = this.parseDeletionAction(nestedAction);
        if (deletionEvent) {
          try {
            this.onMessage(deletionEvent);
          } catch (error) {
            this.logger.error('[YouTube Connector] Deletion callback failed:', error);
          }
          return;
        }

        const item = nestedAction?.addChatItemAction?.item
          || nestedAction?.replaceChatItemAction?.replacementItem;
        const parsedMessage = this.parseChatItem(item);
        if (!parsedMessage || !this.rememberMessage(parsedMessage.id)) return;

        messageCount += 1;
        try {
          this.onMessage(parsedMessage.message);
        } catch (error) {
          this.logger.error('[YouTube Connector] Message callback failed:', error);
        }
      });
    });

    this.continuationToken = continuation?.token || null;

    return {
      messageCount,
      timeoutMs: continuation?.timeoutMs || 30000,
      ended
    };
  }

  parseDeletionAction(action) {
    const targetItemId = action?.markChatItemAsDeletedAction?.targetItemId
      || action?.removeChatItemAction?.targetItemId;
    if (targetItemId) {
      return {
        platform: 'youtube',
        id: targetItemId,
        text: '',
        isDeleted: true
      };
    }

    const authorId = action?.markChatItemsByAuthorAsDeletedAction?.externalChannelId;
    if (authorId) {
      return {
        platform: 'youtube',
        authorId,
        text: '',
        isAuthorDeleted: true
      };
    }

    return null;
  }

  extractLiveFilterContinuation(renderer) {
    const filterItems = renderer
      ?.header
      ?.liveChatHeaderRenderer
      ?.viewSelector
      ?.sortFilterSubMenuRenderer
      ?.subMenuItems;

    // YouTube consistently exposes Top Chat first and the unfiltered Live Chat
    // second. Titles are localized, so their stable ordering is used here.
    if (!Array.isArray(filterItems) || filterItems.length < 2) return null;

    const token = filterItems[1]
      ?.continuation
      ?.reloadContinuationData
      ?.continuation;
    return typeof token === 'string' && token ? token : null;
  }

  getLiveChatRenderer(ytData) {
    return ytData?.contents?.liveChatRenderer
      || ytData?.continuationContents?.liveChatContinuation
      || null;
  }

  expandAction(action) {
    const replayActions = action?.replayChatItemAction?.actions;
    return Array.isArray(replayActions) ? replayActions : [action];
  }

  parseChatItem(item) {
    if (!item || typeof item !== 'object') return null;

    const rendererDefinitions = [
      ['liveChatTextMessageRenderer', 'text'],
      ['liveChatPaidMessageRenderer', 'paid_message'],
      ['liveChatMembershipItemRenderer', 'membership'],
      ['liveChatPaidStickerRenderer', 'paid_sticker'],
      ['liveChatDonationAnnouncementRenderer', 'donation']
    ];

    const definition = rendererDefinitions.find(([rendererName]) => item[rendererName]);
    if (!definition) return null;

    const [rendererName, messageType] = definition;
    const renderer = item[rendererName];
    const author = this.cleanAuthorName(this.extractText(renderer.authorName));
    const messageParts = this.extractRuns(renderer.message);
    let text = messageParts.text;

    if (!text) {
      text = this.extractText(renderer.headerSubtext)
        || this.extractText(renderer.purchaseAmountText)
        || this.getFallbackEventText(messageType, renderer);
    }

    if (!text) return null;

    const id = renderer.id
      || `${messageType}:${renderer.timestampUsec || ''}:${author}:${text}`;
    const leadingMention = text.trimStart().match(/^@([^\s,:;!?]+)/u);

    return {
      id,
      message: {
        platform: 'youtube',
        id,
        author,
        authorId: renderer.authorExternalChannelId || null,
        text,
        replyTo: leadingMention ? leadingMention[1] : null,
        badges: this.extractAuthorBadges(renderer.authorBadges),
        nativeEmotes: messageParts.nativeEmotes,
        messageType,
        amount: this.extractText(renderer.purchaseAmountText) || null,
        timestampUsec: renderer.timestampUsec || null,
        raw: renderer
      }
    };
  }

  extractRuns(textObject) {
    const runs = Array.isArray(textObject?.runs) ? textObject.runs : [];
    const nativeEmotes = [];
    let text = typeof textObject?.simpleText === 'string' ? textObject.simpleText : '';

    if (runs.length > 0) {
      text = '';
      runs.forEach((run) => {
        if (typeof run?.text === 'string') {
          text += run.text;
          return;
        }

        const emoji = run?.emoji;
        if (!emoji) return;

        const code = emoji.shortcuts?.[0]
          || emoji.accessibility?.accessibilityData?.label
          || ':emoji:';
        const thumbnails = emoji.image?.thumbnails;
        const url = Array.isArray(thumbnails) && thumbnails.length > 0
          ? thumbnails[thumbnails.length - 1].url
          : null;
        const start = text.length;
        text += code;

        if (url) {
          nativeEmotes.push({
            start,
            end: text.length - 1,
            code,
            url
          });
        }
      });
    }

    return { text, nativeEmotes };
  }

  extractText(textObject) {
    return this.extractRuns(textObject).text;
  }

  cleanAuthorName(authorName) {
    const raw = typeof authorName === 'string' ? authorName.trim() : '';
    const cleaned = raw.replace(/^@+/, '').trim();
    return cleaned || 'YTUser';
  }

  extractAuthorBadges(authorBadges) {
    if (!Array.isArray(authorBadges)) return [];

    return authorBadges.map((badge) => {
      const renderer = badge?.liveChatAuthorBadgeRenderer;
      if (!renderer) return null;

      const thumbnails = renderer.customThumbnail?.thumbnails;
      const url = Array.isArray(thumbnails) && thumbnails.length > 0
        ? thumbnails[thumbnails.length - 1].url
        : null;
      const title = renderer.tooltip
        || renderer.accessibility?.accessibilityData?.label
        || renderer.icon?.iconType
        || 'YouTube badge';

      return { url, title };
    }).filter((badge) => badge && badge.url);
  }

  getFallbackEventText(messageType, renderer) {
    const amount = this.extractText(renderer.purchaseAmountText);
    if (messageType === 'paid_sticker') {
      return amount ? `Super Sticker ${amount}` : 'Super Sticker';
    }
    if (messageType === 'paid_message') {
      return amount ? `Super Chat ${amount}` : 'Super Chat';
    }
    if (messageType === 'membership') return 'Новый участник канала';
    if (messageType === 'donation') return 'Пожертвование';
    return '';
  }

  extractContinuation(continuations) {
    if (!Array.isArray(continuations)) return null;

    const continuationKeys = [
      'invalidationContinuationData',
      'timedContinuationData',
      'reloadContinuationData',
      'liveChatReplayContinuationData',
      'playerSeekContinuationData'
    ];

    for (const continuationNode of continuations) {
      for (const key of continuationKeys) {
        const data = continuationNode?.[key];
        if (typeof data?.continuation !== 'string' || !data.continuation) continue;

        const rawTimeout = Number(data.timeoutMs);
        const timeoutMs = Number.isFinite(rawTimeout)
          ? Math.min(30000, Math.max(1000, rawTimeout))
          : 1000;

        return {
          token: data.continuation,
          timeoutMs
        };
      }
    }

    return null;
  }

  rememberMessage(id) {
    if (!id || this.seenMessageIds.has(id)) return false;

    this.seenMessageIds.add(id);
    while (this.seenMessageIds.size > this.maxSeenMessageIds) {
      const oldestId = this.seenMessageIds.values().next().value;
      this.seenMessageIds.delete(oldestId);
    }
    return true;
  }

  extractYtInitialData(html) {
    return this.extractAssignedJson(html, [
      'window["ytInitialData"]',
      'var ytInitialData',
      'ytInitialData'
    ]);
  }

  extractAssignedJson(html, markers) {
    const source = String(html || '');

    for (const marker of markers) {
      let markerIndex = source.indexOf(marker);
      while (markerIndex !== -1) {
        const equalsIndex = source.indexOf('=', markerIndex + marker.length);
        if (equalsIndex === -1 || equalsIndex - markerIndex > 100) break;

        const objectStart = source.indexOf('{', equalsIndex + 1);
        if (objectStart === -1 || objectStart - equalsIndex > 100) break;

        const jsonText = this.extractBalancedJsonObject(source, objectStart);
        if (jsonText) {
          try {
            return JSON.parse(jsonText);
          } catch (error) {
            this.logger.warn(`[YouTube Connector] Invalid JSON after ${marker}:`, error);
          }
        }

        markerIndex = source.indexOf(marker, markerIndex + marker.length);
      }
    }

    return null;
  }

  extractBalancedJsonObject(source, objectStart) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = objectStart; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(objectStart, index + 1);
      }
    }

    return null;
  }

  extractUnavailableMessage(ytData) {
    return this.extractText(ytData?.contents?.messageRenderer?.text);
  }

  async fetchText(url, connectionId, operation, parsePage = html => html) {
    const sessionSignal = this.abortController?.signal;
    const requestController = new AbortController();
    let timeoutId;
    let abortRequest;

    // Keep cancellation and the deadline active until the entire body is read.
    const interruption = new Promise((resolve, reject) => {
      abortRequest = () => {
        const error = new Error('YouTube connection was replaced');
        error.name = 'AbortError';
        reject(error);
        requestController.abort();
      };
      if (!this.isConnectionActive(connectionId)) {
        abortRequest();
        return;
      }
      sessionSignal?.addEventListener('abort', abortRequest, { once: true });
      timeoutId = setTimeout(() => {
        const error = new Error(`YouTube request timed out after ${this.requestTimeoutMs}ms`);
        error.code = 'FETCH_TIMEOUT';
        reject(error);
        requestController.abort();
      }, this.requestTimeoutMs);
    });

    try {
      return await Promise.race([
        interruption,
        (async () => {
          if (requestController.signal.aborted) return;
          const init = {
            method: 'GET',
            signal: requestController.signal,
            cache: 'no-store'
          };
          const readResponse = async response => {
            if (requestController.signal.aborted) return;
            if (!response?.ok) throw new Error(`YouTube HTTP ${response?.status || 'error'}`);
            const html = await response.text();
            if (!requestController.signal.aborted) return parsePage(html);
          };
          if (this.fetcher) return readResponse(await this.fetcher(url, init));
          return fetchWithCorsProxy(url, init, { operation, readResponse });
        })()
      ]);
    } finally {
      clearTimeout(timeoutId);
      sessionSignal?.removeEventListener('abort', abortRequest);
    }
  }

  schedulePoll(videoId, connectionId, delayMs) {
    if (!this.isConnectionActive(connectionId)) return;
    if (this.pollTimer) this.clearTimer(this.pollTimer);

    // The HTML continuation endpoint can request a one-second interval and
    // returns hundreds of kilobytes. A small floor keeps chat responsive while
    // preventing excessive traffic through a metered upstream proxy.
    const requestedDelayMs = Number.isFinite(delayMs) ? delayMs : 30000;
    const safeDelayMs = Math.max(this.minimumPollIntervalMs, requestedDelayMs);

    this.pollTimer = this.setTimer(() => {
      this.pollTimer = null;
      void this.pollChat(videoId, connectionId);
    }, safeDelayMs);
  }

  scheduleChannelRetry(connectionId, delayMs) {
    if (!this.isConnectionActive(connectionId)) return;
    if (this.retryTimer) this.clearTimer(this.retryTimer);

    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.isConnectionActive(connectionId)) {
        void this.resolveChannelLiveVideo(this.channelOrVideo, connectionId);
      }
    }, delayMs);
  }

  handleChatEnded(connectionId) {
    if (!this.isConnectionActive(connectionId)) return;

    this.isOnline = false;
    this.continuationToken = null;
    this.onStatus('youtube', false, 'Чат завершён');
    this.logger.info('[YouTube Connector] Live chat ended.');

    if (!this.isDirectVideo) {
      this.scheduleChannelRetry(connectionId, 30000);
    }
  }

  isConnectionActive(connectionId) {
    return Boolean(this.channelOrVideo)
      && connectionId === this.connectionId
      && !this.abortController?.signal.aborted;
  }

  isAbortError(error) {
    return error?.name === 'AbortError';
  }

  logRequestFailure(context, error) {
    const cause = error.cause || error;
    this.logger.warn(`[YouTube Connector] ${context}.`, {
      code: cause.proxyCode || cause.code || cause.name, status: cause.status, requestId: cause.requestId
    });
  }

  stopCurrentConnection(notifyStatus) {
    this.connectionId += 1;
    this.channelOrVideo = '';
    this.currentVideoId = null;
    this.ambiguousVideoId = null;
    this.isDirectVideo = false;
    this.continuationToken = null;
    this.consecutiveErrors = 0;
    this.isOnline = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.pollTimer) {
      this.clearTimer(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }

    this.seenMessageIds.clear();
    if (notifyStatus) this.onStatus('youtube', false, 'Офлайн');
  }

  disconnect() {
    this.stopCurrentConnection(true);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = YoutubeConnector;
}
