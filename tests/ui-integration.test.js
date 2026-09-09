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
  const css = fs.readFileSync(path.join(projectRoot, 'css', 'style.css'), 'utf8');

  assert.match(
    css,
    /\.chat-messages\.hide-twitch-badges\s+\.msg-platform\.twitch\s*\+\s*\.msg-badges/
  );
  assert.doesNotMatch(css, /twitch-badges-hidden/);
});

test('renderMessageNode renders collapsed-reply with === placeholder when shouldCollapse is true', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);
  const appendedElements = [];
  app.chatMessagesEl = {
    appendChild: (el) => appendedElements.push(el)
  };
  app.settings = { settings: { maxChatMessages: 200 } };
  app.pruneExcessMessages = () => {};
  app.escapeHTML = (s) => String(s || '');
  app.normalizeColor = (c) => c;
  app.renderAuthorHTML = (msg, escaped) => `<span class="msg-author">${escaped}</span>`;
  app.emotes = { getBadgesHTML: () => '' };

  const fakeElement = {
    className: '',
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      contains(c) { return this.classes.has(c); }
    },
    dataset: {},
    innerHTML: ''
  };

  const sandboxDocument = {
    readyState: 'loading',
    getElementById: () => null,
    createElement: () => fakeElement
  };

  const MultiChatAppWithDoc = loadMultiChatApp({ document: sandboxDocument });
  const app2 = Object.create(MultiChatAppWithDoc.prototype);
  app2.chatMessagesEl = app.chatMessagesEl;
  app2.settings = app.settings;
  app2.pruneExcessMessages = app.pruneExcessMessages;
  app2.escapeHTML = app.escapeHTML;
  app2.normalizeColor = app.normalizeColor;
  app2.renderAuthorHTML = app.renderAuthorHTML;
  app2.emotes = app.emotes;

  app2.renderMessageNode({ author: 'fra3a', text: '@viewer1 привет', platform: 'twitch' }, '@viewer1 привет', true);

  assert.ok(fakeElement.classList.contains('collapsed-reply'));
  assert.match(fakeElement.innerHTML, /===/);
  assert.match(fakeElement.innerHTML, /collapsed-placeholder/);
  assert.match(fakeElement.innerHTML, /collapsed-content/);
});

test('renderMessageNode strips leading @ from author display', () => {
  const fakeElement = {
    className: '',
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      contains(c) { return this.classes.has(c); }
    },
    dataset: {},
    innerHTML: ''
  };

  const sandboxDocument = {
    readyState: 'loading',
    getElementById: () => null,
    createElement: () => fakeElement
  };

  const MultiChatAppWithDoc = loadMultiChatApp({ document: sandboxDocument });
  const app = Object.create(MultiChatAppWithDoc.prototype);
  app.chatMessagesEl = { appendChild() {} };
  app.settings = { settings: { maxChatMessages: 200 } };
  app.pruneExcessMessages = () => {};
  app.escapeHTML = (s) => String(s || '');
  app.normalizeColor = (c) => c;
  app.renderAuthorHTML = MultiChatAppWithDoc.prototype.renderAuthorHTML;
  app.emotes = { getBadgesHTML: () => '' };

  app.renderMessageNode({ author: '@yt_viewer', text: 'привет', platform: 'youtube' }, 'привет', false);

  assert.match(fakeElement.innerHTML, /<span class="msg-author">yt_viewer<\/span>/);
  assert.doesNotMatch(fakeElement.innerHTML, /@yt_viewer/);
});

test('index.html contains #blockedKeywords input in settings modal', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /<input[^>]+id="blockedKeywords"/);
});

