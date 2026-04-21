# Skeleton Adapter

This is a **placeholder adapter**. It demonstrates the shape an adapter takes
without targeting any real platform. To make the extension work for your
LMS, duplicate this folder under a new name and replace every `{{PLACEHOLDER}}`
with your platform's specifics.

## What an adapter is responsible for

An adapter supplies the platform-specific pieces that the generic core
cannot know about:

1. **URL patterns** — which hosts carry the chat API, materials API,
   slides CDN, and video player
2. **Chat decoding** — shape of the SignalR / MessagePack payloads (or
   REST / WebSocket / SSE, depending on the platform) and how each field
   maps to a conceptual message
3. **Materials API** — endpoint path, pagination, and response shape
4. **Metadata scrape** — DOM selectors for lecture title, instructor,
   and date
5. **Auth** — how Bearer tokens (or cookies, or session keys) are acquired

See [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md) for the rationale
behind each piece — this README focuses on "how to adapt", not "why".

## Step-by-step

### 1. Duplicate this folder

```bash
cp -r extension/adapters/skeleton extension/adapters/<your-platform-name>
```

### 2. Identify your platform's chat backend

Open your LMS in Chrome, load a lecture with an active chat, and open
DevTools → Network tab. Look for:

- **WebSocket connections** (WS filter). If the LMS uses SignalR, you'll
  see frames with binary payloads. That's MessagePack.
- **XHR endpoints** called `/Chat/...`, `/Messages/...`, or similar. These
  are the REST scaffold — often return 0 bytes (the real data is over WS).

Note the **host** and the **endpoint paths**. You'll put these in
`chat-hook.js`.

### 3. Decode a sample SignalR frame

Copy the binary payload of a WebSocket frame (right-click → Copy as ...)
and decode it with the Python reference:

```python
from host.core import messagepack
with open("frame.bin", "rb") as f:
    print(messagepack.decode(f.read()))
```

The output will reveal the payload shape — typically an array like
`[type, headers, invocationId, target, args, ...]`. Identify which
`target` names carry chat messages, Q&A, pinned items, etc., and the
shape of each `args` entry.

### 4. Update `chat-hook.js`

In your new `chat-hook.js`:

- Replace `HOST = "your-lms-chat-api.example.com"` with your chat host
- Update `ENDPOINT_LABEL` with your REST paths and the labels you want
  to emit (e.g., `"conversations"`, `"questions"`, `"pinned"`)
- Adjust the MessagePack `target` filters to match the invocation names
  you identified in step 3
- Adjust the field mapping in the payload decoder so each message comes
  out with consistent fields: `{id, authorId, authorName, text, timestamp, ...}`

### 5. Update `materials-hook.js`

Same approach: find the materials API call in DevTools, note the host
and path, update `HOST` and the endpoint matcher.

### 6. Update `metadata-scrape.js`

In DevTools → Elements, find the DOM elements that hold the lecture
title, instructor name, and date. Update the CSS selectors in
`scrapeMetadata()`.

### 7. Update `manifest.json`

At the repository root, edit `extension/manifest.json`:

- Add your LMS origin to `host_permissions`
- Change every `"matches"` entry in `content_scripts` from
  `https://your-lms.example.com/*` to your LMS origin
- Change the file paths in each content_scripts entry from
  `adapters/skeleton/...` to `adapters/<your-platform-name>/...`

Reload the extension in `chrome://extensions` and verify the content
scripts are injected on your LMS (check the Network tab; you should see
`[hook]` logs or equivalent).

### 8. Test end-to-end

Open a lecture, play it for 30 seconds (so the 1080p HLS chunks get
captured), open the popup. You should see flavors and KS captured. Click
Download — the host should receive a complete request and write files
under `~/Downloads/<your folder>`.

## Things that typically break

- **CSS selectors change across LMS versions.** If your scrape returns
  nulls, use `MutationObserver` like `metadata-scrape.js` does.
- **The page overwrites `window.fetch` after you install your wrapper.**
  This is why `chat-hook.js` has a guard timer that reinstalls the wrapper
  for the first 15 seconds. Leave it in.
- **`chrome.runtime.sendMessage` fails silently if the popup is closed.**
  Wrap in `.catch(() => {})` everywhere.
- **`extraHeaders` is required for the `Authorization` header.** Already
  wired in the core webRequest listeners.
