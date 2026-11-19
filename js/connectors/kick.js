/**
 * Kick WebSocket Connector for MultiChat
 * Subscribes to Kick chatroom events using Kick Pusher WebSocket protocol
 */

const KICK_PUSHER_CONFIG = {
  // Rotated on 2026-10-15: 34bf7a0ff419a2a775b9 is the active key; 32cbd69e4b950bf97679 is legacy fallback
  knownKeys: ['34bf7a0ff419a2a775b9', '32cbd69e4b950bf97679'],
  cluster: 'us2',
  protocol: '7',
  client: 'js',
  version: '7.4.0'
};

const KICK_ROOM_CACHE_TTL_MS = 7 * 86400000;
const KICK_ROOM_REFRESH_COOLDOWN_MS = 120000;

class KickConnector {
  constructor(onMessageCallback, onStatusCallback, options = {}) {
    this.onMessage = onMessageCallback;
    this.onStatus = onStatusCallback;
    this.fetcher = options.fetcher || (typeof fetchWithCorsProxy !== 'function' ? fetch : null);
    this.ws = null;
    this.channel = '';
    this.chatroomId = null;
    this.chatroomExpiresAt = 0;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.subscriptionTimer = null;
    this.pongTimer = null;
    this.nextRoomRefreshAt = 0;
    this.reconnectAttempts = 0;
    this.connectionId = 0;
    this.abortController = null;
    this.createWebSocket = options.createWebSocket || (url => new WebSocket(url));
    this.pusherConfig = {
      ...KICK_PUSHER_CONFIG,
      ...(options.pusherConfig || {})
    };
    this.currentKey = this.getInitialKey();
  }

