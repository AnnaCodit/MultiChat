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

test('Twitch badge markup stays independent from the visibility setting', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  const html = manager.getBadgesHTML({
    platform: 'twitch',
    badges: 'broadcaster/1,subscriber/1,partner/1'
  });

  assert.match(html, /class="msg-badges"/);
  assert.match(html, /class="chat-badge"/);
  assert.doesNotMatch(html, /hide-twitch-badges|twitch-badges-hidden/);
});

test('Twitch native GIF tag is parsed and rendered with .chat-gif class', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  const text = '[Scared Still Waiting GIF by Looney Tunes]';
  const gifsTag = '0-41|joSNxeswxuc74Juo8X|https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=test&rid=giphy.gif';

  const html = manager.parseEmotes(text, null, [], gifsTag);

  assert.match(html, /class="chat-gif"/);
  assert.match(html, /src="https:\/\/media4\.giphy\.com\/media\/joSNxeswxuc74Juo8X\/giphy\.gif\?cid=test&amp;rid=giphy\.gif"/);
  assert.match(html, /title="\[Scared Still Waiting GIF by Looney Tunes\]"/);
  assert.doesNotMatch(html, /\balt=/);
});

test('unsafe GIF URLs are rejected and rendered safely as plain escaped text', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  const text = '[XSS GIF by BadActor]';
  const gifsTag = '0-20|badId|javascript:alert(1)';

  const html = manager.parseEmotes(text, null, [], gifsTag);

  assert.equal(html, '[XSS GIF by BadActor]');
  assert.doesNotMatch(html, /<img/i);
});

test('Twitch GIFs render seamlessly alongside native and third-party emotes', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  manager.emoteMap.set('CatJAM', 'https://cdn.7tv.app/emote/catjam/1x.webp');

  const text = 'Hey [Dancing GIF by Creator] Kappa CatJAM';
  // 'Kappa' is at indices 29-33
  const emotesTag = '25:29-33';
  // '[Dancing GIF by Creator]' is at indices 4-27 (length 24)
  const gifsTag = '4-27|gif123|https://media4.giphy.com/media/dancing.gif';

  const html = manager.parseEmotes(text, emotesTag, [], gifsTag);

  assert.match(html, /class="chat-gif"/);
  assert.match(html, /src="https:\/\/media4\.giphy\.com\/media\/dancing\.gif"/);
  assert.match(html, /class="chat-emote"/);
  assert.match(html, /static-cdn\.jtvnw\.net\/emoticons\/v2\/25\/default\/dark\/1\.0/);
  assert.match(html, /cdn\.7tv\.app\/emote\/catjam\/1x\.webp/);
  assert.match(html, /^Hey /);
});

test('multiple Twitch GIFs in one message are parsed correctly', () => {
  const manager = new EmoteManager({ loadGlobalBadges: false });
  const text = '[GIF 1] and [GIF 2]';
  // '[GIF 1]' is at 0-6 (len 7), '[GIF 2]' is at 12-18 (len 7)
  const gifsTag = '0-6|id1|https://media.giphy.com/1.gif?a=1&b=2,12-18|id2|https://media.giphy.com/2.gif?c=3&d=4';

  const html = manager.parseEmotes(text, null, [], gifsTag);

  assert.match(html, /src="https:\/\/media\.giphy\.com\/1\.gif\?a=1&amp;b=2"/);
  assert.match(html, /src="https:\/\/media\.giphy\.com\/2\.gif\?c=3&amp;d=4"/);
  assert.match(html, / and /);
});