test('SettingsManager: getBlockedKeywords parses comma-separated keywords into lowercased trimmed array', () => {
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    console: { log() {}, warn() {}, error() {} },
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/settings.js'), 'utf8');
  vm.runInContext(`${source}\nthis.SettingsManager = SettingsManager;`, sandbox);

  const manager = new sandbox.SettingsManager();
  manager.settings.blockedKeywords = ' Реклама , Купить Фолловеров,   спам , , ';
  const keywords = manager.getBlockedKeywords();

  assert.deepEqual(Array.from(keywords), ['реклама', 'купить фолловеров', 'спам']);
});

test('index.html contains #favoriteUsers input in settings modal', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /<input[^>]+id="favoriteUsers"/);
});

test('SettingsManager: getFavoriteUsers parses comma-separated usernames, stripping leading @ and trimming', () => {
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    console: { log() {}, warn() {}, error() {} },
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/settings.js'), 'utf8');
  vm.runInContext(`${source}\nthis.SettingsManager = SettingsManager;`, sandbox);

  const manager = new sandbox.SettingsManager();
  manager.settings.favoriteUsers = ' @BestFriend, Cool_Viewer , @vip_mod, BestFriend,  ';
  const favorites = manager.getFavoriteUsers();

  assert.deepEqual(Array.from(favorites), ['bestfriend', 'cool_viewer', 'vip_mod']);
});

test('isAuthorFavorite correctly matches author or login case-insensitively', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  const favorites = ['bestfriend', 'cool_mod'];

  assert.equal(app.isAuthorFavorite({ author: 'BestFriend' }, favorites), true);
  assert.equal(app.isAuthorFavorite({ author: '@bestfriend' }, favorites), true);
  assert.equal(app.isAuthorFavorite({ author: 'SomeOther', login: 'cool_mod' }, favorites), true);
  assert.equal(app.isAuthorFavorite({ author: 'RandomUser' }, favorites), false);
  assert.equal(app.isAuthorFavorite(null, favorites), false);
  assert.equal(app.isAuthorFavorite({ author: 'BestFriend' }, []), false);
});

test('renderMessageNode renders chat-line-favorite and badge-favorite when isFavorite is true', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);
  const appendedElements = [];
  app.chatMessagesEl = {
    appendChild: (el) => appendedElements.push(el)
  };
  app.settings = { settings: { maxChatMessages: 200 } };
  app.pruneExcessMessages = () => {};
  app.escapeHTML = (s) => String(s || '');
  app.normalizeColor = (c) => c;
  app.renderAuthorHTML = (msg, escaped) => `<span class="msg-author">${escaped}</span>`;
  app.emotes = { getBadgesHTML: () => '' };

  const fakeElement = {
    className: '',
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      contains(c) { return this.classes.has(c); }
    },
    dataset: {},
    innerHTML: ''
  };

  const sandboxDocument = {
    readyState: 'loading',
    getElementById: () => null,
    createElement: () => fakeElement
  };

  const MultiChatAppWithDoc = loadMultiChatApp({ document: sandboxDocument });
  const app2 = Object.create(MultiChatAppWithDoc.prototype);
  app2.chatMessagesEl = app.chatMessagesEl;
  app2.settings = app.settings;
  app2.pruneExcessMessages = app.pruneExcessMessages;
  app2.escapeHTML = app.escapeHTML;
  app2.normalizeColor = app.normalizeColor;
  app2.renderAuthorHTML = app.renderAuthorHTML;
  app2.emotes = app.emotes;

  app2.renderMessageNode(
    { author: 'BestFriend', text: 'Всем отличного стрима!', platform: 'twitch' },
    'Всем отличного стрима!',
    false,
    {},
    false,
    false,
    true
  );

  assert.ok(fakeElement.classList.contains('chat-line-favorite'));
  assert.match(fakeElement.innerHTML, /class="badge-favorite"/);
  assert.match(fakeElement.innerHTML, /⭐ Избранный/);
});

