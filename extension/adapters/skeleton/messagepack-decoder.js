// MessagePack decoder — paridade com host/core/messagepack.py.
// Spec: https://github.com/msgpack/msgpack/blob/master/spec.md
//
// Cobre os mesmos type bytes que o decoder Python de referência:
//   positive fixint, negative fixint, fixstr, fixarray, fixmap,
//   nil, bool, bin8/16/32, float32/64, uint8/16/32/64,
//   int8/16/32/64, str8/16/32, array16/32, map16/32.
// Levanta erro em qualquer byte não mapeado (paridade com ValueError do Python).
//
// Exposto como IIFE — não usa ES modules (compatível com MAIN world).
// Ponto de entrada: window.__archivalKit.messagePack.decode(bytes)
(function () {
  const TD = new TextDecoder("utf-8");

  /**
   * Decodifica um payload MessagePack completo e retorna o valor raiz.
   * @param {Uint8Array|ArrayBuffer} bytes
   * @returns {*}
   */
  function decode(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      bytes = new Uint8Array(bytes);
    }
    const [value] = decodeAt(bytes, 0);
    return value;
  }

  /**
   * Decodifica um único valor a partir do offset dado.
   * Retorna [valor, próximo_offset] — espelho de _decode_at() no Python.
   * @param {Uint8Array} b
   * @param {number} off
   * @returns {[*, number]}
   */
  function decodeAt(b, off) {
    // DataView compartilha o mesmo ArrayBuffer subjacente; byteOffset garante
    // que operações multi-byte usem o offset correto quando b é uma subview.
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const c = b[off];

    // positive fixint: 0x00..0x7f
    if (c <= 0x7f) return [c, off + 1];

    // negative fixint: 0xe0..0xff — interpreta como signed (subtrai 0x100)
    if (c >= 0xe0) return [c - 0x100, off + 1];

    // fixstr: 0xa0..0xbf
    if (c >= 0xa0 && c <= 0xbf) {
      const L = c & 0x1f;
      return [TD.decode(b.subarray(off + 1, off + 1 + L)), off + 1 + L];
    }

    // fixarray: 0x90..0x9f
    if (c >= 0x90 && c <= 0x9f) return decodeArray(b, off + 1, c & 0x0f);

    // fixmap: 0x80..0x8f
    if (c >= 0x80 && c <= 0x8f) return decodeMap(b, off + 1, c & 0x0f);

    switch (c) {
      // nil
      case 0xc0: return [null, off + 1];
      // bool
      case 0xc2: return [false, off + 1];
      case 0xc3: return [true, off + 1];

      // bin 8/16/32
      case 0xc4: {
        const L = b[off + 1];
        return [b.subarray(off + 2, off + 2 + L), off + 2 + L];
      }
      case 0xc5: {
        const L = dv.getUint16(off + 1);
        return [b.subarray(off + 3, off + 3 + L), off + 3 + L];
      }
      case 0xc6: {
        const L = dv.getUint32(off + 1);
        return [b.subarray(off + 5, off + 5 + L), off + 5 + L];
      }

      // float 32/64
      case 0xca: return [dv.getFloat32(off + 1), off + 5];
      case 0xcb: return [dv.getFloat64(off + 1), off + 9];

      // uint 8/16/32/64
      case 0xcc: return [b[off + 1], off + 2];
      case 0xcd: return [dv.getUint16(off + 1), off + 3];
      case 0xce: return [dv.getUint32(off + 1), off + 5];
      case 0xcf: {
        // uint64 — JS Number perde precisão para valores > 2^53; cobre o
        // caso típico de timestamps (< ~285 anos desde epoch).
        const hi = dv.getUint32(off + 1);
        const lo = dv.getUint32(off + 5);
        return [hi * 4294967296 + lo, off + 9];
      }

      // int 8/16/32/64
      case 0xd0: return [dv.getInt8(off + 1), off + 2];
      case 0xd1: return [dv.getInt16(off + 1), off + 3];
      case 0xd2: return [dv.getInt32(off + 1), off + 5];
      case 0xd3: {
        // int64 — mesma estratégia que uint64: hi signed + lo unsigned.
        const hi = dv.getInt32(off + 1);
        const lo = dv.getUint32(off + 5);
        return [hi * 4294967296 + lo, off + 9];
      }

      // str 8/16/32
      case 0xd9: {
        const L = b[off + 1];
        return [TD.decode(b.subarray(off + 2, off + 2 + L)), off + 2 + L];
      }
      case 0xda: {
        const L = dv.getUint16(off + 1);
        return [TD.decode(b.subarray(off + 3, off + 3 + L)), off + 3 + L];
      }
      case 0xdb: {
        const L = dv.getUint32(off + 1);
        return [TD.decode(b.subarray(off + 5, off + 5 + L)), off + 5 + L];
      }

      // array 16/32
      case 0xdc: return decodeArray(b, off + 3, dv.getUint16(off + 1));
      case 0xdd: return decodeArray(b, off + 5, dv.getUint32(off + 1));

      // map 16/32
      case 0xde: return decodeMap(b, off + 3, dv.getUint16(off + 1));
      case 0xdf: return decodeMap(b, off + 5, dv.getUint32(off + 1));
    }

    // Qualquer byte não mapeado levanta erro — paridade com ValueError do Python.
    throw new Error(
      `Unknown MessagePack type byte: 0x${c.toString(16).padStart(2, "0")} at offset ${off}`
    );
  }

  /**
   * Decodifica N elementos consecutivos como array.
   * Espelho de _decode_array() no Python.
   */
  function decodeArray(b, off, length) {
    const out = [];
    for (let i = 0; i < length; i++) {
      const [v, next] = decodeAt(b, off);
      out.push(v);
      off = next;
    }
    return [out, off];
  }

  /**
   * Decodifica N pares chave-valor consecutivos como objeto.
   * Espelho de _decode_map() no Python.
   */
  function decodeMap(b, off, length) {
    const out = {};
    for (let i = 0; i < length; i++) {
      const [k, afterKey] = decodeAt(b, off);
      const [v, afterVal] = decodeAt(b, afterKey);
      out[k] = v;
      off = afterVal;
    }
    return [out, off];
  }

  // Registra no namespace global do kit — zero conflito com outros scripts.
  window.__archivalKit = window.__archivalKit || {};
  window.__archivalKit.messagePack = { decode };
})();
