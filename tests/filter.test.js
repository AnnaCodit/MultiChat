const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

function loadMessageFilter() {
  const sandbox = {
    window: {},
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(sandbox);
  const filePath = path.join(__dirname, '..', 'js', 'filter.js');
  const code = fs.readFileSync(filePath, 'utf8');
  vm.runInContext(code, sandbox);
  return sandbox.window.messageFilter || sandbox.MessageFilter;
}

const streamerNicknames = ['fra3a', 'annacodit', 'fra3atv'];

test('MessageFilter: returns false when filter is disabled', () => {
  const filter = loadMessageFilter();
  const msg = {
    author: 'viewer1',
    text: '@viewer2 привет'
  };
  const shouldCollapse = filter.shouldCollapseReply(msg, streamerNicknames, false);
  assert.equal(shouldCollapse, false);
});

test('MessageFilter: general chatter message without mentions is not collapsed', () => {
  const filter = loadMessageFilter();
  const msg = {
    author: 'viewer1',
    text: 'Всем отличного стрима!'
  };
  const shouldCollapse = filter.shouldCollapseReply(msg, streamerNicknames, true);
  assert.equal(shouldCollapse, false);
});

test('MessageFilter: chatter tagging another chatter is collapsed', () => {
  const filter = loadMessageFilter();
  const msg1 = {
    author: 'viewer1',
    text: '@viewer2 привет, как дела?'
  };
  assert.equal(filter.shouldCollapseReply(msg1, streamerNicknames, true), true);

  const msg2 = {
    author: 'viewer1',
    replyTo: 'viewer2',
    text: 'Согласен с тобой'
  };
  assert.equal(filter.shouldCollapseReply(msg2, streamerNicknames, true), true);
});

test('MessageFilter: chatter tagging or replying to streamer is never collapsed', () => {
  const filter = loadMessageFilter();
  const msg1 = {
    author: 'viewer1',
    text: '@fra3a привет стример!'
  };
  assert.equal(filter.shouldCollapseReply(msg1, streamerNicknames, true), false);

  const msg2 = {
    author: 'viewer1',
    text: 'Привет fra3a, во что играем?'
  };
  assert.equal(filter.shouldCollapseReply(msg2, streamerNicknames, true), false);

  const msg3 = {
    author: 'viewer1',
    replyTo: 'fra3a',
    text: 'Отвечаю стримеру'
  };
  assert.equal(filter.shouldCollapseReply(msg3, streamerNicknames, true), false);
});

test('MessageFilter: general streamer message without mentions is not collapsed', () => {
  const filter = loadMessageFilter();
  const msg = {
    author: 'fra3a',
    text: 'Всем привет! Начинаем стрим через 5 минут.'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true), false);
});

test('MessageFilter: streamer tagging another chatter with @username is collapsed', () => {
  const filter = loadMessageFilter();
  const msgLeading = {
    author: 'fra3a',
    text: '@viewer1 спасибо за вопрос!'
  };
  assert.equal(filter.shouldCollapseReply(msgLeading, streamerNicknames, true), true);

  const msgInside = {
    author: 'fra3a',
    text: 'Привет @viewer1, рад тебя видеть!'
  };
  assert.equal(filter.shouldCollapseReply(msgInside, streamerNicknames, true), true);
});

test('MessageFilter: streamer replying to another user via replyTo is collapsed', () => {
  const filter = loadMessageFilter();
  const msg = {
    author: 'fra3a',
    replyTo: 'viewer1',
    text: 'Отличная идея!'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true), true);
});

test('MessageFilter: streamer mentioning their own aliases is not collapsed', () => {
  const filter = loadMessageFilter();
  const msg = {
    author: 'fra3a',
    text: 'Мой второй канал @annacodit, подписывайтесь!'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true), false);
});

test('MessageFilter: broadcaster detected by badge tagging another chatter is collapsed', () => {
  const filter = loadMessageFilter();
  // Twitch broadcaster badge
  const twitchMsg = {
    author: 'DifferentDisplayName',
    badges: 'broadcaster/1,subscriber/12',
    text: 'Привет @viewer1!'
  };
  assert.equal(filter.shouldCollapseReply(twitchMsg, streamerNicknames, true), true);

  // Kick broadcaster badge
  const kickMsg = {
    author: 'CustomKickName',
    badges: [{ type: 'broadcaster' }],
    text: '@viewer1 спасибо!'
  };
  assert.equal(filter.shouldCollapseReply(kickMsg, streamerNicknames, true), true);
});

test('MessageFilter: correctly recognizes Cyrillic usernames with ё/Ё in mentions', () => {
  const filter = loadMessageFilter();
  const msg = {
    author: 'fra3a',
    text: 'Привет, @артём!'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true), true);

  const chatterMsg = {
    author: 'viewer1',
    text: '@Фёдор привет!'
  };
  assert.equal(filter.shouldCollapseReply(chatterMsg, streamerNicknames, true), true);
});

test('MessageFilter: handles whitespace-only replyTo defensively without false collapse', () => {
  const filter = loadMessageFilter();
  const msg = {
    author: 'fra3a',
    replyTo: '   ',
    text: 'Всем привет в чате!'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true), false);
});

