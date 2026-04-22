# chrome-ext-mv3-hls-kaltura-lecture-archival-kit

Open-source reference implementation of a Chrome MV3 extension for
one-click personal archival of Kaltura-based LMS lectures. Captures
1080p HLS via webRequest, decodes SignalR/MessagePack chat in
MAIN-world content scripts, and runs a Python native messaging +
ffmpeg pipeline — video, subtitles, slides, materials, chat.

---

## Status

**Reference implementation.** This repository documents and demonstrates
the engineering techniques needed to build a lecture archival extension
for any Kaltura-based LMS. It is **not** a plug-and-play tool for an
arbitrary platform — each LMS has its own chat API shape, materials API,
authentication flow, and metadata scheme. What generalizes (and what
this repo focuses on) are the **techniques**.

Intended audience:

- Developers building archival tooling for their own institutions
- Engineers curious about non-trivial Chrome MV3 patterns (MAIN-world
  content scripts, native messaging, service-worker coordination)
- Learners studying end-to-end architecture of a browser-extension-plus-
  native-host system

For the deep technical writeup of how every piece works, read
[`ARCHITECTURE.md`](ARCHITECTURE.md). This README is a high-level map.

---

## What it does

One click in the extension popup produces a self-contained folder per
lecture:

- **Video** — 1080p MP4 (H.264 + AAC), remuxed from HLS without
  re-encoding
- **Subtitles** — bilingual SRT tracks (e.g., PT + EN)
- **Transcripts** — Markdown with paragraph-segmented prose, derived
  from SRT locally (no transcription API calls)
- **Slide deck** — original PDF captured from the presentation viewer
- **Course materials** — every file from the lecture's Materials tab,
  downloaded with the user's authenticated token
- **Chat** — conversations, Q&A, and pinned messages in both raw JSON
  (archive) and readable Markdown

Typical output size: ~1.5-2 GB for a 90-minute lecture.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────┐
│ Chrome tab: LMS lecture page                                     │
│   content scripts (MAIN + ISOLATED worlds)                       │
│     → capture chat, materials list, metadata                     │
└───────────────────────┬──────────────────────────────────────────┘
                        │ postMessage + sendMessage
                        ▼
┌──────────────────────────────────────────────────────────────────┐
│ background.js (service worker)                                   │
│   webRequest listeners → HLS chunks, KS, PDF URL, Bearer tokens  │
│   chrome.storage.session per tab                                 │
└───────────────────────┬──────────────────────────────────────────┘
                        │ Native Messaging stdio
                        ▼
┌──────────────────────────────────────────────────────────────────┐
│ Python host                                                      │
│   ffmpeg pipeline, authenticated downloads, format conversions   │
└──────────────────────────────────────────────────────────────────┘
```

Three layers, one job each:

1. **Content scripts** see what the page sees — can monkey-patch
   `window.fetch`/`XMLHttpRequest` to intercept SignalR traffic and
   scrape DOM metadata.
2. **Service worker** observes every network request via
   `webRequest` and coordinates the download flow.
3. **Python host** runs `ffmpeg`, writes to disk, streams progress
   back to the popup via stdio.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the detailed rationale
behind this split.

---

## Tech stack

| Layer       | Technology                                                    |
| ----------- | ------------------------------------------------------------- |
| Extension   | Chrome MV3 (service worker, content scripts in MAIN + ISOLATED) |
| Extension APIs | `webRequest`, `chrome.storage.session`, `chrome.runtime.connectNative` |
| Content script hooks | `fetch` + `XMLHttpRequest` monkey-patching, SignalR MessagePack decoder |
| IPC         | Chrome Native Messaging (stdio, 4-byte length-prefixed JSON)  |
| Host        | Python 3 (stdlib only: `urllib`, `subprocess`, `struct`, `argparse`) |
| Media pipeline | `ffmpeg` (HLS → MP4 remux, VTT → SRT)                     |
| Target player | Kaltura HLS                                                  |
| Target auth | OAuth-style Bearer tokens captured from in-flight XHRs        |

No build step, no bundler, no TypeScript. Vanilla JS in the extension;
vanilla Python in the host.

---

## Getting started

### Prerequisites

- macOS (tested on Darwin 25 / Sequoia) — Linux and Windows support TBD
- Python 3.10 or newer
- `ffmpeg` in `PATH` (macOS: `brew install ffmpeg`)
- Google Chrome with Developer Mode enabled
- ~3 GB free disk space per lecture (final MP4 is 1.5-2 GB)

### Installation

```bash
git clone https://github.com/<your-user>/chrome-ext-mv3-hls-kaltura-lecture-archival-kit.git
cd chrome-ext-mv3-hls-kaltura-lecture-archival-kit

