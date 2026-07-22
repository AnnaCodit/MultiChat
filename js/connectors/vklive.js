/**
 * VK Play Live / VK Video Live Connector for MultiChat
 * Fetches guest JWT token and channel ID, then subscribes to channel-chat via Centrifugo WS
 */

class VkLiveConnector {
  constructor(onMessageCallback, onStatusCallback) {
    this.onMessage = onMessageCallback;
    this.onStatus = onStatusCallback;
    this.ws = null;
    this.channel = '';
    this.channelId = null;
    this.seenMessageIds = new Set();
  }

  async connect(channelName) {
    this.disconnect();

    if (!channelName) {
      this.onStatus('vk', false, 'Канал не указан');
      return;
    }

    this.channel = channelName.toLowerCase().trim().replace(/^@+/, '');
    console.log(`[VK Live Connector] Connecting VK channel: ${this.channel}...`);
    this.onStatus('vk', false, 'Поиск канала VK Live...');

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
      
      const jwtIdx = html.indexOf('eyJ');
      if (jwtIdx === -1) {
        throw new Error('Guest JWT token not found in HTML');
      }
      const jwtEnd = html.indexOf('"', jwtIdx);
      const jwtToken = html.substring(jwtIdx, jwtEnd > jwtIdx ? jwtEnd : jwtIdx + 250);

      console.log(`[VK Live Connector] Extracted guest JWT token. Opening Centrifugo WS...`);
      this.initCentrifugoWS(jwtToken);

    } catch (err) {
      console.warn('[VK Live Connector] Connection setup failed:', err.message);
      this.onStatus('vk', false, 'Канал не найден');
    }
  }

  initCentrifugoWS(jwtToken) {
    try {
      const wsUrl = 'wss://pubsub.live.vkvideo.ru/connection/websocket?cf_protocol_version=v2';
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[VK Live Connector] Centrifugo WS opened. Sending connect packet...');
        this.ws.send(JSON.stringify({
          connect: { token: jwtToken, name: 'js' },
          id: 1
        }));
      };

      this.ws.onmessage = (event) => {
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
        console.error('[VK Live Connector] WS Error:', err);
        this.onStatus('vk', false, 'Ошибка соединения');
      };

      this.ws.onclose = (ev) => {
        console.warn(`[VK Live Connector] WS Closed (Code: ${ev.code}, Reason: ${ev.reason}).`);
        this.onStatus('vk', false, 'Отключен');
        this.cleanup();
      };
    } catch (e) {
      console.error('[VK Live Connector] Exception during WS setup:', e);
      this.onStatus('vk', false, 'Ошибка');
    }
  }

  handleCentrifugoPublication(pubData) {
    try {
      const payload = pubData.data || pubData;
      if (!payload) return;

      // Extract author
      const authorObj = payload.author || (payload.sender ? payload.sender : null);
      const author = authorObj ? (authorObj.displayName || authorObj.nick || authorObj.name) : 'VKUser';

      // Extract & parse message text (unpacks rich text tuples like ["сообщение","unstyled",[]])
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

      let replyTo = null;
      if (payload.replyToAuthor) {
        replyTo = payload.replyToAuthor.displayName || payload.replyToAuthor.nick;
      }

      this.onMessage({
        platform: 'vklive',
        author: author,
        text: text,
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
    this.channel = '';
    this.channelId = null;
    this.cleanup();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.seenMessageIds.clear();
    this.onStatus('vk', false, 'Офлайн');
  }

  cleanup() {
    // Cleanup if needed
  }
}
