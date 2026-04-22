// Content script, ISOLATED world, run_at=document_idle. Scrapes
// metadata (title, presenter, date) from the page DOM and messages it
// to the background service worker. Also handles any commands the
// background sends to the page (e.g. refresh metadata, trigger chat
// scrollback, etc).
//
// ADAPTATION CHECKLIST
//
//   [ ] Replace SELECTORS with CSS/XPath paths to your page's metadata
//       elements. Most LMS players render these async — a polling loop
//       plus a MutationObserver usually handles both initial render and
//       SPA navigations.
//
//   [ ] Send scraped metadata via chrome.runtime.sendMessage. Your
//       adapter-boot.js picks this up and stores it in tab state so the
//       core download flow can use it for the filename/title.
//
//   [ ] If the chat hook needs on-demand scrollback (because the chat
//       UI only loads the latest N messages until the user scrolls up),
//       listen for { type: "startScrollback" } from the background and
//       simulate scroll events.
//
// This skeleton does nothing useful — it only logs that it loaded so
// you can verify content_scripts are wired up in manifest.json.

(function () {
  // TODO: adjust to your platform's DOM structure.
  const SELECTORS = {
    title: null,     // e.g. "h1.lecture-title"
    presenter: null, // e.g. ".instructor-name"
    date: null,      // e.g. ".lecture-date"
  };

  function scrapeMetadata() {
    // TODO: implement using SELECTORS above.
    return null;
  }

  function sendMetadata() {
    const m = scrapeMetadata();
    if (!m) return;
    chrome.runtime.sendMessage({ type: "setMetadata", metadata: m }).catch(() => {});
  }

  // Respond to background commands (your adapter may extend this).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "refreshMetadata") {
      sendMetadata();
      sendResponse({ ok: true });
      return;
    }
    // Add your own commands here (e.g. "startScrollback").
  });

  console.log("[skeleton] content.js loaded at", location.href);
})();