# Set up Python virtualenv (Python 3.14+ on macOS requires this — see PEP 668)
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

# Run tests to verify the Python host works
.venv/bin/pytest
```

### Write your adapter

The extension ships with a **skeleton adapter** that targets the fictional
`your-lms.example.com`. It won't do anything useful until you adapt it to
your real LMS. See [`docs/WRITING-AN-ADAPTER.md`](docs/WRITING-AN-ADAPTER.md)
for the full guide.

Short version:

1. Copy `extension/adapters/skeleton` to `extension/adapters/my-platform`
2. In `adapter-boot.js`, register `chrome.webRequest` listeners for your
   LMS's chat/materials/slides URLs and wire handlers for any custom
   messages your content scripts will send
3. Replace URL patterns and DOM selectors in `chat-hook.js`, `materials-hook.js`,
   and `content.js` with your platform's specifics
4. Do the same for `host/adapters/skeleton` → `host/adapters/my-platform`
5. In `extension/background.js`, change the `importScripts("adapters/skeleton/adapter-boot.js")`
   line to point at `adapters/my-platform/adapter-boot.js`
6. In `extension/manifest.json`, update `content_scripts.js` paths,
   `content_scripts.matches`, and `host_permissions` to match your platform

### Install the native messaging host

```bash
# Installs Python host files to ~/.kaltura-lecture-host/ and writes
# the Chrome Native Messaging manifest.
EXTENSION_ID=<your-extension-id> ./host/install.sh
```

Obtain `EXTENSION_ID` from `chrome://extensions` after loading the extension
unpacked. If you don't pass `EXTENSION_ID`, the script installs a manifest
with a placeholder that you must edit manually.

### Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode" (toggle, top-right)
3. Click "Load unpacked"
4. Select the `extension/` folder from this repo

### Use it

1. Open a lecture page on your LMS (the one you adapted for)
2. Start playback; let it run for ~30 seconds (so the HLS chunks for 1080p
   get captured)
3. Click the extension icon
4. You should see `Flavors captured: ≥ 1`, `KS: ✓ captured`, and your
   lecture title from the metadata scrape
5. Click `Download`
6. Watch progress in the popup; the final folder is at
   `~/Downloads/kaltura-lectures/<lecture title>/`

---

## Project structure

```
chrome-ext-mv3-hls-kaltura-lecture-archival-kit/
├── README.md          ← this file
├── ARCHITECTURE.md    ← deep-dive technical writeup
├── LICENSE            ← MIT
├── extension/                            ← Chrome MV3 extension
│   ├── manifest.json
│   ├── background.js                     ← CORE service worker (generic listeners,
│   │                                       storage, popup messaging, download
│   │                                       lifecycle). Ends with importScripts
│   │                                       of the active adapter-boot.js.
│   ├── popup.html / popup.js
│   └── adapters/
│       └── skeleton/                     ← reference adapter (no-op stubs)
│           ├── README.md                 ← step-by-step adaptation guide
│           ├── adapter.json              ← adapter metadata
│           ├── adapter-boot.js           ← loaded by core via importScripts;
│           │                                registers platform-specific listeners,
│           │                                message handlers, self.adapter hooks
│           ├── content.js                ← ISOLATED, DOM metadata scrape
│           ├── chat-hook.js              ← MAIN world, fetch/XHR/WebSocket hooks
│           ├── chat-bridge.js            ← ISOLATED bridge
│           ├── materials-hook.js         ← MAIN world, materials-API sniff
│           ├── materials-bridge.js       ← ISOLATED bridge
│           └── messagepack-decoder.js    ← optional SignalR binary decoder
├── host/                                 ← Python native messaging host
│   ├── host.py                           ← entry point (CLI + NM mode)
│   ├── host.sh                           ← wrapper shell for Chrome NM
│   ├── install.sh                        ← installs NM manifest + host files
│   ├── com.your.host.json                ← NM manifest template
│   ├── core/
│   │   ├── native_messaging.py           ← stdio protocol
│   │   ├── hls_to_mp4.py                 ← probe flavors + ffmpeg pipeline
│   │   ├── subtitle_convert.py           ← VTT → SRT
│   │   ├── transcript_md.py              ← SRT → Markdown (paragraph heuristics)
│   │   ├── messagepack.py                ← reference decoder (parity with JS)
│   │   └── utils.py                      ← sanitize_filename, HTTP helpers
│   └── adapters/
│       └── skeleton/                     ← reference Python adapter
│           ├── chat_to_markdown.py       ← stub
│           └── materials_downloader.py   ← stub
├── tests/                                ← pytest suite (71 tests)
├── docs/
│   ├── WRITING-AN-ADAPTER.md             ← detailed adapter guide
│   └── TESTING.md                        ← how to run the suite locally
└── .github/workflows/test.yml            ← CI (pytest on Ubuntu + macOS)
```

