const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadMultiChatApp(extraSandbox = {}) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: { readyState: 'loading', getElementById() { return null; } },
    window: { addEventListener() {} },
    ...extraSandbox
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/app.js'), 'utf8');
  vm.runInContext(`${source}\nthis.MultiChatApp = MultiChatApp;`, sandbox);
  return sandbox.MultiChatApp;
}

function createClassList(initial = []) {
  const classes = new Set(initial);
  return {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c)
  };
}

test('formatUnreadCountText correctly pluralizes short Russian labels without "сообщение"', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  assert.equal(app.formatUnreadCountText(1), '↓ 1 новое');
  assert.equal(app.formatUnreadCountText(2), '↓ 2 новых');
  assert.equal(app.formatUnreadCountText(4), '↓ 4 новых');
  assert.equal(app.formatUnreadCountText(5), '↓ 5 новых');
  assert.equal(app.formatUnreadCountText(11), '↓ 11 новых');
  assert.equal(app.formatUnreadCountText(21), '↓ 21 новое');
  assert.equal(app.formatUnreadCountText(22), '↓ 22 новых');
  assert.equal(app.formatUnreadCountText(25), '↓ 25 новых');
});

test('formatUnreadLagText formats lag time as 1м (minimum), Nм, Hч, or Hч Mм', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  assert.equal(app.formatUnreadLagText(-5000), '1м');
  assert.equal(app.formatUnreadLagText(NaN), '1м');
  assert.equal(app.formatUnreadLagText(0), '1м');
  assert.equal(app.formatUnreadLagText(30000), '1м');
  assert.equal(app.formatUnreadLagText(59999), '1м');
  assert.equal(app.formatUnreadLagText(60000), '1м');
  assert.equal(app.formatUnreadLagText(13 * 60000), '13м');
  assert.equal(app.formatUnreadLagText(59 * 60000), '59м');
  assert.equal(app.formatUnreadLagText(60 * 60000), '1ч');
  assert.equal(app.formatUnreadLagText(73 * 60000), '1ч 13м');
  assert.equal(app.formatUnreadLagText(120 * 60000), '2ч');
});

test('resolveMessageTimestamp extracts timestamps across platforms and falls back safely', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);
  const fallbackNow = 1763900000000;

  assert.equal(
    app.resolveMessageTimestamp({ timestamp: 1763900123456 }, fallbackNow),
    1763900123456
  );
  assert.equal(
    app.resolveMessageTimestamp({ tags: { 'tmi-sent-ts': '1763900200000' } }, fallbackNow),
    1763900200000
  );
  assert.equal(
    app.resolveMessageTimestamp({ timestampUsec: '1763900300000123' }, fallbackNow),
    1763900300000
  );
  assert.equal(
    app.resolveMessageTimestamp({ raw: { createdAt: 1763900400 } }, fallbackNow),
    1763900400000
  );
  assert.equal(
    app.resolveMessageTimestamp({ raw: { created_at: '2026-11-23T12:00:00.000Z' } }, fallbackNow),
    Date.parse('2026-11-23T12:00:00.000Z')
  );
  assert.equal(
    app.resolveMessageTimestamp({ text: 'hello' }, fallbackNow),
    fallbackNow
  );
  assert.equal(
    app.resolveMessageTimestamp({ timestamp: 'invalid-date' }, fallbackNow),
    fallbackNow
  );
});

test('renderMessageNode records resolved timestamp in dataset.timestamp', () => {
  const fakeElement = {
    className: '',
    classList: createClassList(),
    dataset: {},
    innerHTML: ''
  };

  const sandboxDocument = {
    readyState: 'loading',
    getElementById: () => null,
    createElement: () => fakeElement
  };

  const MultiChatApp = loadMultiChatApp({ document: sandboxDocument });
  const app = Object.create(MultiChatApp.prototype);
  app.chatMessagesEl = { appendChild() {} };
  app.settings = { settings: { maxChatMessages: 200 } };
  app.pruneExcessMessages = () => {};
  app.escapeHTML = (s) => String(s || '');
  app.normalizeColor = (c) => c;
  app.renderAuthorHTML = (_msg, escaped) => `<span class="msg-author">${escaped}</span>`;
  app.emotes = { getBadgesHTML: () => '' };

  app.renderMessageNode(
    {
      platform: 'twitch',
      author: 'Viewer',
      text: 'Привет',
      tags: { 'tmi-sent-ts': '1763900500000' }
    },
    'Привет',
    false
  );

  assert.equal(fakeElement.dataset.timestamp, '1763900500000');
});

test('updateUnreadBadge hides bar and both badges when auto-scroll is enabled or no unread messages', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  app.isAutoScrollEnabled = true;
  app.chatContainerEl = { scrollTop: 0, clientHeight: 500 };
  app.chatMessagesEl = { children: [{ offsetTop: 100, dataset: { timestamp: '1763900000000' } }] };
  app.unreadFloatingBarEl = { classList: createClassList() };
  app.unreadBadgeEl = { classList: createClassList() };
  app.unreadLagBadgeEl = { classList: createClassList() };

  app.updateUnreadBadge();

  assert.ok(app.unreadFloatingBarEl.classList.contains('hidden'));
  assert.ok(app.unreadBadgeEl.classList.contains('hidden'));
  assert.ok(app.unreadLagBadgeEl.classList.contains('hidden'));

  app.isAutoScrollEnabled = false;
  app.unreadFloatingBarEl.classList.remove('hidden');
  app.unreadBadgeEl.classList.remove('hidden');
  app.unreadLagBadgeEl.classList.remove('hidden');

  app.updateUnreadBadge();

  assert.ok(app.unreadFloatingBarEl.classList.contains('hidden'));
  assert.ok(app.unreadBadgeEl.classList.contains('hidden'));
  assert.ok(app.unreadLagBadgeEl.classList.contains('hidden'));
});

