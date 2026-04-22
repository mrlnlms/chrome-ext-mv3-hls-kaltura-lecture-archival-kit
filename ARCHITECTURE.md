# Architecture

This document describes the engineering behind a Chrome MV3 extension that
archives live-streamed lectures from Kaltura-based Learning Management
Systems (LMS) into a self-contained local folder: 1080p video, bilingual
subtitles, slide decks, course materials, and full chat history — all in one
click.

It's written as a **reference implementation** rather than a plug-and-play
tool. Platforms differ in their chat backends, material APIs, and
authentication schemes, so some pieces need per-platform adapters. What
doesn't change — and what this document focuses on — are the underlying
techniques: HLS interception, SignalR/MessagePack decoding in MAIN-world
content scripts, Chrome Native Messaging to a Python host, and the ffmpeg
pipeline that glues everything together.

---

## How to read this document

Each **Problem** section is self-contained and follows the same shape:

1. **Context** — what the system is trying to do
2. **The problem** — why the obvious approach fails
3. **The solution** — what actually works, with concrete details
4. **Gotchas** — things that bit us along the way

If you only care about one technique (e.g., SignalR decoding), jump
straight to Problem 2. Nothing earlier is a prerequisite.

---

## System architecture at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  LMS page (SPA, usually Angular or React + Kaltura player)          │
│                                                                      │
│  ┌──────────────┐   ┌──────────────────┐   ┌─────────────────────┐  │
│  │  chat-hook   │   │  materials-hook  │   │    content.js       │  │
│  │  (MAIN)      │   │  (MAIN)          │   │    (ISOLATED)       │  │
│  │              │   │                  │   │                     │  │
│  │  SignalR +   │   │  XHR sniff of    │   │  DOM metadata       │  │
│  │  fetch/XHR   │   │  materials API   │   │  scrape (title,     │  │
│  │  hooks       │   │                  │   │  professor, etc.)   │  │
│  └──────┬───────┘   └────────┬─────────┘   └──────────┬──────────┘  │
│         │ postMessage        │ postMessage            │ sendMessage │
└─────────┼────────────────────┼────────────────────────┼─────────────┘
          ▼                    ▼                        ▼
     ┌────────────────────────────────────────────────────────┐
     │              background.js (service worker)             │
     │                                                         │
     │  webRequest listeners capture:                          │
     │    - HLS .ts chunks from Kaltura CDN                    │
     │    - KS (Kaltura Session token)                         │
     │    - Slides PDF URL (CDN blob)                          │
     │    - LMS API Bearer tokens                              │
     │    - Chat API Room IDs + Bearer tokens                  │
     │                                                         │
     │  chrome.storage.session per tab:                        │
     │    flavors, ks, chatData, slidesUrl, lms, metadata      │
     └───────────────────────────┬─────────────────────────────┘
                                 │ Native Messaging stdio
                                 │ (4-byte length prefix + JSON)
                                 ▼
     ┌────────────────────────────────────────────────────────┐
     │              host (Python process via stdio)            │
     │                                                         │
     │  HLS probe + ffmpeg -c copy → MP4                       │
     │  VTT subtitles → SRT                                    │
     │  SRT → Markdown transcript (paragraph heuristics)       │
     │  Authenticated material downloads (Bearer token)        │
     │  Chat JSON → Markdown conversion                        │
     │                                                         │
     │  Progress reports back to UI via stdout                 │
     └────────────────────────────────────────────────────────┘
```

Three layers, each with a reason to exist:

- **Content scripts** run inside the page's JS context (or in an isolated
  world adjacent to it) and see what the page sees. They're the only way
  to observe in-page traffic that never crosses network boundaries
  (SignalR WebSocket frames decoded client-side, for example).

- **Service worker** (`background.js`) is the privileged coordinator. It
  has access to `webRequest` — the only Chrome API that can observe every
  network request across every tab, regardless of the page's JS — and to
  `chrome.runtime.connectNative` for talking to the host process.

- **Native host** is a Python process outside the browser sandbox. It has
  `ffmpeg`, file system access, and no Chrome memory limits. The extension
  talks to it over stdio with a Chrome-specific length-prefixed protocol.

The split is enforced by the browser. You couldn't run `ffmpeg` inside an
extension if you wanted to. You couldn't observe HLS chunks from a page's
JS without a content script. You couldn't intercept headers without
`webRequest`. Each layer does the one thing it can do.

---

## Problem 1: Capturing 1080p HLS when the master playlist only lists 540p

### Context

Kaltura streams video via HLS (HTTP Live Streaming). A client starts by
fetching an `.m3u8` "master playlist" — a text file listing every
available quality tier (bitrate × resolution) and the URL of each tier's
chunk list. The client picks a tier (often adaptively) and streams the
chunks.

Simple case:

```
GET /playManifest/.../a.m3u8

