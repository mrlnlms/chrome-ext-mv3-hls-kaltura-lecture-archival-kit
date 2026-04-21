"""Gera fixtures binárias pra testes de paridade Python vs JS.
Rodar uma vez: python3 tests/fixtures/messagepack/generate.py
"""
import json
import struct
from pathlib import Path

HERE = Path(__file__).parent

FIXTURES = {
    "signalr_frame_basic": (
        bytes([0x95, 0x01, 0x80, 0xC0])
        + bytes([0xAE]) + b"ReceiveMessage"
        + bytes([0x92, 0xA5]) + b"alice" + bytes([0xA2]) + b"hi",
        [1, {}, None, "ReceiveMessage", ["alice", "hi"]],
    ),
    "nested_map": (
        bytes([0x82, 0xA4]) + b"user" + bytes([0x82, 0xA2]) + b"id" + bytes([0x01, 0xA4])
        + b"name" + bytes([0xA3]) + b"Bob" + bytes([0xA5]) + b"admin" + bytes([0xC3]),
        {"user": {"id": 1, "name": "Bob"}, "admin": True},
    ),
    "mixed_types": (
        bytes([0x85])                                  # fixmap 5 pairs
        + bytes([0xA3]) + b"nil" + bytes([0xC0])       # "nil": null
        + bytes([0xA4]) + b"bool" + bytes([0xC3])      # "bool": true
        + bytes([0xA3]) + b"int" + bytes([0xCD]) + struct.pack(">H", 1000)  # "int": 1000 (uint16)
        + bytes([0xA3]) + b"str" + bytes([0xA5]) + b"world"  # "str": "world"
        + bytes([0xA3]) + b"arr" + bytes([0x92, 0x01, 0x02]), # "arr": [1, 2]
        {"nil": None, "bool": True, "int": 1000, "str": "world", "arr": [1, 2]},
    ),
    "utf8_text": (
        bytes([0xAA]) + "olá mundo".encode("utf-8"),   # fixstr, len=10 bytes UTF-8
        "olá mundo",
    ),
    "integers_all_widths": (
        bytes([0x96])                                  # fixarray 6
        + bytes([0xCC, 0xFF])                          # uint8: 255
        + bytes([0xCD]) + struct.pack(">H", 65535)     # uint16: 65535
        + bytes([0xCE]) + struct.pack(">I", 4294967295)  # uint32: 2^32-1
        + bytes([0xD0, 0x80])                          # int8: -128
        + bytes([0xD1]) + struct.pack(">h", -32768)    # int16: -32768
        + bytes([0xD2]) + struct.pack(">i", -2147483648),  # int32: -2^31
        [255, 65535, 4294967295, -128, -32768, -2147483648],
    ),
}

for name, (payload, expected) in FIXTURES.items():
    (HERE / f"{name}.bin").write_bytes(payload)
    (HERE / f"{name}.expected.json").write_text(json.dumps(expected, ensure_ascii=False))

print(f"Generated {len(FIXTURES)} fixtures in {HERE}")
