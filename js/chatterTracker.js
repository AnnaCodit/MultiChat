/**
 * Chatter Tracker for MultiChat
 * Tracks first-time chatters for today (12h window) & native Twitch first-time chatters
 */

const LAST_SEEN_STORAGE_KEY = 'multichat_last_seen';

// Two-letter short platform prefixes to minimize storage size
const PLATFORM_PREFIXES = {
  twitch: 'tw',
  youtube: 'yt',
  kick: 'kk',
  vklive: 'vk'
};

class ChatterTracker {
  constructor() {
    this.seenMap = new Map();
    this.loadFromStorage();
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem(LAST_SEEN_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        const nowSec = Math.floor(Date.now() / 1000);
        const windowSec = this.getWindowSeconds();

        // Load into Map and remove expired entries (> windowSec)
        for (const [key, timestampSec] of Object.entries(obj)) {
          if (typeof timestampSec === 'number' && (nowSec - timestampSec) < windowSec) {
            this.seenMap.set(key, timestampSec);
          }
        }
      }
    } catch (e) {
      console.error('[ChatterTracker] Error loading last_seen map:', e);
      this.seenMap = new Map();
    }
  }

  saveToStorage() {
    try {
      const obj = {};
      const nowSec = Math.floor(Date.now() / 1000);
      const windowSec = this.getWindowSeconds();

      for (const [key, timestampSec] of this.seenMap.entries()) {
        // Only persist non-expired entries
        if ((nowSec - timestampSec) < windowSec) {
          obj[key] = timestampSec;
        }
      }
      localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
      console.error('[ChatterTracker] Error saving last_seen map:', e);
    }
  }

  getWindowSeconds() {
    const hours = (window.settingsManager && window.settingsManager.settings && window.settingsManager.settings.firstMessageWindowHours) || 12;
    return hours * 3600;
  }

  processMessage(msg) {
    if (!msg || !msg.author) {
      return { isFirstTimeEver: false, isFirstToday: false };
    }

    const platformCode = PLATFORM_PREFIXES[msg.platform] || msg.platform || 'tw';
    const key = `${platformCode}:${msg.author.toLowerCase().trim()}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSec = this.getWindowSeconds();

    // 1. Check Native Twitch First-Time Chatter EVER tag
    let isFirstTimeEver = false;
    if (msg.tags && (msg.tags['first-msg'] === '1' || msg.tags['first-msg'] === 'true')) {
      isFirstTimeEver = true;
    }

    // 2. Check local tracking window for First Message Today / in N hours
    const lastSeen = this.seenMap.get(key);
    let isFirstToday = false;

    if (!lastSeen || (nowSec - lastSeen) > windowSec) {
      isFirstToday = true;
      this.seenMap.set(key, nowSec);
      this.saveToStorage();
    }

    return { isFirstTimeEver, isFirstToday };
  }
}

window.chatterTracker = new ChatterTracker();
