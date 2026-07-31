const test = require('node:test');
const assert = require('node:assert/strict');

const EmoteManager = require('../js/emotes.js');

test('raw HTML is always escaped even if it resembles an emote image', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  const html = manager.parseEmotes('<img class="chat-emote" src=x onerror=alert(1)>');

  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img\b/i);
});

test('Kick emote placeholders do not bypass escaping for adjacent user HTML', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  const html = manager.parseEmotes('[emote:123:KEKW] <script>alert(1)</script>');

  assert.match(html, /files\.kick\.com\/emotes\/123\/fullsize/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/i);
});

test('YouTube native emoji is rendered from a validated HTTPS image URL', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  const text = 'A :party: B';
  const html = manager.parseEmotes(text, null, [
    {
      start: 2,
      end: 8,
      code: ':party:',
      url: 'https://yt3.ggpht.com/youtube-emoji'
    }
  ]);

  assert.match(html, /class="chat-emote"/);
  assert.match(html, /yt3\.ggpht\.com\/youtube-emoji/);
  assert.match(html, /alt=":party:"/);
});

test('modern non-numeric Twitch emote IDs render together with 7TV emotes', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  manager.emoteMap.set(
    'фраза',
    'https://cdn.7tv.app/emote/01JF0THNPHZPRTKHQM8ATS7BRJ/1x.webp'
  );

  const html = manager.parseEmotes(
    'тест fra3aSpin фраза',
    'emotesv2_fra3aSpin:5-13'
  );

  assert.match(
    html,
    /static-cdn\.jtvnw\.net\/emoticons\/v2\/emotesv2_fra3aSpin\/default\/dark\/1\.0/
  );
  assert.match(
    html,
    /cdn\.7tv\.app\/emote\/01JF0THNPHZPRTKHQM8ATS7BRJ\/1x\.webp/
  );
  assert.doesNotMatch(html, />fra3aSpin</);
});

test('unsafe badge and emote URLs are not rendered', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  const html = manager.parseEmotes('BAD', null, [
    {
      start: 0,
      end: 2,
      code: 'BAD',
      url: 'javascript:alert(1)'
    }
  ]);
  const badges = manager.getBadgesHTML({
    platform: 'youtube',
    badges: [{ url: 'javascript:alert(1)', title: 'bad' }]
  });

  assert.equal(html, 'BAD');
  assert.equal(badges, '');
});

test('Twitch badges can be hidden with a CSS class without removing their markup', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  const html = manager.getBadgesHTML(
    {
      platform: 'twitch',
      badges: 'broadcaster/1,subscriber/1,partner/1'
    },
    { hideTwitchBadges: true }
  );

  assert.match(html, /class="msg-badges twitch-badges-hidden"/);
  assert.match(html, /class="chat-badge"/);
});
