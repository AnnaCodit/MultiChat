/**
 * Kick WebSocket Connector for MultiChat
 * Subscribes to Kick chatroom events using Kick Pusher WebSocket protocol
 */

class KickConnector {
  constructor(onMessageCallback, onStatusCallback) {
    this.onMessage = onMessageCallback;
    this.onStatus = onStatusCallback;
    this.ws = null;
    this.channel = '';
    this.chatroomId = null;
    this.reconnectTimer = null;
    this.pingInterval = null;
  }

  async connect(channelInput) {
    this.disconnect();

    if (!channelInput) {
      this.onStatus('kick', false, 'Канал не указан');
      return;
    }

    const cleanInput = channelInput.trim().replace(/^@+/, '');
    this.channel = cleanInput.toLowerCase();

    // Direct numeric Chatroom ID
    if (/^\d+$/.test(cleanInput)) {
      this.chatroomId = cleanInput;
      console.log(`[Kick Connector] Direct Chatroom ID provided: ${this.chatroomId}`);
      this.initPusherWS();
      return;
    }

    console.log(`[Kick Connector] Resolving Kick chatroom ID for channel: ${this.channel}...`);
    this.onStatus('kick', false, 'Поиск канала Kick...');

    let foundId = await this.resolveChatroomId(this.channel);
    if (foundId) {
      this.chatroomId = foundId;
      console.log(`[Kick Connector] Resolved Chatroom ID: ${this.chatroomId}. Connecting Pusher WS...`);
      this.initPusherWS();
    } else {
      this.onStatus('kick', false, 'Канал не найден');
    }
  }

  async resolveChatroomId(channelName) {
    // 1. Direct fetch if server permits
    try {
      const res = await fetchWithCorsProxy(`https://kick.com/api/v2/channels/${encodeURIComponent(channelName)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.chatroom && data.chatroom.id) return data.chatroom.id;
      }
    } catch (e) {}

    // 2. Fetch v1 API
    try {
      const res = await fetchWithCorsProxy(`https://kick.com/api/v1/channels/${encodeURIComponent(channelName)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.chatroom && data.chatroom.id) return data.chatroom.id;
      }
    } catch (e) {}

    // 3. Known ID mapping fallback
    const knownIds = {
      'fra3a': '63014532'
    };

    if (knownIds[channelName.toLowerCase()]) {
      return knownIds[channelName.toLowerCase()];
    }

    return null;
  }

  initPusherWS() {
    try {
      // Active Kick Pusher key: 32cbd69e4b950bf97679 on ws-us2.pusher.com
      const kickAppKey = '32cbd69e4b950bf97679';
      const wsUrl = `wss://ws-us2.pusher.com/app/${kickAppKey}?protocol=7&client=js&version=7.4.0&flash=false`;
      
      console.log(`[Kick Connector] Opening Pusher WebSocket to Kick...`);
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[Kick Connector] Pusher WS connected. Subscribing to chatroom...');
        const subscribePayload = {
          event: 'pusher:subscribe',
          data: {
            auth: '',
            channel: `chatrooms.${this.chatroomId}.v2`
          }
        };
        this.ws.send(JSON.stringify(subscribePayload));
        this.onStatus('kick', true, `Онлайн (${this.channel})`);

        // Keepalive ping every 30 seconds
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          }
        }, 30000);
      };

      this.ws.onmessage = (event) => {
        try {
          const packet = JSON.parse(event.data);
          this.handlePusherPacket(packet);
        } catch (e) {
          console.error('[Kick Connector] Error parsing packet:', e);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('[Kick Connector] WS Error:', err);
      };

      this.ws.onclose = () => {
        console.warn('[Kick Connector] WS Closed.');
        this.onStatus('kick', false, 'Отключен');
        this.cleanup();

        // Auto reconnect
        this.reconnectTimer = setTimeout(() => {
          if (this.channel) this.connect(this.channel);
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
        
        let replyTo = null;
        if (msgData.metadata && msgData.metadata.original_message) {
          replyTo = msgData.metadata.original_message.sender ? msgData.metadata.original_message.sender.username : null;
        }

        this.onMessage({
          platform: 'kick',
          author: author,
          text: content,
          replyTo: replyTo,
          raw: msgData
        });
      } catch (e) {
        console.error('[Kick Connector] Error parsing chat message:', e);
      }
    }
  }

  disconnect() {
    this.channel = '';
    this.chatroomId = null;
    this.cleanup();
    if (this.ws) {
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
