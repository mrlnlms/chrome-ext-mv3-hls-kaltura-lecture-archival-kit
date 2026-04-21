"""Testa conversão VTT → SRT."""
from host.core import subtitle_convert
from tests.conftest import FIXTURES_DIR


def test_vtt_to_srt_matches_fixture():
    vtt = (FIXTURES_DIR / "sample.vtt").read_text(encoding="utf-8")
    expected = (FIXTURES_DIR / "sample.srt").read_text(encoding="utf-8")
    assert subtitle_convert.vtt_to_srt(vtt).strip() == expected.strip()


def test_vtt_to_srt_replaces_dot_with_comma_in_timestamps():
    vtt = "WEBVTT\n\n00:00:01.500 --> 00:00:02.750\nHello"
    out = subtitle_convert.vtt_to_srt(vtt)
    assert "00:00:01,500 --> 00:00:02,750" in out


def test_vtt_to_srt_numbers_cues_sequentially():
    vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:03.000 --> 00:00:04.000\nB"
    out = subtitle_convert.vtt_to_srt(vtt)
    assert out.startswith("1\n")
    assert "\n\n2\n" in out