test('renderMessageNode renders chat-line-raid-leader and badge-raid-leader when isRaidLeader is true', () => {
  const fakeElement = {
    className: '',
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      contains(c) { return this.classes.has(c); }
    },
    dataset: {},
    innerHTML: ''
  };

  const sandboxDocument = {
    readyState: 'loading',
    getElementById: () => null,
    createElement: () => fakeElement
  };

  const MultiChatAppWithDoc = loadMultiChatApp({ document: sandboxDocument });
  const app = Object.create(MultiChatAppWithDoc.prototype);
  app.chatMessagesEl = { appendChild() {} };
  app.settings = { settings: { maxChatMessages: 200 } };
  app.pruneExcessMessages = () => {};
  app.escapeHTML = (s) => String(s || '');
  app.normalizeColor = (c) => c;
  app.renderAuthorHTML = (msg, escaped) => `<span class="msg-author">${escaped}</span>`;
  app.emotes = { getBadgesHTML: () => '' };

  app.renderMessageNode(
    { author: 'RaidBoss', login: 'raidboss', text: 'Рейд пришел!', platform: 'twitch' },
    'Рейд пришел!',
    false,
    {},
    false,
    false,
    false,
    true // isRaidLeader
  );

  assert.ok(fakeElement.classList.contains('chat-line-raid-leader'));
  assert.match(fakeElement.innerHTML, /class="badge-raid-leader"/);
  assert.match(fakeElement.innerHTML, /title="Лидер рейда"/);
  assert.doesNotMatch(fakeElement.innerHTML, /активно/);
  assert.match(fakeElement.innerHTML, /⚔️ Лидер рейда/);
});

test('index.html includes js/raidTracker.js in jsFiles loader before app.js', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /'js\/raidTracker\.js'/);
});

test('index.html contains #raidLeaderDurationMinutes input with default value 10 in settings modal', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /<input[^>]+id="raidLeaderDurationMinutes"[^>]+value="10"/);
});

test('SettingsManager: default raidLeaderDurationMinutes is 10 and parses correctly', () => {
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    console: { log() {}, warn() {}, error() {} },
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/settings.js'), 'utf8');
  vm.runInContext(`${source}\nthis.SettingsManager = SettingsManager;`, sandbox);

  const manager = new sandbox.SettingsManager();
  assert.equal(manager.settings.raidLeaderDurationMinutes, 10);
});

test('style.css defines .chat-line-raid-leader and .badge-raid-leader', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'css/style.css'), 'utf8');
  assert.match(css, /\.chat-line-raid-leader/);
  assert.match(css, /\.badge-raid-leader/);
});

test('MultiChatApp: handleRaidEvent and handleIncomingMessage passes isRaidLeader to renderMessageNode', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);
  let passedRaidLeaderStatus = null;

  app.settings = {
    getStreamerNicknames: () => [],
    getFavoriteUsers: () => [],
    getBlockedKeywords: () => [],
    getIgnoredUsers: () => [],
    settings: {}
  };
  app.filter = {
    shouldCollapseReply: () => false,
    isMentioningStreamer: () => false
  };
  app.emotes = {
    parseEmotes: (text) => text
  };
  app.raidTracker = {
    isRaidLeader: (msg) => msg && msg.login === 'epic_raider'
  };
  app.renderMessageNode = (_msg, _parsedText, _shouldCollapse, _firstStatus, _isMention, _isReward, _isFavorite, isRaidLeader) => {
    passedRaidLeaderStatus = isRaidLeader;
  };

  app.handleIncomingMessage({
    platform: 'twitch',
    login: 'epic_raider',
    author: 'Epic_Raider',
    text: 'Привет от рейда!'
  });

  assert.equal(passedRaidLeaderStatus, true);
});


test('index.html contains #ignoredUsers input in settings modal', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /<input[^>]+id="ignoredUsers"/);
});