#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=864000,RESOLUTION=640x360
flavor-A/chunks.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1628000,RESOLUTION=854x540
flavor-B/chunks.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3750000,RESOLUTION=1920x1080
flavor-C/chunks.m3u8
```

Pick C, fetch chunks, mux to MP4. Done.

### The problem

The authenticated master playlist from our target platforms **lies**.

```
GET /playManifest/.../ks/{session_token}/.../a.m3u8

#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=864000,RESOLUTION=640x360
flavor-A/chunks.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1628000,RESOLUTION=854x540
flavor-B/chunks.m3u8
```

It caps at 540p. Yet if you watch the lecture in a browser, the picture
is crisp 1080p. The 1080p stream exists — the player knows about it —
but it's not in the playlist that the server hands out when you request
it with a session token.

We suspect (but haven't verified) that Kaltura's internal quality-ladder
logic exposes the higher tiers to the player via a different mechanism,
not the public master. Whatever the reason, if you probe the master and
pick the "best" tier, you get 540p and miss the quality that's actually
rendering on screen.

### The solution

Don't trust the master. Watch what the player actually fetches.

Every HLS chunk has a URL with a predictable shape:

```
https://cfvod.kaltura.com/p/{partner}/sp/{sub}/serveFlavor/
  entryId/{entry}/v/{v}/ev/{ev}/flavorId/{flavor}/name/a.mp4/
  seg-{N}-v1-a1.ts
```

`flavorId` is the tier (quality) identifier. If the player is rendering
1080p, the 1080p flavor's `.ts` chunks are flying across the network,
and we can see them from a `webRequest.onBeforeRequest` listener:

```js
const CHUNK_URL_PATTERN = /\/seg-\d+-v1-a1\.ts(\?|$)/;
const FLAVOR_ID_PATTERN = /\/flavorId\/([^/]+)\//;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!CHUNK_URL_PATTERN.test(details.url)) return;
    const m = details.url.match(FLAVOR_ID_PATTERN);
    if (!m) return;
    storeFlavorChunk(details.tabId, m[1], details.url);
  },
  { urls: ["https://cfvod.kaltura.com/*"] }
);
```

We keep a per-tab map `{flavorId → latest chunk URL seen}`. Over the
course of playback, the ABR (Adaptive Bitrate) algorithm will dip into
different tiers depending on network conditions, so after 30 seconds or
so we typically have 3-4 distinct flavors tracked.

When the user clicks **download**, we hand the list of captured chunks
to the Python host. The host issues an HTTP `HEAD` request on
`seg-1-v1-a1.ts` of each flavor — the first segment, which has stable,
small, fast-to-fetch headers:

```python
def flavor_size(chunk_url: str) -> int:
    seg1 = chunk_url.replace(
        re.search(r"seg-\d+-v1-a1\.ts", chunk_url).group(),
        "seg-1-v1-a1.ts"
    )
    req = urllib.request.Request(seg1, method="HEAD")
    with urllib.request.urlopen(req) as r:
        return int(r.headers["Content-Length"])
```

The flavor with the largest `Content-Length` for seg-1 is the
highest-bitrate available. Since every flavor has the same number of
segments and roughly similar segment durations, chunk size is a reliable
proxy for bitrate.

Once the winning flavor is chosen, we reconstruct its `chunklist.m3u8`
URL by swapping `seg-N-v1-a1.ts` for `chunklist.m3u8` and hand the result
to ffmpeg:

```bash
ffmpeg -i "https://cfvod.kaltura.com/.../flavorId/{best}/.../chunklist.m3u8" \
       -c copy \
       output.mp4
