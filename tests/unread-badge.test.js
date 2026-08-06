const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadMultiChatApp() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: { readyState: 'loading', getElementById() { return null; } },
    window: { addEventListener() {} }
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/app.js'), 'utf8');
  vm.runInContext(`${source}\nthis.MultiChatApp = MultiChatApp;`, sandbox);
  return sandbox.MultiChatApp;
}

test('formatUnreadCountText correctly pluralizes Russian words', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  assert.equal(app.formatUnreadCountText(1), '↓ 1 новое сообщение');
  assert.equal(app.formatUnreadCountText(2), '↓ 2 новых сообщения');
  assert.equal(app.formatUnreadCountText(4), '↓ 4 новых сообщения');
  assert.equal(app.formatUnreadCountText(5), '↓ 5 новых сообщений');
  assert.equal(app.formatUnreadCountText(11), '↓ 11 новых сообщений');
  assert.equal(app.formatUnreadCountText(21), '↓ 21 новое сообщение');
  assert.equal(app.formatUnreadCountText(22), '↓ 22 новых сообщения');
  assert.equal(app.formatUnreadCountText(25), '↓ 25 новых сообщений');
});

test('updateUnreadBadge hides badge when auto-scroll is enabled', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);
  
  const classList = new Set();
  app.isAutoScrollEnabled = true;
  app.chatContainerEl = { scrollTop: 0, clientHeight: 500 };
  app.chatMessagesEl = { children: [] };
  app.unreadBadgeEl = { classList: { add: (c) => classList.add(c), remove: (c) => classList.delete(c) } };

  app.updateUnreadBadge();

  assert.ok(classList.has('hidden'));
});

test('updateUnreadBadge calculates correct unread messages count below viewport', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  const classList = new Set(['hidden']);
  let badgeText = '';

  app.isAutoScrollEnabled = false;
  app.chatContainerEl = { scrollTop: 100, clientHeight: 400 }; // Viewport bottom = 500
  app.chatMessagesEl = {
    children: [
      { offsetTop: 50 },  // above (50 < 500)
      { offsetTop: 200 }, // above (200 < 500)
      { offsetTop: 495 }, // below (495 + 5 >= 500) -> unread 1
      { offsetTop: 550 }, // below -> unread 2
      { offsetTop: 600 }  // below -> unread 3
    ]
  };
  app.unreadBadgeEl = {
    classList: {
      add: (c) => classList.add(c),
      remove: (c) => classList.delete(c)
    }
  };
  app.unreadBadgeTextEl = {
    set textContent(val) { badgeText = val; }
  };

  app.updateUnreadBadge();

  assert.equal(classList.has('hidden'), false);
  assert.equal(badgeText, '↓ 3 новых сообщения');
});

test('index.html contains #unreadBadge button element within #chatContainer', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /<button id="unreadBadge" class="unread-badge hidden"/);
  assert.match(html, /<span id="unreadBadgeText">/);
});