test('updateUnreadBadge calculates unread count and lag time from bottom-most visible message and updates on new message', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  let badgeText = '';
  let lagText = '';
  const baseTs = 1763900000000;

  app.isAutoScrollEnabled = false;
  app.chatContainerEl = { scrollTop: 100, clientHeight: 400 }; // Viewport bottom = 500
  app.chatMessagesEl = {
    children: [
      { offsetTop: 50, dataset: { timestamp: String(baseTs) } },
      { offsetTop: 200, dataset: { timestamp: String(baseTs + 2 * 60000) } }, // last visible message
      { offsetTop: 495, dataset: { timestamp: String(baseTs + 5 * 60000) } }, // unread 1
      { offsetTop: 550, dataset: { timestamp: String(baseTs + 10 * 60000) } }, // unread 2
      { offsetTop: 600, dataset: { timestamp: String(baseTs + 15 * 60000) } }  // unread 3 (15 - 2 = 13m)
    ]
  };
  app.unreadFloatingBarEl = { classList: createClassList(['hidden']) };
  app.unreadBadgeEl = { classList: createClassList(['hidden']) };
  app.unreadBadgeTextEl = { set textContent(val) { badgeText = val; } };
  app.unreadLagBadgeEl = { classList: createClassList(['hidden']) };
  app.unreadLagTextEl = { set textContent(val) { lagText = val; } };

  app.updateUnreadBadge();

  assert.equal(app.unreadFloatingBarEl.classList.contains('hidden'), false);
  assert.equal(app.unreadBadgeEl.classList.contains('hidden'), false);
  assert.equal(app.unreadLagBadgeEl.classList.contains('hidden'), false);
  assert.equal(badgeText, '↓ 3 новых');
  assert.equal(lagText, '13м');

  // Append a newer message while scrolled up (75 - 2 = 73m -> 1ч 13м)
  app.chatMessagesEl.children.push({
    offsetTop: 650,
    dataset: { timestamp: String(baseTs + 75 * 60000) }
  });
  app.updateUnreadBadge();

  assert.equal(badgeText, '↓ 4 новых');
  assert.equal(lagText, '1ч 13м');
});

test('updateUnreadBadge handles missing timestamps and negative clock skew gracefully', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  let badgeText = '';
  let lagText = '';
  const baseTs = 1763900000000;

  app.isAutoScrollEnabled = false;
  app.chatContainerEl = { scrollTop: 100, clientHeight: 400 };
  app.chatMessagesEl = {
    children: [
      { offsetTop: 50, dataset: {} }, // static intro line without timestamp
      { offsetTop: 495, dataset: { timestamp: String(baseTs + 10 * 60000) } },
      { offsetTop: 550, dataset: { timestamp: String(baseTs + 5 * 60000) } } // out-of-order older ts
    ]
  };
  app.unreadFloatingBarEl = { classList: createClassList(['hidden']) };
  app.unreadBadgeEl = { classList: createClassList(['hidden']) };
  app.unreadBadgeTextEl = { set textContent(val) { badgeText = val; } };
  app.unreadLagBadgeEl = { classList: createClassList(['hidden']) };
  app.unreadLagTextEl = { set textContent(val) { lagText = val; } };

  app.updateUnreadBadge();

  assert.equal(badgeText, '↓ 2 новых');
  assert.equal(lagText, '1м');
  assert.equal(app.unreadLagBadgeEl.classList.contains('hidden'), false);

  // If no messages have timestamps at all, hide only lag pill while keeping count pill visible
  app.chatMessagesEl.children = [
    { offsetTop: 50, dataset: {} },
    { offsetTop: 500, dataset: {} }
  ];
  app.updateUnreadBadge();

  assert.equal(badgeText, '↓ 1 новое');
  assert.equal(app.unreadBadgeEl.classList.contains('hidden'), false);
  assert.equal(app.unreadLagBadgeEl.classList.contains('hidden'), true);
});

test('index.html and style.css define the dual-pill floating unread bar markup and layout', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(projectRoot, 'css', 'style.css'), 'utf8');

  assert.match(html, /<div id="unreadFloatingBar" class="unread-floating-bar hidden">/);
  assert.match(html, /<button id="unreadBadge" class="unread-badge hidden"/);
  assert.match(html, /<span id="unreadBadgeText">↓ 0 новых<\/span>/);
  assert.match(html, /<button id="unreadLagBadge" class="unread-badge unread-lag-badge hidden"/);
  assert.match(html, /<span id="unreadLagText">1м<\/span>/);

  assert.match(css, /\.unread-floating-bar\s*\{[^}]*display:\s*inline-flex/);
  assert.match(css, /\.unread-floating-bar\.hidden\s+\.unread-badge\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.unread-badge\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.unread-lag-badge\s*\{/);
});