```

`-c copy` is critical. It means "remux, don't re-encode": ffmpeg pulls
the `.ts` segments, concatenates them, and writes an MP4 container
around the same H.264 video stream and AAC audio stream that were inside
the segments. No quality loss, and the operation is bounded by network
speed rather than CPU.

### Gotchas

**ABR ramp-up.** The player starts playback at a low tier (often 360p)
and only escalates to 1080p after it's confident the network can sustain
it — typically 10-30 seconds in. If the user clicks **download**
immediately on pressing play, the 1080p chunks may not have been fetched
yet, and our map only contains 360p/540p. The UI instructs the user to
let the stream play for ~30 seconds before triggering the download. The
popup also shows `Flavors captured: N` so they can confirm at least
three are in hand.

**Chunk filter specificity.** The pattern `seg-\d+-v1-a1.ts` matches a
single muxed video+audio segment. Some Kaltura deployments use separate
video-only and audio-only flavors (`v1-a0.ts` + `v0-a1.ts`), which this
filter ignores. Adding them would require independent muxing — worth it
only if the target platform actually delivers split streams.

**Cross-flavor segment counts match.** We rely on the fact that every
flavor has the same number of segments. Kaltura guarantees this because
they encode to a common GOP structure, but it's worth verifying against
the `chunklist.m3u8` of each flavor before trusting it on new
deployments.

**`-c copy` and timestamp alignment.** Some encoded streams have
non-zero start timestamps that upset certain players when remuxed to
MP4. If playback stalls for the first second in some players, add
`-avoid_negative_ts make_zero`.

---

## Problem 2: Decoding SignalR/MessagePack chat

### Context

Live lectures often have a chat panel — students asking questions,
instructors answering, messages pinned. For an offline archive to be
useful, it has to capture this conversational context, not just the
video.

### The problem

The chat API is deceptive. A content script that watches the tab's
network traffic sees the page fetch something like
`/Chat/Messages/Approved` — an obvious REST endpoint that should return
a JSON array of messages. But the response body is **zero bytes**.

```
[chat-hook] xhr conversations status=200 rt="json" textLen=0 resp=null
```

Status 200, but no body. Why does the page still render messages? Because
the real data comes over a **WebSocket**, not the REST endpoint.

More specifically: the platform uses **SignalR**, Microsoft's real-time
framework, with a **MessagePack** binary wire format. SignalR opens a
WebSocket (or falls back to Server-Sent Events) at connection time, then
streams frame-by-frame binary payloads carrying invocation calls, ACKs,
and data. The REST endpoints exist as a negotiation and session-management
scaffold; the actual messages live in the binary frames.

### The solution

Decode SignalR/MessagePack directly in a content script, before the data
is consumed by the page's JavaScript and disappears into application
state.

This requires a **MAIN-world content script**. Content scripts normally
run in an "isolated world" — they share the page's DOM but have a
separate JavaScript heap, so they can't see or monkey-patch the page's
`window.fetch`, `WebSocket`, or `XMLHttpRequest` prototypes. Chrome MV3
supports `world: "MAIN"` in manifest content_scripts entries to opt into
running in the page's actual JS context.

```json
"content_scripts": [
  {
    "matches": ["https://your-lms.example.com/*"],
    "js": ["chat-hook.js"],
    "run_at": "document_start",
    "world": "MAIN"
  },
  {
    "matches": ["https://your-lms.example.com/*"],
    "js": ["chat-bridge.js"],
    "run_at": "document_start"
  }
]
```

The MAIN-world script (`chat-hook.js`) wraps the page's own APIs:

```js
const origFetch = window.fetch;
const wrappedFetch = async function (input, init) {
  const resp = await origFetch.apply(this, arguments);
  try {
    const url = typeof input === "string" ? input : input && input.url;
    const label = labelFor(url);
    if (label && resp.ok) {
      resp.clone().json().then((d) => post(label, d));
    }
  } catch (e) {}
  return resp;
};
window.fetch = wrappedFetch;
```

And because Angular's `HttpClient` can overwrite `window.fetch` after we
do, we keep a guard timer for the first 15 seconds that reinstates our
wrapper if the page has swapped it out:

```js
const guard = setInterval(() => {
  if (window.fetch !== wrappedFetch) {
    window.fetch = wrappedFetch;
  }
}, 250);
setTimeout(() => clearInterval(guard), 15000);
```

Wrapping `XMLHttpRequest.prototype.send` catches requests that don't use
`fetch`.

The MAIN-world script can't talk directly to the background service
worker — only ISOLATED-world scripts have `chrome.runtime.sendMessage`.
So we use `window.postMessage` as a bridge: MAIN-world posts to the
`window` object, the ISOLATED-world `chat-bridge.js` listens for posted
messages with a magic marker, and relays them to the service worker:

```js
// chat-hook.js (MAIN)
window.postMessage({ __archivalKitChatCapture: true, label, data }, "*");

// chat-bridge.js (ISOLATED)
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  if (!e.data || !e.data.__archivalKitChatCapture) return;
  chrome.runtime.sendMessage({
    type: "chatCapture",
    label: e.data.label,
    data: e.data.data,
  });
});
```

### Decoding MessagePack

Wrapping fetch/XHR catches any JSON that does cross HTTP. But most of
the actual chat comes through SignalR's binary channel. To read that,
we hook either the SignalR client constructor (less portable) or the
MessagePack decoder that SignalR uses under the hood (more portable).

MessagePack's wire format is a self-describing binary serialization.
Each value starts with a **type byte** that encodes the type and —
for short values — the size inline. The full decoder is ~100 lines of
code, handling:

```
0x00..0x7f        positive fixint (0..127)         — 1 byte
0xe0..0xff        negative fixint (-32..-1)        — 1 byte
0xa0..0xbf        fixstr (0..31 bytes)             — 1 + N bytes
0x90..0x9f        fixarray (0..15 items)           — 1 byte + items
0x80..0x8f        fixmap (0..15 key-value pairs)   — 1 byte + KVs
0xc0              nil                              — 1 byte
0xc2, 0xc3        false, true                      — 1 byte
0xc4..0xc6        bin 8/16/32                      — 1 + size bytes + data
0xca, 0xcb        float 32, float 64               — 5 / 9 bytes
0xcc..0xcf        uint 8/16/32/64                  — 2 / 3 / 5 / 9 bytes
0xd0..0xd3        int 8/16/32/64                   — 2 / 3 / 5 / 9 bytes
0xd9..0xdb        str 8/16/32                      — 1 + size bytes + utf8
0xdc, 0xdd        array 16/32                      — 3 / 5 bytes + items
0xde, 0xdf        map 16/32                        — 3 / 5 bytes + KVs
```

In a MAIN-world context with access to the raw `ArrayBuffer` from a
WebSocket frame, the decoder is a straightforward walk over a
`Uint8Array`:

```js
const TD = new TextDecoder("utf-8");

