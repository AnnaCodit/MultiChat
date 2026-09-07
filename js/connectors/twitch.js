/**
 * Twitch IRC WebSocket Connector for MultiChat
 * Standard read-only anonymous IRC connection to wss://irc-ws.chat.twitch.tv:443
 */

class TwitchConnector {
  constructor(onMessageCallback, onStatusCallback, onRaidCallback = null) {
    this.onMessage = onMessageCallback;
    this.onStatus = onStatusCallback;
    this.onRaid = onRaidCallback;
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

  unescapeIrcTagValue(val) {
    if (!val) return '';
    return String(val)
      .replace(/\\s/g, ' ')
      .replace(/\\:/g, ';')
      .replace(/\\\\/g, '\\')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n');
  }

  extractIrcTags(line) {
    const tags = {};
    let lineWithoutTags = line;

    if (line.startsWith('@')) {
      const spaceIdx = line.indexOf(' ');
      const tagsRaw = line.substring(1, spaceIdx);
      lineWithoutTags = line.substring(spaceIdx + 1);

      tagsRaw.split(';').forEach(tag => {
        const eqIdx = tag.indexOf('=');
        if (eqIdx === -1) {
          tags[tag] = '';
        } else {
          const key = tag.substring(0, eqIdx);
          const val = tag.substring(eqIdx + 1);
          tags[key] = this.unescapeIrcTagValue(val);
        }
      });
    }

    return { tags, lineWithoutTags };
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

      const { tags, lineWithoutTags } = this.extractIrcTags(line);

      if (/\sPRIVMSG\s/.test(lineWithoutTags) || lineWithoutTags.startsWith('PRIVMSG')) {
        this.parsePrivMsg(lineWithoutTags, tags);
      } else if (/\sUSERNOTICE\s/.test(lineWithoutTags) || lineWithoutTags.startsWith('USERNOTICE')) {
        this.parseUserNotice(lineWithoutTags, tags);
      }
    });
  }

  parseUserNotice(rawLine, parsedTags = null) {
    try {
      const tags = parsedTags || this.extractIrcTags(rawLine).tags;
      const msgId = tags['msg-id'] || '';

      if (msgId === 'raid') {
        const leaderLogin = (tags['msg-param-login'] || tags['login'] || tags['display-name'] || '').toLowerCase().trim();
        const leaderDisplayName = tags['msg-param-displayName'] || tags['display-name'] || leaderLogin;
        const viewerCount = parseInt(tags['msg-param-viewerCount'], 10) || 0;
        const systemMsg = tags['system-msg'] || '';

        console.log(`[Twitch Connector] Raid detected from ${leaderDisplayName} (${leaderLogin}) with ${viewerCount} viewers.`);

        if (typeof this.onRaid === 'function') {
          this.onRaid({
            leaderLogin,
            leaderDisplayName,
            viewerCount,
            systemMsg,
            tags,
            channel: this.channel,
            timestamp: Date.now()
          });
        }
      }
    } catch (e) {
      console.error('[Twitch Connector] Error parsing USERNOTICE:', e);
    }
  }

  parsePrivMsg(rawLine, parsedTags = null) {
    try {
      let tags = parsedTags;
      let lineToParse = rawLine;

      if (!tags) {
        const extracted = this.extractIrcTags(rawLine);
        tags = extracted.tags;
        lineToParse = extracted.lineWithoutTags;
      }

      // Parse prefix and message content
      const privmsgIdx = lineToParse.indexOf('PRIVMSG');
      if (privmsgIdx === -1) return;

      const prefix = lineToParse.substring(0, privmsgIdx).trim();
      const content = lineToParse.substring(lineToParse.indexOf(':', privmsgIdx) + 1);

      // The IRC prefix is the canonical Twitch login. display-name is presentation-only
      // and may not be accepted by profile APIs for localized display names.
      const nickMatch = prefix.match(/^:([^!]+)!/);
      const login = nickMatch ? nickMatch[1] : '';
      const author = tags['display-name'] || login || 'TwitchUser';

      // Extract reply metadata from Twitch tags
      const replyTo = tags['reply-parent-user-login'] || null;

      // Extract user ID from Twitch tags
      const userId = tags['user-id'] || null;

      // Extract nickname color & user badges from Twitch IRC tags
      const userColor = tags['color'] || null;
      const userBadges = tags['badges'] || null;

      // Extract native Twitch GIFs tag (Tier 2/3 subscriber GIFs)
      const userGifs = tags['gifs'] || null;

      // Detect Channel Points custom reward redemption tag
      const isRewardRedemption = !!(tags['custom-reward-id'] || (tags['msg-id'] && tags['msg-id'].includes('custom-reward')));

      this.onMessage({
        platform: 'twitch',
        login,
        author,
        userId,
        text: content,
        color: userColor,
        badges: userBadges,
        gifs: userGifs,
        replyTo: replyTo,
        isRewardRedemption: isRewardRedemption,
        tags: tags
      });
    } catch (e) {
      console.error('[Twitch Connector] Error parsing PRIVMSG:', e);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TwitchConnector;
}
