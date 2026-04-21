# Testing

All tests live in `tests/`. They're Python-only (pytest) — the extension's
JavaScript has no test harness yet; manual validation in Chrome is the
current mechanism.

## Quick start

```bash
# First-time setup (creates venv + installs pytest)
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

# Run the full suite
.venv/bin/pytest

# Run a specific file
.venv/bin/pytest tests/test_native_messaging.py -v

# Run tests matching a name pattern
.venv/bin/pytest -k "messagepack" -v
```

## What's covered

| Module                       | Tests                                          |
| ---------------------------- | ---------------------------------------------- |
| `host/core/native_messaging` | stdio encode/decode, EOF handling              |
| `host/core/utils`            | filename sanitization, HTTP helpers            |
| `host/core/hls_to_mp4`       | URL parsing, flavor selection, ffmpeg parse    |
| `host/core/subtitle_convert` | WebVTT → SRT                                   |
| `host/core/transcript_md`    | SRT → Markdown with paragraph heuristics       |
| `host/core/messagepack`      | Every type byte range, nested structures       |
| `host/host` (CLI + NM)       | Argument parsing, NM happy path + error path   |
| `host/adapters/skeleton`     | Stubs raise `NotImplementedError`              |

## What's NOT covered (yet)

- `run_ffmpeg` end-to-end (invokes real ffmpeg — manual smoke test required)
- The JavaScript MessagePack decoder in `extension/adapters/skeleton/messagepack-decoder.js`
  (kept in parity with the Python reference; if you need confidence, add
  a fixture-based parity test that runs the JS decoder via Node or a
  browser harness)
- Service worker / content script integration (requires Chrome)

## Parity fixtures

`tests/fixtures/messagepack/*.bin` are binary MessagePack payloads with
matching `.expected.json` files. The Python decoder is tested against
them in `test_messagepack.py::test_decoder_matches_fixture_files`. Use
the same fixtures when testing your JS decoder — they should decode to
the exact same values.

## Running CI locally

GitHub Actions runs the suite on Ubuntu and macOS with Python 3.10–3.12.
See [`.github/workflows/test.yml`](../.github/workflows/test.yml).

To reproduce a specific CI environment:

```bash
# Using pyenv to pin Python 3.10 (example)
pyenv install 3.10
pyenv local 3.10
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest
```