test('SettingsManager: default ignoredUsers contains popular streaming bots', () => {
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    console: { log() {}, warn() {}, error() {} },
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/settings.js'), 'utf8');
  vm.runInContext(`${source}\nthis.SettingsManager = SettingsManager;`, sandbox);

  const manager = new sandbox.SettingsManager();
  const defaultBots = manager.getIgnoredUsers();

  assert.ok(defaultBots.includes('nightbot'));
  assert.ok(defaultBots.includes('streamelements'));
  assert.ok(defaultBots.includes('moobot'));
  assert.ok(defaultBots.includes('fossabot'));
});

test('SettingsManager: getIgnoredUsers parses comma-separated usernames, stripping leading @ and trimming', () => {
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    console: { log() {}, warn() {}, error() {} },
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/settings.js'), 'utf8');
  vm.runInContext(`${source}\nthis.SettingsManager = SettingsManager;`, sandbox);

  const manager = new sandbox.SettingsManager();
  manager.settings.ignoredUsers = ' @Nightbot, StreamElements , @Spam_Bot, Nightbot,  ';
  const ignored = manager.getIgnoredUsers();

  assert.deepEqual(Array.from(ignored), ['nightbot', 'streamelements', 'spam_bot']);
});

test('MultiChatApp: handleIncomingMessage passes ignoredUsers to shouldCollapseReply', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);

  let capturedArgs = null;
  app.settings = {
    getStreamerNicknames: () => ['streamer'],
    getFavoriteUsers: () => [],
    getBlockedKeywords: () => ['stopword'],
    getIgnoredUsers: () => ['bot_nick'],
    settings: { hideChatterReplies: true, firstMessageWindowHours: 12 }
  };
  app.filter = {
    shouldCollapseReply: (...args) => {
      capturedArgs = args;
      return true;
    },
    isMentioningStreamer: () => false
  };
  app.isAuthorFavorite = () => false;
  app.emotes = { parseEmotes: (t) => t };
  app.renderMessageNode = () => {};

  const msg = { author: 'bot_nick', text: 'Spam text' };
  app.handleIncomingMessage(msg);

  assert.ok(capturedArgs);
  assert.equal(capturedArgs[0], msg);
  assert.deepEqual(capturedArgs[1], ['streamer']);
  assert.equal(capturedArgs[2], true);
  assert.deepEqual(capturedArgs[3], ['stopword']);
  assert.deepEqual(capturedArgs[4], ['bot_nick']);
});

test('index.html wraps platform channel inputs in .channel-row containers', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /<div class="channel-row">\s*<label for="twitchChannel">/);
  assert.match(html, /<div class="channel-row">\s*<label for="kickChannel">/);
  assert.match(html, /<div class="channel-row">\s*<label for="vkChannel">/);
  assert.match(html, /<div class="channel-row">\s*<label for="youtubeChannel">/);
});

test('style.css defines .channel-row flex layout and custom scrollbar for .modal-body', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'css', 'style.css'), 'utf8');
  assert.match(css, /\.channel-row\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.channel-row\s*\{[^}]*align-items:\s*center/);
  assert.match(css, /\.modal-body\s*\{[^}]*scrollbar-width:\s*thin/);
  assert.match(css, /\.modal-body::-webkit-scrollbar\s*\{[^}]*width:\s*6px/);
  assert.match(css, /\.modal-body::-webkit-scrollbar-thumb\s*\{/);
});

test('SettingsManager: defaults include highlightStreamers = true and streamerMinViewers = 20', () => {
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    console: { log() {}, warn() {}, error() {} },
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/settings.js'), 'utf8');
  vm.runInContext(`${source}\nthis.SettingsManager = SettingsManager;`, sandbox);

  const manager = new sandbox.SettingsManager();
  assert.equal(manager.settings.highlightStreamers, true);
  assert.equal(manager.settings.streamerMinViewers, 20);
});

