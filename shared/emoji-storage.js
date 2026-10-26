// Shared chrome.storage.sync helpers for the customizable reaction bar and
// the recently-used emoji list. Used by both the fullscreen page overlay
// (content script) and the side panel. Classic script - attaches to WT.

(function (global) {
  const WT = global.WT = global.WT || {};
  const { STORAGE_KEYS, DEFAULT_REACTIONS, MAX_REACTION_BAR, MAX_RECENT_EMOJI } = WT;

  WT.emojiStore = {
    async getReactionBar() {
      const got = await chrome.storage.sync.get(STORAGE_KEYS.REACTION_BAR);
      const bar = got[STORAGE_KEYS.REACTION_BAR];
      return Array.isArray(bar) && bar.length ? bar : DEFAULT_REACTIONS.slice();
    },

    async setReactionBar(bar) {
      const trimmed = bar.slice(0, MAX_REACTION_BAR);
      await chrome.storage.sync.set({ [STORAGE_KEYS.REACTION_BAR]: trimmed });
      return trimmed;
    },

    async resetReactionBar() {
      await chrome.storage.sync.set({ [STORAGE_KEYS.REACTION_BAR]: DEFAULT_REACTIONS.slice() });
      return DEFAULT_REACTIONS.slice();
    },

    async getRecentEmoji() {
      const got = await chrome.storage.sync.get(STORAGE_KEYS.RECENT_EMOJI);
      const recent = got[STORAGE_KEYS.RECENT_EMOJI];
      return Array.isArray(recent) ? recent : [];
    },

    async recordRecentEmoji(emoji) {
      const recent = await WT.emojiStore.getRecentEmoji();
      const next = [emoji, ...recent.filter((e) => e !== emoji)].slice(0, MAX_RECENT_EMOJI);
      await chrome.storage.sync.set({ [STORAGE_KEYS.RECENT_EMOJI]: next });
      return next;
    },

    async clearRecentEmoji() {
      await chrome.storage.sync.set({ [STORAGE_KEYS.RECENT_EMOJI]: [] });
      return [];
    }
  };
})(typeof window !== 'undefined' ? window : self);
