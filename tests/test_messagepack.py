"""Testa o decoder MessagePack — serve como referência de paridade pra versão JS."""
import json
import struct
from pathlib import Path

import pytest

from host.core import messagepack
from tests.conftest import FIXTURES_DIR


# ---------------------------------------------------------------------------
# Positive fixint / negative fixint
# ---------------------------------------------------------------------------

def test_decode_positive_fixint():
    assert messagepack.decode(bytes([0x00])) == 0
    assert messagepack.decode(bytes([0x7f])) == 127
    assert messagepack.decode(bytes([0x2a])) == 42


def test_decode_negative_fixint():
    assert messagepack.decode(bytes([0xff])) == -1
    assert messagepack.decode(bytes([0xe0])) == -32
    assert messagepack.decode(bytes([0xf0])) == -16


# ---------------------------------------------------------------------------
# Nil / bool
# ---------------------------------------------------------------------------

def test_decode_nil_bool():
    assert messagepack.decode(bytes([0xc0])) is None
    assert messagepack.decode(bytes([0xc2])) is False
    assert messagepack.decode(bytes([0xc3])) is True


# ---------------------------------------------------------------------------
# Strings
# ---------------------------------------------------------------------------

def test_decode_fixstr():
    assert messagepack.decode(bytes([0xa5]) + b"hello") == "hello"
    assert messagepack.decode(bytes([0xa0])) == ""  # empty fixstr


def test_decode_utf8_str():
    # "olá" em UTF-8 = 4 bytes (o=1, l=1, á=2); fixstr len 4 = 0xa4
    assert messagepack.decode(bytes([0xa4]) + "olá".encode("utf-8")) == "olá"


def test_decode_str8():
    payload = "x" * 200
    data = bytes([0xd9, 200]) + payload.encode("utf-8")
    assert messagepack.decode(data) == payload


def test_decode_str16():
    payload = "y" * 300
    data = bytes([0xda]) + struct.pack(">H", 300) + payload.encode("utf-8")
    assert messagepack.decode(data) == payload


def test_decode_str32():
    payload = "z" * 100
    data = bytes([0xdb]) + struct.pack(">I", 100) + payload.encode("utf-8")
    assert messagepack.decode(data) == payload


# ---------------------------------------------------------------------------
# Binary
# ---------------------------------------------------------------------------

def test_decode_bin8():
    raw = bytes(range(10))
    data = bytes([0xc4, 10]) + raw
    assert messagepack.decode(data) == raw


def test_decode_bin16():
    raw = bytes(range(256))
    data = bytes([0xc5]) + struct.pack(">H", 256) + raw
    assert messagepack.decode(data) == raw


def test_decode_bin32():
    raw = b"\xde\xad\xbe\xef"
    data = bytes([0xc6]) + struct.pack(">I", 4) + raw
    assert messagepack.decode(data) == raw


# ---------------------------------------------------------------------------
# Unsigned integers
# ---------------------------------------------------------------------------

def test_decode_uint8():
    assert messagepack.decode(bytes([0xcc, 0xff])) == 255
    assert messagepack.decode(bytes([0xcc, 0x00])) == 0


def test_decode_uint16():
    assert messagepack.decode(bytes([0xcd, 0x01, 0x00])) == 256
    assert messagepack.decode(bytes([0xcd, 0xff, 0xff])) == 65535


def test_decode_uint32():
    assert messagepack.decode(bytes([0xce]) + struct.pack(">I", 2**32 - 1)) == 2**32 - 1
    assert messagepack.decode(bytes([0xce]) + struct.pack(">I", 100000)) == 100000


def test_decode_uint64():
    val = 2**40
    assert messagepack.decode(bytes([0xcf]) + struct.pack(">Q", val)) == val


# ---------------------------------------------------------------------------
# Signed integers
# ---------------------------------------------------------------------------

def test_decode_int8():
    assert messagepack.decode(bytes([0xd0, 0x80])) == -128
    assert messagepack.decode(bytes([0xd0, 0x7f])) == 127


def test_decode_int16():
    assert messagepack.decode(bytes([0xd1]) + struct.pack(">h", -1000)) == -1000


def test_decode_int32():
    assert messagepack.decode(bytes([0xd2, 0xff, 0xff, 0xff, 0xfe])) == -2
    assert messagepack.decode(bytes([0xd2]) + struct.pack(">i", -2**31)) == -(2**31)


def test_decode_int64():
    val = -(2**62)
    assert messagepack.decode(bytes([0xd3]) + struct.pack(">q", val)) == val


# ---------------------------------------------------------------------------
# Floats
# ---------------------------------------------------------------------------