function mpDecode(b, off) {
  const dv = new DataView(b.buffer, b.byteOffset);
  const c = b[off];
  if (c <= 0x7f) return { v: c, n: off + 1 };
  if (c >= 0xa0 && c <= 0xbf) {
    const L = c & 0x1f;
    return { v: TD.decode(b.subarray(off + 1, off + 1 + L)), n: off + 1 + L };
  }
  if (c >= 0x90 && c <= 0x9f) return mpArray(b, off + 1, c & 0x0f);
  // ... one case per type byte range
}
```

SignalR wraps each MessagePack payload with a **varint length prefix**
(1-5 bytes) so the receiver knows how much to read. After stripping the
varint, the remaining bytes are a MessagePack array of the form:

```
[type, headers, invocationId, target, args[], streamIds?]
```

`target` is the name of the remote method being invoked (e.g.,
`"ReceiveMessage"`), and `args[]` contains the payload. For our purposes,
we filter on specific `target` values and extract the argument that
carries the message payload.

### Capturing the full backlog: react-virtuoso scrollback

Live chat is only half the problem. When a student opens an already-in-
progress lecture, the messages they see initially are just the last
~20-30 — the rest require scrolling up in the chat panel, which
triggers pagination requests via the normal fetch/XHR path we already
hook. But the extension needs the **full** history, not just what the
current user happens to have in view.

The chat UI is built with [react-virtuoso](https://virtuoso.dev/), which
virtualizes rows for performance. To force the full history to load:

1. The service worker asks the MAIN-world content script to programmatically
   click through each chat tab (Conversations, Questions, Pinned).
2. For each tab, the content script calls `scroller.scrollTo({ top: 0 })`
   in a loop, waiting for the message count to stabilize.
3. It bails out when either (a) the count stops growing for ~2s or (b)
   a global timeout (45s) is hit.

The same fetch/XHR hooks catch the paginated responses as the virtuoso
fires them. By the time step 3 completes, we've captured every page.

### Gotchas

**`document_start` is non-negotiable.** If the content script runs later
(`document_idle`, default), the page's Angular/React boot has already
cached references to the original `window.fetch`, and our wrapper is
invisible to it. `run_at: "document_start"` ensures we monkey-patch
before the page's first line of code runs.

**Same-origin postMessage, but still sanitize.** MAIN-world ↔ ISOLATED-world
posts use `window.postMessage(data, "*")`. Both ends are on the same origin,
but the message bus is shared with any script on the page. Always use a
magic marker (`__archivalKitChatCapture: true`) and drop messages without it.

**Response body can only be read once.** `fetch` responses are streams.
If we read the body to inspect it, the page's own handler will see an
empty/consumed stream and likely break. Use `resp.clone()` before reading
— it's cheap and keeps the original intact for the page.

**`responseType: "json"` means no `responseText`.** When the page sets
`xhr.responseType = "json"`, the browser parses for you and `responseText`
is empty. Read from `xhr.response` instead. Our XHR hook handles both.

---

## Problem 3: Chrome Native Messaging for heavy lifting

### Context

The extension needs to run `ffmpeg`, write files outside the browser's
sandboxed download directory, and handle hundreds of megabytes of
video data — none of which is possible from an extension context.

### The problem

Chrome offers four ways to bridge extension code to local software:

1. **`chrome.downloads`** — trigger file downloads, but you don't control
   the post-processing. You can't pipe the result through ffmpeg.
2. **A local HTTP server** — run a daemon on `localhost:PORT` and `fetch`
   from the extension. Works, but requires the user to start the daemon
   manually, the port is fixed, and Chrome's mixed-content policy bites
   if the page is HTTPS.
3. **Clipboard + manual terminal** — copy a command to the clipboard,
   user pastes it in Terminal. Works, zero installation complexity, but
   every download needs user interaction and has no UI feedback.
4. **Chrome Native Messaging** — a stdio channel to an installed "native
   host" process. The extension calls `chrome.runtime.connectNative()`
   and Chrome spawns the host binary, pipes bidirectional length-prefixed
   JSON over stdin/stdout.

Native messaging is the correct answer — one-click UX, real-time progress
feedback, structured error reporting. But it's the most opinionated of
the four. Chrome requires:

- A **native host manifest** (JSON file) in a Chrome-specific directory
  telling Chrome which binary to invoke and which extensions may invoke it.
- The host to implement Chrome's stdio wire protocol: 4-byte little-endian
  length prefix, then JSON payload.
- The host to be an executable file, not a script, depending on platform
  quirks.

### The solution

A Python script (`host.py`) that supports two modes:

```
# CLI mode (manual debug)
python3 host.py --chunk "<url>" --dest <dir> --title "<name>"

