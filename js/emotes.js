/**
 * Emote & Badge Manager for MultiChat
 * Supports Twitch Native Emotes & Badges, Kick Native Emotes & Badges, 7TV, BTTV, FFZ.
 */

class EmoteManager {
  constructor() {
    this.emoteMap = new Map(); // token -> imageUrl
    this.badgeMap = new Map(); // set_id/version -> imageUrl
    this.loadedChannels = new Set();

    // Default static fallback badge URLs for common Twitch/Kick roles
    this.defaultTwitchBadges = {
      'broadcaster/1': 'https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/1',
      'moderator/1': 'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1',
      'vip/1': 'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/1',
      'partner/1': 'https://static-cdn.jtvnw.net/badges/v1/d12a2e27-16f6-41d0-ab77-b780518f00a3/1',
      'premium/1': 'https://static-cdn.jtvnw.net/badges/v1/bbbe0db0-a598-423e-86d0-f9fb98ca1933/1',
      'subscriber/1': 'https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/1',
      'founder/0': 'https://static-cdn.jtvnw.net/badges/v1/52467d0f-4856-4ec8-8889-1065c786c57f/1'
    };

    // Load Twitch global badges asynchronously
    this.loadGlobalBadges().catch(() => {});
  }

  /**
   * Reset maps
   */
  clear() {
    this.emoteMap.clear();
    this.loadedChannels.clear();
  }

