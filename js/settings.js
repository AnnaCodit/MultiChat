/**
 * Settings Manager for MultiChat
 * Manages configuration and persistence using localStorage.
 */

const STORAGE_KEY = 'multichat_settings';

const defaultSettings = {
  twitchChannel: '',
  kickChannel: '',
  vkChannel: '',
  youtubeChannel: '',
  extraNicknames: '',
  hideChatterReplies: true,
  enableThirdPartyEmotes: true,
  hideTwitchBadges: false,
  fontSize: 16,
  firstMessageWindowHours: 12,
  maxChatMessages: 200
};

class SettingsManager {
  constructor() {
    this.settings = this.loadSettings();
  }

  loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const settings = { ...defaultSettings, ...parsed };
        const stringFields = [
          'twitchChannel',
          'kickChannel',
          'vkChannel',
          'youtubeChannel',
          'extraNicknames'
        ];
        stringFields.forEach(field => {
          if (typeof settings[field] !== 'string') {
            settings[field] = defaultSettings[field] || '';
          }
        });
        return settings;
      }
    } catch (e) {
      console.error('[MultiChat Settings] Error reading settings from localStorage:', e);
    }
    return { ...defaultSettings };
  }

  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      console.log('[MultiChat Settings] Settings saved:', this.settings);
    } catch (e) {
      console.error('[MultiChat Settings] Error saving settings to localStorage:', e);
    }
  }

  /**
   * Returns true if at least one platform channel is configured.
   */
  hasAnyChannelConfigured() {
    const s = this.settings;
    return [
      s.twitchChannel,
      s.kickChannel,
      s.vkChannel,
      s.youtubeChannel
    ].some(channel => typeof channel === 'string' && channel.trim().length > 0);
  }

  /**
   * Returns a normalized array of all streamer nicknames
   * (channel names from all platforms + extra nicknames), stripping leading '@'.
   */
  getStreamerNicknames() {
    const names = new Set();
    
    const cleanNick = (str) => (typeof str === 'string' ? str : '').toLowerCase().trim().replace(/^@+/, '');
    const addIfNotEmpty = (str) => {
      const cleaned = cleanNick(str);
      if (cleaned) names.add(cleaned);
    };

    // Add channel names
    addIfNotEmpty(this.settings.twitchChannel);
    addIfNotEmpty(this.settings.kickChannel);
    addIfNotEmpty(this.settings.vkChannel);
    addIfNotEmpty(this.settings.youtubeChannel);

    // Add extra nicknames
    if (typeof this.settings.extraNicknames === 'string' && this.settings.extraNicknames) {
      const extraList = this.settings.extraNicknames.split(',');
      extraList.forEach(n => addIfNotEmpty(n));
    }

    return Array.from(names);
  }

  /**
   * Populate HTML Form inputs from current settings state.
   */
  populateForm() {
    document.getElementById('twitchChannel').value = this.settings.twitchChannel || '';
    document.getElementById('kickChannel').value = this.settings.kickChannel || '';
    document.getElementById('vkChannel').value = this.settings.vkChannel || '';
    document.getElementById('youtubeChannel').value = this.settings.youtubeChannel || '';
    document.getElementById('extraNicknames').value = this.settings.extraNicknames || '';
    
    document.getElementById('hideChatterReplies').checked = !!this.settings.hideChatterReplies;
    document.getElementById('enableThirdPartyEmotes').checked = !!this.settings.enableThirdPartyEmotes;
    document.getElementById('hideTwitchBadges').checked = !!this.settings.hideTwitchBadges;
    
    document.getElementById('fontSizeRange').value = this.settings.fontSize || 16;
    document.getElementById('fontSizeVal').textContent = (this.settings.fontSize || 16) + 'px';

    const windowInput = document.getElementById('firstMessageWindowHours');
    if (windowInput) {
      windowInput.value = this.settings.firstMessageWindowHours || 12;
    }

    const maxMessagesInput = document.getElementById('maxChatMessages');
    if (maxMessagesInput) {
      maxMessagesInput.value = this.settings.maxChatMessages || 200;
    }
  }

  /**
   * Read values from form inputs and update settings.
   */
  readForm() {
    const windowInput = document.getElementById('firstMessageWindowHours');
    const maxMessagesInput = document.getElementById('maxChatMessages');
    const newSettings = {
      twitchChannel: document.getElementById('twitchChannel').value.trim(),
      kickChannel: document.getElementById('kickChannel').value.trim(),
      vkChannel: document.getElementById('vkChannel').value.trim(),
      youtubeChannel: document.getElementById('youtubeChannel').value.trim(),
      extraNicknames: document.getElementById('extraNicknames').value.trim(),
      hideChatterReplies: document.getElementById('hideChatterReplies').checked,
      enableThirdPartyEmotes: document.getElementById('enableThirdPartyEmotes').checked,
      hideTwitchBadges: document.getElementById('hideTwitchBadges').checked,
      fontSize: parseInt(document.getElementById('fontSizeRange').value, 10) || 16,
      firstMessageWindowHours: windowInput ? (parseInt(windowInput.value, 10) || 12) : 12,
      maxChatMessages: maxMessagesInput ? (parseInt(maxMessagesInput.value, 10) || 200) : 200
    };
    this.saveSettings(newSettings);
    return this.settings;
  }
}

// Global instance
window.settingsManager = new SettingsManager();