test('SettingsManager: populateForm and readForm handle highlightStreamers and streamerMinViewers', () => {
  const elements = {
    twitchChannel: { value: 'mychan' },
    kickChannel: { value: '' },
    vkChannel: { value: '' },
    youtubeChannel: { value: '' },
    extraNicknames: { value: '' },
    favoriteUsers: { value: '' },
    blockedKeywords: { value: '' },
    ignoredUsers: { value: '' },
    hideChatterReplies: { checked: true },
    enableThirdPartyEmotes: { checked: true },
    hideTwitchBadges: { checked: false },
    highlightStreamers: { checked: true },
    streamerMinViewers: { value: '50' },
    fontSizeRange: { value: '16' },
    fontSizeVal: { textContent: '16px' },
    firstMessageWindowHours: { value: '12' },
    raidLeaderDurationMinutes: { value: '10' },
    maxChatMessages: { value: '200' }
  };

  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    document: {
      getElementById: (id) => elements[id] || null
    },
    console: { log() {}, warn() {}, error() {} },
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/settings.js'), 'utf8');
  vm.runInContext(`${source}\nthis.SettingsManager = SettingsManager;`, sandbox);

  const manager = new sandbox.SettingsManager();
  manager.settings.highlightStreamers = false;
  manager.settings.streamerMinViewers = 35;
  manager.populateForm();

  assert.equal(elements.highlightStreamers.checked, false);
  assert.equal(elements.streamerMinViewers.value, 35);

  elements.highlightStreamers.checked = true;
  elements.streamerMinViewers.value = '100';
  const updated = manager.readForm();

  assert.equal(updated.highlightStreamers, true);
  assert.equal(updated.streamerMinViewers, 100);
});

test('index.html contains #highlightStreamers and #streamerMinViewers inputs in settings modal', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /<input[^>]+id="highlightStreamers"/);
  assert.match(html, /<input[^>]+id="streamerMinViewers"/);
});

test('index.html includes js/streamerTracker.js in jsFiles loader before app.js', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const jsLoader = html.indexOf('const jsFiles');
  const trackerIndex = html.indexOf("'js/streamerTracker.js'");
  const appIndex = html.indexOf("'js/app.js'");

  assert.ok(trackerIndex > jsLoader, 'streamerTracker.js should be in jsFiles');
  assert.ok(trackerIndex < appIndex, 'streamerTracker.js must be loaded before app.js');
});

test('style.css defines .chat-line-streamer and .badge-streamer', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'css/style.css'), 'utf8');
  assert.match(css, /\.chat-line-streamer/);
  assert.match(css, /\.badge-streamer/);
});

test('MultiChatApp: handleIncomingMessage identifies cached streamer and passes isStreamer to renderMessageNode', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);
  let capturedArgs = null;

  app.settings = {
    getStreamerNicknames: () => [],
    getFavoriteUsers: () => [],
    getBlockedKeywords: () => [],
    getIgnoredUsers: () => [],
    settings: { highlightStreamers: true, streamerMinViewers: 50 }
  };
  app.filter = {
    shouldCollapseReply: () => false,
    isMentioningStreamer: () => false
  };
  app.emotes = { parseEmotes: (t) => t };
  app.streamerTracker = {
    getStreamerStats: (login) => login === 'popular_streamer' ? { avgViewers: 120, isStreamer: true } : null,
    queueCheck: () => {}
  };
  app.renderMessageNode = (...args) => {
    capturedArgs = args;
  };

  app.handleIncomingMessage({
    platform: 'twitch',
    login: 'popular_streamer',
    author: 'Popular_Streamer',
    text: 'Привет чат!'
  });

  assert.ok(capturedArgs);
  // isStreamer is passed as arg 8, streamerAvgViewers as arg 9
  assert.equal(capturedArgs[8], true);
  assert.equal(capturedArgs[9], 120);
});

