# Writing an Adapter

This guide walks through the full process of adapting this toolkit to a new
Kaltura-based LMS. It goes deeper than the
[skeleton adapter README](../extension/adapters/skeleton/README.md), which
covers *what* to change. This document covers *why* and *how to discover*
what values to put there.

---

## Prerequisites

- **Chrome DevTools — Network tab.** You need to identify the chat API host,
  transport type, and payload shape before writing a line of code. The Network
  tab is where that investigation happens.
- **Reading binary data.** If the platform uses SignalR, the WebSocket frames
  are binary (MessagePack). You'll decode one or two frames manually via a
  Python one-liner before writing any hook code.
- **Basic Python.** Enough to run a script and read dict output. No library
  installs beyond what's already in `requirements-dev.txt`.
- **About 60–90 minutes** for a first pass, assuming the platform's network
  traffic is not heavily obfuscated.

---

## Anatomy of an adapter

An adapter is split across two directories — one for the extension, one for
the Python host. Together they provide everything the generic core cannot know:
the URL patterns, payload shapes, and field mappings specific to one platform.

### Extension side (`extension/adapters/<name>/`)

| File | World | Responsibility |
| ---- | ----- | -------------- |
| `chat-hook.js` | MAIN | Monkey-patches `window.fetch`, `XMLHttpRequest`, and optionally `window.WebSocket` to intercept chat API traffic. Runs at `document_start`. |
| `chat-bridge.js` | ISOLATED | Listens for `window.postMessage` events from `chat-hook.js` and forwards them to the service worker via `chrome.runtime.sendMessage`. |
| `materials-hook.js` | MAIN | Same pattern as `chat-hook.js`, but targets the materials list API endpoint. |
| `materials-bridge.js` | ISOLATED | Same pattern as `chat-bridge.js`, but for materials captures. |
| `metadata-scrape.js` | ISOLATED | Reads lecture title, instructor, and date from the DOM using CSS selectors. Uses `MutationObserver` in case the DOM isn't ready at `document_start`. |
| `messagepack-decoder.js` | MAIN | Shared decoder — do not modify. Loaded before `chat-hook.js` by `manifest.json`. |

The MAIN / ISOLATED split is a Chrome MV3 constraint: MAIN-world scripts share
the page's JavaScript context (so they can monkey-patch `window.fetch`);
ISOLATED-world scripts can call `chrome.runtime.*` APIs. The bridge files exist
solely to bridge that gap via `postMessage`.

### Python host side (`host/adapters/<name>/`)

| File | Responsibility |
| ---- | -------------- |
| `chat_to_markdown.py` | Converts the raw chat captures (dicts of messages by channel) to readable Markdown files. One file per channel. |
| `materials_downloader.py` | Parses the raw materials API response, performs authenticated downloads, and writes files to the output directory. |

---

## 1. Discovery phase — Chrome DevTools

Open your LMS in Chrome, navigate to a lecture page with an active chat, and
open DevTools (`F12` or `Cmd+Opt+I`).

### Finding the chat API host

1. Go to the **Network** tab.
2. Set the filter to **Fetch/XHR**.
3. Reload the lecture page.
4. In the filter box, type `Chat` — look for XHR calls to something like
   `/Chat/Messages/Initial` or `/api/chat/history`.
5. Click the matching request. In the **Headers** panel, note:
   - The **Request URL** — extract the host (e.g., `chat-api.your-lms.com`).
   - The **Authorization** header — `Bearer <token>` confirms Bearer token auth.
6. Check the **Preview** or **Response** tab:
   - If it shows JSON chat messages, that's a REST endpoint with real data.
   - If the response body is **empty (0 bytes)**, the real data arrives over
     WebSocket. This is the SignalR pattern — continue to the next step.

### Identifying the transport

Still in the Network tab, switch the filter to **WS** (WebSocket).

- If there is **no WebSocket connection** listed, the platform uses plain REST
  or SSE. The XHR hook alone is sufficient.
- If there is a WebSocket connection with **binary messages** in the Messages
  panel (the payload column shows raw bytes or a download icon), the platform
  is almost certainly using **SignalR over MessagePack**. You need the WebSocket
  hook.
