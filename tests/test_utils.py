"""Testa utilitários compartilhados do host."""
from host.core import utils


def test_sanitize_filename_removes_problematic_chars():
    assert utils.sanitize_filename('Aula 1: "Intro" / parte 2') == 'Aula 1 - Intro - parte 2'


def test_sanitize_filename_preserves_unicode():
    assert utils.sanitize_filename('Estatística — Método') == 'Estatística — Método'


def test_sanitize_filename_collapses_whitespace():
    assert utils.sanitize_filename('  foo    bar  ') == 'foo bar'


def test_http_head_returns_content_length(monkeypatch):
    """Não faz request real — testa que método e headers estão corretos."""
    calls = []

    class FakeResponse:
        headers = {"Content-Length": "12345"}
        def __enter__(self): return self
        def __exit__(self, *args): pass

    def fake_urlopen(req, timeout=None):
        calls.append({"method": req.get_method(), "url": req.full_url})
        return FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = utils.http_head_content_length("https://example.com/file.ts")
    assert result == 12345
    assert calls[0]["method"] == "HEAD"


def test_http_head_returns_none_when_header_absent(monkeypatch):
    """Retorna None quando Content-Length não está na resposta."""

    class FakeResponseNoLength:
        headers = {}
        def __enter__(self): return self
        def __exit__(self, *args): pass

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=None: FakeResponseNoLength())
    result = utils.http_head_content_length("https://example.com/file.ts")
    assert result is None


def test_http_get_bytes_returns_body(monkeypatch):
    """Testa que http_get_bytes retorna o body da resposta."""

    class FakeGetResponse:
        def read(self) -> bytes:
            return b"hello bytes"
        def __enter__(self): return self
        def __exit__(self, *args): pass

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=None: FakeGetResponse())
    result = utils.http_get_bytes("https://example.com/data")
    assert result == b"hello bytes"
