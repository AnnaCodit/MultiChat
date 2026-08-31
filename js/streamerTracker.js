/**
 * StreamerTracker for MultiChat
 * Checks Twitch chatters against TwitchTracker API to identify active streamers,
 * with ultra-compact localStorage caching, 7-day TTL, and a throttled background queue.
 */

const STREAMER_TRACKER_CONFIG = Object.freeze({
  storageKey: 'multichat_streamer_cache',
  defaultTtlSeconds: 7 * 86400, // 7 days
  queueDelayMs: 600,
  maxQueueSize: 50,
  maxStorageEntries: 3000,
  requestTimeoutMs: 5000
});

class StreamerTracker {
  constructor({
    storageKey = STREAMER_TRACKER_CONFIG.storageKey,
    ttlSeconds = STREAMER_TRACKER_CONFIG.defaultTtlSeconds,
    queueDelayMs = STREAMER_TRACKER_CONFIG.queueDelayMs,
    maxQueueSize = STREAMER_TRACKER_CONFIG.maxQueueSize,
    maxStorageEntries = STREAMER_TRACKER_CONFIG.maxStorageEntries,
    requestTimeoutMs = STREAMER_TRACKER_CONFIG.requestTimeoutMs,
    fetcher = null,
    getNow = null
  } = {}) {
    this.storageKey = storageKey;
    this.ttlSeconds = ttlSeconds;
    this.queueDelayMs = queueDelayMs;
    this.maxQueueSize = maxQueueSize;
    this.maxStorageEntries = maxStorageEntries;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetcher = fetcher || this.defaultFetcher.bind(this);
    this.getNow = getNow || (() => Date.now());

    /**
     * In-memory cache: login -> { avgViewers: number, timestamp: number }
     */
    this.cache = new Map();

    /**
     * Sequential processing queue (FIFO) and tracking sets
     */
    this.queue = [];
    this.pendingSet = new Set();
    this.inFlightLogin = null;
    this.isProcessing = false;
    this.subscribers = [];

    this.loadFromStorage();
  }

