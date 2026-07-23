/**
 * Message Filter Logic for MultiChat
 * Evaluates whether a message is a chatter-to-chatter reply that should be collapsed.
 */

class MessageFilter {
  /**
   * Checks if a message is a chatter-to-chatter reply.
   * @param {Object} msg - The message object
   * @param {string} msg.author - Author username
   * @param {string} msg.text - Message content
   * @param {string|null} msg.replyTo - Username of the user being replied to (if platform provides reply tags)
   * @param {Array<string>} streamerNicknames - List of lowercased streamer nicknames/handles
   * @param {boolean} hideChatterRepliesEnabled - Whether the filter toggle is ON
   * @returns {boolean} true if message should be collapsed into "[чаттерсы общаются]"
   */
  shouldCollapseReply(msg, streamerNicknames = [], hideChatterRepliesEnabled = true) {
    if (!hideChatterRepliesEnabled) {
      return false;
    }

    const authorClean = (msg.author || '').toLowerCase().trim();
    
    // 1. Never collapse messages sent by the streamer
    if (streamerNicknames.includes(authorClean)) {
      return false;
    }

    const text = msg.text || '';
    const textLower = text.toLowerCase();

    // 2. Check if message mentions the streamer anywhere in text
    const mentionsStreamer = streamerNicknames.some(nick => {
      if (!nick) return false;
      // Match nickname as word or after @ tag
      const pattern = new RegExp(`(?:^|\\s|@)${this.escapeRegExp(nick)}(?:$|\\s|[.,!?])`, 'i');
      return pattern.test(textLower);
    });

    if (mentionsStreamer) {
      return false; // Do NOT hide if streamer is mentioned!
    }

    // 3. Check explicit platform reply metadata (e.g. Twitch reply-parent-user-login)
    if (msg.replyTo) {
      const targetClean = msg.replyTo.toLowerCase().trim();
      // If replying directly to streamer -> DO NOT HIDE
      if (streamerNicknames.includes(targetClean)) {
        return false;
      }
      // Replying to another chatter -> COLLAPSE
      return true;
    }

    // 4. Check if message starts with @username (standard text reply format)
    const leadingMentionMatch = text.trim().match(/^@([a-zA-Z0-9_А-Яа-я]+)/);
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
      const pattern = new RegExp(`(?:^|\\s|@)${this.escapeRegExp(nick)}(?:$|\\s|[.,!?])`, 'i');
      return pattern.test(textLower);
    });
  }

  escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// Global instance
window.messageFilter = new MessageFilter();
