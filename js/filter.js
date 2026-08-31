/**
 * Message Filter Logic for MultiChat
 * Evaluates whether a message is a chatter-to-chatter reply or streamer-to-user mention that should be collapsed.
 */

class MessageFilter {
  /**
   * Checks if author is streamer/broadcaster.
   * @param {Object} msg - The message object
   * @param {Array<string>} streamerNicknames - List of lowercased streamer nicknames/handles
   * @returns {boolean}
   */
  isAuthorStreamer(msg, streamerNicknames = []) {
    if (!msg) return false;
    const authorClean = (msg.author || '').toLowerCase().trim();
    const loginClean = (msg.login || '').toLowerCase().trim();

    if (authorClean && streamerNicknames.includes(authorClean)) return true;
    if (loginClean && streamerNicknames.includes(loginClean)) return true;

    // Check broadcaster/owner badges (Twitch/Kick/YouTube)
    if (typeof msg.badges === 'string' && msg.badges.includes('broadcaster')) {
      return true;
    }
    if (Array.isArray(msg.badges)) {
      const hasBroadcasterBadge = msg.badges.some(b => {
        if (typeof b === 'string') return b.includes('broadcaster') || b.includes('owner');
        if (b && typeof b === 'object') {
          return b.type === 'broadcaster' || b.type === 'owner';
        }
        return false;
      });
      if (hasBroadcasterBadge) return true;
    }

    if (msg.isOwner || msg.isBroadcaster) {
      return true;
    }

    return false;
  }

