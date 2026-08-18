# Kick Viewer Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch and display Kick online viewer count in `#statusKick` with dark-red styling when Kick channel is online.

**Architecture:** Add `KICK_CONNECTOR_CONFIG` with `viewerPollIntervalMs: 20000` to `kick.js`. `KickConnector` polls `https://kick.com/api/v2/channels/{channel}` every 20s while connected, extracts `data.livestream.viewer_count`, and emits it to `onStatus`. `MultiChatApp` updates `#kickViewerCount` inside `#statusKick`, styled with dark-red colors in `style.css`.

**Tech Stack:** Vanilla JavaScript (ES6+), HTML5, CSS3, Node.js test runner (`node --test`).

## Global Constraints
- Kick viewer poll interval is 20000ms configured in `KICK_CONNECTOR_CONFIG.viewerPollIntervalMs`.
- URL endpoint for Kick channel data: `https://kick.com/api/v2/channels/{channel}`.
- Data field: `data.livestream.viewer_count` when online, or `null`/`undefined` when offline.
- Output container: `#kickViewerCount` inside `.status-badge.status-kick`.
- Dark-red styling for `.status-kick.online`.

---

### Task 1: KickConnector Viewer Polling Logic & Unit Tests

**Files:**
- Create: `tests/kick-connector.test.js`
- Modify: `js/connectors/kick.js`

**Interfaces:**
- Produces: `KICK_CONNECTOR_CONFIG = Object.freeze({ viewerPollIntervalMs: 20000 })`
- Produces: `KickConnector.prototype.fetchViewerCount()`, `KickConnector.prototype.startViewerPolling()`, `KickConnector.prototype.stopViewerPolling()`
- Calls: `onStatus(platform, isConnected, description, viewerCount)`

- [ ] **Step 1: Write the failing tests for KickConnector**

Create `tests/kick-connector.test.js`:
```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadKickConnector(options = {}) {
  const fetchMock = options.fetcher || (async () => ({ ok: false }));
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    },
    WebSocket: class MockWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
      }
      send() {}
      close() {}
    },
    fetchWithCorsProxy: fetchMock,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window: {}
  };

  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/connectors/kick.js'), 'utf8');
  vm.runInContext(`${source}\nthis.KickConnector = KickConnector;\nthis.KICK_CONNECTOR_CONFIG = KICK_CONNECTOR_CONFIG;`, sandbox);
  return { KickConnector: sandbox.KickConnector, KICK_CONNECTOR_CONFIG: sandbox.KICK_CONNECTOR_CONFIG };
}

test('KICK_CONNECTOR_CONFIG has viewerPollIntervalMs set to 20000', () => {
  const { KICK_CONNECTOR_CONFIG } = loadKickConnector();
  assert.equal(KICK_CONNECTOR_CONFIG.viewerPollIntervalMs, 20000);
});

test('KickConnector fetches viewer_count when livestream is active', async () => {
  const channelData = {
    chatroom: { id: 12345 },
    livestream: {
      is_live: true,
      viewer_count: 142
    }
  };

  let requestedUrl = '';
  const fetcher = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => channelData
    };
  };

  const { KickConnector } = loadKickConnector({ fetcher });
  const statuses = [];
  const connector = new KickConnector(
    () => {},
    (plat, isOnline, desc, viewerCount) => {
      statuses.push({ plat, isOnline, desc, viewerCount });
    },
    { fetcher }
  );

  connector.channel = 'testchannel';
  const viewers = await connector.fetchViewerCount();

  assert.equal(viewers, 142);
  assert.ok(requestedUrl.includes('testchannel'));
});

test('KickConnector returns null when livestream is null (offline)', async () => {
  const channelData = {
    chatroom: { id: 12345 },
    livestream: null
  };

  const fetcher = async () => ({
    ok: true,
    json: async () => channelData
  });

  const { KickConnector } = loadKickConnector({ fetcher });
  const connector = new KickConnector(() => {}, () => {}, { fetcher });
  connector.channel = 'offlinechannel';
  const viewers = await connector.fetchViewerCount();

  assert.equal(viewers, null);
});

test('KickConnector cleans up viewer polling timer on disconnect', () => {
  const { KickConnector } = loadKickConnector();
  const connector = new KickConnector(() => {}, () => {});
  connector.viewerPollTimer = setTimeout(() => {}, 100000);
  connector.disconnect();

  assert.equal(connector.viewerPollTimer, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/kick-connector.test.js`
Expected: FAIL (KickConnector viewer methods or config not yet defined)

- [ ] **Step 3: Implement KickConnector viewer polling in `js/connectors/kick.js`**

