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

test('Twitch connector extracts native gifs tag from PRIVMSG', () => {
  const TwitchConnector = loadTwitchConnector();
  const messages = [];
  const connector = new TwitchConnector(message => messages.push(message), () => {});

  const fullGifUrl = 'https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=test1234&rid=giphy.gif&ct=g';
  connector.parsePrivMsg(
    `@display-name=TwitchDev;gifs=0-33|joSNxeswxuc74Juo8X|${fullGifUrl} `
      + ':twitchdev!twitchdev@twitchdev.tmi.twitch.tv '
      + 'PRIVMSG #twitch :[Y A Y Yes GIF by Djemilah Birnie]'
  );

  assert.equal(messages[0].login, 'twitchdev');
  assert.equal(messages[0].gifs, `0-33|joSNxeswxuc74Juo8X|${fullGifUrl}`);
  assert.equal(messages[0].tags.gifs, `0-33|joSNxeswxuc74Juo8X|${fullGifUrl}`);
});

test('Twitch connector parses USERNOTICE raid event and calls onRaid callback', () => {
  const TwitchConnector = loadTwitchConnector();
  const raids = [];
  const connector = new TwitchConnector(() => {}, () => {}, raid => raids.push(raid));

  const rawNotice = '@badge-info=;badges=;color=#8A2BE2;display-name=RaidLeader;emotes=;id=123;login=raidleader;msg-id=raid;msg-param-displayName=RaidLeader;msg-param-login=raidleader;msg-param-viewerCount=42;room-id=456;system-msg=42\\sraiders\\sfrom\\sRaidLeader\\shave\\sjoined! :tmi.twitch.tv USERNOTICE #fra3a';
  connector.handleIrcMessage(rawNotice);

  assert.equal(raids.length, 1);
  assert.equal(raids[0].leaderLogin, 'raidleader');
  assert.equal(raids[0].leaderDisplayName, 'RaidLeader');
  assert.equal(raids[0].viewerCount, 42);
  assert.equal(raids[0].systemMsg, '42 raiders from RaidLeader have joined!');
});

test('Twitch connector dispatches USERNOTICE raid correctly even if tags contain PRIVMSG substring', () => {
  const TwitchConnector = loadTwitchConnector();
  const raids = [];
  const connector = new TwitchConnector(() => {}, () => {}, raid => raids.push(raid));

  const rawNotice = '@display-name=PRIVMSG_King;login=privmsg_king;msg-id=raid;msg-param-displayName=PRIVMSG_King;msg-param-login=privmsg_king;msg-param-viewerCount=10 :tmi.twitch.tv USERNOTICE #fra3a';
  connector.handleIrcMessage(rawNotice);

  assert.equal(raids.length, 1);
  assert.equal(raids[0].leaderLogin, 'privmsg_king');
  assert.equal(raids[0].viewerCount, 10);
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
