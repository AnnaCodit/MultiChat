/**
 * Kick WebSocket Connector for MultiChat
 * Subscribes to Kick chatroom events using Kick Pusher WebSocket protocol
 */

class KickConnector {
  constructor(onMessageCallback, onStatusCallback, options = {}) {
    this.onMessage = onMessageCallback;
    this.onStatus = onStatusCallback;
    this.fetcher = options.fetcher || ((url, init) => (typeof fetchWithCorsProxy === 'function' ? fetchWithCorsProxy(url, init) : fetch(url, init)));
    this.ws = null;
    this.channel = '';
    this.chatroomId = null;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.connectionId = 0;
    this.abortController = null;
    this.createWebSocket = options.createWebSocket || (url => new WebSocket(url));
  }

  async connect(channelInput) {
    this.disconnect();
    const connectionId = this.connectionId;

    if (!channelInput) {
      this.onStatus('kick', false, 'Канал не указан');
      return;
    }

    let cleanInput = String(channelInput).trim().replace(/^@+/, '');
    if (/^https?:\/\//i.test(cleanInput)) {
      try {
        const url = new URL(cleanInput);
        if (!['kick.com', 'www.kick.com'].includes(url.hostname.toLowerCase())) throw new Error('Invalid Kick URL');
        cleanInput = url.pathname.replace(/^\/|\/$/g, '');
      } catch (error) {
        this.onStatus('kick', false, 'Введите имя канала Kick или ссылку на него');
        return;
      }
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanInput)) {
      this.onStatus('kick', false, 'Введите имя канала Kick или ссылку на него');
      return;
    }
    this.channel = cleanInput.toLowerCase();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Check localStorage cache first to avoid CORS proxy calls
    const cacheKey = `kick_chatroom_id_${this.channel}`;
    let cachedId = null;
    try {
      if (typeof localStorage !== 'undefined') {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (cached && cached.expires > Date.now() && /^[1-9][0-9]*$/.test(String(cached.id))) cachedId = String(cached.id);
      }
    } catch (error) {
      console.warn('[Kick Connector] Unable to read chatroom cache:', error);
    }
    if (cachedId) {
      this.chatroomId = cachedId;
      console.log(`[Kick Connector] Using cached Chatroom ID (${cachedId}) for ${this.channel}`);
      this.initPusherWS(connectionId);
      return;
    }

    console.log(`[Kick Connector] Resolving Kick chatroom ID for channel: ${this.channel}...`);
    this.onStatus('kick', false, 'Поиск канала Kick...');