Modify `js/connectors/kick.js`:
- Add `const KICK_CONNECTOR_CONFIG = Object.freeze({ viewerPollIntervalMs: 20000 });` at top.
- Support `options.fetcher` in constructor (defaulting to `fetchWithCorsProxy`).
- Add `this.viewerPollTimer = null;` and `this.viewerCount = null;`.
- Add `fetchViewerCount()`:
  ```javascript
  async fetchViewerCount() {
    if (!this.channel) return null;
    try {
      const res = await this.fetcher(`https://kick.com/api/v2/channels/${encodeURIComponent(this.channel)}`);
      if (res && res.ok) {
        const data = await res.json();
        const count = data?.livestream?.viewer_count;
        this.viewerCount = typeof count === 'number' ? count : null;
        this.onStatus('kick', true, `Онлайн (${this.channel})`, this.viewerCount);
        return this.viewerCount;
      }
    } catch (e) {
      console.warn('[Kick Connector] Viewer count fetch failed:', e);
    }
    return null;
  }
  ```
- Add `startViewerPolling()`:
  ```javascript
  startViewerPolling() {
    this.stopViewerPolling();
    this.fetchViewerCount();
    this.viewerPollTimer = setInterval(() => {
      this.fetchViewerCount();
    }, KICK_CONNECTOR_CONFIG.viewerPollIntervalMs);
  }
  ```
- Add `stopViewerPolling()`:
  ```javascript
  stopViewerPolling() {
    if (this.viewerPollTimer) {
      clearInterval(this.viewerPollTimer);
      this.viewerPollTimer = null;
    }
  }
  ```
- Call `this.startViewerPolling()` inside `initPusherWS` upon successful connection.
- Call `this.stopViewerPolling()` in `disconnect()` and `cleanup()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/kick-connector.test.js`
Expected: PASS

- [ ] **Step 5: Commit Task 1 changes**

```bash
git add tests/kick-connector.test.js js/connectors/kick.js
git commit -m "feat: add Kick viewer polling logic and unit tests"
```

---

### Task 2: UI Markup, Status Update Handler, and Dark-Red Badge Styling

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`
- Modify: `style.css`
- Modify: `tests/unread-badge.test.js`
- Modify: `tests/ui-integration.test.js`

**Interfaces:**
- Consumes: `onStatus(platform, isConnected, description, viewerCount)`
- Produces: `#kickViewerCount` in DOM with updated viewer count and dark-red `.status-kick.online` style.

- [ ] **Step 1: Write UI tests for Kick viewer count in `tests/ui-integration.test.js`**

Add tests verifying:
- `#statusKick` contains `#kickViewerCount`.
- `updateStatus('kick', true, 'Онлайн', 42)` sets `#kickViewerCount` text to `42`.
- `updateStatus('kick', false, 'Офлайн')` clears `#kickViewerCount`.

- [ ] **Step 2: Update `index.html`**

Update `#statusKick` in `index.html`:
```html
<span class="status-badge status-kick offline" id="statusKick" title="Kick">
  <span class="platform-icon kick-icon"></span> KI <span id="kickViewerCount" class="viewer-count"></span>
</span>
```

- [ ] **Step 3: Update `js/app.js`**

In `MultiChatApp.prototype.updateStatus`:
```javascript
updateStatus(platform, isOnline, description, viewerCount = null) {
  const badgeMap = {
    twitch: 'statusTwitch',
    kick: 'statusKick',
    vk: 'statusVk',
    youtube: 'statusYoutube'
  };

  const elId = badgeMap[platform];
  if (!elId) return;

  const el = document.getElementById(elId);
  if (!el) return;

  if (isOnline) {
    el.classList.remove('offline');
    el.classList.add('online');
  } else {
    el.classList.remove('online');
    el.classList.add('offline');
  }
  el.title = `${platform.toUpperCase()}: ${description}`;

  if (platform === 'kick') {
    const countEl = document.getElementById('kickViewerCount');
    if (countEl) {
      if (isOnline && typeof viewerCount === 'number') {
        countEl.textContent = viewerCount.toLocaleString('ru-RU');
      } else {
        countEl.textContent = '';
      }
    }
  }
}
```

Also fix `formatUnreadCountText` in `js/app.js` to align with `unread-badge.test.js` ("новое сообщение / новых сообщения / новых сообщений").

- [ ] **Step 4: Update `style.css`**

Add/update dark-red styling for `.status-kick.online`:
```css
.status-kick.online {
  background-color: rgba(139, 0, 0, 0.4);
  border-color: rgba(220, 38, 38, 0.4);
  color: #ffcccc;
}

.status-kick .viewer-count {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  margin-left: 2px;
}

.status-kick .viewer-count:empty {
  display: none;
}
```

- [ ] **Step 5: Run tests**

Run: `node --test`
Expected: All tests PASS

- [ ] **Step 6: Commit Task 2 changes**

```bash
git add index.html js/app.js style.css tests/ui-integration.test.js tests/unread-badge.test.js
git commit -m "feat: add Kick viewer count UI element and dark-red styling"
```

---

### Task 3: Documentation and Verification

**Files:**
- Modify: `docs.md`

- [ ] **Step 1: Update `docs.md`**
Document the Kick viewer count polling (`KICK_CONNECTOR_CONFIG.viewerPollIntervalMs`, `https://kick.com/api/v2/channels/{channel}`) and UI status badge display.

- [ ] **Step 2: Run all project tests**
Run: `npm test`
Expected: All tests passing with 0 failures.

- [ ] **Step 3: Commit Task 3 changes**
```bash
git add docs.md
git commit -m "docs: document Kick viewer count polling and display"
```
