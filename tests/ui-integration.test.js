const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadMultiChatApp() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: { readyState: 'loading' },
    window: { addEventListener() {} }
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