test('MessageFilter: recognizes streamer mentions with trailing colon, semicolon, and brackets', () => {
  const filter = loadMessageFilter();
  const msg1 = {
    author: 'viewer1',
    text: 'fra3a: смотри какой момент!'
  };
  assert.equal(filter.shouldCollapseReply(msg1, streamerNicknames, true), false);

  const msg2 = {
    author: 'viewer1',
    text: 'Привет fra3a) как дела?'
  };
  assert.equal(filter.shouldCollapseReply(msg2, streamerNicknames, true), false);
});

test('MessageFilter: collapses message containing single blocked keyword (case-insensitive)', () => {
  const filter = loadMessageFilter();
  const blockedKeywords = ['реклама', 'спам'];
  const msg = {
    author: 'viewer1',
    text: 'У нас лучшая РЕКЛАМА на районе!'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true, blockedKeywords), true);
});

test('MessageFilter: collapses message containing multi-word blocked phrase', () => {
  const filter = loadMessageFilter();
  const blockedKeywords = ['купить фолловеров', 'подпишись на канал'];
  const msg = {
    author: 'viewer1',
    text: 'Хочешь быстрый старт? Заходи купить фолловеров со скидкой!'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true, blockedKeywords), true);
});

test('MessageFilter: does not collapse message when blocked keywords list does not match', () => {
  const filter = loadMessageFilter();
  const blockedKeywords = ['реклама', 'спам'];
  const msg = {
    author: 'viewer1',
    text: 'Привет, как дела на стриме?'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true, blockedKeywords), false);
});

test('MessageFilter: matches blocked phrases even with multiple consecutive spaces', () => {
  const filter = loadMessageFilter();
  const blockedKeywords = ['купить   фолловеров'];
  const msg = {
    author: 'viewer1',
    text: 'Хочешь купить  фолловеров быстро?'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true, blockedKeywords), true);
});

test('MessageFilter: does not collapse message containing blocked keyword if streamer is mentioned or replied to', () => {
  const filter = loadMessageFilter();
  const blockedKeywords = ['реклама', 'спам'];
  const msgMention = {
    author: 'viewer1',
    text: '@fra3a У нас лучшая РЕКЛАМА на районе!'
  };
  assert.equal(filter.shouldCollapseReply(msgMention, streamerNicknames, true, blockedKeywords), false);

  const msgReply = {
    author: 'viewer1',
    text: 'Это не спам, а важная инфа',
    replyTo: 'fra3a'
  };
  assert.equal(filter.shouldCollapseReply(msgReply, streamerNicknames, true, blockedKeywords), false);
});

test('MessageFilter: isAuthorIgnored matches author or login case-insensitively and strips @', () => {
  const filter = loadMessageFilter();
  const ignoredUsers = ['nightbot', 'streamelements', 'spam_bot'];

  assert.equal(filter.isAuthorIgnored({ author: 'Nightbot' }, ignoredUsers), true);
  assert.equal(filter.isAuthorIgnored({ author: 'Viewer', login: 'streamelements' }, ignoredUsers), true);
  assert.equal(filter.isAuthorIgnored({ author: '@SPAM_BOT' }, ignoredUsers), true);
  assert.equal(filter.isAuthorIgnored({ author: 'regular_viewer' }, ignoredUsers), false);
  assert.equal(filter.isAuthorIgnored(null, ignoredUsers), false);
  assert.equal(filter.isAuthorIgnored({ author: 'Nightbot' }, []), false);
});

test('MessageFilter: collapses message when author is in ignoredUsers list unless streamer is mentioned or replied to', () => {
  const filter = loadMessageFilter();
  const ignoredUsers = ['nightbot'];
  const msg1 = {
    author: 'Nightbot',
    text: 'Подписывайтесь на наш Телеграм-канал: https://t.me/example'
  };
  // Regular bot message without streamer mention -> collapsed even if hideChatterReplies is false
  assert.equal(filter.shouldCollapseReply(msg1, streamerNicknames, false, [], ignoredUsers), true);

  const msg2 = {
    author: 'Nightbot',
    text: '@fra3a Стрим онлайн уже 3 часа!'
  };
  // Bot explicitly mentions streamer -> DO NOT collapse!
  assert.equal(filter.shouldCollapseReply(msg2, streamerNicknames, true, [], ignoredUsers), false);

  const msg3 = {
    author: 'Nightbot',
    text: 'Важное уведомление для стримера',
    replyTo: 'fra3a'
  };
  // Bot replies to streamer -> DO NOT collapse!
  assert.equal(filter.shouldCollapseReply(msg3, streamerNicknames, true, [], ignoredUsers), false);
});

test('MessageFilter: does not collapse message when author is not in ignoredUsers list', () => {
  const filter = loadMessageFilter();
  const ignoredUsers = ['nightbot'];
  const msg = {
    author: 'viewer1',
    text: 'Привет всем!'
  };
  assert.equal(filter.shouldCollapseReply(msg, streamerNicknames, true, [], ignoredUsers), false);
});

test('MessageFilter: isAuthorStreamer matches author or login with leading @', () => {
  const filter = loadMessageFilter();
  assert.equal(filter.isAuthorStreamer({ author: '@fra3a' }, streamerNicknames), true);
  assert.equal(filter.isAuthorStreamer({ author: '@@annacodit' }, streamerNicknames), true);
  assert.equal(filter.isAuthorStreamer({ author: 'unknown', login: '@fra3atv' }, streamerNicknames), true);
  assert.equal(filter.isAuthorStreamer({ author: '@regular_viewer' }, streamerNicknames), false);
});