# Native messaging mode (invoked by Chrome)
python3 host.py --native-messaging
```

In native messaging mode, the script reads one JSON request from stdin:

```python
def nm_read():
    length_bytes = sys.stdin.buffer.read(4)
    if len(length_bytes) != 4:
        return None
    length = struct.unpack("<I", length_bytes)[0]
    return json.loads(sys.stdin.buffer.read(length))
```

…executes the pipeline, emitting progress reports as separate JSON
messages back to the extension:

```python
def nm_send(payload: dict):
    data = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

nm_send({"type": "progress", "phase": "video", "percent": 42, "speed": "3.2x"})
nm_send({"type": "done", "folder": "/Users/.../downloads/lecture-42"})
```

…and exits. The wire format is symmetric (host → extension and
extension → host both use the same length-prefix JSON scheme), which
means the Python side is easy to test independently.

### The `install.sh` bootstrap

Distributing a native host means installing the manifest file in the
right place on the user's machine. On macOS:

```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
  com.your.host.json
```

Example manifest:

```json
{
  "name": "com.your.host",
  "description": "My native host",
  "path": "/Users/{user}/.my-host/host_wrapper.sh",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://{YOUR_EXTENSION_ID}/"
  ]
}
```

The `install.sh` template in this kit copies the host binary/script to
a known location in `$HOME`, templates the `path` field with absolute
paths, and writes the manifest.

### The macOS Sequoia exec gotcha

macOS Sequoia (Darwin 25) introduced a security control that prevents
binary execution from `~/Desktop/` and a few other user-facing
directories without an explicit Gatekeeper exception. If you install
Chrome Native Messaging directly from a clone in `~/Desktop/projects/`,
the first invocation reports:

```
Native host has exited
```

…with no further explanation in Chrome's logs.

The fix: install copies the host files into `~/.your-host/`, a hidden
directory in `$HOME` that's not subject to the Sequoia restriction.
The native host manifest points at the installed location, not the
source tree. Every source-code change requires re-running `install.sh`
to refresh the installed copy.

### `parse_known_args` vs `parse_args`

When Chrome invokes a native host, it passes several **extra arguments**
the extension didn't ask for:

```
/Users/.../host.py --native-messaging \
  chrome-extension://{YOUR_EXTENSION_ID}/ \
  --parent-window=0
```

If you parse with `argparse.parse_args()`, `argparse` exits with status
code 2 on encountering `chrome-extension://...` as an unrecognized
positional argument. Chrome sees the immediate non-zero exit and
reports "Native host has exited" before any of your code runs.

Use `parse_known_args()`:

```python
parser = argparse.ArgumentParser()
parser.add_argument("--native-messaging", action="store_true")
parser.add_argument("--chunk", action="append", default=[])
# ... etc
args, unknown = parser.parse_known_args()  # ignore Chrome's extra args
```

### Gotchas

**Extension ID must be stable.** The native host manifest names specific
extension IDs in `allowed_origins`. If the extension's ID changes — which
happens by default every time you reload an unpacked extension from a
new folder path — the manifest no longer allows the connection and
Chrome rejects the native messaging attempt. Fix by embedding a `key`
(public RSA key) in the extension's `manifest.json`. Chrome derives the
ID deterministically from the key, so the ID stays constant across
reloads and across machines.

**Daemon threads and stdin teardown.** If your host spawns threads to
watch stdin (e.g., to react to cancellation messages mid-download), make
sure they exit cleanly before `sys.exit()`. On macOS we saw "Python quit
unexpectedly" dialogs pop up from lingering threads during shutdown —
resolved by calling `os._exit(0)` after flushing the final `done`
message, which bypasses Python's thread-teardown.

**Flushing is mandatory.** Progress updates that aren't `flush()`-ed
won't reach the extension until the host exits. Always flush after
every `nm_send()`.

**Message size ceiling.** Chrome enforces a hard limit of **1 MB** per
message from host to extension. If you were thinking of sending the raw
MP4 back, think again — this is a command-and-control channel, not a
data channel. Files stay on disk; the extension gets back a path.

---

## Problem 4: Progress streaming back to the UI

### Context

A lecture download takes 5-15 minutes. During that time the user should
see:

- Phase markers (capturing, downloading video, downloading subtitles,
  downloading slides, downloading materials, generating transcripts, done)
- Real-time byte/percentage/ETA for the video (which dominates the
  total time)
- Per-item status for each material: idle → pending → downloading → ok/err
- The ability to close the popup and reopen it without losing state

### The problem

Chrome extension popups are **ephemeral**. Every time the user closes
the popup and reopens it, the `popup.html` page is destroyed and
recreated from scratch. In-memory state is gone.

Meanwhile the native host is streaming dozens of progress messages per
second, each received by the service worker. The user may or may not
have the popup open at any given moment.