test('MultiChatApp: renderMessageNode renders chat-line-streamer and badge-streamer when isStreamer is true', () => {
  const fakeElement = {
    className: '',
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      contains(c) { return this.classes.has(c); }
    },
    dataset: {},
    innerHTML: ''
  };

  const sandboxDocument = {
    readyState: 'loading',
    getElementById: () => null,
    createElement: () => fakeElement
  };

  const MultiChatAppWithDoc = loadMultiChatApp({ document: sandboxDocument });
  const app = Object.create(MultiChatAppWithDoc.prototype);
  app.chatMessagesEl = { appendChild() {} };
  app.settings = { settings: { maxChatMessages: 200 } };
  app.pruneExcessMessages = () => {};
  app.escapeHTML = (s) => String(s || '');
  app.normalizeColor = (c) => c;
  app.renderAuthorHTML = (msg, escapedAuthor, style) => `<span class="msg-author twitch-author" data-twitch-username="${msg.login}">${escapedAuthor}</span>`;
  app.emotes = {
    getBadgesHTML: () => ''
  };

  const msg = {
    platform: 'twitch',
    author: 'FamousStreamer',
    login: 'famousstreamer',
    text: 'Привет!'
  };

  const node = app.renderMessageNode(
    msg,
    'Привет!',
    false, // shouldCollapse
    {}, // firstStatus
    false, // isMention
    false, // isReward
    false, // isFavorite
    false, // isRaidLeader
    true, // isStreamer
    150 // streamerAvgViewers
  );

  assert.ok(node.classList.contains('chat-line-streamer'));
  assert.match(node.innerHTML, /class="badge-streamer"/);
  assert.match(node.innerHTML, /150/);
});

test('MultiChatApp: handleStreamerDetected dynamically updates matching DOM nodes with streamer badge and class', () => {
  const sandboxDocument = {
    readyState: 'loading',
    getElementById: () => null,
    createElement: (tag) => ({
      tagName: tag,
      className: '',
      title: '',
      textContent: ''
    })
  };

  const MultiChatApp = loadMultiChatApp({ document: sandboxDocument });
  const app = Object.create(MultiChatApp.prototype);
  app.normalizeTwitchLogin = (login) => String(login || '').trim().toLowerCase().replace(/^[@#]+/, '');
  app.settings = {
    settings: { highlightStreamers: true, streamerMinViewers: 20 }
  };

  // Mock DOM structure
  const lineEl = {
    classList: {
      classes: new Set(['chat-line']),
      add(c) { this.classes.add(c); },
      contains(c) { return this.classes.has(c); }
    },
    querySelector: (selector) => null
  };

  const authorEl = {
    closest: (sel) => sel === '.chat-line' ? lineEl : null,
    parentNode: {
      insertBefore: (newEl, refEl) => {
        lineEl.insertedBadge = newEl;
      }
    }
  };

  app.chatMessagesEl = {
    querySelectorAll: (sel) => {
      if (sel.includes('superstar')) return [authorEl];
      return [];
    }
  };

  app.handleStreamerDetected('SuperStar', 75);

  assert.ok(lineEl.classList.contains('chat-line-streamer'));
  assert.ok(lineEl.insertedBadge);
  assert.equal(lineEl.insertedBadge.className, 'badge-streamer');
  assert.match(lineEl.insertedBadge.textContent, /75/);
});

test('Twitch connector parsePrivMsg extracts userId tag', () => {
  const TwitchConnector = require('../js/connectors/twitch');
  let capturedMsg = null;
  const connector = new TwitchConnector((msg) => { capturedMsg = msg; });

  const rawLine = '@badge-info=;badges=broadcaster/1;color=#00FF7F;display-name=Streamer;emotes=;user-id=998877 :streamer!streamer@streamer.tmi.twitch.tv PRIVMSG #streamer :Hello 7TV!';
  connector.parsePrivMsg(rawLine);

  assert.ok(capturedMsg);
  assert.equal(capturedMsg.userId, '998877');
  assert.equal(capturedMsg.author, 'Streamer');
  assert.equal(capturedMsg.text, 'Hello 7TV!');
});

test('SettingsManager: defaults include enableSevenTvColors = true and handles form reading', () => {
  const elements = {
    twitchChannel: { value: '' },
    kickChannel: { value: '' },
    vkChannel: { value: '' },
    youtubeChannel: { value: '' },
    extraNicknames: { value: '' },
    blockedKeywords: { value: '' },
    ignoredUsers: { value: '' },
    favoriteUsers: { value: '' },
    hideChatterReplies: { checked: true },
    enableThirdPartyEmotes: { checked: true },
    hideTwitchBadges: { checked: false },
    enableSevenTvColors: { checked: true },
    highlightStreamers: { checked: true },
    streamerMinViewers: { value: '20' },
    fontSizeRange: { value: '16' },
    fontSizeVal: { textContent: '16px' },
    firstMessageWindowHours: { value: '12' },
    raidLeaderDurationMinutes: { value: '10' },
    maxChatMessages: { value: '200' }
  };

  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    document: {
      getElementById: (id) => elements[id] || null
    },
    console: { log() {}, warn() {}, error() {} },
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/settings.js'), 'utf8');
  vm.runInContext(`${source}\nthis.SettingsManager = SettingsManager;`, sandbox);

  const manager = new sandbox.SettingsManager();
  assert.equal(manager.settings.enableSevenTvColors, true);

  manager.settings.enableSevenTvColors = false;
  manager.populateForm();
  assert.equal(elements.enableSevenTvColors.checked, false);

  elements.enableSevenTvColors.checked = true;
  const updated = manager.readForm();
  assert.equal(updated.enableSevenTvColors, true);
});

test('index.html contains #enableSevenTvColors input in settings modal', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /id="enableSevenTvColors"/);
});

