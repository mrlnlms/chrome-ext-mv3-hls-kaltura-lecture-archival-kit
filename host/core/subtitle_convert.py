"""Conversão de legendas WebVTT para formato SRT."""
import re


_TIMESTAMP_RE = re.compile(r"(\d{2}:\d{2}:\d{2})\.(\d{3})")


def _convert_timestamp_line(line: str) -> str:
    """Substitui ponto por vírgula nos timestamps de um cue (HH:MM:SS.ms → HH:MM:SS,ms)."""
    return _TIMESTAMP_RE.sub(r"\1,\2", line)


def vtt_to_srt(vtt_text: str) -> str:
    """Converte texto WebVTT em texto SRT numerado sequencialmente.

    Remove o cabeçalho WEBVTT, converte separadores decimais dos timestamps
    de ponto para vírgula e adiciona numeração sequencial a cada cue.
    """
    # Remove header WEBVTT (e qualquer metadado opcional na mesma linha)
    text = re.sub(r"^WEBVTT[^\n]*\n", "", vtt_text, count=1)

    # Divide em blocos de cue separados por linha em branco
    raw_blocks = re.split(r"\n{2,}", text.strip())

    srt_blocks: list[str] = []
    counter = 1
    for block in raw_blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.splitlines()
        # Primeira linha do bloco deve ser uma linha de timestamp
        if not re.match(r"\d{2}:\d{2}:\d{2}\.\d{3}", lines[0]):
            continue
        timestamp_line = _convert_timestamp_line(lines[0])
        text_lines = lines[1:]
        srt_blocks.append(f"{counter}\n{timestamp_line}\n" + "\n".join(text_lines))
        counter += 1

    return "\n\n".join(srt_blocks)
