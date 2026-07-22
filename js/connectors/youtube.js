/**
 * YouTube Live Chat Connector for MultiChat
 * Supports YouTube channel handles, video URLs, video IDs, and sequential live chat polling with auto-retry
 */

class YoutubeConnector {
  constructor(onMessageCallback, onStatusCallback) {
    this.onMessage = onMessageCallback;
    this.onStatus = onStatusCallback;
    this.channelOrVideo = '';
    this.pollTimer = null;
    this.retryTimer = null;
    this.isPolling = false;
    this.continuationToken = null;
    this.seenMessageIds = new Set();
  }

  async connect(channelOrVideo) {
    this.disconnect();

    if (!channelOrVideo) {
      this.onStatus('youtube', false, 'Канал/Видео не указано');
      return;
    }

    this.channelOrVideo = channelOrVideo.trim();
    console.log(`[YouTube Connector] Connecting to: ${this.channelOrVideo}...`);
    this.onStatus('youtube', false, 'Поиск трансляции YouTube...');

    // Extract video ID if user passed a URL or video ID directly
    let videoId = this.extractVideoId(this.channelOrVideo);

    if (videoId) {
      this.startChatPollingByVideoId(videoId);
    } else {
      // Try resolving channel handle to live video
      this.resolveChannelLiveVideo(this.channelOrVideo);
    }
  }

  extractVideoId(input) {
    // Match youtube.com/watch?v=VIDEO_ID or video ID string (11 chars)
    const match = input.match(/(?:v=|\/embed\/|\/live\/|youtu\.be\/|^)([a-zA-Z0-9_-]{11})(?:[&?]|$)/);
    return match ? match[1] : null;
  }

  async resolveChannelLiveVideo(channelHandle) {
    try {
      const handle = channelHandle.replace(/^@+/, '').trim();
      const url = `https://www.youtube.com/@${encodeURIComponent(handle)}/live`;
      
      this.onStatus('youtube', false, 'Проверка Live стрима...');
      
      const res = await fetchWithCorsProxy(url);
      const html = await res.text();
      
      if (!this.channelOrVideo) return;

      // Extract video ID from page canonical link or ytInitialPlayerResponse
      const videoMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (videoMatch && videoMatch[1]) {
        console.log(`[YouTube Connector] Found live video ID: ${videoMatch[1]}`);
        this.startChatPollingByVideoId(videoMatch[1]);
      } else {
        throw new Error('Офлайн');
      }
    } catch (err) {
      if (this.channelOrVideo) {
        console.log('[YouTube Connector] Stream not found or offline. Will retry in 30s...');
        this.onStatus('youtube', false, 'Офлайн (ожидание стрима)');

        // Retry after 30 seconds automatically
        this.retryTimer = setTimeout(() => {
          if (this.channelOrVideo) {
            this.resolveChannelLiveVideo(this.channelOrVideo);
          }
        }, 30000);
      }
    }
  }

  startChatPollingByVideoId(videoId) {
    this.onStatus('youtube', true, `Онлайн (Video ID: ${videoId})`);
    this.continuationToken = null;

    // Sequential async polling loop (prevents request stacking)
    const pollLoop = async () => {
      if (!this.channelOrVideo) return;
      if (this.isPolling) return;

      this.isPolling = true;
      try {
        await this.fetchChatStep(videoId);
      } catch (e) {
        console.error('[YouTube Connector] Polling error:', e);
      } finally {
        this.isPolling = false;
        if (this.channelOrVideo) {
          // Schedule next poll 3.5s after current completes
          this.pollTimer = setTimeout(pollLoop, 3500);
        }
      }
    };

    pollLoop();
  }

  async fetchChatStep(videoId) {
    // 1. If we have a continuation token, try lighter continuation endpoint first
    if (this.continuationToken) {
      try {
        const res = await fetchWithCorsProxy('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat');
        // If POST succeeds
      } catch(e) {}
    }

    // 2. Fetch live chat page via CORS proxy
    const chatUrl = `https://www.youtube.com/live_chat?v=${videoId}`;
    const res = await fetchWithCorsProxy(chatUrl);
    const html = await res.text();

    const match = html.match(/window\["ytInitialData"\]\s*=\s*({.*?});<\/script>/s) || 
                  html.match(/var ytInitialData\s*=\s*({.*?});/s);
    if (match && match[1]) {
      const ytData = JSON.parse(match[1]);
      this.parseYtLiveChatData(ytData);
    }
  }

  parseYtLiveChatData(ytData) {
    try {
      const renderer = ytData?.contents?.liveChatRenderer;
      if (!renderer) return;

      // Extract continuation token for future optimization
      const continuations = renderer.continuations;
      if (Array.isArray(continuations) && continuations.length > 0) {
        const contObj = continuations[0].invalidationContinuationData || continuations[0].timedContinuationData;
        if (contObj && contObj.continuation) {
          this.continuationToken = contObj.continuation;
        }
      }

      const actions = renderer.actions;
      if (!Array.isArray(actions)) return;

      actions.forEach(action => {
        const item = action?.addChatItemAction?.item?.liveChatMessageRenderer;
        if (!item) return;

        const id = item.id;
        if (this.seenMessageIds.has(id)) return;
        
        this.seenMessageIds.add(id);
        if (this.seenMessageIds.size > 200) {
          const first = this.seenMessageIds.values().next().value;
          this.seenMessageIds.delete(first);
        }

        const author = item.authorName?.simpleText || 'YTUser';
        const messageRuns = item.message?.runs || [];
        const text = messageRuns.map(r => r.text || '').join('');

        let replyTo = null;
        const leadingMention = text.match(/^@([a-zA-Z0-9_А-Яа-я]+)/);
        if (leadingMention) {
          replyTo = leadingMention[1];
        }

        this.onMessage({
          platform: 'youtube',
          author: author,
          text: text,
          replyTo: replyTo,
          raw: item
        });
      });
    } catch (e) {
      console.error('[YouTube Connector] Error parsing YouTube chat JSON:', e);
    }
  }

  disconnect() {
    this.channelOrVideo = '';
    this.continuationToken = null;
    this.isPolling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.seenMessageIds.clear();
    this.onStatus('youtube', false, 'Офлайн');
  }
}