  /**
   * Fetch Twitch Global Badges from IVR API
   */
  async loadGlobalBadges() {
    try {
      const res = await fetch('https://api.ivr.fi/v2/twitch/badges/global');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        data.forEach(set => {
          if (set.set_id && Array.isArray(set.versions)) {
            set.versions.forEach(v => {
              if (v.id && (v.image_url_1x || v.image_url_2x)) {
                const key = set.set_id + '/' + v.id;
                this.badgeMap.set(key, v.image_url_1x || v.image_url_2x);
              }
            });
          }
        });
        console.log(`[MultiChat Badges] Loaded ${this.badgeMap.size} Twitch badges.`);
      }
    } catch (e) {
      console.warn('[Badges] Failed to load Twitch global badges:', e.message);
    }
  }

  /**
   * Fetch global emotes from 7TV, BTTV, FFZ
   */
  async loadGlobalEmotes() {
    console.log('[MultiChat Emotes] Loading global emotes...');
    await Promise.allSettled([
      this.fetch7TVGlobal(),
      this.fetchBTTVGlobal(),
      this.fetchFFZGlobal()
    ]);
    console.log(`[MultiChat Emotes] Loaded ${this.emoteMap.size} total emotes.`);
  }

  /**
   * Fetch channel-specific emotes for Twitch / Kick channels
   */
  async loadChannelEmotes(twitchChannel, kickChannel) {
    if (twitchChannel && !this.loadedChannels.has('twitch:' + twitchChannel)) {
      this.loadedChannels.add('twitch:' + twitchChannel);
      await this.fetchTwitchChannelEmotes(twitchChannel);
    }
    if (kickChannel && !this.loadedChannels.has('kick:' + kickChannel)) {
      this.loadedChannels.add('kick:' + kickChannel);
      await this.fetchKickChannelEmotes(kickChannel);
    }
  }

  // --- 7TV Global ---
  async fetch7TVGlobal() {
    try {
      const res = await fetch('https://api.7tv.app/v3/emote-sets/global');
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.emotes) {
        data.emotes.forEach(e => {
          const name = e.name || (e.data ? e.data.name : null);
          const id = e.id || (e.data ? e.data.id : null);
          if (name && id) {
            const url = `https://cdn.7tv.app/emote/${id}/1x.webp`;
            this.emoteMap.set(name, url);
          }
        });
        console.log(`[7TV Global] Loaded ${data.emotes.length} global emotes.`);
      }
    } catch (err) {
      console.warn('[Emotes] Failed 7TV global fetch:', err.message);
    }
  }

  // --- BTTV Global ---
  async fetchBTTVGlobal() {
    try {
      const res = await fetch('https://api.betterttv.net/3/cached/emotes/global');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        data.forEach(e => {
          if (e.code && e.id) {
            const url = `https://cdn.betterttv.net/emote/${e.id}/1x`;
            this.emoteMap.set(e.code, url);
          }
        });
      }
    } catch (err) {
      console.warn('[Emotes] Failed BTTV global fetch:', err.message);
    }
  }

  // --- FFZ Global ---
  async fetchFFZGlobal() {
    try {
      const res = await fetch('https://api.frankerfacez.com/v1/set/global');
      if (!res.ok) return;
      const data = await res.json();
      if (data.sets) {
        Object.values(data.sets).forEach(set => {
          if (set.emoticons) {
            set.emoticons.forEach(e => {
              if (e.name && (e.urls['1'] || e.urls['1x'])) {
                const url = e.urls['1'] || e.urls['1x'];
                this.emoteMap.set(e.name, url.startsWith('//') ? 'https:' + url : url);
              }
            });
          }
        });
      }
    } catch (err) {
      console.warn('[Emotes] Failed FFZ global fetch:', err.message);
    }
  }

  // --- Twitch Channel Emotes ---
  async fetchTwitchChannelEmotes(channelName) {
    try {
      const cleanChannel = channelName.replace(/^@+/, '').trim().toLowerCase();
      
      const decRes = await fetch(`https://decapi.me/twitch/id/${encodeURIComponent(cleanChannel)}`);
      if (!decRes.ok) return;
      const twitchUserId = (await decRes.text()).trim();

      if (!/^\d+$/.test(twitchUserId)) {
        console.warn(`[Twitch Emotes] Could not resolve Twitch ID for ${cleanChannel}:`, twitchUserId);
        return;
      }

      console.log(`[Twitch Emotes] Resolved ${cleanChannel} -> Twitch User ID: ${twitchUserId}`);

      await Promise.allSettled([
        fetch(`https://7tv.io/v3/users/twitch/${twitchUserId}`)
          .then(r => r.json())
          .then(data => {
            if (data.emote_set && data.emote_set.emotes) {
              data.emote_set.emotes.forEach(e => {
                const name = e.name || (e.data ? e.data.name : null);
                const id = e.id || (e.data ? e.data.id : null);
                if (name && id) {
                  this.emoteMap.set(name, `https://cdn.7tv.app/emote/${id}/1x.webp`);
                }
              });
              console.log(`[7TV Channel] Loaded ${data.emote_set.emotes.length} emotes for ${cleanChannel}`);
            }
          }).catch(() => {}),

        fetch(`https://api.betterttv.net/3/cached/users/twitch/${twitchUserId}`)
          .then(r => r.json())
          .then(data => {
            const channelEmotes = (data.channelEmotes || []).concat(data.sharedEmotes || []);
            channelEmotes.forEach(e => {
              if (e.code && e.id) {
                this.emoteMap.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/1x`);
              }
            });
            console.log(`[BTTV Channel] Loaded ${channelEmotes.length} emotes for ${cleanChannel}`);
          }).catch(() => {}),

        fetch(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(cleanChannel)}`)
          .then(r => r.json())
          .then(data => {
            if (data.sets) {
              Object.values(data.sets).forEach(set => {
                if (set.emoticons) {
                  set.emoticons.forEach(e => {
                    if (e.name && (e.urls['1'] || e.urls['1x'])) {
                      const url = e.urls['1'] || e.urls['1x'];
                      this.emoteMap.set(e.name, url.startsWith('//') ? 'https:' + url : url);
                    }
                  });
                }
              });
            }
          }).catch(() => {})
      ]);
    } catch (err) {
      console.warn('[Emotes] Failed channel emotes fetch for:', channelName, err.message);
    }
  }

  // --- Kick Channel Emotes ---
  async fetchKickChannelEmotes(channelName) {
    try {
      const cleanChannel = channelName.replace(/^@+/, '').trim().toLowerCase();
      const res = await fetchWithCorsProxy(`https://kick.com/api/v2/channels/${encodeURIComponent(cleanChannel)}`);
      const data = await res.json();
      if (data.emotes) {
        data.emotes.forEach(e => {
          if (e.name && e.id) {
            this.emoteMap.set(e.name, `https://files.kick.com/emotes/${e.id}/fullsize`);
          }
        });
      }
    } catch (err) {
      console.warn('[Emotes] Failed Kick channel emotes fetch for:', channelName, err.message);
    }
  }

  /**
   * Render User Badges HTML (Parses ALL user badges for Twitch & Kick)
   */
  getBadgesHTML(msg) {
    if (!msg || !msg.badges) return '';

    let badgeUrls = [];

    // 1. Twitch Badges Parsing (renders ALL badges present in tags, e.g. "broadcaster/1,subscriber/12,partner/1")
    if (msg.platform === 'twitch') {
      let badgeTokens = [];
      if (typeof msg.badges === 'string') {
        badgeTokens = msg.badges.split(',').filter(Boolean);
      } else if (Array.isArray(msg.badges)) {
        badgeTokens = msg.badges;
      }

      badgeTokens.forEach(token => {
        // Direct match (e.g. "broadcaster/1", "subscriber/12")
        let url = this.badgeMap.get(token) || this.defaultTwitchBadges[token];
        
        // Fallback to base set_id (e.g. "subscriber/1" or "subscriber/0")
        if (!url) {
          const setId = token.split('/')[0];
          url = this.badgeMap.get(setId + '/1') || 
                this.badgeMap.get(setId + '/0') || 
                this.defaultTwitchBadges[setId + '/1'] ||
                this.defaultTwitchBadges[setId + '/0'];
        }

        if (url) {
          badgeUrls.push({ url, title: token });
        }
      });
    }

    // 2. Kick Badges Parsing (renders ALL badges in array)
    if (msg.platform === 'kick' && Array.isArray(msg.badges)) {
      msg.badges.forEach(b => {
        let url = null;
        if (b.active_badge && b.active_badge.url) url = b.active_badge.url;
        else if (b.url) url = b.url;
        
        // Fallbacks for common Kick badge types
        if (!url && b.type) {
          if (b.type === 'broadcaster') url = this.defaultTwitchBadges['broadcaster/1'];
          else if (b.type === 'moderator') url = this.defaultTwitchBadges['moderator/1'];
          else if (b.type === 'vip') url = this.defaultTwitchBadges['vip/1'];
        }

        if (url) {
          badgeUrls.push({ url, title: b.type || b.text || 'badge' });
        }
      });
    }

    if (badgeUrls.length === 0) return '';

    return badgeUrls.map(b => {
      const cleanUrl = this.escapeAttr(b.url);
      const cleanTitle = this.escapeAttr(b.title);
      return `<img class="chat-badge" src="${cleanUrl}" alt="${cleanTitle}" title="${cleanTitle}">`;
    }).join('');
  }

  /**
   * Parse Twitch native emotes tag
   */
  parseTwitchNativeEmotes(text, emotesTag) {
    if (!text || !emotesTag) return text;

    try {
      const emoteGroups = emotesTag.split('/');
      const replacements = [];

      emoteGroups.forEach(group => {
        const [emoteId, positionStr] = group.split(':');
        if (!emoteId || !positionStr) return;

        const positions = positionStr.split(',');
        positions.forEach(pos => {
          const [startStr, endStr] = pos.split('-');
          const start = parseInt(startStr, 10);
          const end = parseInt(endStr, 10);

          if (!isNaN(start) && !isNaN(end) && start <= end && end < text.length) {
            const emoteCode = text.substring(start, end + 1);
            replacements.push({
              start,
              end,
              code: emoteCode,
              url: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0`
            });
          }
        });
      });

      replacements.sort((a, b) => b.start - a.start);

      let result = text;
      replacements.forEach(({ start, end, code, url }) => {
        const escapedCode = this.escapeAttr(code);
        const imgTag = `<img class="chat-emote" src="${url}" alt="${escapedCode}" title="${escapedCode}" loading="lazy">`;
        result = result.substring(0, start) + imgTag + result.substring(end + 1);
      });

      return result;
    } catch (e) {
      console.error('[Emotes] Error parsing Twitch native emotes:', e);
      return text;
    }
  }

  /**
   * Parse Kick native emotes tag (e.g. "[emote:87361:KEWWL]")
   */
  parseKickNativeEmotes(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\[emote:(\d+):([\w-]+)\]/g, (match, id, name) => {
      const cleanName = this.escapeAttr(name);
      return `<img class="chat-emote" src="https://files.kick.com/emotes/${id}/fullsize" alt="${cleanName}" title="${cleanName}" loading="lazy">`;
    });
  }

  /**
   * Parse text message HTML, replacing native & 3rd party emotes with <img> elements
   */
  parseEmotes(text, twitchEmotesTag = null) {
    if (!text) return '';

    let processedText = this.parseKickNativeEmotes(text);

    if (twitchEmotesTag) {
      processedText = this.parseTwitchNativeEmotes(processedText, twitchEmotesTag);
    }

    let safeHTML = processedText;
    const hasNativeImgTags = processedText.includes('<img class="chat-emote"');
    if (!hasNativeImgTags) {
      safeHTML = processedText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    if (this.emoteMap.size > 0) {
      const words = safeHTML.split(' ');
      safeHTML = words.map(word => {
        if (word.startsWith('<img') || word.includes('class="chat-emote"')) {
          return word;
        }

        if (this.emoteMap.has(word)) {
          const rawUrl = this.emoteMap.get(word);
          if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
            const cleanUrl = this.escapeAttr(rawUrl);
            const cleanWord = this.escapeAttr(word);
            return `<img class="chat-emote" src="${cleanUrl}" alt="${cleanWord}" title="${cleanWord}" loading="lazy">`;
          }
        }

        const cleanWordMatch = word.match(/^([^\w]*)([\w-]+)([^\w]*)$/);
        if (cleanWordMatch) {
          const [, prefix, bareWord, suffix] = cleanWordMatch;
          if (this.emoteMap.has(bareWord)) {
            const rawUrl = this.emoteMap.get(bareWord);
            if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
              const cleanUrl = this.escapeAttr(rawUrl);
              const cleanWord = this.escapeAttr(bareWord);
              return `${prefix}<img class="chat-emote" src="${cleanUrl}" alt="${cleanWord}" title="${cleanWord}" loading="lazy">${suffix}`;
            }
          }
        }

        return word;
      }).join(' ');
    }

    return safeHTML;
  }

  escapeAttr(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

// Global instance
window.emoteManager = new EmoteManager();
