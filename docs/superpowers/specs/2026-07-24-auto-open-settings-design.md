# Design Spec: Auto-open Settings Modal When No Channels Are Configured

## Overview
When MultiChat is loaded, if no channel address (Twitch, Kick, VK Live, YouTube) is specified in `localStorage` settings, the settings modal dialog should open automatically so the user can immediately configure their channels.

## Requirements
1. Check configured channels upon application initialization.
2. If all 4 channel fields (`twitchChannel`, `kickChannel`, `vkChannel`, `youtubeChannel`) are empty or contain only whitespace:
   - Populate the settings form with existing state.
   - Open the settings modal (`#settingsModal`).
3. If at least one channel field is specified, do not open the modal automatically.

## Proposed Architecture & Changes

### 1. `SettingsManager` (`js/settings.js`)
Add a helper method `hasAnyChannelConfigured()`:
```javascript
hasAnyChannelConfigured() {
  const s = this.settings;
  return !!(
    (s.twitchChannel && s.twitchChannel.trim()) ||
    (s.kickChannel && s.kickChannel.trim()) ||
    (s.vkChannel && s.vkChannel.trim()) ||
    (s.youtubeChannel && s.youtubeChannel.trim())
  );
}
```

### 2. `MultiChatApp` (`js/app.js`)
1. Refactor modal opening into a helper method `openSettingsModal()`:
```javascript
openSettingsModal() {
  const modalEl = document.getElementById('settingsModal');
  if (modalEl) {
    this.settings.populateForm();
    modalEl.classList.remove('hidden');
  }
}
```
2. Call `this.openSettingsModal()` in `initUI()` if `!this.settings.hasAnyChannelConfigured()`.

## Verification Plan
1. Clear `multichat_settings` in `localStorage` (or test with fresh defaults).
2. Open `index.html` in browser — settings modal should pop up automatically.
3. Enter a channel name (e.g., Twitch: `testchannel`), save settings.
4. Reload page — settings modal should NOT pop up automatically.