Also: `chrome.storage.session` (our state store) is asynchronous and
has no transaction primitive. Multiple rapid updates race — handler A
reads state at t=0, handler B reads state at t=1, both modify their
copy and write back. B's write lands first, A's write lands second and
clobbers B.

### The solution

Two patterns, used together.

**Persistent state in `chrome.storage.session`.** Every host message
that mutates state writes it into the session-scoped storage. The popup,
on open, reads the same storage and paints the UI from it. The popup
is stateless; `chrome.storage.session` is the source of truth.

```js
async function getTabState(tabId) {
  const k = `tab:${tabId}`;
  return (await chrome.storage.session.get(k))[k] || defaultState();
}

async function setTabState(tabId, state) {
  await chrome.storage.session.set({ [`tab:${tabId}`]: state });
}
```

**Promise-chain serialization for concurrent updates.** Wrap every state
mutation in a function, and thread them through a single outstanding
promise so they execute in order:

```js
let stateUpdateChain = Promise.resolve();

function queueStateUpdate(fn) {
  stateUpdateChain = stateUpdateChain.then(fn, fn);
  return stateUpdateChain;
}

// Every handler that touches state goes through this:
queueStateUpdate(async () => {
  const s = await getTabState(tabId);
  s.materials[idx].status = "ok";
  await setTabState(tabId, s);
});
```

The key insight: `stateUpdateChain.then(fn, fn)` — both `onFulfilled`
and `onRejected` call `fn`. That means even if one update throws, the
chain doesn't stall; the next update still runs. Errors in one handler
don't poison subsequent handlers.

### Pushing updates to an open popup

When the popup is open, it registers a `chrome.runtime.onMessage`
listener. The service worker broadcasts state changes by calling
`chrome.runtime.sendMessage({ type: "tabStateUpdate", tabId, state })`.

When the popup is closed, these broadcasts `sendMessage`-fail silently
(no listener), which is fine — state is already in storage and the
popup will read it on next open.

### Gotchas

**`sendMessage` fails if no listener exists.** With no popup open, the
message goes into the void and the sender gets a rejected promise.
Wrap in `try/catch` or `.catch(() => {})`:

```js
chrome.runtime.sendMessage({ type: "tabStateUpdate", tabId, state })
  .catch(() => {}); // popup may not be open
```

**Drain the native host on `done`.** When the host sends `{"type":
"done"}`, it's tempting to tear down the port immediately. But there
may be a trailing `progress` or `error` message already in flight. We
wait 300ms after receiving `done` before declaring the port dead — this
was the fix for a bug where successful downloads sometimes displayed
"Native host has exited" in the popup, because `Port.onDisconnect` fired
between `done` and the final UI state flush.

**Service worker lifecycle.** MV3 service workers are terminated after
30 seconds of idle. To keep the worker alive during a download, we hold
a reference to the `Port` returned by `connectNative()` — as long as
the port is open, Chrome keeps the worker alive. Storing ports in a
`Map<tabId, Port>` survives the worker's initial event-handler return
and keeps everything running until the host signals `done`.

---

## Pipeline composition

The Python host does more than one thing. Each step is independent, can
fail independently, and reports its own progress.

### 1. Video (HLS → MP4)

```bash
ffmpeg -i "https://.../chunklist.m3u8" -c copy output.mp4
```

Progress reporting: parse ffmpeg's stderr. ffmpeg writes progress lines
like:

```
frame= 1234 fps=58 q=-1.0 size=   42069kB time=00:02:15.67 bitrate=...
```

A regex over `time=HH:MM:SS.ff` gives elapsed output time. Divide by
total duration (known from the master playlist or from a probe HEAD) and
you have a percentage. The `speed=N.Nx` field gives you a live multiplier
that you can use to estimate remaining wall-clock time.

### 2. Subtitles (VTT → SRT)

HLS can carry subtitles as a separate track, listed in the master
playlist under `#EXT-X-MEDIA:TYPE=SUBTITLES`. The format is WebVTT (a
text-based subtitle format similar to SRT but with different header and
timestamp syntax).

ffmpeg converts VTT to SRT with the same `-c copy` treatment:

```bash
ffmpeg -i "https://.../subtitles_pt.m3u8" subtitles_pt.srt
```

### 3. Markdown transcripts

A text transcript with paragraph breaks is more useful for reading than
a raw SRT. We convert SRT → Markdown by:

1. Dropping timestamps and segment numbers
2. Joining adjacent segments into a single paragraph
3. Breaking paragraphs at sentence-ending punctuation (`.`, `!`, `?`)
   followed by a capital letter, provided the paragraph has ≥120
   characters and the punctuation isn't a known abbreviation (`Dr.`,
   `Prof.`, `Sr.`, `Sra.`, etc.)

This is entirely local — no API calls, no Whisper, no transcription
cost. The SRT is already the transcription; we just reshape it.

### 4. Slide deck (Azure Blob CDN)