test('index.html includes js/sevenTvTracker.js in jsFiles loader before app.js', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const sevenTvIdx = html.indexOf("'js/sevenTvTracker.js'");
  const appIdx = html.indexOf("'js/app.js'");

  assert.ok(sevenTvIdx > 0, 'index.html should include js/sevenTvTracker.js');
  assert.ok(appIdx > sevenTvIdx, 'sevenTvTracker.js must be loaded before app.js');
});

test('style.css defines transition for .msg-author.twitch-author and .msg-author.seventv-painted', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'css/style.css'), 'utf8');
  assert.match(css, /\.msg-author\.twitch-author\s*\{\s*transition:\s*color\s+0\.2s\s+ease,\s*text-shadow\s+0\.2s\s+ease,\s*filter\s+0\.2s\s+ease;/);
  assert.match(css, /\.msg-author\.seventv-painted\s*\{/);
  assert.match(css, /-webkit-background-clip:\s*text/);
  assert.match(css, /-webkit-text-fill-color:\s*transparent/);
});

test('MultiChatApp: renderAuthorHTML includes data-twitch-user-id when userId is present', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);
  app.normalizeTwitchLogin = (l) => l;
  app.escapeHTML = (s) => String(s || '');

  const htmlWithId = app.renderAuthorHTML(
    { platform: 'twitch', login: 'viewer_bob', author: 'Bob', userId: '887766' },
    'Bob'
  );
  assert.match(htmlWithId, /data-twitch-user-id="887766"/);
  assert.match(htmlWithId, /data-twitch-username="viewer_bob"/);

  const htmlWithoutId = app.renderAuthorHTML(
    { platform: 'twitch', login: 'viewer_bob', author: 'Bob' },
    'Bob'
  );
  assert.doesNotMatch(htmlWithoutId, /data-twitch-user-id/);
});

