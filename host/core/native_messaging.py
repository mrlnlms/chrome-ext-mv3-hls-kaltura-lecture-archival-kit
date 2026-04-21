"""Protocolo stdio do Chrome Native Messaging.

O Chrome exige que host e extensão troquem mensagens via stdin/stdout com o
seguinte framing:
  - 4 bytes little-endian (unsigned int): tamanho do payload em bytes
  - N bytes: payload JSON codificado em UTF-8

Referência: https://developer.chrome.com/docs/apps/nativeMessaging/
"""
import json
import struct
import sys
from typing import IO, Optional


def read_message(stream: Optional[IO[bytes]] = None) -> Optional[dict]:
    """Lê uma mensagem do stream de entrada seguindo o protocolo Native Messaging.

    Lê 4 bytes de length prefix (little-endian) e em seguida N bytes de payload
    JSON. Retorna None se o stream estiver em EOF (menos de 4 bytes disponíveis
    no header ou payload incompleto).

    Args:
        stream: stream binário de leitura. Padrão: sys.stdin.buffer.

    Returns:
        Dicionário com os dados da mensagem, ou None em EOF/stream vazio.
    """
    if stream is None:
        stream = sys.stdin.buffer

    raw_len = stream.read(4)
    if len(raw_len) < 4:
        # EOF ou stream vazio — sinaliza fim de comunicação
        return None

    length: int = struct.unpack("<I", raw_len)[0]
    raw_payload = stream.read(length)
    if len(raw_payload) < length:
        # Payload incompleto — stream foi fechado antes de entregar N bytes
        return None

    return json.loads(raw_payload.decode("utf-8"))


def write_message(stream: IO[bytes], payload: dict) -> None:
    """Escreve uma mensagem no stream de saída seguindo o protocolo Native Messaging.

    Serializa o payload como JSON UTF-8, precede com 4 bytes de length prefix
    little-endian e faz flush imediato para garantir entrega ao Chrome.

    Args:
        stream: stream binário de escrita.
        payload: dicionário com os dados a enviar.
    """
    data: bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("<I", len(data)))
    stream.write(data)
    stream.flush()


def send(payload: dict) -> None:
    """Atalho para escrever uma mensagem em sys.stdout.buffer.

    Equivalente a write_message(sys.stdout.buffer, payload).

    Args:
        payload: dicionário com os dados a enviar para a extensão.
    """
    write_message(sys.stdout.buffer, payload)