Lecture slides often live on an unauthenticated CDN blob (Azure Blob
Storage in our reference platform, but any object-storage URL works).
When the player renders the "Slides" tab, it fetches the PDF URL.
Our service worker captures the URL via a `webRequest` filter, and the
Python host downloads it with `urllib.request.urlretrieve`.

### 5. Authenticated course materials

Material downloads require a Bearer token. The service worker captures
the token from the LMS's authenticated XHRs (see Problem 3 for the
capture mechanism). The Python host uses it:

```python
req = urllib.request.Request(material_url, headers={
    "Authorization": f"Bearer {bearer_token}",
    "User-Agent": USER_AGENT,
})
with urllib.request.urlopen(req) as resp:
    Path(dest).write_bytes(resp.read())
```

### 6. Chat → Markdown

The captured chat JSON is converted to Markdown with:

- Conversations and Questions in chronological order
- Indentation for replies / nested threads
- A separate file for pinned messages
- Timestamps localized to the user's timezone

---

## MV3 constraints and workarounds

### Service worker ephemerality

MV3 replaced MV2's persistent background page with a service worker
that terminates after 30 seconds of idle. Every API handler runs from
a cold start unless a persistent event source is keeping the worker
alive.

**Implication.** Global variables don't survive. All state must go in
`chrome.storage.session` (tab-scoped, cleared when Chrome restarts) or
`chrome.storage.local` (persistent across sessions).

**Implication.** Listeners need to be registered synchronously at the
top of `background.js`, not inside async callbacks, or Chrome won't
know to wake the worker when the event fires.

### Extension ID stability via manifest `key`

As noted in Problem 3, the native host manifest names specific extension
IDs in `allowed_origins`. To keep a stable ID across reloads:

```json
{
  "manifest_version": 3,
  "name": "Your Extension",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAO...(base64 RSA public key)...QIDAQAB",
  ...
}
```

Chrome derives the extension ID from the public key. You generate one
with `openssl`:

```bash
openssl genrsa 2048 | openssl rsa -pubout -outform DER | openssl base64 -A
```

The private key stays on your disk (used when you eventually pack and
sign the extension for distribution). The public key lives in the
`manifest.json` and fixes the ID.

### `content_scripts.world = "MAIN"` for prototype patching

As covered in Problem 2, the MAIN-world flag is what enables content
scripts to monkey-patch page APIs. MV3 supports this; MV2 did not.
Scripts in MAIN-world can't directly use `chrome.*` APIs (they run in
the page's origin, not the extension's), so they need an ISOLATED-world
bridge to talk to the service worker.

### `host_permissions` vs `content_scripts.matches`

Two separate permission systems that must both be satisfied:

- **`host_permissions`** — what URLs the extension's service worker can
  `fetch` from and what origins `webRequest` will observe.
- **`content_scripts.matches`** — which URLs get content scripts injected.

A URL that's in one but not the other silently fails in subtle ways.
Include the full list of LMS domains (plus the Kaltura CDN for HLS)
in both.

### `extraHeaders` for `Authorization`

By default, `webRequest.onBeforeSendHeaders` does not include the
`Authorization` header in the list of headers it passes to your listener
— Chrome strips it for privacy. Pass `"extraHeaders"` in the opt_extraInfoSpec
argument to get it:

```js
chrome.webRequest.onBeforeSendHeaders.addListener(
  handler,
  { urls: ["https://api.example.com/*"] },
  ["requestHeaders", "extraHeaders"]  // <-- extraHeaders is required
);
```

Without `extraHeaders`, your handler sees every request header **except**
`Authorization`, `Cookie`, and `Set-Cookie`. Fun to debug.

---

## The adapter pattern

The techniques in this document — HLS interception, SignalR/MessagePack
decoding, native messaging, ffmpeg piping — generalize to any Kaltura-based
LMS. What doesn't generalize:

- The **URL patterns** for your LMS's chat API, materials API, slides CDN.
- The **token acquisition flow** (cookies, Bearer, custom header?).
- The **chat payload shape** (which MessagePack fields map to which UI
  concepts).
- The **DOM scrape** for lecture metadata (title, professor, date).

This repo separates those platform-specific pieces into a per-platform
**adapter**. Only the skeleton adapter (all no-ops with TODOs) is tracked
here; real adapters live outside this repo and are applied locally via a
script that copies files in and patches `manifest.json` + `background.js`.

### Repo layout

```
extension/
  background.js                 # CORE. Registers generic Kaltura listeners
                                # (HLS chunks + KS), storage, popup messaging,
                                # download lifecycle. Ends with:
                                #   importScripts("adapters/skeleton/adapter-boot.js")
  manifest.json                 # Default content_scripts + host_permissions
                                # point at adapters/skeleton/ and your-lms.example.com.
  popup.html / popup.js         # UI, mostly generic.
  adapters/
    skeleton/                   # Tracked. No-op stubs with adaptation TODOs.
      adapter-boot.js           # Loaded by core via importScripts.
      content.js                # ISOLATED world, DOM metadata scrape.
      chat-hook.js              # MAIN world, fetch/XHR/WebSocket hooks.
      chat-bridge.js            # ISOLATED world, relays to service worker.
      materials-hook.js         # MAIN world, materials-API sniff.
      materials-bridge.js       # ISOLATED world, relays to service worker.
      messagepack-decoder.js    # Optional: decoder for SignalR binary frames.
      adapter.json              # Adapter metadata (host names, etc.).
host/
  host.py                       # Native messaging entry point (generic).
  core/                         # HLS → MP4, VTT → SRT, SRT → Markdown, etc.
  adapters/
    skeleton/                   # Tracked. Stubs for platform-specific Python.
```