  /**
   * Default network fetcher with timeout and fallback to fetchWithCorsProxy if available.
   */
  async defaultFetcher(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      if (typeof fetchWithCorsProxy === 'function') {
        return await fetchWithCorsProxy(url, {
          ...init,
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            ...(init.headers || {})
          }
        });
      }
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          ...(init.headers || {})
        }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Normalizes login string to trimmed lowercase without leading @ or #.
   */
  normalizeLogin(login) {
    return String(login || '').trim().toLowerCase().replace(/^[@#]+/, '');
  }

  /**
   * Returns current UNIX timestamp in whole seconds.
   */
  nowSeconds() {
    return Math.floor(this.getNow() / 1000);
  }

  /**
   * Loads compact [avg, timestampSec] cache from localStorage.
   */
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const nowSec = this.nowSeconds();
        for (const [key, val] of Object.entries(parsed)) {
          const login = this.normalizeLogin(key);
          if (!login) continue;

          // Compact format: [avgViewers, timestampSec]
          if (Array.isArray(val) && val.length >= 2) {
            const avgViewers = typeof val[0] === 'number' && !isNaN(val[0]) ? val[0] : 0;
            const timestamp = typeof val[1] === 'number' && !isNaN(val[1]) ? val[1] : 0;

            // Only keep entries within TTL
            if (nowSec - timestamp <= this.ttlSeconds) {
              this.cache.set(login, { avgViewers, timestamp });
            }
          }
        }
        this.pruneCache();
      }
    } catch (e) {
      console.warn('[StreamerTracker] Error loading cache from localStorage:', e);
    }
  }

  /**
   * Saves in-memory cache to localStorage in compact format.
   */
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      this.pruneCache();

      const obj = {};
      for (const [login, data] of this.cache.entries()) {
        obj[login] = [data.avgViewers, data.timestamp];
      }
      localStorage.setItem(this.storageKey, JSON.stringify(obj));
    } catch (e) {
      console.warn('[StreamerTracker] Error saving cache to localStorage:', e);
    }
  }

  /**
   * Prunes expired entries and enforces maxStorageEntries limit using LRU eviction.
   */
  pruneCache() {
    const nowSec = this.nowSeconds();

    // 1. Evict expired entries
    for (const [login, data] of this.cache.entries()) {
      if (nowSec - data.timestamp > this.ttlSeconds) {
        this.cache.delete(login);
      }
    }

    // 2. Evict oldest entries if capacity exceeded
    if (this.cache.size > this.maxStorageEntries) {
      const sorted = Array.from(this.cache.entries()).sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      );
      const toRemoveCount = this.cache.size - this.maxStorageEntries;
      for (let i = 0; i < toRemoveCount; i++) {
        this.cache.delete(sorted[i][0]);
      }
    }
  }

  /**
   * Synchronously checks if streamer stats exist and are valid in cache.
   * Returns { avgViewers, isStreamer, timestamp, cached: true } or null.
   */
  getStreamerStats(login) {
    const normalized = this.normalizeLogin(login);
    if (!normalized) return null;

    const entry = this.cache.get(normalized);
    if (!entry) return null;

    const nowSec = this.nowSeconds();
    if (nowSec - entry.timestamp > this.ttlSeconds) {
      this.cache.delete(normalized);
      return null;
    }

    return {
      avgViewers: entry.avgViewers,
      isStreamer: entry.avgViewers > 0,
      timestamp: entry.timestamp,
      cached: true
    };
  }

  /**
   * Schedules a background check for a user if not cached or already queued.
   */
  queueCheck(login) {
    const normalized = this.normalizeLogin(login);
    if (!normalized) return;

    // Skip if valid entry in cache
    if (this.getStreamerStats(normalized)) return;

    // Skip if already queued or currently in flight
    if (this.pendingSet.has(normalized) || this.inFlightLogin === normalized) {
      return;
    }

    // Enforce backlog cap (drop oldest un-fetched item)
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift();
      if (dropped) this.pendingSet.delete(dropped);
    }

    this.queue.push(normalized);
    this.pendingSet.add(normalized);

    this.processQueue();
  }

  /**
   * Processes queue items one at a time with a throttled delay.
   */
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const login = this.queue.shift();
    if (login) {
      this.pendingSet.delete(login);
    }
    this.inFlightLogin = login;

    try {
      if (login) {
        await this.fetchStreamerStats(login);
      }
    } catch (error) {
      console.warn(`[StreamerTracker] Lookup error for ${login}:`, error);
    } finally {
      this.inFlightLogin = null;
      setTimeout(() => {
        this.isProcessing = false;
        this.processQueue();
      }, this.queueDelayMs);
    }
  }

  /**
   * Fetches streamer summary from TwitchTracker API and updates cache.
   */
  async fetchStreamerStats(login) {
    const url = `https://twitchtracker.com/api/channels/summary/${encodeURIComponent(login)}`;
    let avgViewers = 0;

    try {
      const response = await this.fetcher(url);
      if (response && response.ok) {
        const data = await response.json();
        if (data && typeof data === 'object') {
          if (typeof data.avg_viewers === 'number' && !isNaN(data.avg_viewers) && data.avg_viewers > 0) {
            avgViewers = Math.round(data.avg_viewers);
          }
        }
      }
      // Save result in cache (0 for non-streamers or empty results, >0 for streamers)
      const nowSec = this.nowSeconds();
      this.cache.set(login, { avgViewers, timestamp: nowSec });
      this.saveToStorage();

      if (avgViewers > 0) {
        this.notifyStreamerDetected(login, avgViewers);
      }
    } catch (e) {
      console.warn(`[StreamerTracker] Failed to fetch stats for ${login}:`, e);
    }
  }

  /**
   * Registers a subscriber callback for streamer detection events.
   */
  onStreamerDetected(callback) {
    if (typeof callback === 'function') {
      this.subscribers.push(callback);
    }
  }

  /**
   * Notifies all subscribers that a streamer was detected.
   */
  notifyStreamerDetected(login, avgViewers) {
    this.subscribers.forEach((cb) => {
      try {
        cb(login, avgViewers);
      } catch (err) {
        console.error('[StreamerTracker] Error in subscriber callback:', err);
      }
    });
  }

  /**
   * Clears in-memory cache and localStorage (primarily for testing/resets).
   */
  clear() {
    this.cache.clear();
    this.queue = [];
    this.pendingSet.clear();
    this.inFlightLogin = null;
    this.isProcessing = false;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(this.storageKey);
      }
    } catch (e) {}
  }
}

// Global instance & CommonJS export
if (typeof window !== 'undefined') {
  window.STREAMER_TRACKER_CONFIG = STREAMER_TRACKER_CONFIG;
  window.StreamerTracker = StreamerTracker;
  window.streamerTracker = new StreamerTracker();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StreamerTracker, STREAMER_TRACKER_CONFIG };
}
