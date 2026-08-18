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

test('Twitch badge visibility uses one class on the chat container', () => {
  const MultiChatApp = loadMultiChatApp();
  const calls = [];
  const app = Object.create(MultiChatApp.prototype);
  app.settings = { settings: { hideTwitchBadges: true } };
  app.chatMessagesEl = {
    classList: {
      toggle: (className, enabled) => calls.push({ className, enabled })
    }
  };

  app.applyTwitchBadgesVisibility();

  assert.deepEqual(calls, [{ className: 'hide-twitch-badges', enabled: true }]);
});

test('author markup uses canonical Twitch login without depending on popup renderer', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  const html = app.renderAuthorHTML(
    { platform: 'twitch', login: 'actual_login', author: 'ОтображаемоеИмя' },
    'ОтображаемоеИмя',
    'style="color: #fff"'
  );

  assert.match(html, /class="msg-author twitch-author"/);
  assert.match(html, /data-twitch-username="actual_login"/);
  assert.doesNotMatch(html, /data-twitch-username="ОтображаемоеИмя"/);
});

test('color and HTML normalization safely handle primitive values', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  assert.equal(app.normalizeColor(5), '5');
  assert.equal(app.normalizeColor(0), '0');
  assert.equal(app.escapeHTML(5), '5');
  assert.equal(app.escapeHTML(null), '');
});

test('cache-busted styles are requested in head before body parsing', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const headEnd = html.indexOf('</head>');
  const bodyStart = html.indexOf('<body');
  const cssLoader = html.indexOf('const cssFiles');
  const jsLoader = html.indexOf('const jsFiles');

  assert.ok(cssLoader > 0 && cssLoader < headEnd);
  assert.ok(headEnd < bodyStart);
  assert.ok(jsLoader > bodyStart);
  assert.match(html.slice(cssLoader, headEnd), /style\.css/);
  assert.match(html.slice(cssLoader, headEnd), /twitch-user-popup\.css/);
  assert.match(html.slice(cssLoader, headEnd), /blocking['"],\s*['"]render/);
});

test('Twitch badges are hidden by a parent state class without changing badge markup', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'style.css'), 'utf8');

  assert.match(
    css,
    /\.chat-messages\.hide-twitch-badges\s+\.msg-platform\.twitch\s*\+\s*\.msg-badges/
  );
  assert.doesNotMatch(css, /twitch-badges-hidden/);
});

test('index.html contains #kickViewerCount element within #statusKick badge', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(
    html,
    /<span class="status-badge status-kick offline" id="statusKick" title="Kick">\s*<span class="platform-icon kick-icon"><\/span>\s*KI\s*<span id="kickViewerCount" class="viewer-count"><\/span>\s*<\/span>/
  );
});

test('updateStatus updates Kick badge and viewer count element when online with number count', () => {
  const statusBadge = {
    classList: {
      classes: new Set(['status-badge', 'status-kick', 'offline']),
      remove(c) { this.classes.delete(c); },
      add(c) { this.classes.add(c); },
      contains(c) { return this.classes.has(c); }
    },
    title: ''
  };
  const countEl = {
    textContent: ''
  };
  const elements = {
    statusKick: statusBadge,
    kickViewerCount: countEl
  };

  const MultiChatApp = loadMultiChatApp({
    document: {
      readyState: 'loading',
      getElementById: (id) => elements[id] || null
    }
  });

  const app = Object.create(MultiChatApp.prototype);
  app.updateStatus('kick', true, 'Онлайн (testchannel)', 1420);

  assert.ok(statusBadge.classList.contains('online'));
  assert.ok(!statusBadge.classList.contains('offline'));
  assert.equal(statusBadge.title, 'KICK: Онлайн (testchannel)');
  assert.equal(countEl.textContent, (1420).toLocaleString('ru-RU'));
});

test('updateStatus clears Kick viewer count when offline or viewer count is not a number', () => {
  const statusBadge = {
    classList: {
      classes: new Set(['status-badge', 'status-kick', 'online']),
      remove(c) { this.classes.delete(c); },
      add(c) { this.classes.add(c); },
      contains(c) { return this.classes.has(c); }
    },
    title: ''
  };
  const countEl = {
    textContent: '1 420'
  };
  const elements = {
    statusKick: statusBadge,
    kickViewerCount: countEl
  };

  const MultiChatApp = loadMultiChatApp({
    document: {
      readyState: 'loading',
      getElementById: (id) => elements[id] || null
    }
  });

  const app = Object.create(MultiChatApp.prototype);

  // Online but null count
  app.updateStatus('kick', true, 'Онлайн (testchannel)', null);
  assert.equal(countEl.textContent, '');

  // Offline with count
  countEl.textContent = '1 420';
  app.updateStatus('kick', false, 'Офлайн', 1420);
  assert.ok(statusBadge.classList.contains('offline'));
  assert.ok(!statusBadge.classList.contains('online'));
  assert.equal(countEl.textContent, '');
});

test('style.css defines dark-red badge styling and viewer-count layout for Kick', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'style.css'), 'utf8');
  assert.match(css, /\.status-kick\.online\s*\{[^}]*background-color:\s*rgba\(139,\s*0,\s*0,\s*0\.4\)/);
  assert.match(css, /\.status-kick\.online\s*\{[^}]*border-color:\s*rgba\(220,\s*38,\s*38,\s*0\.4\)/);
  assert.match(css, /\.status-kick\.online\s*\{[^}]*color:\s*#ffcccc/);
  assert.match(css, /\.status-kick\s+\.viewer-count\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.status-kick\s+\.viewer-count\s*\{[^}]*font-weight:\s*700/);
  assert.match(css, /\.status-kick\s+\.viewer-count:empty\s*\{[^}]*display:\s*none/);
});