    const foundId = await this.resolveChatroomId(this.channel, signal);
    // Aborting fetch is not enough: a response may already be queued for parsing.
    if (!this.isConnectionActive(connectionId)) return;
    if (foundId) {
      this.chatroomId = foundId;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(cacheKey, JSON.stringify({ id: foundId, expires: Date.now() + 7 * 86400000 }));
      } catch (error) {
        console.warn('[Kick Connector] Unable to save chatroom cache:', error);
      }
      console.log(`[Kick Connector] Resolved Chatroom ID: ${this.chatroomId}. Connecting Pusher WS...`);
      this.initPusherWS(connectionId);
    } else {
      this.onStatus('kick', false, 'Не удалось загрузить канал Kick. Повтор через 15 секунд...');
      this.reconnectTimer = setTimeout(() => {
        if (this.isConnectionActive(connectionId)) this.connect(this.channel);
      }, 15000);
    }
  }

  async resolveChatroomId(channelName, signal) {
    if (signal?.aborted) return null;
    // 1. Primary metadata lookup through the v2 endpoint.
    try {
      const data = await this.fetchChannelData(channelName, 2, signal);
      if (signal?.aborted) return null;
      if (data?.chatroom?.id) return String(data.chatroom.id);
    } catch (error) {
      if (signal?.aborted) return null;
      console.warn('[Kick Connector] Chatroom lookup failed:', error);
    }

    // 2. Compatibility fallback for installations where only v1 responds.
    try {
      const data = await this.fetchChannelData(channelName, 1, signal);
      if (signal?.aborted) return null;
      if (data?.chatroom?.id) return String(data.chatroom.id);
    } catch (error) {
      if (signal?.aborted) return null;
      console.warn('[Kick Connector] Chatroom lookup failed:', error);
    }

    return null;
  }

  async fetchChannelData(channel, version, signal) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000);
    const response = await this.fetcher(`https://kick.com/api/v${version}/channels/${encodeURIComponent(channel)}`, { signal: requestSignal });
    if (!response?.ok) throw new Error(`Kick HTTP ${response?.status || 'error'}`);
    const data = await response.json();
    if (!/^[1-9][0-9]*$/.test(String(data?.chatroom?.id || ''))) throw new Error('Invalid Kick chatroom response');
    return data;
  }

  initPusherWS(connectionId = this.connectionId) {
    if (!this.isConnectionActive(connectionId)) return;
    try {
      // Active Kick Pusher key: 32cbd69e4b950bf97679 on ws-us2.pusher.com
      const kickAppKey = '32cbd69e4b950bf97679';
      const wsUrl = `wss://ws-us2.pusher.com/app/${kickAppKey}?protocol=7&client=js&version=7.4.0&flash=false`;
      
      console.log(`[Kick Connector] Opening Pusher WebSocket to Kick...`);
      const ws = this.createWebSocket(wsUrl);
      this.ws = ws;
      const isCurrentSocket = () => this.isConnectionActive(connectionId) && this.ws === ws;

      ws.onopen = () => {
        if (!isCurrentSocket()) return;
        console.log('[Kick Connector] Pusher WS connected. Subscribing to chatroom...');
        const subscribePayload = {
          event: 'pusher:subscribe',
          data: {
            auth: '',
            channel: `chatrooms.${this.chatroomId}.v2`
          }
        };
        ws.send(JSON.stringify(subscribePayload));
        this.onStatus('kick', true, `Онлайн (${this.channel})`);

        // Keepalive ping every 30 seconds
        this.pingInterval = setInterval(() => {
          if (isCurrentSocket() && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          }
        }, 30000);
      };

      ws.onmessage = (event) => {
        if (!isCurrentSocket()) return;
        try {
          const packet = JSON.parse(event.data);
          this.handlePusherPacket(packet);
        } catch (e) {
          console.error('[Kick Connector] Error parsing packet:', e);
        }
      };

      ws.onerror = (err) => {
        if (!isCurrentSocket()) return;
        console.warn('[Kick Connector] WS Error:', err);
      };

      ws.onclose = () => {
        if (!isCurrentSocket()) return;
        console.warn('[Kick Connector] WS Closed. Reconnecting in 5s...');
        this.onStatus('kick', false, 'Отключен');
        this.cleanup();
        this.ws = null;

        // Auto reconnect
        this.reconnectTimer = setTimeout(() => {
          if (this.isConnectionActive(connectionId)) this.connect(this.channel);
        }, 5000);
      };
    } catch (e) {
      console.error('[Kick Connector] Exception during WS setup:', e);
      this.onStatus('kick', false, 'Ошибка');
    }
  }

  handlePusherPacket(packet) {
    if (!packet || !packet.event) return;

    // Chat message event
    if (packet.event === 'App\\Events\\ChatMessageEvent') {
      try {
        const msgData = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data;
        
        const author = msgData.sender ? (msgData.sender.username || msgData.sender.slug) : 'KickUser';
        const content = msgData.content || '';
        
        // Extract color and badges from Kick sender identity
        const color = (msgData.sender && msgData.sender.identity) ? msgData.sender.identity.color : null;
        const badges = (msgData.sender && msgData.sender.identity) ? msgData.sender.identity.badges : null;

        // Correct original_sender handling for replies
        let replyTo = null;
        if (msgData.metadata) {
          if (msgData.metadata.original_sender) {
            replyTo = msgData.metadata.original_sender.username || msgData.metadata.original_sender.slug;
          } else if (msgData.metadata.original_message && msgData.metadata.original_message.sender) {
            replyTo = msgData.metadata.original_message.sender.username || msgData.metadata.original_message.sender.slug;
          }
        }

        this.onMessage({
          platform: 'kick',
          author: author,
          text: content,
          color: color,
          badges: badges,
          replyTo: replyTo,
          raw: msgData
        });
      } catch (e) {
        console.error('[Kick Connector] Error parsing chat message:', e);
      }
    }
  }

  isConnectionActive(connectionId) {
    return connectionId === this.connectionId && Boolean(this.channel) && !this.abortController?.signal.aborted;
  }

  disconnect() {
    this.connectionId += 1;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.channel = '';
    this.chatroomId = null;
    this.cleanup();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.onStatus('kick', false, 'Офлайн');
  }

  cleanup() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = KickConnector;
}