- If the WebSocket messages are **plain text** starting with `{`, it is
  SignalR over JSON or a custom WebSocket protocol. You can adapt the WebSocket
  hook to parse JSON instead of MessagePack.

### Copying a binary WebSocket frame

When you have identified a SignalR/MessagePack connection:

1. Click the WebSocket entry in the Network tab.
2. Go to the **Messages** sub-tab.
3. Find a message frame that looks like it carries a chat event (they arrive
   after someone sends a message in chat).
4. Right-click the frame → **Copy message** (or **Copy as binary** in some
   Chrome versions). The exact option label varies between Chrome versions.
5. Paste into a file — if it pastes as hex bytes (e.g., `\x93\x01\x80...`),
   write a short Python script to decode the escape sequences. If it pastes
   as raw bytes, save directly as `frame.bin`.

Alternatively, use the DevTools **Console** with a breakpoint in `WebSocket`
to capture `event.data` as an `ArrayBuffer` and export it.

### Finding the materials API host

Repeat the same Fetch/XHR filter process but search for `Material`, `File`,
`Document`, or `Resource`. Note the host and endpoint path.

### Finding the slides CDN (optional)

If the lecture includes a slide deck served from a separate PDF viewer:

1. Filter Fetch/XHR by `pdf` or `slide`.
2. If no match, filter **All** and look for requests with `Content-Type:
   application/pdf` in the Response Headers.
3. The service worker's `webRequest` listener already captures PDF URLs — you
   only need to ensure the CDN host is listed in `host_permissions`.

---

## 2. Decoding a SignalR/MessagePack frame

Once you have `frame.bin`, decode it using the Python reference implementation:

```bash
# From the repo root, with the venv active:
python3 -c "
from host.core import messagepack
data = open('frame.bin', 'rb').read()
print(messagepack.decode(data))
"
```

A typical SignalR invocation frame decodes to:

```python
[1, {}, None, "ReceiveMessage", [{"id": "abc123", "author": "Alice", "text": "hello", "timestamp": 1700000000}]]
```

The SignalR frame shape is always a MessagePack array whose elements are:

| Index | Meaning |
| ----- | ------- |
| 0 | Message type (1 = invocation, 6 = ping) |
| 1 | Headers dict (usually empty `{}`) |
| 2 | Invocation ID (usually `None` for server-push events) |
| 3 | Target — the string name of the hub method being invoked |
| 4 | Args — a list; typically `args[0]` is the payload object |

Multiple frames may be packed into a single WebSocket message, each prefixed
with a varint length byte. The `readVarint` helper in the chat-hook skeleton
handles this.

Repeat this for a few frames to understand which `target` names carry each
category: main chat messages, Q&A questions, pinned messages, etc.

---

## 3. Field mapping

Once you can read decoded frames, write down the mapping from platform fields
to the internal shape your `chat_to_markdown.py` will consume. Example:

Platform frame `args[0]`:

```python
{
    "MessageId":  "abc123",
    "UserName":   "alice",
    "Body":       "hello world",
    "TimeSent":   1700000000,
    "ReplyToId":  None,
}
```

Internal shape you want to produce:

```python
{
    "id":        "abc123",
    "author":    "alice",
    "text":      "hello world",
    "timestamp": 1700000000,
    "reply_to":  None,
}
```

Write the mapping explicitly in a comment at the top of `chat-hook.js` before
touching any code. Having it written down prevents mismatches between the JS
hook (which produces the raw capture) and the Python renderer (which consumes
it).

---

## 4. Writing `chat-hook.js`

Start from `extension/adapters/skeleton/chat-hook.js` (copied to your adapter
folder). Make the following changes:

**Replace `HOST`:**

```js
const HOST = "chat-api.your-lms.com"; // replace with the real host you found
```

**Adjust `ENDPOINT_LABEL`:**

```js
const ENDPOINT_LABEL = {
  "/Chat/Messages/Initial": "conversations",
  "/QA/Questions/Initial":  "questions",
  "/Chat/Messages/Pinned":  "pinned",
};
```

Add, remove, or rename entries to match your platform's REST paths. The label
strings (`"conversations"`, `"questions"`, `"pinned"`) become the keys in
`captures` that your Python `chat_to_markdown.py` will read.

