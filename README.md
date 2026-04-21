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

> **Status: WIP.** Generalized extension and host code are being
> extracted from a production-validated implementation and are not yet
> committed. Until that lands, this section is a stub.
>
> In the meantime, [`ARCHITECTURE.md`](ARCHITECTURE.md) is fully written
> and describes every technique needed to implement your own version.

Planned structure for the eventual installation flow:

```
# Install the native messaging host (copies host files to ~/.local-host/
# and writes the Chrome NativeMessagingHosts manifest)
./host/install.sh

# Load the extension in Chrome
# chrome://extensions → enable "Developer mode" → "Load unpacked"
# → point at extension/
```

Prerequisites (planned):

- macOS or Linux (Windows support TBD)
- Python 3.8+
- `ffmpeg` in PATH (`brew install ffmpeg` on macOS)
- Chrome / Chromium with Developer Mode enabled

---

## Project structure

```
chrome-ext-mv3-hls-kaltura-lecture-archival-kit/
├── README.md          ← this file
├── ARCHITECTURE.md    ← deep-dive technical writeup
├── LICENSE            ← MIT
├── extension/         ← Chrome MV3 extension (planned)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── chat-hook.js           (MAIN world)
│   ├── chat-bridge.js         (ISOLATED world)
│   ├── materials-hook.js      (MAIN world)
│   ├── materials-bridge.js    (ISOLATED world)
│   ├── popup.html
│   └── popup.js
└── host/              ← Python native messaging host (planned)
    ├── host.py
    ├── host.sh
    ├── install.sh
    └── com.your.host.json
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
