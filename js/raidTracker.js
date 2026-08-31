/**
 * Raid Tracker for MultiChat
 * Tracks recent raid leaders on Twitch and highlights their messages for 10 minutes
 */

const RAID_LEADER_DURATION_MS = 10 * 60 * 1000; // 10 minutes

class RaidTracker {
  constructor(durationMs = RAID_LEADER_DURATION_MS) {
    this.durationMs = durationMs;
    this.raidLeaders = new Map(); // key: normalized login/alias -> { login, displayName, viewerCount, raidedAt, expiresAt }
  }

  /**
   * Normalizes username or login by lowercasing and trimming leading @ symbols
   * @param {string} name
   * @returns {string}
   */
  normalizeName(name) {
    return String(name ?? '').toLowerCase().trim().replace(/^@+/, '');
  }

  /**
   * Returns active raid leader duration in milliseconds from settings or default
   * @returns {number}
   */
  getDurationMs() {
    if (typeof window !== 'undefined' && window.settingsManager && window.settingsManager.settings) {
      const minutes = window.settingsManager.settings.raidLeaderDurationMinutes;
      if (typeof minutes === 'number' && minutes > 0) {
        return minutes * 60 * 1000;
      }
    }
    return this.durationMs;
  }

  /**
   * Registers a new raid event and sets raid leader expiration time
   * @param {Object} raidEvent
   * @param {string} raidEvent.leaderLogin
   * @param {string} [raidEvent.leaderDisplayName]
   * @param {number} [raidEvent.viewerCount]
   * @param {number} [raidEvent.timestamp]
   */
  registerRaid({ leaderLogin, leaderDisplayName, viewerCount = 0, timestamp = Date.now() }) {
    const cleanLogin = this.normalizeName(leaderLogin);
    const cleanDisplayName = this.normalizeName(leaderDisplayName);

    if (!cleanLogin && !cleanDisplayName) {
      console.warn('[RaidTracker] Attempted to register raid with empty leader name');
      return;
    }

    const primaryKey = cleanLogin || cleanDisplayName;
    const duration = this.getDurationMs();
    const expiresAt = timestamp + duration;

    const leaderRecord = {
      login: cleanLogin || cleanDisplayName,
      displayName: leaderDisplayName || leaderLogin || primaryKey,
      viewerCount: Number(viewerCount) || 0,
      raidedAt: timestamp,
      expiresAt: expiresAt
    };

    this.raidLeaders.set(primaryKey, leaderRecord);
    if (cleanDisplayName && cleanDisplayName !== primaryKey) {
      this.raidLeaders.set(cleanDisplayName, leaderRecord);
    }

    console.log(`[RaidTracker] Registered raid leader "${leaderRecord.displayName}" (${leaderRecord.login}) with ${leaderRecord.viewerCount} viewers. Active for ${Math.round(duration / 60000)}m until ${new Date(expiresAt).toLocaleTimeString()}.`);
  }

  /**
   * Removes expired raid leader entries
   * @param {number} now
   */
  pruneExpired(now = Date.now()) {
    for (const [key, record] of this.raidLeaders.entries()) {
      if (now > record.expiresAt) {
        this.raidLeaders.delete(key);
      }
    }
  }

  /**
   * Checks if message author is currently an active raid leader (within 10m window)
   * @param {Object} msg
   * @param {number} [now]
   * @returns {boolean}
   */
  isRaidLeader(msg, now = Date.now()) {
    if (!msg) return false;
    if (msg.platform && msg.platform !== 'twitch') return false;

    this.pruneExpired(now);

    if (this.raidLeaders.size === 0) return false;

    const cleanAuthor = this.normalizeName(msg.author);
    const cleanLogin = this.normalizeName(msg.login);

    if (cleanLogin && this.raidLeaders.has(cleanLogin)) {
      const record = this.raidLeaders.get(cleanLogin);
      if (now <= record.expiresAt) return true;
    }

    if (cleanAuthor && this.raidLeaders.has(cleanAuthor)) {
      const record = this.raidLeaders.get(cleanAuthor);
      if (now <= record.expiresAt) return true;
    }

    return false;
  }

  /**
   * Returns list of currently active raid leaders
   * @param {number} [now]
   * @returns {Array}
   */
  getActiveRaidLeaders(now = Date.now()) {
    this.pruneExpired(now);
    const uniqueLeaders = new Map();
    for (const record of this.raidLeaders.values()) {
      if (now <= record.expiresAt) {
        uniqueLeaders.set(record.login, record);
      }
    }
    return Array.from(uniqueLeaders.values());
  }

  /**
   * Clears all active raid leaders
   */
  clear() {
    this.raidLeaders.clear();
  }
}

// Global singleton instance for MultiChat
if (typeof window !== 'undefined') {
  window.raidTracker = new RaidTracker();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RaidTracker, RAID_LEADER_DURATION_MS };
}

