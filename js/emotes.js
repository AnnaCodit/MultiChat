/**
 * Emote Manager for MultiChat
 * Supports Twitch Native Emotes, 7TV (Global + Channel), BetterTTV (BTTV), FrankerFaceZ (FFZ).
 */

class EmoteManager {
  constructor() {
    this.emoteMap = new Map(); // token -> imageUrl
    this.loadedChannels = new Set();
  }

  /**
   * Reset emote map
   */
  clear() {
    this.emoteMap.clear();
    this.loadedChannels.clear();
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

  // --- Twitch Channel Emotes (DecAPI -> Twitch User ID -> 7TV / BTTV / FFZ) ---
  async fetchTwitchChannelEmotes(channelName) {
    try {
      const cleanChannel = channelName.replace(/^@+/, '').trim().toLowerCase();
      
      // 1. Resolve Twitch username -> numeric Twitch User ID using DecAPI
      const decRes = await fetch(`https://decapi.me/twitch/id/${encodeURIComponent(cleanChannel)}`);
      if (!decRes.ok) return;
      const twitchUserId = (await decRes.text()).trim();

      if (!/^\d+$/.test(twitchUserId)) {
        console.warn(`[Twitch Emotes] Could not resolve Twitch ID for ${cleanChannel}:`, twitchUserId);
        return;
      }

      console.log(`[Twitch Emotes] Resolved ${cleanChannel} -> Twitch User ID: ${twitchUserId}`);

      await Promise.allSettled([
        // 7TV Channel Emotes
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

        // BTTV Channel Emotes
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

        // FFZ Channel Emotes
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
   * Parse Twitch native emotes tag (e.g. "25:0-4,6-10/1902:12-16")
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

      // Sort by start position descending (back to front replacement)
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
   * Parse text message HTML, escaping unsafe tags and replacing 7TV/BTTV/FFZ emote tokens with <img> elements
   */
  parseEmotes(text, twitchEmotesTag = null) {
    if (!text) return '';

    // 1. If Twitch native emotes tag is present, replace Twitch native emotes first
    let processedText = text;
    if (twitchEmotesTag) {
      processedText = this.parseTwitchNativeEmotes(text, twitchEmotesTag);
    }

    // 2. If native emotes were parsed, we have HTML tags embedded.
    // If no native emotes, escape raw HTML to prevent XSS
    let safeHTML = processedText;
    if (!twitchEmotesTag) {
      safeHTML = processedText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // 3. Process 3rd-party emotes (7TV, BTTV, FFZ) if enabled
    if (this.emoteMap.size > 0) {
      const words = safeHTML.split(' ');
      safeHTML = words.map(word => {
        // Skip already rendered <img> tags
        if (word.startsWith('<img') || word.includes('class="chat-emote"')) {
          return word;
        }

        // Direct exact match
        if (this.emoteMap.has(word)) {
          const rawUrl = this.emoteMap.get(word);
          if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
            const cleanUrl = this.escapeAttr(rawUrl);
            const cleanWord = this.escapeAttr(word);
            return `<img class="chat-emote" src="${cleanUrl}" alt="${cleanWord}" title="${cleanWord}" loading="lazy">`;
          }
        }

        // Punctuation match (e.g. "Sus!", "Sus,", "(Sus)")
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
