// Adapter boot — loaded by the service worker via importScripts() at the
// end of background.js. This file is the entry point for everything
// platform-specific: webRequest listeners for platform-specific URLs,
// runtime message handlers for payloads sent by content scripts, and the
// optional `self.adapter` hooks that extend the download flow.
//
// INTERFACE WITH THE CORE
//
// The core exposes these as globals inside the service worker scope
// (they are plain function declarations in background.js, so they live
// on `self`):
//
//   - queueStateUpdate(fn)
//   - getTabState(tabId), setTabState(tabId, state), patchTabState(tabId, patch)
//   - notifyPopup(tabId)
//
// The adapter may optionally populate `self.adapter` with these hooks;
// the core calls them if present, otherwise falls back to bare defaults:
//
//   - self.adapter.onBeforeDownload(tabId)
//       Fired before a download job is sent to the native host. Good
//       place to trigger scrollback loading, metadata refresh, etc.
//
//   - self.adapter.buildJobExtras(state)
//       Returns an object merged into the job payload. Use to attach
//       platform-specific captures (chat transcripts, slide URLs, auth
//       tokens, etc.) that the host pipeline consumes.
//
//   - self.adapter.prePopulateDownload(state)
//       Returns { materials, multimedia }. Pre-populates the popup UI
//       so the user sees pending items before the host starts emitting
//       progress events.
//
// IMPLEMENTATION CHECKLIST (copy this file into your own adapter)
//
//   [ ] Register chrome.webRequest listeners for your platform's API
//       hosts (chat, materials, slides CDN, auth token sources). Refer
//       to README.md for URL patterns.
//
//   [ ] Register chrome.runtime.onMessage handlers for custom payloads
//       your content scripts send (metadata scrape, chat snapshots,
//       materials listing, etc.).
//
//   [ ] If you need the download flow to know about captured chat,
//       slides URLs, auth tokens — implement self.adapter.buildJobExtras.
//
//   [ ] If the popup should show pending items before the host runs,
//       implement self.adapter.prePopulateDownload.
//
// This skeleton does nothing — it only logs a warning so you know the
// default adapter is active (i.e. nothing platform-specific is wired up).

console.log(
  "[skeleton] adapter-boot loaded — no platform-specific listeners " +
    "registered. Replace adapters/skeleton/ with your own adapter, or use " +
    "apply-to-public-clone.sh to wire up a plugin adapter."
);
