/**
 * Twitch user profile popup for MultiChat.
 * Handles profile lookup, author click events, profile links and popup layout.
 */

const TWITCH_USER_REQUEST_TIMEOUT_MS = 8000;

async function getTwitchUserData(username, { timeoutMs = TWITCH_USER_REQUEST_TIMEOUT_MS } = {}) {
  const normalizedUsername = String(username || '').trim().toLowerCase().replace(/^@+/, '');
  if (!normalizedUsername) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(normalizedUsername)}`,
      { signal: controller.signal }
    );
    if (!response.ok) {
      throw new Error(`IVR API returned HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data && data[0]) return data[0];
    return null;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error(`IVR API request timed out after ${timeoutMs} ms`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

class TwitchUserPopup {
  constructor({ chatMessagesEl, chatContainerEl, getCurrentTwitchChannel }) {
    this.chatMessagesEl = chatMessagesEl;
    this.chatContainerEl = chatContainerEl;
    this.getCurrentTwitchChannel = getCurrentTwitchChannel;
    this.userDataCache = new Map();
    this.requestId = 0;
    this.anchorEl = null;

    this.init();
  }

  init() {
    this.popupEl = document.getElementById('twitchUserPopup');
    this.avatarEl = document.getElementById('twitchUserAvatar');
    this.nameEl = document.getElementById('twitchUserName');
    this.statusEl = document.getElementById('twitchUserStatus');
    this.historyLinkEl = document.getElementById('twitchUserHistoryLink');
    this.channelLinkEl = document.getElementById('twitchUserChannelLink');
    this.closeEl = document.getElementById('closeTwitchUserPopup');

    const popupElements = [
      this.popupEl,
      this.avatarEl,
      this.nameEl,
      this.statusEl,
      this.historyLinkEl,
      this.channelLinkEl,
      this.closeEl
    ];
    if (popupElements.some(element => !element)) {
      console.error('[Twitch User Popup] Popup markup is incomplete.');
      return;
    }

    this.closeEl.addEventListener('click', () => this.close());
    this.historyLinkEl.addEventListener('click', (event) => this.openViewerCard(event));
    this.avatarEl.addEventListener('error', () => {
      this.avatarEl.hidden = true;
      this.avatarEl.removeAttribute('src');
      console.warn('[Twitch User Popup] Failed to load Twitch user avatar.');
    });

    if (this.chatMessagesEl) {
      this.chatMessagesEl.addEventListener('click', (event) => {
        const target = event.target;
        const authorEl = target
          && typeof target.closest === 'function'
          && target.closest('.msg-author.twitch-author');
        if (!authorEl || !this.chatMessagesEl.contains(authorEl)) return;

        event.preventDefault();
        // Prevent the main chat handler from toggling a collapsed line as well.
        event.stopImmediatePropagation();
        this.open(authorEl);
      });
    }

    if (this.chatContainerEl) {
      this.chatContainerEl.addEventListener('scroll', () => this.position());
    }

    document.addEventListener('click', (event) => {
      if (!this.popupEl || this.popupEl.classList.contains('hidden')) return;

      const target = event.target;
      const clickedAuthor = target
        && typeof target.closest === 'function'
        && target.closest('.msg-author.twitch-author');
      if (!this.popupEl.contains(target) && !clickedAuthor) this.close();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });

    window.addEventListener('resize', () => this.position());
  }

  async open(authorEl) {
    if (!this.popupEl) return;

    const username = this.normalizeLogin(
      authorEl.dataset.twitchUsername || authorEl.textContent
    );
    if (!username) {
      console.warn('[Twitch User Popup] Cannot open popup without a username.');
      return;
    }

    const requestId = ++this.requestId;
    this.anchorEl = authorEl;
    this.prepare(username);
    this.popupEl.classList.remove('hidden');
    this.popupEl.setAttribute('aria-hidden', 'false');
    this.position();

    try {
      const userData = await this.getCachedUserData(username);
      if (requestId !== this.requestId || this.popupEl.classList.contains('hidden')) return;
      this.render(userData, username);
    } catch (error) {
      if (requestId !== this.requestId || this.popupEl.classList.contains('hidden')) return;
      this.renderError(username, error);
      console.error(`[Twitch User Popup] Failed to load Twitch user ${username}:`, error);
    }
    this.position();
  }

  prepare(username) {
    this.nameEl.textContent = username;
    this.statusEl.textContent = 'Загрузка профиля...';
    this.avatarEl.hidden = true;
    this.avatarEl.removeAttribute('src');
    this.avatarEl.alt = `Аватарка пользователя ${username}`;
    this.updateLinks(username);
  }

  render(userData, fallbackUsername) {
    const username = this.normalizeLogin(userData?.login || fallbackUsername);
    const displayName = String(userData?.displayName || userData?.display_name || username);
    const avatarUrl = userData?.logo || userData?.profile_image_url || '';

    this.nameEl.textContent = displayName;
    this.statusEl.textContent = userData ? 'Пользователь Twitch' : 'Профиль не найден';
    this.updateLinks(username);

    if (this.isSafeImageUrl(avatarUrl)) {
      this.avatarEl.alt = `Аватарка пользователя ${displayName}`;
      this.avatarEl.src = avatarUrl;
      this.avatarEl.hidden = false;
    } else {
      this.avatarEl.hidden = true;
      this.avatarEl.removeAttribute('src');
    }
  }

  renderError(username, error) {
    this.nameEl.textContent = username;
    this.avatarEl.hidden = true;
    this.avatarEl.removeAttribute('src');
    this.statusEl.textContent = error && error.name === 'TimeoutError'
      ? 'Профиль не загрузился вовремя. Нажмите на ник, чтобы повторить.'
      : 'Не удалось загрузить профиль. Нажмите на ник, чтобы повторить.';
    this.updateLinks(username);
  }

  getCachedUserData(username) {
    const cacheKey = this.normalizeLogin(username);
    if (!cacheKey) return Promise.resolve(null);

    if (!this.userDataCache.has(cacheKey)) {
      const request = getTwitchUserData(cacheKey)
        .then((userData) => {
          // Cache successful profiles only; a missing profile may appear later.
          if (!userData) this.userDataCache.delete(cacheKey);
          return userData;
        })
        .catch((error) => {
          // A temporary IVR/network failure must be retried on the next click.
          this.userDataCache.delete(cacheKey);
          throw error;
        });
      this.userDataCache.set(cacheKey, request);
    }

    return this.userDataCache.get(cacheKey);
  }

  updateLinks(username) {
    const normalizedUsername = this.normalizeLogin(username);
    const channel = this.getTwitchChannelName();
    const channelUrl = normalizedUsername
      ? `https://www.twitch.tv/${encodeURIComponent(normalizedUsername)}`
      : '';
    const historyUrl = channel && normalizedUsername
      ? `https://www.twitch.tv/popout/${encodeURIComponent(channel)}/viewercard/${encodeURIComponent(normalizedUsername)}?popout=`
      : '';

    this.setLink(this.channelLinkEl, channelUrl);
    this.setLink(this.historyLinkEl, historyUrl);
    this.historyLinkEl.dataset.popupUrl = historyUrl;
  }

  setLink(linkEl, url) {
    if (url) {
      linkEl.href = url;
      linkEl.setAttribute('aria-disabled', 'false');
      linkEl.classList.remove('is-disabled');
    } else {
      linkEl.removeAttribute('href');
      linkEl.setAttribute('aria-disabled', 'true');
      linkEl.classList.add('is-disabled');
    }
  }

  openViewerCard(event) {
    const popupUrl = this.historyLinkEl.dataset.popupUrl;
    if (!popupUrl) {
      event.preventDefault();
      console.warn('[Twitch User Popup] Viewer card is unavailable: Twitch channel is not configured.');
      return;
    }

    event.preventDefault();
    const popupWindow = window.open(
      popupUrl,
      'twitch-viewer-card',
      'popup=yes,width=420,height=640,resizable=yes,scrollbars=yes'
    );
    if (popupWindow) {
      popupWindow.focus();
    } else {
      this.statusEl.textContent = 'Браузер заблокировал всплывающее окно';
      console.warn('[Twitch User Popup] Browser blocked viewer card popup.');
    }
  }

  close() {
    if (!this.popupEl) return;

    this.requestId += 1;
    this.anchorEl = null;
    this.popupEl.classList.add('hidden');
    this.popupEl.setAttribute('aria-hidden', 'true');
  }

  position() {
    if (
      !this.popupEl
      || this.popupEl.classList.contains('hidden')
      || !this.anchorEl
    ) {
      return;
    }

    if (!this.anchorEl.isConnected) {
      this.close();
      return;
    }

    const anchorRect = this.anchorEl.getBoundingClientRect();
    const gap = 8;
    const popupWidth = this.popupEl.offsetWidth || 280;
    const popupHeight = this.popupEl.offsetHeight || 150;
    const viewportPadding = 8;

    let left = anchorRect.left;
    let top = anchorRect.bottom + gap;
    if (left + popupWidth > window.innerWidth - viewportPadding) {
      left = window.innerWidth - popupWidth - viewportPadding;
    }
    if (top + popupHeight > window.innerHeight - viewportPadding) {
      top = anchorRect.top - popupHeight - gap;
    }

    left = Math.max(viewportPadding, left);
    top = Math.max(viewportPadding, top);
    this.popupEl.style.left = `${Math.round(left)}px`;
    this.popupEl.style.top = `${Math.round(top)}px`;
  }

  getTwitchChannelName() {
    const channel = typeof this.getCurrentTwitchChannel === 'function'
      ? this.getCurrentTwitchChannel()
      : '';
    return this.normalizeLogin(channel);
  }

  normalizeLogin(value) {
    return String(value || '').trim().toLowerCase().replace(/^[@#]+/, '');
  }

  isSafeImageUrl(url) {
    if (typeof url !== 'string') return false;
    try {
      return new URL(url).protocol === 'https:';
    } catch (error) {
      return false;
    }
  }
}

window.TwitchUserPopup = TwitchUserPopup;
window.getTwitchUserData = getTwitchUserData;
