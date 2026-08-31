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
  blockedKeywords: '',
  ignoredUsers: 'Nightbot, StreamElements, Moobot, Fossabot, Wizebot, Botisimo, Streamlabs, RestreamBot',
  favoriteUsers: '',
  hideChatterReplies: true,
  enableThirdPartyEmotes: true,
  hideTwitchBadges: false,
  highlightStreamers: true,
  streamerMinViewers: 20,
  fontSize: 16,
  firstMessageWindowHours: 12,
  raidLeaderDurationMinutes: 10,
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
          'extraNicknames',
          'blockedKeywords',
          'ignoredUsers',
          'favoriteUsers'
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
   * Returns a normalized array of lowercased, trimmed keywords/phrases to block.
   */
  getBlockedKeywords() {
    if (typeof this.settings.blockedKeywords !== 'string' || !this.settings.blockedKeywords) {
      return [];
    }
    return this.settings.blockedKeywords
      .split(',')
      .map(kw => kw.toLowerCase().trim().replace(/\s+/g, ' '))
      .filter(Boolean);
  }

  /**
   * Returns a normalized array of lowercased, trimmed ignored usernames without leading '@'.
   */
  getIgnoredUsers() {
    if (typeof this.settings.ignoredUsers !== 'string' || !this.settings.ignoredUsers) {
      return [];
    }
    const cleanNick = (str) => (typeof str === 'string' ? str : '').toLowerCase().trim().replace(/^@+/, '');
    const names = new Set();
    this.settings.ignoredUsers
      .split(',')
      .map(n => cleanNick(n))
      .filter(Boolean)
      .forEach(n => names.add(n));
    return Array.from(names);
  }

  /**
   * Returns a normalized array of lowercased, trimmed favorite usernames without leading '@'.
   */
  getFavoriteUsers() {
    if (typeof this.settings.favoriteUsers !== 'string' || !this.settings.favoriteUsers) {
      return [];
    }
    const cleanNick = (str) => (typeof str === 'string' ? str : '').toLowerCase().trim().replace(/^@+/, '');
    const names = new Set();
    this.settings.favoriteUsers
      .split(',')
      .map(n => cleanNick(n))
      .filter(Boolean)
      .forEach(n => names.add(n));
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
    
    const favoriteUsersInput = document.getElementById('favoriteUsers');
    if (favoriteUsersInput) {
      favoriteUsersInput.value = this.settings.favoriteUsers || '';
    }

    const blockedKeywordsInput = document.getElementById('blockedKeywords');
    if (blockedKeywordsInput) {
      blockedKeywordsInput.value = this.settings.blockedKeywords || '';
    }

    const ignoredUsersInput = document.getElementById('ignoredUsers');
    if (ignoredUsersInput) {
      ignoredUsersInput.value = this.settings.ignoredUsers || '';
    }

    document.getElementById('hideChatterReplies').checked = !!this.settings.hideChatterReplies;
    document.getElementById('enableThirdPartyEmotes').checked = !!this.settings.enableThirdPartyEmotes;
    document.getElementById('hideTwitchBadges').checked = !!this.settings.hideTwitchBadges;
    
    const highlightStreamersInput = document.getElementById('highlightStreamers');
    if (highlightStreamersInput) {
      highlightStreamersInput.checked = this.settings.highlightStreamers !== false;
    }

    const streamerMinViewersInput = document.getElementById('streamerMinViewers');
    if (streamerMinViewersInput) {
      streamerMinViewersInput.value = typeof this.settings.streamerMinViewers === 'number' ? this.settings.streamerMinViewers : 20;
    }

    document.getElementById('fontSizeRange').value = this.settings.fontSize || 16;
    document.getElementById('fontSizeVal').textContent = (this.settings.fontSize || 16) + 'px';

    const windowInput = document.getElementById('firstMessageWindowHours');
    if (windowInput) {
      windowInput.value = this.settings.firstMessageWindowHours || 12;
    }

    const raidLeaderInput = document.getElementById('raidLeaderDurationMinutes');
    if (raidLeaderInput) {
      raidLeaderInput.value = this.settings.raidLeaderDurationMinutes || 10;
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
    const raidLeaderInput = document.getElementById('raidLeaderDurationMinutes');
    const maxMessagesInput = document.getElementById('maxChatMessages');
    const blockedKeywordsInput = document.getElementById('blockedKeywords');
    const ignoredUsersInput = document.getElementById('ignoredUsers');
    const favoriteUsersInput = document.getElementById('favoriteUsers');
    const highlightStreamersInput = document.getElementById('highlightStreamers');
    const streamerMinViewersInput = document.getElementById('streamerMinViewers');

    const newSettings = {
      twitchChannel: document.getElementById('twitchChannel').value.trim(),
      kickChannel: document.getElementById('kickChannel').value.trim(),
      vkChannel: document.getElementById('vkChannel').value.trim(),
      youtubeChannel: document.getElementById('youtubeChannel').value.trim(),
      extraNicknames: document.getElementById('extraNicknames').value.trim(),
      favoriteUsers: favoriteUsersInput ? favoriteUsersInput.value.trim() : (this.settings.favoriteUsers || ''),
      blockedKeywords: blockedKeywordsInput ? blockedKeywordsInput.value.trim() : (this.settings.blockedKeywords || ''),
      ignoredUsers: ignoredUsersInput ? ignoredUsersInput.value.trim() : (this.settings.ignoredUsers || ''),
      hideChatterReplies: document.getElementById('hideChatterReplies').checked,
      enableThirdPartyEmotes: document.getElementById('enableThirdPartyEmotes').checked,
      hideTwitchBadges: document.getElementById('hideTwitchBadges').checked,
      highlightStreamers: highlightStreamersInput ? highlightStreamersInput.checked : (this.settings.highlightStreamers !== false),
      streamerMinViewers: streamerMinViewersInput ? (parseInt(streamerMinViewersInput.value, 10) || 20) : (this.settings.streamerMinViewers || 20),
      fontSize: parseInt(document.getElementById('fontSizeRange').value, 10) || 16,
      firstMessageWindowHours: windowInput ? (parseInt(windowInput.value, 10) || 12) : 12,
      raidLeaderDurationMinutes: raidLeaderInput ? (parseInt(raidLeaderInput.value, 10) || 10) : 10,
      maxChatMessages: maxMessagesInput ? (parseInt(maxMessagesInput.value, 10) || 200) : 200
    };
    this.saveSettings(newSettings);
    return this.settings;
  }
}

// Global instance & CommonJS export
if (typeof window !== 'undefined') {
  window.settingsManager = new SettingsManager();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SettingsManager;
}
