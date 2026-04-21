"""Testa o protocolo stdio do Chrome Native Messaging:
4 bytes little-endian de length prefix + JSON UTF-8."""
import io
import json
import struct

from host.core import native_messaging


def test_encode_produces_length_prefix_plus_json():
    buf = io.BytesIO()
    native_messaging.write_message(buf, {"type": "hello", "value": 42})
    data = buf.getvalue()
    length = struct.unpack("<I", data[:4])[0]
    assert len(data) == 4 + length
    payload = json.loads(data[4:4 + length].decode("utf-8"))
    assert payload == {"type": "hello", "value": 42}


def test_decode_reads_length_prefix_and_returns_json():
    payload = {"type": "progress", "percent": 42}
    data = json.dumps(payload).encode("utf-8")
    stream = io.BytesIO(struct.pack("<I", len(data)) + data)
    result = native_messaging.read_message(stream)
    assert result == payload


def test_decode_returns_none_on_eof():
    stream = io.BytesIO(b"")
    assert native_messaging.read_message(stream) is None


def test_decode_returns_none_on_truncated_payload():
    # Anuncia 100 bytes mas entrega só 4 — simula Chrome fechando o pipe no meio
    stream = io.BytesIO(struct.pack("<I", 100) + b"abcd")
    assert native_messaging.read_message(stream) is None


def test_roundtrip_unicode():
    payload = {"title": "Aula — prova α,β,γ"}
    buf = io.BytesIO()
    native_messaging.write_message(buf, payload)
    buf.seek(0)
    result = native_messaging.read_message(buf)
    assert result == payload
