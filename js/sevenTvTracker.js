/**
 * SevenTvTracker for MultiChat
 * Fetches and caches 7TV user nickname colors and cosmetic paints for Twitch chatters.
 * Supports full 7TV paints (linear/radial gradients, textures, drop-shadows, animations)
 * and is designed for high load: negative caching, throttled background queue, and compact storage.
 */

const SEVENTV_TRACKER_CONFIG = Object.freeze({
  storageKey: 'multichat_7tv_cache',
  positiveTtlSeconds: 7 * 86400, // 7 days for users found on 7TV
  negativeTtlSeconds: 86400,     // 1 day for users not on 7TV (404)
  queueDelayMs: 300,             // 300ms between requests to avoid rate limits
  maxQueueSize: 100,             // Drop excess lookups if queue fills during raids
  maxStorageEntries: 2000,       // Maximum cached entries in localStorage
  requestTimeoutMs: 5000,
  apiBase: 'https://7tv.io/v3'
});

class SevenTvTracker {
  constructor({
    storageKey = SEVENTV_TRACKER_CONFIG.storageKey,
    positiveTtlSeconds = SEVENTV_TRACKER_CONFIG.positiveTtlSeconds,
    negativeTtlSeconds = SEVENTV_TRACKER_CONFIG.negativeTtlSeconds,
    queueDelayMs = SEVENTV_TRACKER_CONFIG.queueDelayMs,
    maxQueueSize = SEVENTV_TRACKER_CONFIG.maxQueueSize,
    maxStorageEntries = SEVENTV_TRACKER_CONFIG.maxStorageEntries,
    requestTimeoutMs = SEVENTV_TRACKER_CONFIG.requestTimeoutMs,
    apiBase = SEVENTV_TRACKER_CONFIG.apiBase,
    fetcher = null,
    getNow = null,
    loadPaintsImmediately = true
  } = {}) {
    this.storageKey = storageKey;
    this.positiveTtlSeconds = positiveTtlSeconds;
    this.negativeTtlSeconds = negativeTtlSeconds;
    this.queueDelayMs = queueDelayMs;
    this.maxQueueSize = maxQueueSize;
    this.maxStorageEntries = maxStorageEntries;
    this.requestTimeoutMs = requestTimeoutMs;
    this.apiBase = apiBase;
    this.fetcher = fetcher || this.defaultFetcher.bind(this);
    this.getNow = getNow || (() => Date.now());

    /**
     * In-memory cache: userId -> { color, shadow, paint, timestamp, found }
     */
    this.cache = new Map();

    /**
     * Map of global cosmetic paints: paintId -> { id, name, backgroundImage, filter, color, shadow }
     */
    this.paintsMap = new Map();
    this.paintsLoaded = false;
    this.paintsPromise = null;

    /**
     * Sequential request queue (FIFO) and state
     */
    this.queue = [];
    this.pendingSet = new Set();
    this.inFlightId = null;
    this.isProcessing = false;
    this.processTimer = null;
    this.saveStorageTimer = null;
    this.subscribers = [];

    this.loadFromStorage();

    if (loadPaintsImmediately && typeof fetch !== 'undefined') {
      this.paintsPromise = this.loadGlobalPaints().catch(() => {});
    }
  }