def test_decode_float32():
    data = bytes([0xca]) + struct.pack(">f", 1.5)
    result = messagepack.decode(data)
    assert abs(result - 1.5) < 1e-6


def test_decode_float64():
    data = bytes([0xcb]) + struct.pack(">d", 3.14)
    assert messagepack.decode(data) == 3.14


# ---------------------------------------------------------------------------
# Arrays
# ---------------------------------------------------------------------------

def test_decode_fixarray():
    assert messagepack.decode(bytes([0x93, 0x01, 0x02, 0x03])) == [1, 2, 3]
    assert messagepack.decode(bytes([0x90])) == []  # empty fixarray


def test_decode_array16():
    # array16 com 3 elementos: [1, 2, 3]
    data = bytes([0xdc]) + struct.pack(">H", 3) + bytes([0x01, 0x02, 0x03])
    assert messagepack.decode(data) == [1, 2, 3]


def test_decode_array32():
    data = bytes([0xdd]) + struct.pack(">I", 2) + bytes([0x7f, 0x00])
    assert messagepack.decode(data) == [127, 0]


def test_decode_nested_array():
    # [[1, 2], [3]]  — 0x92 (fixarray 2), 0x92 (fixarray 2), 1, 2, 0x91 (fixarray 1), 3
    data = bytes([0x92, 0x92, 0x01, 0x02, 0x91, 0x03])
    assert messagepack.decode(data) == [[1, 2], [3]]


# ---------------------------------------------------------------------------
# Maps
# ---------------------------------------------------------------------------

def test_decode_fixmap():
    assert messagepack.decode(bytes([0x81, 0xa1, ord("a"), 0x01])) == {"a": 1}
    assert messagepack.decode(bytes([0x80])) == {}  # empty fixmap


def test_decode_map16():
    # map16 {"x": 1}
    data = bytes([0xde]) + struct.pack(">H", 1) + bytes([0xa1, ord("x"), 0x01])
    assert messagepack.decode(data) == {"x": 1}


def test_decode_map32():
    data = bytes([0xdf]) + struct.pack(">I", 1) + bytes([0xa1, ord("y"), 0x02])
    assert messagepack.decode(data) == {"y": 2}


def test_decode_nested_map():
    # {"outer": {"inner": 42}}
    inner = bytes([0x81]) + bytes([0xa5]) + b"inner" + bytes([0x2a])
    outer = bytes([0x81]) + bytes([0xa5]) + b"outer" + inner
    assert messagepack.decode(outer) == {"outer": {"inner": 42}}


def test_decode_map_mixed_values():
    # {"flag": true, "n": nil}
    data = (
        bytes([0x82])
        + bytes([0xa4]) + b"flag" + bytes([0xc3])
        + bytes([0xa1]) + b"n" + bytes([0xc0])
    )
    assert messagepack.decode(data) == {"flag": True, "n": None}


# ---------------------------------------------------------------------------
# Complex / SignalR-like frame
# ---------------------------------------------------------------------------

def test_decode_signalr_like_frame():
    """Simula um frame SignalR invocation:
    [type=1, headers={}, invocationId=nil, target="ReceiveMessage", args=["alice", "hi"]]"""
    frame = (
        bytes([0x95, 0x01, 0x80, 0xc0])
        + bytes([0xae]) + b"ReceiveMessage"
        + bytes([0x92, 0xa5]) + b"alice" + bytes([0xa2]) + b"hi"
    )
    decoded = messagepack.decode(frame)
    assert decoded == [1, {}, None, "ReceiveMessage", ["alice", "hi"]]


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

def test_decode_unknown_type_raises():
    # 0xc1 é reservado na spec MessagePack
    with pytest.raises(ValueError, match="0xc1"):
        messagepack.decode(bytes([0xc1]))


def test_decode_unknown_type_0xc8_raises():
    with pytest.raises(ValueError):
        messagepack.decode(bytes([0xc8]))


# ---------------------------------------------------------------------------
# Paridade com fixtures geradas por generate.py
# ---------------------------------------------------------------------------

def test_decoder_matches_fixture_files():
    """Verifica paridade byte-a-byte entre .bin e .expected.json."""
    fixtures_dir = FIXTURES_DIR / "messagepack"
    bin_files = list(fixtures_dir.glob("*.bin"))
    assert bin_files, "Nenhuma fixture .bin encontrada — rode generate.py primeiro"
    for bin_file in bin_files:
        expected_file = bin_file.with_suffix(".expected.json")
        payload = bin_file.read_bytes()
        expected = json.loads(expected_file.read_text())
        assert messagepack.decode(payload) == expected, f"mismatch for {bin_file.name}"
