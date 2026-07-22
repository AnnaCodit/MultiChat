/**
 * Twitch IRC WebSocket Connector for MultiChat
 * Standard read-only anonymous IRC connection to wss://irc-ws.chat.twitch.tv:443
 */

class TwitchConnector {
  constructor(onMessageCallback, onStatusCallback) {
    this.onMessage = onMessageCallback;
    this.onStatus = onStatusCallback;
    this.ws = null;
    this.channel = '';
    this.reconnectTimer = null;
    this.pingInterval = null;
  }

  connect(channelName) {
    this.disconnect();

    if (!channelName) {
      this.onStatus('twitch', false, 'Канал не указан');
      return;
    }

    this.channel = channelName.toLowerCase().trim().replace(/^#/, '');
    console.log(`[Twitch Connector] Connecting to #${this.channel}...`);
    this.onStatus('twitch', false, 'Подключение...');

    try {
      this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

      this.ws.onopen = () => {
        console.log('[Twitch Connector] WebSocket connected. Registering IRC capabilities...');
        this.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        const randomNick = `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
        this.ws.send(`NICK ${randomNick}`);
        this.ws.send(`JOIN #${this.channel}`);

        this.onStatus('twitch', true, `Онлайн (${this.channel})`);

        // Keepalive ping
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send('PING :tmi.twitch.tv');
          }
        }, 60000);
      };

      this.ws.onmessage = (event) => {
        this.handleIrcMessage(event.data);
      };

      this.ws.onerror = (err) => {
        console.error('[Twitch Connector] WebSocket error:', err);
        this.onStatus('twitch', false, 'Ошибка соединения');
      };

      this.ws.onclose = () => {
        console.warn('[Twitch Connector] WebSocket closed.');
        this.onStatus('twitch', false, 'Отключен');
        this.cleanup();

        // Auto-reconnect after 5 seconds
        this.reconnectTimer = setTimeout(() => {
          if (this.channel) this.connect(this.channel);
        }, 5000);
      };
    } catch (e) {
      console.error('[Twitch Connector] Exception during connect:', e);
      this.onStatus('twitch', false, 'Ошибка');
    }
  }

  disconnect() {
    this.channel = '';
    this.cleanup();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.onStatus('twitch', false, 'Офлайн');
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

  handleIrcMessage(rawMessage) {
    const lines = rawMessage.split('\r\n');
    lines.forEach(line => {
      if (!line) return;

      // Respond to Twitch PING
      if (line.startsWith('PING')) {
        this.ws.send('PONG :tmi.twitch.tv');
        return;
      }

      if (line.includes('PRIVMSG')) {
        this.parsePrivMsg(line);
      }
    });
  }

  parsePrivMsg(line) {
    try {
      let tags = {};
      let lineToParse = line;

      // Extract IRC tags
      if (line.startsWith('@')) {
        const spaceIdx = line.indexOf(' ');
        const tagsRaw = line.substring(1, spaceIdx);
        lineToParse = line.substring(spaceIdx + 1);

        tagsRaw.split(';').forEach(tag => {
          const [key, val] = tag.split('=');
          tags[key] = val || '';
        });
      }

      // Parse prefix and message content
      const privmsgIdx = lineToParse.indexOf('PRIVMSG');
      if (privmsgIdx === -1) return;

      const prefix = lineToParse.substring(0, privmsgIdx).trim();
      const content = lineToParse.substring(lineToParse.indexOf(':', privmsgIdx) + 1);

      // Extract author display-name or fallback to IRC username
      let author = tags['display-name'] || '';
      if (!author) {
        const nickMatch = prefix.match(/^:([^!]+)!/);
        author = nickMatch ? nickMatch[1] : 'TwitchUser';
      }

      // Extract reply metadata from Twitch tags
      // reply-parent-user-login contains the target username of a reply!
      const replyTo = tags['reply-parent-user-login'] || null;

      this.onMessage({
        platform: 'twitch',
        author: author,
        text: content,
        replyTo: replyTo,
        tags: tags
      });
    } catch (e) {
      console.error('[Twitch Connector] Error parsing PRIVMSG:', e);
    }
  }
}
