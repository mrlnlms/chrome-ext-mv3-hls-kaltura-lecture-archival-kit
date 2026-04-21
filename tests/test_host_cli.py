"""Testa o entry point CLI do host."""
import pytest
from host import host


def test_main_without_args_returns_exit_2(capsys):
    rc = host.main([])
    assert rc == 2


def test_main_with_native_messaging_returns_exit_2(capsys):
    """Phase 4 finaliza; por ora stub."""
    rc = host.main(["--native-messaging"])
    assert rc == 2
    captured = capsys.readouterr()
    assert "not yet implemented" in captured.err


def test_main_ignores_unknown_args(capsys):
    """parse_known_args: argv extras do Chrome não matam o parser."""
    rc = host.main(["--native-messaging", "chrome-extension://abc/", "--parent-window=0"])
    assert rc == 2  # ainda é stub, mas não foi exit 2 por parse error


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