---

## Engineering highlights

A handful of non-obvious problems worth reading about in detail:

- **The master playlist lies.** Kaltura's authenticated HLS master
  playlist caps listed qualities below what the player actually streams.
  We intercept chunk URLs via `webRequest` and pick the highest-bitrate
  flavor by `HEAD`-probing the first segment of each.
  → [`ARCHITECTURE.md#problem-1`](ARCHITECTURE.md#problem-1-capturing-1080p-hls-when-the-master-playlist-only-lists-540p)

- **Chat REST endpoints return 0 bytes.** The real data arrives over
  a SignalR WebSocket in MessagePack binary frames. We decode it
  client-side from a MAIN-world content script.
  → [`ARCHITECTURE.md#problem-2`](ARCHITECTURE.md#problem-2-decoding-signalrmessagepack-chat)

- **Chrome Native Messaging is opinionated.** macOS Sequoia blocks
  binary execution in `~/Desktop/`. Chrome passes surprise arguments.
  The message protocol has a hard 1 MB ceiling. All of these have
  specific, narrow fixes.
  → [`ARCHITECTURE.md#problem-3`](ARCHITECTURE.md#problem-3-chrome-native-messaging-for-heavy-lifting)

- **MV3 service workers are ephemeral.** State races between rapid
  host messages. The popup comes and goes. We use a promise-chain
  serialization pattern and `chrome.storage.session` as the single
  source of truth.
  → [`ARCHITECTURE.md#problem-4`](ARCHITECTURE.md#problem-4-progress-streaming-back-to-the-ui)

---

## Supported platforms

At the technique level: **any** Kaltura-based LMS that streams HLS and
uses SignalR or similar real-time chat backends.

At the code level (once code is extracted and published here): **the
one platform the reference adapter targets.** Supporting a second
platform is a matter of writing a new adapter — new URL patterns in
`host_permissions`, new MessagePack payload field mapping, new DOM
metadata scrape. The ARCHITECTURE doc describes the adapter boundary.

---

## License

MIT — see [`LICENSE`](LICENSE). Use it however you want.

---

## Legal & ethics

This project exists to support **personal offline archival of lectures
you are legitimately enrolled in**. It is not built to redistribute
content, circumvent DRM (there is none to circumvent — HLS without DRM
is plain HTTP video), or violate any platform's terms of service for
unauthorized access.

**If you use this, you are responsible** for:

- Being an authenticated, paying, or otherwise-authorized user of the
  content you archive
- Reviewing your LMS's terms of service and local copyright law before
  using any tool of this kind
- Not redistributing archived material
- Not using the archived material in ways that violate the rights of
  the content creators (professors, institutions, platforms)

**I'm not a lawyer. This is not legal advice.** Archival of purchased
or licensed educational content for personal offline consumption is
commonly treated as fair use / fair dealing in many jurisdictions, but
the boundaries vary. Know your local law before acting on anything
here.