test('MultiChatApp: renderMessageNode applies cached 7TV style and queues lookup if not cached', () => {
  const fakeElement = {
    className: '',
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      contains(c) { return this.classes.has(c); }
    },
    dataset: {},
    innerHTML: ''
  };

  const sandboxDocument = {
    readyState: 'loading',
    getElementById: () => null,
    createElement: () => fakeElement
  };

  const MultiChatAppWithDoc = loadMultiChatApp({ document: sandboxDocument });
  const app = Object.create(MultiChatAppWithDoc.prototype);
  app.chatMessagesEl = { appendChild() {} };
  app.settings = { settings: { maxChatMessages: 200, enableSevenTvColors: true } };
  app.pruneExcessMessages = () => {};
  app.escapeHTML = (s) => String(s || '');
  app.normalizeColor = (c) => c;
  app.normalizeTwitchLogin = (l) => l;
  app.renderAuthorHTML = (msg, escapedAuthor, style, isPainted) => {
    const paintedClass = isPainted ? ' seventv-painted' : '';
    return `<span class="msg-author twitch-author${paintedClass}" data-twitch-user-id="${msg.userId}" ${style}>${escapedAuthor}</span>`;
  };
  app.emotes = { getBadgesHTML: () => '' };

  const queued = [];
  app.sevenTvTracker = {
    getStyle: (userId) => {
      if (userId === '111') {
        return {
          color: 'rgba(255, 170, 0, 1)',
          shadow: '0px 0px 4px rgba(255, 170, 0, 1)',
          paint: {
            backgroundImage: 'repeating-radial-gradient(ellipse, #1f59e0 0%, #00fbff 21%)',
            filter: 'drop-shadow(0px 0px 4px rgba(0, 98, 255, 1))'
          }
        };
      }
      return null;
    },
    queueCheck: (userId) => queued.push(userId)
  };

  // 1. Message with cached 7TV paint style
  const node1 = app.renderMessageNode(
    { platform: 'twitch', author: 'User1', login: 'user1', userId: '111', color: '#fff' },
    'Hello!'
  );
  assert.match(node1.innerHTML, /seventv-painted/);
  assert.match(node1.innerHTML, /background-image: repeating-radial-gradient\(ellipse/);
  assert.match(node1.innerHTML, /filter: drop-shadow\(0px 0px 4px rgba\(0, 98, 255, 1\)\)/);

  // 2. Message without cached 7TV style -> should queue lookup
  const node2 = app.renderMessageNode(
    { platform: 'twitch', author: 'User2', login: 'user2', userId: '222', color: '#fff' },
    'Hello 2!'
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0], '222');
});

test('MultiChatApp: handleSevenTvStyleDetected dynamically updates rendered author elements', () => {
  const MultiChatApp = loadMultiChatApp();
  const app = Object.create(MultiChatApp.prototype);
  app.settings = { settings: { enableSevenTvColors: true } };

  function createMockAuthorEl() {
    return {
      style: { color: '#ffffff', textShadow: '', backgroundImage: '', filter: '' },
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        contains(c) { return this.classes.has(c); }
      }
    };
  }

  const author1 = createMockAuthorEl();
  const author2 = createMockAuthorEl();

  app.chatMessagesEl = {
    querySelectorAll: (sel) => {
      if (sel.includes('777')) return [author1, author2];
      return [];
    }
  };

  // Update with paint
  app.handleSevenTvStyleDetected('777', {
    color: 'rgba(50, 230, 250, 0.988)',
    shadow: '1px 1px 5px rgba(50, 230, 250, 1)',
    paint: {
      backgroundImage: 'repeating-radial-gradient(ellipse, blue 0%, cyan 21%)',
      filter: 'drop-shadow(0px 0px 4px blue)'
    }
  });

  assert.equal(author1.style.color, 'rgba(50, 230, 250, 0.988)');
  assert.equal(author1.style.backgroundImage, 'repeating-radial-gradient(ellipse, blue 0%, cyan 21%)');
  assert.equal(author1.style.filter, 'drop-shadow(0px 0px 4px blue)');
  assert.ok(author1.classList.contains('seventv-painted'));

  assert.equal(author2.style.color, 'rgba(50, 230, 250, 0.988)');
  assert.equal(author2.style.backgroundImage, 'repeating-radial-gradient(ellipse, blue 0%, cyan 21%)');
  assert.ok(author2.classList.contains('seventv-painted'));
});




