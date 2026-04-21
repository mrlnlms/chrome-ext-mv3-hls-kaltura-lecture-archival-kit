"""Testa o pipeline HLS → MP4."""
import pytest
from host.core import hls_to_mp4


KALTURA_CHUNK_URL = (
    "https://cfvod.kaltura.com/p/123/sp/456/serveFlavor/entryId/0_abc123/"
    "v/1/ev/2/flavorId/0_flav1080/name/a.mp4/seg-1-v1-a1.ts"
)


def test_parse_chunk_url_extracts_fields():
    info = hls_to_mp4.parse_chunk_url(KALTURA_CHUNK_URL)
    assert info.partner_id == "123"
    assert info.sub == "456"
    assert info.entry_id == "0_abc123"
    assert info.flavor_id == "0_flav1080"


def test_parse_chunk_url_raises_on_invalid():
    with pytest.raises(ValueError):
        hls_to_mp4.parse_chunk_url("https://example.com/not-a-kaltura-url")


def test_chunklist_url_from_chunk_url():
    url = hls_to_mp4.chunklist_url(KALTURA_CHUNK_URL)
    assert url.endswith("chunklist.m3u8")
    assert "/flavorId/0_flav1080/" in url


def test_pick_best_flavor_picks_largest(monkeypatch):
    urls = [
        "https://cfvod.kaltura.com/p/1/sp/1/serveFlavor/entryId/e/v/1/ev/1/flavorId/f540/name/a.mp4/seg-5-v1-a1.ts",
        "https://cfvod.kaltura.com/p/1/sp/1/serveFlavor/entryId/e/v/1/ev/1/flavorId/f1080/name/a.mp4/seg-5-v1-a1.ts",
        "https://cfvod.kaltura.com/p/1/sp/1/serveFlavor/entryId/e/v/1/ev/1/flavorId/f360/name/a.mp4/seg-5-v1-a1.ts",
    ]
    fake_sizes = {"f540": 1_000_000, "f1080": 3_000_000, "f360": 500_000}

    def fake_head(url, timeout=30.0):
        for fid, size in fake_sizes.items():
            if f"/flavorId/{fid}/" in url:
                return size
        return 0

    monkeypatch.setattr(hls_to_mp4.utils, "http_head_content_length", fake_head)
    best = hls_to_mp4.pick_best_flavor(urls)
    assert "/flavorId/f1080/" in best
    assert best.endswith("seg-1-v1-a1.ts")  # normalizado


def test_parse_ffmpeg_progress_line():
    line = "frame= 1234 fps=58 q=-1.0 size=42069kB time=00:02:15.67 bitrate=1234kbits/s speed=1.25x"
    p = hls_to_mp4.parse_ffmpeg_progress(line)
    assert p.elapsed_seconds == pytest.approx(135.67, abs=0.01)
    assert p.speed == pytest.approx(1.25, abs=0.01)


def test_parse_ffmpeg_progress_returns_none_on_garbage():
    assert hls_to_mp4.parse_ffmpeg_progress("not a progress line") is None


# --- edge cases extras ------------------------------------------------------

def test_parse_ffmpeg_progress_without_speed():
    """Linha com time= mas sem speed= deve retornar speed=None."""
    line = "frame=  100 fps=25 q=-1.0 size=10240kB time=00:00:04.00 bitrate=2048kbits/s"
    p = hls_to_mp4.parse_ffmpeg_progress(line)
    assert p is not None
    assert p.elapsed_seconds == pytest.approx(4.0, abs=0.01)
    assert p.speed is None


def test_pick_best_flavor_raises_on_empty_list(monkeypatch):
    """Lista vazia deve levantar ValueError."""
    monkeypatch.setattr(hls_to_mp4.utils, "http_head_content_length", lambda url, timeout=30.0: 0)
    with pytest.raises(ValueError):
        hls_to_mp4.pick_best_flavor([])
