/**
 * Main Application Orchestrator for MultiChat
 * Integrates Settings, EmoteManager, MessageFilter, Connectors, and DOM Rendering
 */

const MAX_CHAT_MESSAGES = 200;

class MultiChatApp {
  constructor() {
    this.settings = window.settingsManager;
    this.filter = window.messageFilter;
    this.emotes = window.emoteManager;

    // Connectors
    this.twitch = new TwitchConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));
    this.kick = new KickConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));
    this.vk = new VkLiveConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));
    this.youtube = new YoutubeConnector((msg) => this.handleIncomingMessage(msg), (plat, active, desc) => this.updateStatus(plat, active, desc));

    this.chatMessagesEl = document.getElementById('chatMessages');
    this.chatContainerEl = document.getElementById('chatContainer');

    this.initUI();
    
    // Auto-connect to saved channels on page load!
    this.initEmotesAndConnect();
  }

  initUI() {
    // Modal controls
    const openBtn = document.getElementById('openSettingsBtn');
    const closeBtn = document.getElementById('closeSettingsBtn');
    const saveBtn = document.getElementById('saveSettingsBtn');
    const modalEl = document.getElementById('settingsModal');
    const clearBtn = document.getElementById('clearChatBtn');
    const fontRange = document.getElementById('fontSizeRange');
    const fontVal = document.getElementById('fontSizeVal');

    openBtn.addEventListener('click', () => {
      this.settings.populateForm();
      modalEl.classList.remove('hidden');
    });

    closeBtn.addEventListener('click', () => {
      modalEl.classList.add('hidden');
    });

    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) modalEl.classList.add('hidden');
    });

    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const updated = this.settings.readForm();
      modalEl.classList.add('hidden');
      this.applyFontSettings(updated.fontSize);
      this.initEmotesAndConnect();
    });

    fontRange.addEventListener('input', (e) => {
      fontVal.textContent = e.target.value + 'px';
      this.applyFontSettings(e.target.value);
    });

    clearBtn.addEventListener('click', () => {
      this.chatMessagesEl.innerHTML = '';
      this.addSystemMessage('Чат очищен.');
    });

    // Event Delegation for collapsed messages
    this.chatMessagesEl.addEventListener('click', (e) => {
      const collapsedLine = e.target.closest('.collapsed-reply');
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

    // Format HTML content with emote parser (including Twitch native emote tags)
    const twitchEmotesTag = (msg.tags && msg.tags.emotes) ? msg.tags.emotes : null;
    const parsedTextHTML = this.emotes.parseEmotes(msg.text, twitchEmotesTag);

    // Render DOM node
    this.renderMessageNode(msg, parsedTextHTML, shouldCollapse);
  }

  renderMessageNode(msg, parsedTextHTML, shouldCollapse) {
    const lineEl = document.createElement('div');
    lineEl.className = 'chat-line';

    const platformClass = msg.platform || 'twitch';
    const platformLabel = platformClass.charAt(0).toUpperCase();

    if (shouldCollapse) {
      // Collapsed Chatter-to-Chatter Reply format
      lineEl.classList.add('collapsed-reply');
      lineEl.innerHTML = `
        <div class="collapsed-placeholder">
          <span class="msg-platform ${platformClass}">${platformLabel}</span>
          <span>[чаттерсы общаются]</span>
        </div>
        <div class="collapsed-content">
          <span class="msg-author">${this.escapeHTML(msg.author)}</span><span class="msg-colon">:</span>
          <span class="msg-text">${parsedTextHTML}</span>
        </div>
      `;
    } else {
      // Standard Chat Line format
      lineEl.innerHTML = `
        <span class="msg-platform ${platformClass}">${platformLabel}</span>
        <span class="msg-author">${this.escapeHTML(msg.author)}</span><span class="msg-colon">:</span>
        <span class="msg-text">${parsedTextHTML}</span>
      `;
    }

    this.chatMessagesEl.appendChild(lineEl);

    // Limit DOM messages count to prevent memory leaks in long streams
    while (this.chatMessagesEl.children.length > MAX_CHAT_MESSAGES) {
      this.chatMessagesEl.removeChild(this.chatMessagesEl.firstChild);
    }

    this.scrollToBottom();
  }

  addSystemMessage(text) {
    const line = document.createElement('div');
    line.className = 'chat-line system-line';
    line.innerHTML = `
      <span class="system-badge">System</span>
      <span class="system-text">${this.escapeHTML(text)}</span>
    `;
    this.chatMessagesEl.appendChild(line);
    this.scrollToBottom();
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
