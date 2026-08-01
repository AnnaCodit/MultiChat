const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadTwitchConnector() {
  const sandbox = {
    console,
    WebSocket: function WebSocket() {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/connectors/twitch.js'), 'utf8');
  vm.runInContext(`${source}\nthis.TwitchConnector = TwitchConnector;`, sandbox);
  return sandbox.TwitchConnector;
}

function loadTwitchPopup(fetchImpl) {
  const sandbox = {
    AbortController,
    URL,
    clearTimeout,
    console,
    document: {},
    fetch: fetchImpl,
    setTimeout,
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/twitchUserPopup.js'), 'utf8');
  vm.runInContext(source, sandbox);
  return sandbox.window;
}

function createLinkElement() {
  const attributes = new Map();
  const classes = new Set();
  return {
    dataset: {},
    href: '',
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value)
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'href') this.href = '';
    }
  };
}

test('Twitch connector preserves canonical login separately from display name', () => {
  const TwitchConnector = loadTwitchConnector();
  const messages = [];
  const connector = new TwitchConnector(message => messages.push(message), () => {});

  connector.parsePrivMsg(
    '@display-name=ОтображаемоеИмя;badges=;color=#123456 '
      + ':actual_login!actual_login@actual_login.tmi.twitch.tv '
      + 'PRIVMSG #fra3a :Привет'
  );

  assert.equal(messages[0].login, 'actual_login');
  assert.equal(messages[0].author, 'ОтображаемоеИмя');
});

test('popup builds channel and viewer card URLs from canonical login', () => {
  const { TwitchUserPopup } = loadTwitchPopup(async () => ({ ok: true, json: async () => [] }));
  const popup = Object.create(TwitchUserPopup.prototype);
  popup.channelLinkEl = createLinkElement();
  popup.historyLinkEl = createLinkElement();
  popup.getCurrentTwitchChannel = () => '#Fra3A';

  popup.updateLinks('@Actual_Login');

  assert.equal(popup.channelLinkEl.href, 'https://www.twitch.tv/actual_login');
  assert.equal(
    popup.historyLinkEl.href,
    'https://www.twitch.tv/popout/fra3a/viewercard/actual_login?popout='
  );
  assert.equal(popup.historyLinkEl.dataset.popupUrl, popup.historyLinkEl.href);
});

test('temporary IVR failure is evicted from cache and retried', async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    if (requestCount === 1) throw new Error('temporary network failure');
    return {
      ok: true,
      json: async () => [{ login: 'viewer', displayName: 'Viewer', logo: 'https://example.com/avatar.png' }]
    };
  };
  const { TwitchUserPopup } = loadTwitchPopup(fetchImpl);
  const popup = Object.create(TwitchUserPopup.prototype);
  popup.userDataCache = new Map();

  await assert.rejects(popup.getCachedUserData('viewer'), /temporary network failure/);
  assert.equal(popup.userDataCache.has('viewer'), false);

  const userData = await popup.getCachedUserData('viewer');
  const cachedUserData = await popup.getCachedUserData('viewer');
  assert.equal(userData.login, 'viewer');
  assert.equal(cachedUserData.login, 'viewer');
  assert.equal(requestCount, 2);
});

test('IVR request aborts after the configured timeout', async () => {
  const fetchImpl = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const { getTwitchUserData } = loadTwitchPopup(fetchImpl);

  await assert.rejects(
    getTwitchUserData('viewer', { timeoutMs: 5 }),
    error => error && error.name === 'TimeoutError'
  );
});
