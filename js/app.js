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

    // Connectors
    this.twitch = new TwitchConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));
    this.kick = new KickConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));
    this.vk = new VkLiveConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));
    this.youtube = new YoutubeConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));

    this.chatMessagesEl = document.getElementById('chatMessages');
    this.chatContainerEl = document.getElementById('chatContainer');

    this.initUI();

    // Add demonstration test messages (short, long, badges, colors, mentions)
    this.addDemoMessages();

    // Auto-connect to saved channels on page load!
    this.initEmotesAndConnect();
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
        this.settings.populateForm();
        modalEl.classList.remove('hidden');
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
  }

  applyFontSettings(sizePx) {
    document.documentElement.style.setProperty('--font-size', `${sizePx}px`);
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

  updateStatus(platform, isOnline, description) {
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
  }

  handleIncomingMessage(msg) {
    if (!msg || !msg.text) return;

    const streamerNicknames = this.settings.getStreamerNicknames();
    const hideRepliesEnabled = this.settings.settings.hideChatterReplies;

    // Evaluate chatter reply filter
    const shouldCollapse = this.filter.shouldCollapseReply(msg, streamerNicknames, hideRepliesEnabled);

    // Evaluate streamer mention highlight
    const isMention = this.filter.isMentioningStreamer(msg, streamerNicknames);

    // Evaluate Channel Points reward redemption status
    const isReward = !!msg.isRewardRedemption || !!(msg.tags && msg.tags['custom-reward-id']);

    // Evaluate first-time chatter status
    const firstStatus = window.chatterTracker ? window.chatterTracker.processMessage(msg) : { isFirstTimeEver: false, isFirstToday: false };

    // Format HTML content with emote parser (including Twitch native emote tags)
    const twitchEmotesTag = (msg.tags && msg.tags.emotes) ? msg.tags.emotes : null;
    const parsedTextHTML = this.emotes.parseEmotes(msg.text, twitchEmotesTag);

    // Render DOM node
    this.renderMessageNode(msg, parsedTextHTML, shouldCollapse, firstStatus, isMention, isReward);
  }

  renderMessageNode(msg, parsedTextHTML, shouldCollapse, firstStatus = {}, isMention = false, isReward = false) {
    const lineEl = document.createElement('div');
    lineEl.className = 'chat-line';

    // Apply special highlight classes
    if (isReward) {
      lineEl.classList.add('chat-line-reward');
    } else if (isMention) {
      lineEl.classList.add('chat-line-mention');
    }

    if (firstStatus.isFirstTimeEver) {
      lineEl.classList.add('chat-line-first-ever');
    } else if (firstStatus.isFirstToday) {
      lineEl.classList.add('chat-line-first-today');
    }

    const platformClass = msg.platform || 'twitch';
    const platformLabel = platformClass.charAt(0).toUpperCase();
    const escapedAuthor = this.escapeHTML(msg.author);

    // Badges HTML (Parses ALL user badges: Twitch & Kick)
    let badgesHTML = this.emotes.getBadgesHTML(msg);

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

    // Custom user nickname color
    const authorStyle = msg.color ? `style="color: ${this.escapeHTML(msg.color)}"` : '';

    if (isReward) {
      // Collapsed Reward format with spoiler hint
      lineEl.classList.add('collapsed-reward');
      lineEl.innerHTML = `
        <div class="collapsed-placeholder">
          <span class="msg-header"><span class="msg-platform ${platformClass}">${platformLabel}</span>${badgesHTML}<span class="msg-author" ${authorStyle}>${escapedAuthor}</span><span class="msg-colon">:</span></span>
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
          <span class="msg-header"><span class="msg-platform ${platformClass}">${platformLabel}</span>${badgesHTML}<span class="msg-author" ${authorStyle}>${escapedAuthor}</span><span class="msg-colon">:</span></span><span class="msg-text">${parsedTextHTML}</span>
        </div>
      `;
    } else {
      // Standard Chat Line format with parent msg-header wrapper
      lineEl.innerHTML = `<span class="msg-header"><span class="msg-platform ${platformClass}">${platformLabel}</span>${badgesHTML}<span class="msg-author" ${authorStyle}>${escapedAuthor}</span><span class="msg-colon">:</span></span><span class="msg-text">${parsedTextHTML}</span>`;
    }

    this.chatMessagesEl.appendChild(lineEl);

    // Limit DOM messages count based on maxChatMessages configuration
    this.pruneExcessMessages();

    // Auto scroll down only if auto-scroll is currently active
    if (this.isAutoScrollEnabled) {
      this.scrollToBottom();
    }
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

  escapeHTML(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Start Application on DOM Load
window.addEventListener('DOMContentLoaded', () => {
  window.app = new MultiChatApp();
});
