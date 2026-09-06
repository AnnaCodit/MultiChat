/**
 * Main Application Orchestrator for MultiChat
 * Integrates Settings, EmoteManager, MessageFilter, Connectors, and DOM Rendering
 */

class MultiChatApp {
  constructor() {
    this.settings = window.settingsManager;
    this.filter = window.messageFilter;
    this.emotes = window.emoteManager;

    this.isAutoScrollEnabled = true;

    // Trackers
    this.raidTracker = window.raidTracker;
    this.streamerTracker = window.streamerTracker || (typeof StreamerTracker !== 'undefined' ? new StreamerTracker() : null);
    if (this.streamerTracker && typeof this.streamerTracker.onStreamerDetected === 'function') {
      this.streamerTracker.onStreamerDetected((login, avgViewers) => {
        this.handleStreamerDetected(login, avgViewers);
      });
    }

    // Connectors
    this.twitch = new TwitchConnector(
      (msg) => this.handleIncomingMessage(msg),
      (plat, active, desc) => this.updateStatus(plat, active, desc),
      (raid) => this.handleRaidEvent(raid)
    );
    this.kick = new KickConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc, viewerCount) => this.updateStatus(plat, active, desc, viewerCount));
    this.vk = new VkLiveConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));
    this.youtube = new YoutubeConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));

    this.chatMessagesEl = document.getElementById('chatMessages');
    this.chatContainerEl = document.getElementById('chatContainer');
    this.unreadBadgeEl = document.getElementById('unreadBadge');
    this.unreadBadgeTextEl = document.getElementById('unreadBadgeText');
    this.kickViewerCountEl = document.getElementById('kickViewerCount');
    this.twitchUserPopup = new TwitchUserPopup({
      chatMessagesEl: this.chatMessagesEl,
      chatContainerEl: this.chatContainerEl,
      getCurrentTwitchChannel: () => this.twitch?.channel || this.settings?.settings?.twitchChannel || ''
    });

    this.initUI();

    // Add demonstration test messages (short, long, badges, colors, mentions)
    this.addDemoMessages();

    // Auto-connect to saved channels on page load!
    this.initEmotesAndConnect();
  }

  handleRaidEvent(raid) {
    if (this.raidTracker && typeof this.raidTracker.registerRaid === 'function') {
      this.raidTracker.registerRaid(raid);
    }
  }

  handleStreamerDetected(login, avgViewers) {
    if (!this.chatMessagesEl || !login) return;
    const highlightStreamersEnabled = this.settings?.settings?.highlightStreamers !== false;
    const streamerMinViewers = typeof this.settings?.settings?.streamerMinViewers === 'number'
      ? this.settings.settings.streamerMinViewers
      : 20;

    if (!highlightStreamersEnabled || avgViewers < streamerMinViewers) return;

    const normalizedLogin = this.normalizeTwitchLogin(login);
    const authorEls = this.chatMessagesEl.querySelectorAll(`.msg-author[data-twitch-username="${normalizedLogin}"]`);
    authorEls.forEach((authorEl) => {
      const lineEl = authorEl.closest('.chat-line');
      if (!lineEl) return;
      lineEl.classList.add('chat-line-streamer');

      if (!lineEl.querySelector('.badge-streamer')) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'badge-streamer';
        badgeEl.textContent = `📺 ${avgViewers}`;

        if (authorEl.parentNode) {
          authorEl.parentNode.insertBefore(badgeEl, authorEl);
        }
      }
    });
  }

  addDemoMessages() {
    // Demonstration Twitch message with 3 badges (Broadcaster + Subscriber + Partner)
    this.handleIncomingMessage({
      platform: 'twitch',
      author: 'TwitchBroadcaster',
      color: '#9146FF',
      badges: 'broadcaster/1,subscriber/1,partner/1',
      text: 'Привет! Чат подключен и готов к работе 🚀'
    });

    // Demonstration Twitch message from another streamer with high average online
    if (this.streamerTracker && this.streamerTracker.cache && typeof this.streamerTracker.cache.set === 'function') {
      this.streamerTracker.cache.set('streamerguest', {
        avgViewers: 145,
        timestamp: Math.floor(Date.now() / 1000)
      });
    }
    this.handleIncomingMessage({
      platform: 'twitch',
      author: 'StreamerGuest',
      login: 'streamerguest',
      color: '#38bdf8',
      badges: 'broadcaster/1',
      text: 'Всем привет, отличного стрима! Заглянул пожелать удачи 👋'
    });

    // Demonstration Kick message with Kick Broadcaster badge (First message today)
    this.handleIncomingMessage({
      platform: 'kick',
      author: 'fra3a',
      color: '#53FC18',
      badges: [{ type: 'broadcaster' }],
      text: 'Проверяем выведение цветных никнеймов и всех значков модераторов и стримеров.'
    });

    // Demonstration Twitch message from a brand new first-time chatter EVER on channel
    this.handleIncomingMessage({
      platform: 'twitch',
      author: 'NewStreamViewer',
      color: '#00f5d4',
      tags: { 'first-msg': '1' },
      text: 'Всем привет! Я впервые зашёл на этот стрим, рад познакомиться! 👋'
    });

    // Demonstration Twitch message from recent Raid Leader
    if (this.raidTracker && typeof this.raidTracker.registerRaid === 'function') {
      this.raidTracker.registerRaid({
        leaderLogin: 'RaidHero',
        leaderDisplayName: 'RaidHero',
        viewerCount: 120,
        timestamp: Date.now()
      });
    }
    this.handleIncomingMessage({
      platform: 'twitch',
      author: 'RaidHero',
      login: 'raidhero',
      color: '#c084fc',
      badges: 'broadcaster/1',
      text: 'Привет всем от нашего канала! Ловите наш мощный рейд! ⚔️🔥'
    });

    // Demonstration VK Live message with Streamer Mention
    this.handleIncomingMessage({
      platform: 'vklive',
      author: 'Анна',
      color: '#e056fd',
      text: 'Привет @fra3a! Сообщение с упоминанием стримера сразу выделяется яркой подсветкой 🔥'
    });

    // Demonstration Twitch message with Channel Points Reward Redemption
    this.handleIncomingMessage({
      platform: 'twitch',
      author: 'PointsEnjoyer',
      color: '#94a3b8',
      isRewardRedemption: true,
      text: 'Активировал награду за баллы канала! Сообщение выводится сдержанным серым цветом 🎁'
    });

    // Demonstration Twitch message with bright blue nickname (auto-mapped to rgb(153, 153, 255))
    this.handleIncomingMessage({
      platform: 'twitch',
      author: 'BlueViewer',
      color: 'rgb(0, 0, 255)',
      text: 'Проверка чтения ника: ярко-синий цвет автоматически заменён на доступный мягкий rgb(153, 153, 255)! 💙'
    });

    // Demonstration Twitch message with native GIF (Tier 2/3 subscriber perk)
    this.handleIncomingMessage({
      platform: 'twitch',
      author: 'GifEnjoyer',
      color: '#f59e0b',
      badges: 'subscriber/12',
      tags: {
        gifs: '0-41|joSNxeswxuc74Juo8X|https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=095d7a5dzizsiwgabonagkmigggv8v1spfai91ac3x0dsiy0&ep=v1_gifs_trending&rid=giphy.gif&ct=g'
      },
      text: '[Scared Still Waiting GIF by Looney Tunes]'
    });
  }

  initUI() {
    // Modal controls
    const openBtn = document.getElementById('openSettingsBtn');
    const closeBtn = document.getElementById('closeSettingsBtn');
    const saveBtn = document.getElementById('saveSettingsBtn');
    const modalEl = document.getElementById('settingsModal');
    const fontRange = document.getElementById('fontSizeRange');
    const fontVal = document.getElementById('fontSizeVal');

    if (openBtn) {
      openBtn.addEventListener('click', () => {
        this.openSettingsModal();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modalEl.classList.add('hidden');
      });
    }

    if (modalEl) {
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) modalEl.classList.add('hidden');
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const updated = this.settings.readForm();
        modalEl.classList.add('hidden');
        this.applyFontSettings(updated.fontSize);
        this.applyTwitchBadgesVisibility();
        this.pruneExcessMessages();
        this.initEmotesAndConnect();
      });
    }

    if (fontRange) {
      fontRange.addEventListener('input', (e) => {
        fontVal.textContent = e.target.value + 'px';
        this.applyFontSettings(e.target.value);
      });
    }

    // Scroll listener for smart auto-scroll toggling
    if (this.chatContainerEl) {
      this.chatContainerEl.addEventListener('scroll', () => {
        const distanceToBottom = this.chatContainerEl.scrollHeight - this.chatContainerEl.scrollTop - this.chatContainerEl.clientHeight;
        // Turn auto-scroll on only if user is at or near bottom (within 40px)
        this.isAutoScrollEnabled = distanceToBottom <= 40;
        this.updateUnreadBadge();
      });
    }

    if (this.unreadBadgeEl) {
      this.unreadBadgeEl.addEventListener('click', () => {
        this.scrollToBottom();
        this.isAutoScrollEnabled = true;
        this.updateUnreadBadge();
      });
    }

    // Event Delegation for collapsed messages (replies and reward spoilers)
    this.chatMessagesEl.addEventListener('click', (e) => {
      const collapsedLine = e.target.closest('.collapsed-reply, .collapsed-reward');
      if (collapsedLine) {
        collapsedLine.classList.toggle('expanded');
      }
    });

    this.applyFontSettings(this.settings.settings.fontSize);
    this.applyTwitchBadgesVisibility();

    // Auto-open settings modal if no channel address is specified
    if (!this.settings.hasAnyChannelConfigured()) {
      this.openSettingsModal();
    }
  }

  openSettingsModal() {
    const modalEl = document.getElementById('settingsModal');
    if (modalEl) {
      this.settings.populateForm();
      modalEl.classList.remove('hidden');
    }
  }

  applyFontSettings(sizePx) {
    document.documentElement.style.setProperty('--font-size', `${sizePx}px`);
  }

  applyTwitchBadgesVisibility() {
    const shouldHide = !!this.settings.settings.hideTwitchBadges;
    this.chatMessagesEl.classList.toggle('hide-twitch-badges', shouldHide);
    console.log(`[MultiChat UI] Twitch user badges ${shouldHide ? 'hidden' : 'shown'}.`);
  }

  renderAuthorHTML(msg, escapedAuthor, authorStyle = '') {
    const classes = ['msg-author'];
    const attributes = [];

    if (msg.platform === 'twitch') {
      classes.push('twitch-author');
      const login = this.normalizeTwitchLogin(msg.login || msg.author);
      if (login) {
        attributes.push(`data-twitch-username="${this.escapeHTML(login)}"`);
      }
    }

    if (authorStyle) attributes.push(authorStyle);
    const extraAttributes = attributes.length ? ` ${attributes.join(' ')}` : '';
    return `<span class="${classes.join(' ')}"${extraAttributes}>${escapedAuthor}</span>`;
  }

  initEmotesAndConnect() {
    const config = this.settings.settings;

    // 1. Connect platforms IMMEDIATELY (non-blocking)
    this.twitch.connect(config.twitchChannel);
    this.kick.connect(config.kickChannel);
    this.vk.connect(config.vkChannel);
    this.youtube.connect(config.youtubeChannel);

    // 2. Load emotes in background asynchronously
    if (config.enableThirdPartyEmotes) {
      this.emotes.loadGlobalEmotes().catch(e => console.warn(e));
      this.emotes.loadChannelEmotes(config.twitchChannel, config.kickChannel).catch(e => console.warn(e));
    } else {
      this.emotes.clear();
    }
  }

  updateStatus(platform, isOnline, description, viewerCount = null) {
    const badgeMap = {
      twitch: 'statusTwitch',
      kick: 'statusKick',
      vk: 'statusVk',
      youtube: 'statusYoutube'
    };

    const elId = badgeMap[platform];
    if (!elId) return;

    const el = document.getElementById(elId);
    if (!el) return;

    if (isOnline) {
      el.classList.remove('offline');
      el.classList.add('online');
    } else {
      el.classList.remove('online');
      el.classList.add('offline');
    }
    el.title = `${platform.toUpperCase()}: ${description}`;

    if (platform === 'kick') {
      const countEl = this.kickViewerCountEl || document.getElementById('kickViewerCount');
      if (countEl) {
        if (isOnline && typeof viewerCount === 'number') {
          countEl.textContent = String(viewerCount);
        } else {
          countEl.textContent = '';
        }
      }
    }
  }

  isAuthorFavorite(msg, favoriteUsers = []) {
    if (!msg || !Array.isArray(favoriteUsers) || !favoriteUsers.length) return false;
    const authorClean = (msg.author || '').toLowerCase().trim().replace(/^@+/, '');
    const loginClean = (msg.login || '').toLowerCase().trim().replace(/^@+/, '');
    return Boolean((authorClean && favoriteUsers.includes(authorClean)) || (loginClean && favoriteUsers.includes(loginClean)));
  }

  handleIncomingMessage(msg) {
    if (!msg) return;
    if (msg.isDeleted || msg.isAuthorDeleted) {
      this.markDeletedMessages(msg);
      return;
    }
    if (!msg.text) return;

    const streamerNicknames = this.settings.getStreamerNicknames();
    const favoriteUsers = typeof this.settings.getFavoriteUsers === 'function' ? this.settings.getFavoriteUsers() : [];
    const hideRepliesEnabled = this.settings.settings.hideChatterReplies;
    const blockedKeywords = typeof this.settings.getBlockedKeywords === 'function' ? this.settings.getBlockedKeywords() : [];
    const ignoredUsers = typeof this.settings.getIgnoredUsers === 'function' ? this.settings.getIgnoredUsers() : [];

    // Evaluate chatter reply, blocked keyword, and ignored user filter
    const shouldCollapse = this.filter.shouldCollapseReply(msg, streamerNicknames, hideRepliesEnabled, blockedKeywords, ignoredUsers);

    // Evaluate streamer mention highlight
    const isMention = this.filter.isMentioningStreamer(msg, streamerNicknames);

    // Evaluate favorite user highlight
    const isFavorite = this.isAuthorFavorite(msg, favoriteUsers);

    // Evaluate Channel Points reward redemption status
    const isReward = !!msg.isRewardRedemption || !!(msg.tags && msg.tags['custom-reward-id']);

    // Evaluate raid leader highlight (active for 10m after raid)
    const isRaidLeader = this.raidTracker && typeof this.raidTracker.isRaidLeader === 'function'
      ? this.raidTracker.isRaidLeader(msg)
      : false;

    // Evaluate Twitch streamer highlight status
    let isStreamer = false;
    let streamerAvgViewers = 0;
    const highlightStreamersEnabled = this.settings?.settings?.highlightStreamers !== false;
    const streamerMinViewers = typeof this.settings?.settings?.streamerMinViewers === 'number'
      ? this.settings.settings.streamerMinViewers
      : 20;

    if (msg.platform === 'twitch' && highlightStreamersEnabled && this.streamerTracker) {
      const twitchLogin = this.normalizeTwitchLogin(msg.login || msg.author);
      if (twitchLogin) {
        const stats = this.streamerTracker.getStreamerStats(twitchLogin);
        if (stats) {
          if (stats.avgViewers >= streamerMinViewers) {
            isStreamer = true;
            streamerAvgViewers = stats.avgViewers;
          }
        } else {
          this.streamerTracker.queueCheck(twitchLogin);
        }
      }
    }

    // Evaluate first-time chatter status
    const firstStatus = window.chatterTracker ? window.chatterTracker.processMessage(msg) : { isFirstTimeEver: false, isFirstToday: false };

    // Format HTML content with emote & GIF parser (including Twitch native emote tags and GIF tags)
    const twitchEmotesTag = (msg.tags && msg.tags.emotes) ? msg.tags.emotes : null;
    const twitchGifsTag = (msg.tags && msg.tags.gifs) ? msg.tags.gifs : (msg.gifs || null);
    const parsedTextHTML = this.emotes.parseEmotes(msg.text, twitchEmotesTag, msg.nativeEmotes, twitchGifsTag);

    // Render DOM node
    this.renderMessageNode(msg, parsedTextHTML, shouldCollapse, firstStatus, isMention, isReward, isFavorite, isRaidLeader, isStreamer, streamerAvgViewers);
  }

  markDeletedMessages(msg) {
    Array.from(this.chatMessagesEl.children).forEach((lineEl) => {
      const matchesMessage = msg.isDeleted
        && msg.id
        && lineEl.dataset.messageId === String(msg.id);
      const matchesAuthor = msg.isAuthorDeleted
        && msg.authorId
        && lineEl.dataset.authorId === String(msg.authorId);

      if (matchesMessage || matchesAuthor) {
        lineEl.classList.add('chat-line-deleted');
        lineEl.dataset.deletedOnYoutube = 'true';
        lineEl.title = 'Сообщение удалено на YouTube';
      }
    });
  }

  renderMessageNode(msg, parsedTextHTML, shouldCollapse, firstStatus = {}, isMention = false, isReward = false, isFavorite = false, isRaidLeader = false, isStreamer = false, streamerAvgViewers = 0) {
    const lineEl = document.createElement('div');
    lineEl.className = 'chat-line';
    if (msg.id) lineEl.dataset.messageId = String(msg.id);
    if (msg.authorId) lineEl.dataset.authorId = String(msg.authorId);

    // Apply special highlight classes
    if (isReward) {
      lineEl.classList.add('chat-line-reward');
    } else if (isRaidLeader) {
      lineEl.classList.add('chat-line-raid-leader');
    } else if (isStreamer) {
      lineEl.classList.add('chat-line-streamer');
    } else if (isMention) {
      lineEl.classList.add('chat-line-mention');
    } else if (isFavorite) {
      lineEl.classList.add('chat-line-favorite');
    }

    if (firstStatus.isFirstTimeEver) {
      lineEl.classList.add('chat-line-first-ever');
    } else if (firstStatus.isFirstToday) {
      lineEl.classList.add('chat-line-first-today');
    }

    const platformClass = msg.platform || 'twitch';
    const platformLabel = platformClass.charAt(0).toUpperCase();
    const cleanAuthor = typeof msg.author === 'string' ? msg.author.trim().replace(/^@+/, '').trim() : (msg.author || '');
    const escapedAuthor = this.escapeHTML(cleanAuthor || 'User');

    // Badges HTML (Parses ALL user badges: Twitch, Kick & YouTube)
    let badgesHTML = this.emotes.getBadgesHTML(msg);

    // Append Raid Leader Badge if applicable
    if (isRaidLeader) {
      badgesHTML += `<span class="badge-raid-leader" title="Лидер рейда">⚔️ Лидер рейда</span>`;
    }

    // Append Streamer Badge if applicable
    if (isStreamer) {
      badgesHTML += `<span class="badge-streamer">📺 ${streamerAvgViewers}</span>`;
    }

    // Append Favorite User Badge if applicable
    if (isFavorite) {
      badgesHTML += `<span class="badge-favorite" title="Избранный пользователь">⭐ Избранный</span>`;
    }

    // Append Channel Points Reward Badge if applicable
    if (isReward) {
      badgesHTML += `<span class="badge-reward" title="Активация награды за баллы канала">🎁 Награда</span>`;
    }

    // Append First-Time Chatter Badge if applicable
    if (firstStatus.isFirstTimeEver) {
      badgesHTML += `<span class="badge-first-ever" title="Пользователь впервые пишет на этом канале за всё время!">✨ Впервые в чате</span>`;
    } else if (firstStatus.isFirstToday) {
      const windowHours = this.settings.settings.firstMessageWindowHours || 12;
      badgesHTML += `<span class="badge-first-today" title="Первое сообщение пользователя за последние ${windowHours}ч">☀️ 1-е за сегодня</span>`;
    }

    // Custom user nickname color (with unreadable bright blue remapped to rgb(153, 153, 255))
    const authorColor = this.normalizeColor(msg.color);
    const authorStyle = authorColor ? `style="color: ${this.escapeHTML(authorColor)}"` : '';
    const authorHTML = this.renderAuthorHTML(msg, escapedAuthor, authorStyle);

    if (isReward) {
      // Collapsed Reward format with spoiler hint
      lineEl.classList.add('collapsed-reward');
      lineEl.innerHTML = `
        <div class="collapsed-placeholder">
          <span class="msg-header"><span class="msg-platform ${platformClass}">${platformLabel}</span>${badgesHTML}${authorHTML}<span class="msg-colon">:</span></span>
          <span class="reward-spoiler-hint">▶ (нажмите, чтобы развернуть текст)</span>
        </div>
        <div class="collapsed-content">
          <span class="msg-text">${parsedTextHTML}</span>
        </div>
      `;
    } else if (shouldCollapse) {
      // Collapsed Chatter-to-Chatter Reply format (Clean placeholder without platform badge)
      lineEl.classList.add('collapsed-reply');
      lineEl.innerHTML = `
        <div class="collapsed-placeholder">
          <span>===</span>
        </div>
        <div class="collapsed-content">
          <span class="msg-header"><span class="msg-platform ${platformClass}">${platformLabel}</span>${badgesHTML}${authorHTML}<span class="msg-colon">:</span></span><span class="msg-text">${parsedTextHTML}</span>
        </div>
      `;
    } else {
      // Standard Chat Line format with parent msg-header wrapper
      lineEl.innerHTML = `<span class="msg-header"><span class="msg-platform ${platformClass}">${platformLabel}</span>${badgesHTML}${authorHTML}<span class="msg-colon">:</span></span><span class="msg-text">${parsedTextHTML}</span>`;
    }

    if (this.chatMessagesEl) {
      this.chatMessagesEl.appendChild(lineEl);
    }

    // Limit DOM messages count based on maxChatMessages configuration
    this.pruneExcessMessages();

    // Auto scroll down only if auto-scroll is currently active
    if (this.isAutoScrollEnabled) {
      this.scrollToBottom();
    } else {
      this.updateUnreadBadge();
    }

    return lineEl;
  }

  pruneExcessMessages() {
    const maxMessages = this.settings.settings.maxChatMessages || 200;
    while (this.chatMessagesEl.children.length > maxMessages) {
      this.chatMessagesEl.removeChild(this.chatMessagesEl.firstChild);
    }
  }

  scrollToBottom() {
    this.chatContainerEl.scrollTop = this.chatContainerEl.scrollHeight;
  }

  formatUnreadCountText(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;

    let word = 'новых сообщений';
    if (mod100 >= 11 && mod100 <= 19) {
      word = 'новых сообщений';
    } else if (mod10 === 1) {
      word = 'новое сообщение';
    } else if (mod10 >= 2 && mod10 <= 4) {
      word = 'новых сообщения';
    }

    return `↓ ${count} ${word}`;
  }

  updateUnreadBadge() {
    if (!this.chatContainerEl || !this.chatMessagesEl || !this.unreadBadgeEl) return;

    if (this.isAutoScrollEnabled) {
      this.unreadBadgeEl.classList.add('hidden');
      return;
    }

    const viewportBottom = this.chatContainerEl.scrollTop + this.chatContainerEl.clientHeight;
    let unreadCount = 0;

    const children = this.chatMessagesEl.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child.offsetTop + 5 >= viewportBottom) {
        unreadCount++;
      } else {
        break;
      }
    }

    if (unreadCount > 0) {
      if (this.unreadBadgeTextEl) {
        this.unreadBadgeTextEl.textContent = this.formatUnreadCountText(unreadCount);
      }
      this.unreadBadgeEl.classList.remove('hidden');
    } else {
      this.unreadBadgeEl.classList.add('hidden');
    }
  }

  normalizeColor(color) {
    if (color === null || color === undefined) return null;
    const cleanColor = String(color).trim().toLowerCase();
    if (!cleanColor) return null;
    const compactColor = cleanColor.replace(/\s+/g, '');

    // Replace unreadable bright blue rgb(0, 0, 255) / #0000ff / #00f / blue with readable rgb(153, 153, 255)
    if (
      compactColor === '#0000ff' ||
      compactColor === '#00f' ||
      compactColor === 'blue' ||
      compactColor === 'rgb(0,0,255)' ||
      compactColor === 'rgba(0,0,255,1)'
    ) {
      return 'rgb(153, 153, 255)';
    }

    return cleanColor;
  }

  normalizeTwitchLogin(value) {
    return String(value || '').trim().toLowerCase().replace(/^[@#]+/, '');
  }

  escapeHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Dynamic cache-busted loading can finish after DOMContentLoaded, so start immediately
// when the document is already ready and otherwise wait for the normal event.
const startApplication = () => {
  if (!window.app) {
    window.app = new MultiChatApp();
  }
};

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startApplication, { once: true });
} else {
  startApplication();
}