**Enable the WebSocket hook (SignalR platforms):**

Uncomment the WebSocket section at the bottom of `chat-hook.js`. Then adjust
`TARGET_TO_LABEL` with the `target` strings you found in step 2:

```js
const TARGET_TO_LABEL = {
  ReceiveMessage:  "conversations",
  ReceiveQuestion: "questions",
  PinMessage:      "pinned",
};
```

Each incoming invocation with a matching target will call `post(label, args[0])`
— forwarding one message object at a time to `chat-bridge.js`.

Note: if the REST endpoint returns real data (not 0 bytes), the `fetch` / XHR
wrappers already handle it. You only need the WebSocket hook if the real data
arrives over SignalR.

---

## 5. Writing `chat_to_markdown.py`

The function signature is fixed — the host core calls it:

```python
def chat_to_markdown(captures: dict, output_dir: Path, title: str) -> list[Path]:
    ...
```

`captures` will contain one key per label you defined in `chat-hook.js`,
each pointing to a list of message dicts in the shape you designed in step 3.

Structure your implementation around these concerns:

**Sort chronologically.** Messages arrive in the order WebSocket frames were
received, which is not always chronological. Sort by `timestamp` before
rendering.

**Handle replies with indentation.** If `reply_to` is present and non-null,
find the parent message and render the reply indented under it in Markdown:

```markdown
**Alice** — 10:01
hello world

  > **Bob** (reply) — 10:02
  > good point!
```

**Write one file per channel.** Avoid a single huge file — one `.md` for
conversations, one for Q&A, one for pinned. Return the list of written `Path`
objects so the host core can log them.

**Timestamp localization.** The raw `timestamp` is typically a Unix epoch in
seconds or milliseconds. Convert to a human-readable local time using
`datetime.fromtimestamp(ts, tz=datetime.timezone.utc).strftime(...)`. Decide
at the top of the file whether your platform sends seconds or milliseconds.

**Also write raw JSON.** As a matter of archival discipline, write the raw
`captures` dict to a `.json` file alongside the Markdown. The JSON is the
canonical archive; the Markdown is for readability.

---

## 6. Writing `materials_downloader.py`

The function signature:

```python
def download_materials(captures: dict, auth_token: str, output_dir: Path) -> list[Path]:
    ...
```

`captures["materials_raw"]` contains whatever JSON the materials API returned.
`auth_token` is the Bearer token the service worker captured from an in-flight
XHR.

Steps:

1. **Parse the file list.** Inspect `captures["materials_raw"]` to find the
   array of file entries. Each entry typically has a URL, a filename, and
   possibly a folder/section label.

2. **Authenticate each download.** Use `urllib.request.urlopen` with an
   `Authorization: Bearer <auth_token>` header:

   ```python
   import urllib.request

   req = urllib.request.Request(
       file_url,
       headers={"Authorization": f"Bearer {auth_token}"},
   )
   with urllib.request.urlopen(req) as resp:
       content = resp.read()
   ```

3. **Respect the folder hierarchy.** If the API response includes section
   names, create subdirectories under `output_dir` to mirror them:

   ```python
   section_dir = output_dir / sanitize_filename(section_name)
   section_dir.mkdir(parents=True, exist_ok=True)
   dest = section_dir / sanitize_filename(filename)
   dest.write_bytes(content)
   ```

   `host.core.utils` provides a `sanitize_filename` helper — import and use
   it rather than rolling your own.

4. **Return the list of written paths** so the host core can log them.

---

## 7. Writing `metadata-scrape.js`

The goal is to extract three fields: `title`, `instructor`, and `date` as
text strings. Strategy:

**Prefer `data-*` attributes over CSS classes.** LMS frameworks often
regenerate CSS class names on deploy (e.g., `a1b2c3` → `d4e5f6`). A selector
based on `.a1b2c3` breaks silently on the next deploy. A selector based on
`[data-testid="lecture-title"]` or `[aria-label="Lecture title"]` is stable
across rebuilds.

**Use DevTools → Elements to inspect each field:**