  getInitialKey() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('multichat_kick_pusher_key');
        if (saved && (this.pusherConfig.knownKeys.includes(saved) || /^[a-f0-9]{20}$/i.test(saved))) {
          return saved;
        }
      }
    } catch (e) {
      // Ignore localStorage read errors
    }
    return this.pusherConfig.knownKeys[0];
  }

  saveWorkingKey(key) {
    try {
      if (typeof localStorage !== 'undefined' && key) {
        localStorage.setItem('multichat_kick_pusher_key', key);
      }
    } catch (e) {
      // Ignore localStorage write errors
    }
  }

  evictWorkingKey() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('multichat_kick_pusher_key');
      }
    } catch (e) {
      // Ignore localStorage write errors
    }
  }

  rotateToNextKey() {
    const keys = this.pusherConfig.knownKeys;
    if (!Array.isArray(keys) || keys.length <= 1) return false;
    const currentIndex = keys.indexOf(this.currentKey);
    const nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    this.evictWorkingKey();
    if (nextIndex >= keys.length) {
      this.currentKey = keys[0];
      console.warn('[Kick Connector] All known Pusher keys tried. Reverting to default.');
      return false; // Cycled through all keys
    }
    this.currentKey = keys[nextIndex];
    console.warn(`[Kick Connector] Switched Pusher app key to fallback (index ${nextIndex}).`);
    return true; // Advanced to next fallback key
  }

  getPusherWsUrl() {
    const key = this.currentKey || this.pusherConfig.knownKeys[0];
    const cluster = this.pusherConfig.cluster || 'us2';
    const protocol = this.pusherConfig.protocol || '7';
    const client = this.pusherConfig.client || 'js';
    const version = this.pusherConfig.version || '7.4.0';
    return `wss://ws-${cluster}.pusher.com/app/${key}?protocol=${protocol}&client=${client}&version=${version}&flash=false`;
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
    await this.lookupAndConnect(connectionId);
  }

  async lookupAndConnect(connectionId, refresh = false) {
    const { channel, abortController } = this;
    // Check localStorage cache first to avoid CORS proxy calls
    const cacheKey = `kick_chatroom_id_${channel}`;
    let cachedId = null;
    try {
      if (typeof localStorage !== 'undefined') {
        if (refresh) {
          localStorage.removeItem(cacheKey);
        } else {
          const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
          if (cached && cached.expires > Date.now() && /^[1-9][0-9]*$/.test(String(cached.id))) {
            cachedId = String(cached.id);
            this.chatroomExpiresAt = cached.expires;
          }
        }
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

    const foundId = await this.resolveChatroomId(channel, abortController.signal, refresh);
    // Aborting fetch is not enough: a response may already be queued for parsing.
    if (!this.isConnectionActive(connectionId)) return;
    if (foundId) {
      this.chatroomId = foundId;
      this.chatroomExpiresAt = Date.now() + KICK_ROOM_CACHE_TTL_MS;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(cacheKey, JSON.stringify({ id: foundId, expires: this.chatroomExpiresAt }));
      } catch (error) {
        console.warn('[Kick Connector] Unable to save chatroom cache:', error);
      }
      console.log(`[Kick Connector] Resolved Chatroom ID: ${this.chatroomId}. Connecting Pusher WS...`);
      this.initPusherWS(connectionId);
    } else {
      this.onStatus('kick', false, 'Не удалось загрузить канал Kick. Повтор через 15 секунд...');
      this.reconnectTimer = setTimeout(() => {
        if (this.isConnectionActive(connectionId)) void this.lookupAndConnect(connectionId, refresh);
      }, 15000);
    }
  }

  async resolveChatroomId(channelName, signal, refresh) {
    if (signal?.aborted) return null;
    // Prefer v2 and retain v1 for installations where only v1 responds.
    for (const version of [2, 1]) {
      try {
        const data = await this.fetchChannelData(channelName, version, signal, refresh);
        if (signal?.aborted) return null;
        return String(data.chatroom.id);
      } catch (error) {
        if (signal?.aborted) return null;
        const cause = error.cause || error;
        console.warn('[Kick Connector] Chatroom lookup failed.', {
          version, code: cause.proxyCode || cause.code || cause.name, status: cause.status, requestId: cause.requestId
        });
      }
    }

    return null;
  }

  async fetchChannelData(channel, version, signal, refresh) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000);
    const url = `https://kick.com/api/v${version}/channels/${encodeURIComponent(channel)}`;
    const init = { signal: requestSignal, cache: 'no-store' };
    const readResponse = async response => {
      if (!response?.ok) throw new Error(`Kick HTTP ${response?.status || 'error'}`);
      const data = await response.json();
      if (!/^[1-9][0-9]*$/.test(String(data?.chatroom?.id || ''))
        || (typeof data.slug === 'string' && data.slug.toLowerCase() !== channel)) {
        throw new Error('Invalid Kick chatroom response');
      }
      return data;
    };
    if (this.fetcher) return readResponse(await this.fetcher(url, init));
    return fetchWithCorsProxy(url, init, { operation: 'kick-room', refresh, readResponse });
  }

  initPusherWS(connectionId = this.connectionId) {
    if (!this.isConnectionActive(connectionId)) return;
    const room = `chatrooms.${this.chatroomId}.v2`;
    let ws;
    try {
      console.log('[Kick Connector] Opening Pusher WebSocket to Kick...');
      ws = this.createWebSocket(this.getPusherWsUrl());
    } catch (e) {
      console.warn('[Kick Connector] WebSocket setup failed.', e.name);
      this.reconnectSocket(connectionId);
      return;
    }
    this.ws = ws;
    let subscribed = false;
    let subscribing = false;
    const isCurrentSocket = () => this.isConnectionActive(connectionId) && this.ws === ws;

    const recover = (reason, options) => {
      if (!isCurrentSocket()) return;
      console.warn('[Kick Connector] Reconnecting Pusher:', reason);
      this.reconnectSocket(connectionId, options);
    };
    this.subscriptionTimer = setTimeout(() => recover('connection timeout'), 12000);
    ws.onopen = () => {
      if (isCurrentSocket()) this.onStatus('kick', false, `Подключение к чату (${this.channel})...`);
    };

    ws.onmessage = (event) => {
      if (!isCurrentSocket()) return;
      try {
        const packet = JSON.parse(event.data);
        const isExpectedRoom = packet.channel === room;

        if (packet.event === 'pusher:connection_established' && !subscribing) {
          subscribing = true;
          clearTimeout(this.subscriptionTimer);
          this.subscriptionTimer = setTimeout(() => recover('subscription timeout', { roomFailure: true }), 10000);
          ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: room } }));
        } else if (['pusher_internal:subscription_succeeded', 'pusher:subscription_succeeded'].includes(packet.event)
          && isExpectedRoom && subscribing && !subscribed) {
          subscribed = true;
          clearTimeout(this.subscriptionTimer);
          this.subscriptionTimer = null;
          this.saveWorkingKey(this.currentKey);
          this.nextRoomRefreshAt = 0;
          this.reconnectAttempts = 0;
          // Keepalive ping every 30 seconds, with a deadline for its pong.
          this.pingInterval = setInterval(() => {
            if (!isCurrentSocket() || this.pongTimer || ws.readyState !== (ws.OPEN ?? 1)) return;
            this.pongTimer = setTimeout(() => recover('pong timeout'), 10000);
            ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          }, 30000);
          this.onStatus('kick', true, `Онлайн (${this.channel})`);
        } else if (packet.event === 'pusher:ping') {
          ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        } else if (packet.event === 'pusher:pong') {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        } else if (packet.event === 'pusher:error') {
          this.handlePusherError(packet, room, recover);
        } else if (isExpectedRoom && ['pusher:subscription_error', 'pusher_internal:subscription_error'].includes(packet.event)) {
          recover('subscription refused', { roomFailure: true });
        } else if (subscribed && isExpectedRoom) {
          this.handlePusherPacket(packet);
        }
      } catch (e) {
        console.warn('[Kick Connector] Could not process Pusher event.', e.name);
      }
    };

    ws.onerror = () => {
      if (isCurrentSocket()) console.warn('[Kick Connector] WebSocket transport error.');
    };
    ws.onclose = (event) => {
      const code = event?.code;
      recover(`connection closed (${code || 'unknown'})`, { keyRefused: code === 4001 });
    };
  }

  handlePusherError(packet, room, recover) {
    let data = packet.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (_) {
        // Non-JSON string payload
      }
    }
    const message = typeof data === 'string' ? data : data?.message;
    if (Number(data?.code) === 4001 || /not in this cluster/i.test(message || '')) {
      recover('app key refused', { keyRefused: true });
    } else if (packet.channel === room || data?.channel === room) {
      recover('subscription refused', { roomFailure: true });
    } else {
      console.warn('[Kick Connector] Pusher error.', Number(data?.code) || 'unknown');
    }
  }

  reconnectSocket(connectionId, { keyRefused = false, roomFailure = false } = {}) {
    this.cleanup();
    this.closeSocket();
    const refreshRoom = roomFailure && Date.now() >= this.nextRoomRefreshAt;
    if (refreshRoom) this.nextRoomRefreshAt = Date.now() + KICK_ROOM_REFRESH_COOLDOWN_MS;

    // Try the next known Pusher key promptly. Slow down repeated transport failures.
    const delay = keyRefused ? (this.rotateToNextKey() ? 1000 : 15000)
      : Math.min(30000, 5000 * 2 ** Math.min(this.reconnectAttempts++, 3));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isConnectionActive(connectionId)) return;
      if (refreshRoom || this.chatroomExpiresAt <= Date.now()) void this.lookupAndConnect(connectionId, refreshRoom);
      else this.initPusherWS(connectionId);
    }, delay);
    this.onStatus('kick', false, 'Переподключение к чату Kick...');
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
    this.chatroomExpiresAt = 0;
    this.nextRoomRefreshAt = 0;
    this.reconnectAttempts = 0;
    this.cleanup();
    this.closeSocket();
    this.onStatus('kick', false, 'Офлайн');
  }

  closeSocket() {
    const socket = this.ws;
    if (!socket) return;
    this.ws = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch (e) {}
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
    clearTimeout(this.subscriptionTimer);
    clearTimeout(this.pongTimer);
    this.subscriptionTimer = null;
    this.pongTimer = null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = KickConnector;
}