  /**
   * Default network fetcher with AbortController timeout and CORS proxy fallback.
   */
  async defaultFetcher(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          ...(init.headers || {})
        }
      });
    } catch (directErr) {
      // In browser environment, if direct fetch fails (network/CORS/ISP block), attempt fetchWithCorsProxy fallback
      const corsProxyFn = (typeof window !== 'undefined' && window.fetchWithCorsProxy)
        || (typeof fetchWithCorsProxy === 'function' ? fetchWithCorsProxy : null);

      if (corsProxyFn) {
        try {
          console.warn(`[SevenTvTracker] Direct fetch failed for ${url}, trying CORS proxy...`);
          return await corsProxyFn(url, init);
        } catch (proxyErr) {
          throw directErr;
        }
      }
      throw directErr;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Converts a 7TV 32-bit signed integer color (0xRRGGBBAA) to CSS rgba string.
   * @param {number} intColor - Signed 32-bit integer
   * @returns {string|null} - e.g. "rgba(255, 170, 0, 1)"
   */
  int32ToRgba(intColor) {
    if (typeof intColor !== 'number' || !Number.isFinite(intColor) || intColor === 0) return null;

    const unsigned = intColor >>> 0;
    const alphaInt = unsigned & 0xFF;
    if (alphaInt === 0) return null; // Avoid transparent/invisible nicknames

    const r = (unsigned >>> 24) & 0xFF;
    const g = (unsigned >>> 16) & 0xFF;
    const b = (unsigned >>> 8) & 0xFF;
    const a = alphaInt / 255;
    const alphaFormatted = Number(a.toFixed(3));

    return `rgba(${r}, ${g}, ${b}, ${alphaFormatted})`;
  }

  /**
   * Parses 7TV paint shadows array into a CSS text-shadow string.
   * @param {Array} shadows - Array of { x_offset, y_offset, radius, color }
   * @returns {string} - CSS text-shadow value
   */
  parseShadows(shadows) {
    if (!Array.isArray(shadows) || shadows.length === 0) return '';

    const parts = [];
    for (const s of shadows) {
      if (!s || typeof s !== 'object') continue;
      const x = Number(s.x_offset) || 0;
      const y = Number(s.y_offset) || 0;
      const r = Number(s.radius) || 0;
      const color = typeof s.color === 'number' ? this.int32ToRgba(s.color) : 'rgba(0,0,0,0.5)';
      if (color) {
        parts.push(`${x}px ${y}px ${r}px ${color}`);
      }
    }

    return parts.join(', ');
  }

  /**
   * Parses 7TV paint shadows array into a CSS filter: drop-shadow(...) string.
   * @param {Array} shadows - Array of { x_offset, y_offset, radius, color }
   * @returns {string} - CSS filter value, e.g. "drop-shadow(0px 0px 4px rgba(...))"
   */
  parseShadowsToFilter(shadows) {
    if (!Array.isArray(shadows) || shadows.length === 0) return '';

    const parts = [];
    for (const s of shadows) {
      if (!s || typeof s !== 'object') continue;
      const x = Number(s.x_offset) || 0;
      const y = Number(s.y_offset) || 0;
      const r = Number(s.radius) || 0;
      const color = typeof s.color === 'number' ? this.int32ToRgba(s.color) : 'rgba(0,0,0,0.5)';
      if (color) {
        parts.push(`drop-shadow(${x}px ${y}px ${r}px ${color})`);
      }
    }

    return parts.join(' ');
  }

  /**
   * Converts a 7TV paint object into complete CSS properties (gradient, texture, filter, color).
   * @param {Object} paint - 7TV CosmeticPaint object
   * @returns {{ id: string, name: string, backgroundImage: string, filter: string, color: string|null, shadow: string }|null}
   */
  parsePaint(paint) {
    if (!paint || typeof paint !== 'object') return null;

    let backgroundImage = '';
    const func = String(paint.function || '').toUpperCase();

    const stops = Array.isArray(paint.stops)
      ? paint.stops
          .map(s => {
            const color = this.int32ToRgba(s.color);
            if (!color) return null;
            const atPercent = typeof s.at === 'number' ? (s.at * 100).toFixed(2) + '%' : '0%';
            return `${color} ${atPercent}`;
          })
          .filter(Boolean)
          .join(', ')
      : '';

    if (paint.image_url || func === 'URL') {
      backgroundImage = `url("${paint.image_url}")`;
    } else if (func === 'LINEAR_GRADIENT') {
      if (stops) {
        const prefix = paint.repeat ? 'repeating-linear-gradient' : 'linear-gradient';
        const angle = Number(paint.angle) || 0;
        backgroundImage = `${prefix}(${angle}deg, ${stops})`;
      }
    } else if (func === 'RADIAL_GRADIENT') {
      if (stops) {
        const prefix = paint.repeat ? 'repeating-radial-gradient' : 'radial-gradient';
        const shape = paint.shape || 'circle';
        backgroundImage = `${prefix}(${shape}, ${stops})`;
      }
    }

    const filter = this.parseShadowsToFilter(paint.shadows);
    const shadow = this.parseShadows(paint.shadows);
    const color = typeof paint.color === 'number' ? this.int32ToRgba(paint.color) : null;

    return {
      id: paint.id || '',
      name: paint.name || '',
      backgroundImage,
      filter,
      color,
      shadow
    };
  }

  /**
   * Returns current UNIX timestamp in seconds.
   */
  nowSeconds() {
    return Math.floor(this.getNow() / 1000);
  }

  /**
   * Pre-loads all 7TV global cosmetic paints via GraphQL once at startup.
   */
  async loadGlobalPaints() {
    if (this.paintsLoaded) return;

    try {
      const query = '{ cosmetics { paints { id name color function angle shape image_url repeat stops { at color } shadows { x_offset y_offset radius color } } } }';
      const res = await this.fetcher(`${this.apiBase}/gql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });

      if (!res.ok) return;
      const json = await res.json();
      const paints = json?.data?.cosmetics?.paints;

      if (Array.isArray(paints)) {
        paints.forEach(paint => {
          if (paint && paint.id) {
            const parsed = this.parsePaint(paint);
            if (parsed) {
              this.paintsMap.set(paint.id, parsed);
            }
          }
        });
        this.paintsLoaded = true;
        console.log(`[SevenTvTracker] Loaded ${this.paintsMap.size} cosmetic paints.`);
      }
    } catch (err) {
      console.warn('[SevenTvTracker] Failed to load global paints (non-critical):', err?.message || err);
    }
  }

  /**
   * Loads compact cache from localStorage.
   * Format: { [userId]: [color, shadow, timestampSec, foundFlag, paintBg, paintFilter] }
   */
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const nowSec = this.nowSeconds();

        for (const [userId, val] of Object.entries(parsed)) {
          if (!userId || !Array.isArray(val) || val.length < 4) continue;

          const color = typeof val[0] === 'string' ? val[0] : null;
          const shadow = typeof val[1] === 'string' ? val[1] : null;
          const timestamp = typeof val[2] === 'number' ? val[2] : 0;
          const found = Boolean(val[3]);

          let paint = null;
          const bg = typeof val[4] === 'string' ? val[4] : '';
          const flt = typeof val[5] === 'string' ? val[5] : '';
          if (bg || flt) {
            paint = {
              backgroundImage: bg,
              filter: flt
            };
          }

          const ttl = found ? this.positiveTtlSeconds : this.negativeTtlSeconds;
          if (nowSec - timestamp <= ttl) {
            this.cache.set(userId, { color, shadow, paint, timestamp, found });
          }
        }
        this.pruneCache();
      }
    } catch (e) {
      console.warn('[SevenTvTracker] Error loading cache from localStorage:', e);
    }
  }

  /**
   * Saves cache to localStorage in compact format.
   */
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      this.pruneCache();

      const obj = {};
      for (const [userId, data] of this.cache.entries()) {
        const entry = [
          data.color,
          data.shadow,
          data.timestamp,
          data.found ? 1 : 0
        ];
        if (data.paint && (data.paint.backgroundImage || data.paint.filter)) {
          entry.push(data.paint.backgroundImage || null, data.paint.filter || null);
        }
        obj[userId] = entry;
      }
      localStorage.setItem(this.storageKey, JSON.stringify(obj));
    } catch (e) {
      console.warn('[SevenTvTracker] Error saving cache to localStorage:', e);
    }
  }

  /**
   * Debounced save to reduce localStorage disk I/O under continuous chat traffic.
   */
  scheduleSaveToStorage(delayMs = 2000) {
    if (this.saveStorageTimer) return;
    this.saveStorageTimer = setTimeout(() => {
      this.saveStorageTimer = null;
      this.saveToStorage();
    }, delayMs);
  }

  /**
   * Prunes expired entries and enforces maxStorageEntries limit.
   */
  pruneCache() {
    const nowSec = this.nowSeconds();

    // 1. Evict expired entries
    for (const [userId, data] of this.cache.entries()) {
      const ttl = data.found ? this.positiveTtlSeconds : this.negativeTtlSeconds;
      if (nowSec - data.timestamp > ttl) {
        this.cache.delete(userId);
      }
    }

    // 2. Enforce capacity limit (FIFO eviction)
    if (this.cache.size > this.maxStorageEntries) {
      const excess = this.cache.size - this.maxStorageEntries;
      const iterator = this.cache.keys();
      for (let i = 0; i < excess; i++) {
        const oldestKey = iterator.next().value;
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }
    }
  }

  /**
   * Retrieves cached style for a given Twitch user ID.
   * Returns null if not cached or expired.
   * @param {string} userId - Twitch numeric User ID
   * @returns {{ color: string|null, shadow: string|null, paint: Object|null }|null}
   */
  getStyle(userId) {
    if (!userId) return null;
    const cleanId = String(userId).trim();
    if (!this.cache.has(cleanId)) return null;

    const data = this.cache.get(cleanId);
    const nowSec = this.nowSeconds();
    const ttl = data.found ? this.positiveTtlSeconds : this.negativeTtlSeconds;

    if (nowSec - data.timestamp > ttl) {
      this.cache.delete(cleanId);
      return null;
    }

    if (!data.found) {
      return { color: null, shadow: null, paint: null };
    }

    return {
      color: data.color || null,
      shadow: data.shadow || null,
      paint: data.paint || null
    };
  }

  /**
   * Queues a Twitch User ID for background 7TV lookup.
   * If already cached, pending, or in-flight, returns immediately.
   */
  queueCheck(userId) {
    if (!userId) return;
    const cleanId = String(userId).trim();
    if (!cleanId || this.cache.has(cleanId) || this.pendingSet.has(cleanId) || this.inFlightId === cleanId) {
      return;
    }

    // Cap queue size to prevent backlog during raid traffic
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift();
      if (dropped) this.pendingSet.delete(dropped);
    }

    this.queue.push(cleanId);
    this.pendingSet.add(cleanId);

    if (!this.isProcessing) {
      this.scheduleNext(0);
    }
  }

  /**
   * Schedules next queue tick with throttling.
   */
  scheduleNext(delayMs = this.queueDelayMs) {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
    }
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      void this.processNext();
    }, delayMs);
  }

  /**
   * Sequential queue worker processing one Twitch ID at a time.
   */
  async processNext() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      this.inFlightId = null;
      return;
    }

    this.isProcessing = true;
    const userId = this.queue.shift();
    this.pendingSet.delete(userId);
    this.inFlightId = userId;

    try {
      const nowSec = this.nowSeconds();
      let resolvedStyle = null;

      // 1. Primary lookup: GraphQL userByConnection (fetches style and inline paint together)
      try {
        const userQuery = `query GetUser($id: String!) {
          userByConnection(platform: TWITCH, id: $id) {
            id
            username
            style {
              color
              paint {
                id
                name
                color
                function
                angle
                shape
                image_url
                repeat
                stops { at color }
                shadows { x_offset y_offset radius color }
              }
            }
          }
        }`;

        const gqlRes = await this.fetcher(`${this.apiBase}/gql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: userQuery, variables: { id: userId } })
        });

        if (gqlRes.ok) {
          const gqlJson = await gqlRes.json();
          const userData = gqlJson?.data?.userByConnection;

          if (userData && userData.username !== '*DeletedUser') {
            const styleData = userData.style;
            const color = typeof styleData?.color === 'number' ? this.int32ToRgba(styleData.color) : null;
            let paint = null;
            let shadow = null;

            if (styleData?.paint) {
              paint = this.parsePaint(styleData.paint);
              if (paint && paint.filter) {
                shadow = paint.shadow;
              }
            }

            resolvedStyle = { color, shadow, paint, timestamp: nowSec, found: true };
          } else if (userData && userData.username === '*DeletedUser') {
            // User not present on 7TV
            resolvedStyle = { color: null, shadow: null, paint: null, timestamp: nowSec, found: false };
          }
        }
      } catch (gqlErr) {
        // GQL lookup error, will try REST fallback below
      }

      // 2. Fallback lookup: REST endpoint /users/twitch/:id + paintsMap
      if (!resolvedStyle) {
        const url = `${this.apiBase}/users/twitch/${encodeURIComponent(userId)}`;
        const res = await this.fetcher(url);

        if (res.status === 404) {
          resolvedStyle = { color: null, shadow: null, paint: null, timestamp: nowSec, found: false };
        } else if (res.ok) {
          const json = await res.json();
          const styleData = json?.user?.style;

          const color = typeof styleData?.color === 'number'
            ? this.int32ToRgba(styleData.color)
            : null;

          let paint = null;
          let shadow = null;

          if (styleData?.paint_id) {
            if (!this.paintsLoaded && this.paintsPromise) {
              await this.paintsPromise;
            }
            if (this.paintsMap.has(styleData.paint_id)) {
              const p = this.paintsMap.get(styleData.paint_id);
              if (typeof p === 'string') {
                shadow = p;
              } else if (p && typeof p === 'object') {
                paint = p;
                shadow = p.shadow || null;
              }
            }
          }
          if (!paint && styleData?.paint) {
            paint = this.parsePaint(styleData.paint);
            shadow = paint ? paint.shadow : null;
          }

          resolvedStyle = { color, shadow, paint, timestamp: nowSec, found: true };
        }
      }

      if (resolvedStyle) {
        this.cache.set(userId, resolvedStyle);
        this.scheduleSaveToStorage();

        if (resolvedStyle.found && (resolvedStyle.color || resolvedStyle.shadow || resolvedStyle.paint)) {
          this.notifySubscribers(userId, resolvedStyle);
        }
      }
    } catch (err) {
      // Network or timeout errors: do not cache failure so it can be retried later
      console.warn(`[SevenTvTracker] Lookup failed for user ID ${userId}:`, err?.message || err);
    } finally {
      this.inFlightId = null;
      if (this.queue.length > 0) {
        this.scheduleNext(this.queueDelayMs);
      } else {
        this.isProcessing = false;
        this.saveToStorage(); // Flush cache to localStorage when queue is idle
      }
    }
  }

  /**
   * Subscribes to 7TV style discovery events.
   */
  onStyleDetected(callback) {
    if (typeof callback === 'function') {
      this.subscribers.push(callback);
    }
  }

  notifySubscribers(userId, style) {
    for (const sub of this.subscribers) {
      try {
        sub(userId, style);
      } catch (err) {
        console.error('[SevenTvTracker] Subscriber error:', err);
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.sevenTvTracker = new SevenTvTracker();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SevenTvTracker;
}
