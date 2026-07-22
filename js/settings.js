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
  fontSize: 16
};

class SettingsManager {
  constructor() {
    this.settings = this.loadSettings();
  }

  loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return { ...defaultSettings, ...JSON.parse(saved) };
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
   * Returns a normalized array of all streamer nicknames
   * (channel names from all platforms + extra nicknames), stripping leading '@'.
   */
  getStreamerNicknames() {
    const names = new Set();
    
    const cleanNick = (str) => (str || '').toLowerCase().trim().replace(/^@+/, '');

    // Add channel names
    if (this.settings.twitchChannel) names.add(cleanNick(this.settings.twitchChannel));
    if (this.settings.kickChannel) names.add(cleanNick(this.settings.kickChannel));
    if (this.settings.vkChannel) names.add(cleanNick(this.settings.vkChannel));
    if (this.settings.youtubeChannel) names.add(cleanNick(this.settings.youtubeChannel));

    // Add extra nicknames
    if (this.settings.extraNicknames) {
      const extraList = this.settings.extraNicknames.split(',');
      extraList.forEach(n => {
        const cleaned = cleanNick(n);
        if (cleaned) names.add(cleaned);
      });
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
    
    document.getElementById('fontSizeRange').value = this.settings.fontSize || 16;
    document.getElementById('fontSizeVal').textContent = (this.settings.fontSize || 16) + 'px';
  }

  /**
   * Read values from form inputs and update settings.
   */
  readForm() {
    const newSettings = {
      twitchChannel: document.getElementById('twitchChannel').value.trim(),
      kickChannel: document.getElementById('kickChannel').value.trim(),
      vkChannel: document.getElementById('vkChannel').value.trim(),
      youtubeChannel: document.getElementById('youtubeChannel').value.trim(),
      extraNicknames: document.getElementById('extraNicknames').value.trim(),
      hideChatterReplies: document.getElementById('hideChatterReplies').checked,
      enableThirdPartyEmotes: document.getElementById('enableThirdPartyEmotes').checked,
      fontSize: parseInt(document.getElementById('fontSizeRange').value, 10) || 16
    };
    this.saveSettings(newSettings);
    return this.settings;
  }
}

// Global instance
window.settingsManager = new SettingsManager();
