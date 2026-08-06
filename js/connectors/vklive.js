/**
 * VK Play Live / VK Video Live Connector for MultiChat
 * Fetches guest JWT token and channel ID, then subscribes to channel-chat via Centrifugo WS.
 * Falls back to the public recent-messages endpoint when VK rejects the page WebSocket Origin.
 */

const VK_LIVE_CONNECTOR_CONFIG = Object.freeze({
  pollIntervalMs: 4000,
  pollMessageLimit: 20
});

class VkLiveConnector {
  constructor(onMessageCallback, onStatusCallback, options = {}) {
    this.onMessage = onMessageCallback;
    this.onStatus = onStatusCallback;
    this.ws = null;
    this.channel = '';
    this.channelId = null;
    this.pollTimer = null;
    this.pollAbortController = null;
    this.connectionId = 0;
    this.isPolling = false;
    this.isPollingOnline = false;
    this.seenMessageIds = new Set();
    this.fetcher = options.fetcher || ((url, init) => fetchWithCorsProxy(url, init));
    this.createWebSocket = options.createWebSocket || (url => new WebSocket(url));
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.logger = options.logger || console;
  }

  async connect(channelName) {
    this.disconnect();
    const connectionId = this.connectionId;

    if (!channelName) {
      this.onStatus('vk', false, 'Канал не указан');
      return;
    }

    this.channel = channelName.toLowerCase().trim().replace(/^@+/, '');
    console.log(`[VK Live Connector] Connecting VK channel: ${this.channel}...`);
    this.onStatus('vk', false, 'Поиск канала VK Live...');

    // Check localStorage cache for valid channelId and JWT token
    const cacheKey = `vk_cache_${this.channel}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const { channelId, jwtToken, exp } = JSON.parse(cached);
        const nowSec = Math.floor(Date.now() / 1000);
        // If token expires in > 300 seconds, use cached credentials
        if (channelId && jwtToken && exp && (exp - nowSec) > 300) {
          this.channelId = channelId;
          console.log(`[VK Live Connector] Using cached VK credentials for ${this.channel}`);
          this.initCentrifugoWS(jwtToken, connectionId);
          return;
        }
      }
    } catch (e) {}

    try {
      // 1. Fetch channel ID from VK Video Live API
      const chanRes = await fetchWithCorsProxy(`https://api.live.vkvideo.ru/v1/channel/${encodeURIComponent(this.channel)}`);
      const chanData = await chanRes.json();
      if (!chanData || !chanData.data || !chanData.data.channel || !chanData.data.channel.id) {
        throw new Error('Channel ID not found');
      }

      this.channelId = chanData.data.channel.id;
      console.log(`[VK Live Connector] Found VK Channel ID: ${this.channelId}`);

      // 2. Fetch HTML page to extract guest JWT token
      const htmlRes = await fetchWithCorsProxy(`https://live.vkvideo.ru/${encodeURIComponent(this.channel)}`);
      const html = await htmlRes.text();
      
      const jwtToken = this.extractJwtTokenFromHtml(html);
      if (!jwtToken) {
        throw new Error('Guest JWT token not found in HTML');
      }

      // Parse exp from JWT if possible
      let exp = Math.floor(Date.now() / 1000) + 86400; // default 24h fallback
      try {
        const parts = jwtToken.split('.');
        if (parts.length >= 2) {
          const payloadObj = JSON.parse(atob(parts[1]));
          if (payloadObj && payloadObj.exp) exp = payloadObj.exp;
        }
      } catch(e) {}

      // Cache token in localStorage
      localStorage.setItem(cacheKey, JSON.stringify({
        channelId: this.channelId,
        jwtToken: jwtToken,
        exp: exp
      }));

      console.log(`[VK Live Connector] Extracted guest JWT token. Opening Centrifugo WS...`);
      this.initCentrifugoWS(jwtToken, connectionId);

    } catch (err) {
      if (connectionId !== this.connectionId) return;
      console.warn('[VK Live Connector] Connection setup failed:', err.message);
      this.startPolling(connectionId);
    }
  }

  extractJwtTokenFromHtml(html) {
    if (!html) return null;
    // 1. Strict regex for wsToken / token properties
    const tokenMatch = html.match(/"wsToken"\s*:\s*"([^"]+)"/) || 
                       html.match(/"token"\s*:\s*"(eyJ[^"]+)"/) ||
                       html.match(/"signedQuery"\s*:\s*"(eyJ[^"]+)"/);
    if (tokenMatch && tokenMatch[1]) {
      return tokenMatch[1];
    }

    // 2. Fallback to index search for eyJ...
    const jwtIdx = html.indexOf('eyJ');
    if (jwtIdx !== -1) {
      const jwtEnd = html.indexOf('"', jwtIdx);
      return html.substring(jwtIdx, jwtEnd > jwtIdx ? jwtEnd : jwtIdx + 250);
    }

    return null;
  }

  initCentrifugoWS(jwtToken, connectionId = this.connectionId) {
    try {
      const wsUrl = 'wss://pubsub.live.vkvideo.ru/connection/websocket?cf_protocol_version=v2';
      this.ws = this.createWebSocket(wsUrl);

      this.ws.onopen = () => {
        if (connectionId !== this.connectionId) return;
        console.log('[VK Live Connector] Centrifugo WS opened. Sending connect packet...');
        this.ws.send(JSON.stringify({
          connect: { token: jwtToken, name: 'js' },
          id: 1
        }));
      };

      this.ws.onmessage = (event) => {
        if (connectionId !== this.connectionId) return;
        const rawText = (event.data || '').toString().trim();
        if (!rawText) return;

        // Centrifugo packets can be newline-delimited inside a single frame
        const lines = rawText.split('\n');

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          // 1. Centrifugo Server Ping/Pong protocol handler
          if (trimmedLine === '{}') {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send('{}');
            }
            continue;
          }

          try {
            const packet = JSON.parse(trimmedLine);

            // Connect response -> subscribe to channel chat topics
            if (packet.id === 1 && packet.connect) {
              this.stopPolling();
              console.log(`[VK Live Connector] Connected! Subscribing to channel-chat:${this.channelId}...`);
              this.ws.send(JSON.stringify({
                subscribe: { channel: `channel-chat:${this.channelId}` },
                id: 2
              }));
              this.ws.send(JSON.stringify({
                subscribe: { channel: `channel-chat:${this.channelId}@0` },
                id: 3
              }));
              this.onStatus('vk', true, `Онлайн (${this.channel})`);
            }

            if (packet.id === 1 && packet.error) {
              this.logger.warn('[VK Live Connector] Centrifugo rejected the connection:', packet.error);
              this.ws.close();
            }

            // Handle incoming push publication
            if (packet.push && packet.push.pub && packet.push.pub.data) {
              this.handleCentrifugoPublication(packet.push.pub.data);
            }
          } catch (e) {
            console.error('[VK Live Connector] Error parsing WS message line:', e);
          }
        }
      };

      this.ws.onerror = (err) => {
        if (connectionId !== this.connectionId) return;
        console.error('[VK Live Connector] WS Error:', err);
        this.onStatus('vk', false, 'WebSocket недоступен');
      };

      this.ws.onclose = (ev) => {
        if (connectionId !== this.connectionId || !this.channel) return;
        this.logger.warn(`[VK Live Connector] WS Closed (Code: ${ev.code}, Reason: ${ev.reason}). Switching to polling.`);
        this.ws = null;
        this.startPolling(connectionId);
      };
    } catch (e) {
      console.error('[VK Live Connector] Exception during WS setup:', e);
      this.startPolling(connectionId);
    }
  }

  buildPollingUrl() {
    const channel = encodeURIComponent(this.channel);
    return `https://api.live.vkvideo.ru/v1/blog/${channel}/public_video_stream/chat?limit=${VK_LIVE_CONNECTOR_CONFIG.pollMessageLimit}`;
  }

  async startPolling(connectionId = this.connectionId) {
    if (connectionId !== this.connectionId || !this.channel || this.isPolling) return;

    this.isPolling = true;
    this.isPollingOnline = false;
    this.logger.info(`[VK Live Connector] Starting recent-message polling every ${VK_LIVE_CONNECTOR_CONFIG.pollIntervalMs}ms.`);
    this.onStatus('vk', false, 'Подключение через резервный режим...');
    return this.pollMessages(connectionId);
  }

  async pollMessages(connectionId) {
    if (connectionId !== this.connectionId || !this.channel || !this.isPolling) return;

    const abortController = new AbortController();
    this.pollAbortController = abortController;

    try {
      const response = await this.fetcher(this.buildPollingUrl(), {
        cache: 'no-store',
        signal: abortController.signal
      });
      const payload = await response.json();

      if (connectionId !== this.connectionId || abortController.signal.aborted) return;
      if (!payload || !Array.isArray(payload.data)) {
        throw new Error('Unexpected recent-message response');
      }

      const messages = payload.data.slice().sort((left, right) => {
        return Number(left.createdAt || 0) - Number(right.createdAt || 0);
      });
      messages.forEach(message => this.handleCentrifugoPublication(message));

      if (!this.isPollingOnline) {
        this.isPollingOnline = true;
        this.onStatus('vk', true, `Онлайн (${this.channel}, резервный режим)`);
      }
    } catch (error) {
      if (connectionId !== this.connectionId || abortController.signal.aborted) return;
      this.isPollingOnline = false;
      this.logger.error('[VK Live Connector] Recent-message polling failed:', error);
      this.onStatus('vk', false, 'Ошибка получения сообщений VK');
    } finally {
      if (this.pollAbortController === abortController) {
        this.pollAbortController = null;
      }
      if (connectionId === this.connectionId && this.channel && this.isPolling) {
        this.pollTimer = this.setTimer(() => {
          this.pollTimer = null;
          return this.pollMessages(connectionId);
        }, VK_LIVE_CONNECTOR_CONFIG.pollIntervalMs);
      }
    }
  }

  stopPolling() {
    this.isPolling = false;
    this.isPollingOnline = false;

    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }
    if (this.pollTimer) {
      this.clearTimer(this.pollTimer);
      this.pollTimer = null;
    }
  }

  handleCentrifugoPublication(pubData) {
    try {
      // WebSocket publications wrap the message in data, while polling messages
      // use data for the rich-text parts and must remain intact.
      const shouldUnwrap = pubData
        && pubData.data
        && !Array.isArray(pubData.data)
        && !pubData.author
        && !pubData.sender
        && !pubData.user;
      const payload = shouldUnwrap ? pubData.data : pubData;
      if (!payload) return;

      // Extract author
      const authorObj = payload.author || payload.sender || payload.user || null;
      const author = authorObj ? (authorObj.displayName || authorObj.nick || authorObj.name) : 'VKUser';
      const color = authorObj ? (authorObj.color || authorObj.nickColor) : null;

      // Extract & parse message text (unpacks Draft.js tuples like ["сообщение","unstyled",[]])
      const text = this.parseVkText(payload.content || payload.data || payload.text);
      if (!text) return;

      // Prevent duplicates
      const msgId = payload.id || (author + text);
      if (this.seenMessageIds.has(msgId)) return;
      this.seenMessageIds.add(msgId);
      if (this.seenMessageIds.size > 200) {
        const first = this.seenMessageIds.values().next().value;
        this.seenMessageIds.delete(first);
      }

      // Check both parent message author and replyToAuthor
      let replyTo = null;
      if (payload.parent) {
        const parentAuthor = payload.parent.author || payload.parent.sender;
        if (parentAuthor) {
          replyTo = parentAuthor.displayName || parentAuthor.nick || parentAuthor.name;
        }
      } else if (payload.replyToAuthor) {
        replyTo = payload.replyToAuthor.displayName || payload.replyToAuthor.nick;
      }

      this.onMessage({
        platform: 'vklive',
        author: author,
        text: text,
        color: color,
        replyTo: replyTo,
        raw: payload
      });
    } catch (e) {
      console.error('[VK Live Connector] Error handling publication:', e);
    }
  }

  parseVkText(content) {
    if (!content) return '';

    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          return this.parseVkText(parsed);
        } catch (e) {}
      }
      return content;
    }

    if (Array.isArray(content)) {
      // Handle Draft.js / VK rich text tuple ["сообщение", "unstyled", []]
      if (content.length >= 1 && typeof content[0] === 'string' && typeof content[1] === 'string') {
        return content[0];
      }

      return content.map(item => {
        if (typeof item === 'string') return this.parseVkText(item);
        if (Array.isArray(item)) return this.parseVkText(item);
        if (item && typeof item === 'object') return this.parseVkText(item.text || item.content || item.data);
        return '';
      }).filter(Boolean).join(' ');
    }

    if (typeof content === 'object') {
      if (content.text) return this.parseVkText(content.text);
      if (content.content) return this.parseVkText(content.content);
      if (content.data) return this.parseVkText(content.data);
    }

    return String(content);
  }

  disconnect() {
    this.connectionId += 1;
    this.channel = '';
    this.channelId = null;
    this.stopPolling();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.seenMessageIds.clear();
    this.onStatus('vk', false, 'Офлайн');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VkLiveConnector;
  module.exports.CONFIG = VK_LIVE_CONNECTOR_CONFIG;
}