1. Right-click the lecture title text on the page → Inspect.
2. Look at the highlighted element. Check for `data-*` attributes, `id`
   attributes, or semantic HTML (`<h1>`, `<time>`).
3. If you must use a CSS class, look for classes that appear in more than
   one place on the page and pick the most specific parent container.

Example:

```js
// Good: data attribute unlikely to change
const titleEl = document.querySelector('[data-lecture-id] .lecture-title');

// Fragile: generated class, may break on next deploy
const titleEl = document.querySelector('.a1b2c3-lecture_title__xyz');
```

**Use `MutationObserver` as a fallback.** The skeleton already does this — if
`scrapeMetadata()` returns a `null` title, an observer watches for DOM changes
until the element appears (or the 15-second hard timeout fires). Do not remove
this pattern.

---

## 8. Updating `manifest.json`

After writing your adapter files, open `extension/manifest.json` and make
three changes:

**Update `content_scripts` paths:**

```json
{
  "matches": ["https://your.real.lms.com/*"],
  "js": [
    "adapters/my-platform/messagepack-decoder.js",
    "adapters/my-platform/chat-hook.js"
  ],
  "run_at": "document_start",
  "world": "MAIN"
}
```

Replace `skeleton` with `my-platform` in every `content_scripts` entry, and
replace `https://your-lms.example.com/*` with your LMS origin.

**Update `host_permissions`:**

```json
"host_permissions": [
  "https://your.real.lms.com/*",
  "https://chat-api.your.real.lms.com/*",
  "https://materials-api.your.real.lms.com/*"
]
```

Add every host that the extension needs to observe via `webRequest` or that
content scripts will send requests to.

**Remove the skeleton entries.** The extension only runs one adapter at a time
— leave only your platform's `content_scripts` entry.

---

## 9. Testing your adapter

After loading the extension unpacked in Chrome:

1. **Open the LMS lecture page.** The content scripts should inject
   automatically.
2. **Open DevTools → Console on the lecture page** (not the extension's
   background page). You should see:
   ```
   [chat-hook] fetch + XHR wrappers installed at https://your.real.lms.com/...
   ```
   If you don't, check the `manifest.json` `matches` patterns.
3. **Wait 15 seconds after page load.** The hook guard timer is active for
   15 seconds; some frameworks replace `window.fetch` during boot. After 15s
   the guard logs a reinstall message if needed.
4. **Open the extension popup.** It should show:
   - `Flavors captured: ≥ 1` — HLS chunks were seen
   - `KS: ✓ captured` — session key was extracted
   - The lecture title from your `metadata-scrape.js`
5. **Click Download.** Watch the popup progress lines. Common failure points:
   - `[chat-hook]` lines are missing → `matches` or `HOST` mismatch
   - KS missing → `webRequest` `host_permissions` missing the player domain
   - Materials download 401 → Bearer token not being captured (check the
     `Authorization` header name the platform uses)

**Smoke-test the Python side independently:**

```bash
# Build a minimal captures dict from a real WebSocket dump and call
# chat_to_markdown directly:
python3 -c "
from pathlib import Path
from host.adapters.my_platform.chat_to_markdown import chat_to_markdown

captures = {
    'conversations': [
        {'id': '1', 'author': 'Alice', 'text': 'hello', 'timestamp': 1700000000}
    ]
}
paths = chat_to_markdown(captures, Path('/tmp/test-output'), 'Test Lecture')
print('Written:', paths)
"
```

---

## 10. Contributing your adapter back

If you build an adapter for a platform and want to share it with others who
use the same LMS, open a pull request adding:

- `extension/adapters/<name>/` — all JS files from your adapter
- `host/adapters/<name>/` — `chat_to_markdown.py` and `materials_downloader.py`
- `extension/adapters/<name>/README.md` — a short description of the platform,
  which transport it uses, and any platform-specific gotchas

Before submitting, verify that your adapter contains no credentials, no
institution-specific endpoint hostnames that would identify a private LMS
deployment, and no personally identifiable data from real chat messages.
Anonymize any fixture data used in tests.

Open the PR against `main`. In the description, note the transport type
(SignalR/MessagePack, REST, SSE), the approximate LMS version you tested
against, and a brief description of what the chat API looks like.