  /**
   * Extracts all @mentions from text.
   * @param {string} text
   * @returns {Array<string>} list of lowercased usernames mentioned with @
   */
  extractUserMentions(text) {
    if (!text || typeof text !== 'string') return [];
    const pattern = /(?:^|\s|[,.!?])@([a-zA-Z0-9_А-Яа-яёЁ]+)/g;
    const mentions = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) {
        mentions.push(match[1].toLowerCase());
      }
    }
    return mentions;
  }

  /**
   * Checks if author or login is in the ignored users list (case-insensitive, ignores @ prefix).
   * @param {Object} msg - The message object
   * @param {Array<string>} ignoredUsers - List of lowercased ignored usernames
   * @returns {boolean}
   */
  isAuthorIgnored(msg, ignoredUsers = []) {
    if (!msg || !Array.isArray(ignoredUsers) || !ignoredUsers.length) {
      return false;
    }
    const authorClean = (msg.author || '').toLowerCase().trim().replace(/^@+/, '');
    const loginClean = (msg.login || '').toLowerCase().trim().replace(/^@+/, '');
    return Boolean((authorClean && ignoredUsers.includes(authorClean)) || (loginClean && ignoredUsers.includes(loginClean)));
  }

  /**
   * Checks if message text contains any blocked keyword or phrase (case-insensitive).
   * @param {string} text
   * @param {Array<string>} blockedKeywords - List of lowercased keywords/phrases
   * @returns {boolean}
   */
  containsBlockedKeyword(text, blockedKeywords = []) {
    if (!text || typeof text !== 'string' || !Array.isArray(blockedKeywords) || !blockedKeywords.length) {
      return false;
    }
    const textNormalized = text.toLowerCase().replace(/\s+/g, ' ');
    return blockedKeywords.some(keyword => {
      if (!keyword || typeof keyword !== 'string') return false;
      const cleanKeyword = keyword.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!cleanKeyword) return false;
      return textNormalized.includes(cleanKeyword);
    });
  }

  /**
   * Checks if a message is a chatter-to-chatter reply, streamer-to-user reply/mention, contains blocked keywords, or is from an ignored user.
   * @param {Object} msg - The message object
   * @param {string} msg.author - Author username
   * @param {string} msg.text - Message content
   * @param {string|null} msg.replyTo - Username of the user being replied to (if platform provides reply tags)
   * @param {Array<string>} streamerNicknames - List of lowercased streamer nicknames/handles
   * @param {boolean} hideChatterRepliesEnabled - Whether the chatter replies filter toggle is ON
   * @param {Array<string>} blockedKeywords - List of lowercased keywords/phrases to collapse
   * @param {Array<string>} ignoredUsers - List of lowercased ignored usernames to collapse
   * @returns {boolean} true if message should be collapsed into spoiler placeholder
   */
  shouldCollapseReply(msg, streamerNicknames = [], hideChatterRepliesEnabled = true, blockedKeywords = [], ignoredUsers = []) {
    if (!msg) {
      return false;
    }

    const mentionsStreamer = this.isMentioningStreamer(msg, streamerNicknames);
    const replyTargetClean = (msg.replyTo || '').toLowerCase().trim().replace(/^@+/, '');
    const repliesToStreamer = Boolean(replyTargetClean && streamerNicknames.includes(replyTargetClean));
    const isDirectlyForStreamer = mentionsStreamer || repliesToStreamer;

    // 0. Keyword/phrase stopword filter: collapse messages containing blocked keywords UNLESS addressed to streamer
    if (this.containsBlockedKeyword(msg.text, blockedKeywords)) {
      if (isDirectlyForStreamer) {
        return false; // Do NOT hide if streamer is mentioned or replied to!
      }
      return true;
    }

    // 0b. Ignored users / bots filter: collapse messages from ignored users UNLESS addressed to streamer
    if (this.isAuthorIgnored(msg, ignoredUsers)) {
      if (isDirectlyForStreamer) {
        return false; // Do NOT hide if streamer is mentioned or replied to!
      }
      return true;
    }

    if (!hideChatterRepliesEnabled) {
      return false;
    }

    const isStreamer = this.isAuthorStreamer(msg, streamerNicknames);
    const text = msg.text || '';
    const mentions = this.extractUserMentions(text);

    // 1. Messages sent by the streamer/channel owner
    if (isStreamer) {
      // If replying directly via platform reply metadata
      const replyTargetClean = (msg.replyTo || '').toLowerCase().trim();
      if (replyTargetClean && !streamerNicknames.includes(replyTargetClean)) {
        return true; // Streamer replied to a chatter -> COLLAPSE
      }

      // If message contains @username mentioning another user
      const mentionsOtherUser = mentions.some(user => !streamerNicknames.includes(user));
      if (mentionsOtherUser) {
        return true; // Streamer tagged another chatter -> COLLAPSE
      }

      // General message from streamer without mentions -> DO NOT HIDE
      return false;
    }

    // 2. Regular chatter message: check if message mentions the streamer anywhere in text
    if (mentionsStreamer) {
      return false; // Do NOT hide if streamer is mentioned!
    }

    // 3. Regular chatter message: check explicit platform reply metadata (e.g. Twitch reply-parent-user-login)
    const chatterReplyTarget = (msg.replyTo || '').toLowerCase().trim();
    if (chatterReplyTarget) {
      // If replying directly to streamer -> DO NOT HIDE
      if (streamerNicknames.includes(chatterReplyTarget)) {
        return false;
      }
      // Replying to another chatter -> COLLAPSE
      return true;
    }

    // 4. Regular chatter message: check if message starts with @username or mentions another chatter
    const leadingMentionMatch = text.trim().match(/^@([a-zA-Z0-9_А-Яа-яёЁ]+)/);
    if (leadingMentionMatch) {
      const targetUser = leadingMentionMatch[1].toLowerCase();
      // If leading mention is streamer -> DO NOT HIDE
      if (streamerNicknames.includes(targetUser)) {
        return false;
      }
      // Leading mention is another chatter -> COLLAPSE
      return true;
    }

    // Default: normal message, do not collapse
    return false;
  }

  /**
   * Checks if a message mentions any streamer nickname/handle.
   * @param {Object} msg - The message object
   * @param {Array<string>} streamerNicknames - List of lowercased streamer nicknames/handles
   * @returns {boolean} true if message mentions the streamer
   */
  isMentioningStreamer(msg, streamerNicknames = []) {
    if (!msg || !msg.text || !streamerNicknames.length) return false;
    const textLower = msg.text.toLowerCase();
    return streamerNicknames.some(nick => {
      if (!nick) return false;
      const pattern = new RegExp(`(?:^|\\s|@)${this.escapeRegExp(nick)}(?:$|\\s|[.,!?:;)])`, 'i');
      return pattern.test(textLower);
    });
  }

  escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// Global instance & CommonJS export
if (typeof window !== 'undefined') {
  window.messageFilter = new MessageFilter();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageFilter;
}
