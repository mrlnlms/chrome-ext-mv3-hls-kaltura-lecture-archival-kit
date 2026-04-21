"""Testa o entry point CLI do host."""
import pytest
from host import host


def test_main_without_args_returns_exit_2(capsys):
    rc = host.main([])
    assert rc == 2


def test_main_without_required_args_prints_usage(capsys):
    """Sem --chunk/--dest/--title: print usage e exit 2."""
    rc = host.main(["--dest", "/tmp/out"])
    assert rc == 2


def test_main_missing_chunk_only_prints_usage(capsys):
    """Sem --chunk mas com --dest e --title: exit 2 com usage."""
    rc = host.main(["--dest", "/tmp/out", "--title", "Aula 01"])
    assert rc == 2


def test_main_missing_dest_prints_usage(capsys):
    """Sem --dest mas com --chunk e --title: exit 2 com usage."""
    rc = host.main(["--chunk", "https://example.com/seg-1-v1-a1.ts", "--title", "Aula 01"])
    assert rc == 2


def test_main_missing_title_prints_usage(capsys):
    """Sem --title mas com --chunk e --dest: exit 2 com usage."""
    rc = host.main(["--chunk", "https://example.com/seg-1-v1-a1.ts", "--dest", "/tmp/out"])
    assert rc == 2


def test_main_ignores_unknown_args(monkeypatch):
    """parse_known_args: argv extras do Chrome não matam o parser.

    Com --native-messaging, o modo NM tenta ler stdin; monkeypatcha
    read_message pra retornar None (stdin vazio) — resulta em error + exit 1.
    """
    from host.core import native_messaging

    sent = []
    monkeypatch.setattr(native_messaging, "read_message", lambda: None)
    monkeypatch.setattr(native_messaging, "send", sent.append)
    import os
    monkeypatch.setattr(os, "_exit", lambda code: (_ for _ in ()).throw(SystemExit(code)))

    with pytest.raises(SystemExit) as exc_info:
        host.main(["--native-messaging", "chrome-extension://abc/", "--parent-window=0"])
    # Stdin vazio → error + exit 1 (não exit 2 de parse error)
    assert exc_info.value.code == 1
    assert sent[-1]["type"] == "error"


def test_native_messaging_mode_happy_path(monkeypatch, tmp_path):
    """Valida o fluxo NM: read request → progress → done."""
    from host.core import native_messaging, hls_to_mp4

    sent_messages = []
    monkeypatch.setattr(native_messaging, "read_message", lambda: {
        "chunks": ["https://cfvod.kaltura.com/p/1/sp/1/serveFlavor/entryId/e/v/1/ev/1/flavorId/f/name/a.mp4/seg-1-v1-a1.ts"],
        "dest": str(tmp_path),
        "title": "test-lecture",
    })
    monkeypatch.setattr(native_messaging, "send", sent_messages.append)
    monkeypatch.setattr(hls_to_mp4, "pick_best_flavor", lambda urls: urls[0])
    monkeypatch.setattr(
        hls_to_mp4, "chunklist_url",
        lambda u: u.replace("seg-1-v1-a1.ts", "chunklist.m3u8"),
    )
    monkeypatch.setattr(hls_to_mp4, "run_ffmpeg", lambda *a, **kw: None)

    # os._exit mata o pytest; substitui por SystemExit(code)
    import os
    monkeypatch.setattr(os, "_exit", lambda code: (_ for _ in ()).throw(SystemExit(code)))

    with pytest.raises(SystemExit) as exc_info:
        host.native_messaging_mode()
    assert exc_info.value.code == 0

    # Valida mensagens enviadas
    types = [m["type"] for m in sent_messages]
    assert "progress" in types
    assert types[-1] == "done"


def test_native_messaging_mode_missing_fields(monkeypatch):
    """Request sem campos obrigatórios → error + exit 1."""
    from host.core import native_messaging

    sent = []
    monkeypatch.setattr(native_messaging, "read_message", lambda: {"chunks": []})
    monkeypatch.setattr(native_messaging, "send", sent.append)
    import os
    monkeypatch.setattr(os, "_exit", lambda code: (_ for _ in ()).throw(SystemExit(code)))

    with pytest.raises(SystemExit) as exc_info:
        host.native_messaging_mode()
    assert exc_info.value.code == 1
    assert sent[-1]["type"] == "error"
