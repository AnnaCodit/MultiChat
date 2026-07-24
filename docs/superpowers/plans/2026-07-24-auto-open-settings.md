# Auto-open Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically open the settings modal on page load if no channel address (Twitch, Kick, VK Live, YouTube) is configured.

**Architecture:** Add a `hasAnyChannelConfigured()` method to `SettingsManager` in `js/settings.js`, refactor modal open logic in `MultiChatApp` in `js/app.js`, and invoke it upon initialization if no channel is configured.

**Tech Stack:** Vanilla JavaScript (ES6+), HTML5, CSS3.

## Global Constraints
- Do not introduce external dependencies.
- Follow existing patterns in `js/settings.js` and `js/app.js`.

---

### Task 1: Add `hasAnyChannelConfigured()` to `SettingsManager`

**Files:**
- Modify: `js/settings.js:48-52`

**Interfaces:**
- Produces: `settingsManager.hasAnyChannelConfigured(): boolean`

- [ ] **Step 1: Implement `hasAnyChannelConfigured()` method in `SettingsManager`**

In [js/settings.js](file:///C:/FRA3A/projects/multichat-gemini/js/settings.js), add the method `hasAnyChannelConfigured()` to `SettingsManager` class:

```javascript
  /**
   * Returns true if at least one platform channel is configured.
   */
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

- [ ] **Step 2: Verify method functionality**

Run in browser console or node evaluation:
`window.settingsManager.hasAnyChannelConfigured()` should return `false` when default empty channels are present, and `true` when at least one channel string is non-empty.

- [ ] **Step 3: Commit changes**

```bash
git add js/settings.js
git commit -m "feat(settings): add hasAnyChannelConfigured method"
```

---

### Task 2: Refactor `openSettingsModal()` and auto-open in `MultiChatApp`

**Files:**
- Modify: `js/app.js:80-92`

**Interfaces:**
- Consumes: `window.settingsManager.hasAnyChannelConfigured(): boolean`

- [ ] **Step 1: Add `openSettingsModal()` helper and auto-open trigger in `MultiChatApp`**

In [js/app.js](file:///C:/FRA3A/projects/multichat-gemini/js/app.js):

1. Add `openSettingsModal()` method to `MultiChatApp`:
```javascript
  openSettingsModal() {
    const modalEl = document.getElementById('settingsModal');
    if (modalEl) {
      this.settings.populateForm();
      modalEl.classList.remove('hidden');
    }
  }
```

2. Update `openBtn` listener in `initUI()` to call `this.openSettingsModal()`.

3. At the end of `initUI()`, check if `!this.settings.hasAnyChannelConfigured()` and call `this.openSettingsModal()`:
```javascript
    if (!this.settings.hasAnyChannelConfigured()) {
      this.openSettingsModal();
    }
```

- [ ] **Step 2: Verification**

1. Clear `multichat_settings` from `localStorage` in browser devtools.
2. Refresh page. Verify settings modal pops up automatically on launch.
3. Enter a channel (e.g. `teststream`), click "Сохранить".
4. Refresh page. Verify settings modal does NOT pop up automatically.

- [ ] **Step 3: Commit changes**

```bash
git add js/app.js
git commit -m "feat(app): auto-open settings modal when no channel is configured"
```