### How the core loads an adapter

At the bottom of `background.js`:

```js
try {
  importScripts("adapters/skeleton/adapter-boot.js");
} catch (e) {
  console.warn("[core] adapter-boot não carregou:", e.message);
}
```

`importScripts()` is synchronous, so the adapter registers its listeners
before the first event loop tick. This matters: MV3 service workers must
register listeners synchronously at boot or Chrome won't wake the worker
on matching events.

To swap in a different adapter, rewrite the path in that `importScripts`
call (an `apply-to-public-clone.sh`-style script does this mechanically).

### The core ↔ adapter contract

The core exposes these as service-worker globals (plain function
declarations in `background.js`):

- `queueStateUpdate(fn)` — serializes concurrent writes to `chrome.storage.session`.
- `getTabState(tabId)`, `setTabState(tabId, state)`, `patchTabState(tabId, patch)`.
- `notifyPopup(tabId)` — broadcasts a re-render to an open popup.

The adapter may optionally populate `self.adapter` with hooks that
`startDownload` calls if present:

- `self.adapter.onBeforeDownload(tabId)` — fires right before the job is
  sent to the host. Good place to trigger chat scrollback, refresh
  metadata, etc.
- `self.adapter.buildJobExtras(state)` — returns an object merged into
  the job payload. Use it to attach chat transcripts, slide URLs, and
  auth tokens captured by your listeners.
- `self.adapter.prePopulateDownload(state)` — returns `{ materials,
  multimedia }`. Pre-populates the popup UI with pending items before
  the host starts emitting progress events.

If the adapter doesn't set `self.adapter`, the core falls back to a bare
download job with `{ chunks, ks, title, dest }` — enough for generic
HLS-to-MP4 with no chat, slides, or materials handling.

### Building an adapter

1. Identify your platform's chat API host, materials API, slides CDN.
2. Copy `extension/adapters/skeleton/` to `extension/adapters/<yourname>/`
   and fill in URL patterns, field mappings, and DOM selectors. Follow
   the TODO comments at the top of each file.
3. Register additional `chrome.webRequest` listeners in your
   `adapter-boot.js` for the URLs you identified.
4. If your chat uses SignalR over a WebSocket with MessagePack payloads,
   uncomment the WebSocket-wrapper block in `chat-hook.js` and set
   `TARGET_TO_LABEL` to your platform's SignalR targets.
5. If you want the download flow to bundle captured chat/slides/tokens
   into the job, set `self.adapter.buildJobExtras` in your `adapter-boot.js`.
6. Patch `manifest.json` so `content_scripts.matches`, the `js` paths,
   and `host_permissions` all point at your adapter path and your LMS's
   URLs — matches and host_permissions must both cover every origin you
   care about, or Chrome silently drops events. See the "`host_permissions`
   vs `content_scripts.matches`" section above.
7. In `background.js`, change the `importScripts` argument to
   `"adapters/<yourname>/adapter-boot.js"`.

---

## Lessons learned

**Trust the network, not the API.** The master playlist lied about
available qualities. The REST endpoint lied about where the chat was.
In both cases, watching what the player actually did got us the truth
faster than reading documentation.

**MAIN-world content scripts are a superpower.** Monkey-patching
`window.fetch` and `window.XMLHttpRequest` from inside the page's own
JS context turned an opaque SignalR WebSocket into a stream of JSON
events. MV3 made this possible; MV2 did not.

**Native messaging is worth the setup cost.** Compared to the alternatives
(local HTTP server, clipboard, `chrome.downloads`), Chrome Native Messaging
gives you structured bidirectional messaging with lifecycle management
for free. The installation-time complexity is a fixed one-time cost; the
per-download UX benefits recur forever.

**Promise-chain serialization beats locks.** JavaScript has no native
mutex, but you don't need one if your critical sections are all async
and you thread them through a single promise. This is lighter, simpler,
and harder to deadlock than any locking scheme.

**`parse_known_args` is the right default** for any Python script that
might be invoked by something you don't control. `parse_args` is safer
when you want to catch typos in your own invocations, but for scripts
at API boundaries, tolerating extra arguments is the polite behavior.

**macOS Sequoia broke a lot of things** silently. If your tool spawns
native processes and works on Ventura but not Sequoia, check for
execution restrictions in `~/Desktop/`, `~/Documents/`, and `~/Downloads/`
before blaming your code.
