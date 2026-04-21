"""Decoder MessagePack de referência.

Porta fiel da implementação JS (mpDecode/mpArray/mpMap) para Python.
Serve como oráculo de paridade: mesmos bytes devem produzir mesmos outputs
nas duas linguagens.

Spec: https://github.com/msgpack/msgpack/blob/master/spec.md
"""
import struct
from typing import Any, Tuple


def decode(data: bytes) -> Any:
    """Decodifica um payload MessagePack completo e retorna o valor raiz.

    Args:
        data: payload MessagePack como bytes.

    Returns:
        Valor Python correspondente (int, float, str, bytes, list, dict, None, bool).

    Raises:
        ValueError: se um type byte não reconhecido for encontrado.
    """
    value, _ = _decode_at(data, 0)
    return value


def _decode_at(data: bytes, off: int) -> Tuple[Any, int]:
    """Decodifica um único valor a partir do offset dado.

    Retorna uma tupla (valor, próximo_offset).
    """
    c = data[off]

    # positive fixint: 0x00..0x7f
    if c <= 0x7F:
        return c, off + 1

    # negative fixint: 0xe0..0xff
    if c >= 0xE0:
        # interpreta como signed: subtrai 0x100
        return c - 0x100, off + 1

    # fixstr: 0xa0..0xbf
    if 0xA0 <= c <= 0xBF:
        length = c & 0x1F
        raw = data[off + 1 : off + 1 + length]
        return raw.decode("utf-8"), off + 1 + length

    # fixarray: 0x90..0x9f
    if 0x90 <= c <= 0x9F:
        return _decode_array(data, off + 1, c & 0x0F)

    # fixmap: 0x80..0x8f
    if 0x80 <= c <= 0x8F:
        return _decode_map(data, off + 1, c & 0x0F)

    # --- tipos com type byte explícito ---
    if c == 0xC0:  # nil
        return None, off + 1

    if c == 0xC2:  # false
        return False, off + 1

    if c == 0xC3:  # true
        return True, off + 1

    # bin 8/16/32
    if c == 0xC4:
        length = data[off + 1]
        return data[off + 2 : off + 2 + length], off + 2 + length

    if c == 0xC5:
        (length,) = struct.unpack_from(">H", data, off + 1)
        return data[off + 3 : off + 3 + length], off + 3 + length

    if c == 0xC6:
        (length,) = struct.unpack_from(">I", data, off + 1)
        return data[off + 5 : off + 5 + length], off + 5 + length

    # float 32 / float 64
    if c == 0xCA:
        (value,) = struct.unpack_from(">f", data, off + 1)
        return value, off + 5

    if c == 0xCB:
        (value,) = struct.unpack_from(">d", data, off + 1)
        return value, off + 9

    # uint 8/16/32/64
    if c == 0xCC:
        return data[off + 1], off + 2

    if c == 0xCD:
        (value,) = struct.unpack_from(">H", data, off + 1)
        return value, off + 3

    if c == 0xCE:
        (value,) = struct.unpack_from(">I", data, off + 1)
        return value, off + 5

    if c == 0xCF:
        (value,) = struct.unpack_from(">Q", data, off + 1)
        return value, off + 9

    # int 8/16/32/64
    if c == 0xD0:
        (value,) = struct.unpack_from(">b", data, off + 1)
        return value, off + 2

    if c == 0xD1:
        (value,) = struct.unpack_from(">h", data, off + 1)
        return value, off + 3

    if c == 0xD2:
        (value,) = struct.unpack_from(">i", data, off + 1)
        return value, off + 5

    if c == 0xD3:
        (value,) = struct.unpack_from(">q", data, off + 1)
        return value, off + 9

    # str 8/16/32
    if c == 0xD9:
        length = data[off + 1]
        raw = data[off + 2 : off + 2 + length]
        return raw.decode("utf-8"), off + 2 + length

    if c == 0xDA:
        (length,) = struct.unpack_from(">H", data, off + 1)
        raw = data[off + 3 : off + 3 + length]
        return raw.decode("utf-8"), off + 3 + length

    if c == 0xDB:
        (length,) = struct.unpack_from(">I", data, off + 1)
        raw = data[off + 5 : off + 5 + length]
        return raw.decode("utf-8"), off + 5 + length

    # array 16/32
    if c == 0xDC:
        (n,) = struct.unpack_from(">H", data, off + 1)
        return _decode_array(data, off + 3, n)

    if c == 0xDD:
        (n,) = struct.unpack_from(">I", data, off + 1)
        return _decode_array(data, off + 5, n)

    # map 16/32
    if c == 0xDE:
        (n,) = struct.unpack_from(">H", data, off + 1)
        return _decode_map(data, off + 3, n)

    if c == 0xDF:
        (n,) = struct.unpack_from(">I", data, off + 1)
        return _decode_map(data, off + 5, n)

    raise ValueError(f"type byte não suportado: 0x{c:02x}")


def _decode_array(data: bytes, off: int, n: int) -> Tuple[list, int]:
    """Decodifica N elementos consecutivos como lista."""
    result = []
    for _ in range(n):
        value, off = _decode_at(data, off)
        result.append(value)
    return result, off


def _decode_map(data: bytes, off: int, n: int) -> Tuple[dict, int]:
    """Decodifica N pares chave-valor consecutivos como dict."""
    result = {}
    for _ in range(n):
        key, off = _decode_at(data, off)
        value, off = _decode_at(data, off)
        result[key] = value
    return result, off
