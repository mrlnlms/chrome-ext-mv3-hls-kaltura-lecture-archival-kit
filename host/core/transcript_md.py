"""Converte legenda SRT em Markdown corrido com quebra heurística de parágrafos."""
from __future__ import annotations

import re

# Separa blocos SRT por linhas em branco.
_BLOCK_SEP = re.compile(r"\r?\n\s*\r?\n")

# Identifica linha de timestamp: "00:00:12,345 --> 00:00:15,678"
_TIMESTAMP_LINE = re.compile(r"\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->")

# Detecta início de frase com maiúscula (inclui acentuadas do PT-BR).
_UPPERCASE_START = re.compile(r"[A-ZÁÉÍÓÚÂÊÔÀÃÕÇÜ]")

# Tamanho mínimo do parágrafo acumulado antes de permitir quebra.
MIN_PARAGRAPH_CHARS: int = 120

# Abreviações que não devem disparar quebra de parágrafo (lowercase, sem ponto final).
ABBREVIATIONS: set[str] = {
    "dr", "dra", "sr", "sra", "srta",
    "prof", "profa",
    "etc", "vs", "cf", "ex",
}


def srt_to_plain_text(srt: str) -> str:
    """Extrai o texto corrido de um SRT, descartando índices e timestamps.

    Parâmetros:
        srt: conteúdo bruto de um arquivo SubRip (.srt).

    Retorna:
        String única com todos os segmentos de texto unidos por espaço.
    """
    blocks = _BLOCK_SEP.split(srt.strip())
    segments: list[str] = []
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip()]
        content: list[str] = []
        for line in lines:
            if line.strip().isdigit():
                continue
            if _TIMESTAMP_LINE.search(line):
                continue
            content.append(line.strip())
        if content:
            segments.append(" ".join(content))
    return " ".join(segments)


def _word_before_punct(fragment: str) -> str:
    """Retorna a última palavra de `fragment` antes da pontuação final, em lowercase."""
    stripped = fragment.rstrip(" .!?")
    match = re.search(r"([A-Za-zÀ-ÿ]+)$", stripped)
    if not match:
        return ""
    return match.group(1).lower()


def format_paragraphs(text: str) -> str:
    """Quebra texto corrido em parágrafos usando heurística de fronteira de frase.

    Regras:
    - Quebra após `.`, `!` ou `?` seguidos de espaço + letra maiúscula.
    - Só quebra se o parágrafo acumulado tiver >= MIN_PARAGRAPH_CHARS chars.
    - Não quebra após abreviações conhecidas em ABBREVIATIONS.

    Parâmetros:
        text: texto corrido (tipicamente saída de srt_to_plain_text).

    Retorna:
        String com parágrafos separados por ``\\n\\n``.
    """
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""

    paragraphs: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(text)

    while i < n:
        ch = text[i]
        buf.append(ch)

        if ch in ".!?":
            # Consome sequências de pontuação ("...", "!?", etc.)
            j = i
            while j + 1 < n and text[j + 1] in ".!?":
                j += 1
                buf.append(text[j])

            # Pula espaços após pontuação.
            k = j + 1
            while k < n and text[k].isspace():
                k += 1

            if k < n and _UPPERCASE_START.match(text[k]):
                current = "".join(buf).strip()
                last_word = _word_before_punct(current)
                is_abbrev = last_word in ABBREVIATIONS
                long_enough = len(current) >= MIN_PARAGRAPH_CHARS
                if not is_abbrev and long_enough:
                    paragraphs.append(current)
                    buf = []
                    i = k
                    continue

            i = j + 1
            continue

        i += 1

    tail = "".join(buf).strip()
    if tail:
        paragraphs.append(tail)

    return "\n\n".join(paragraphs)


def srt_to_markdown(srt: str) -> str:
    """Converte SRT diretamente em Markdown com parágrafos heurísticos.

    Parâmetros:
        srt: conteúdo bruto de um arquivo SubRip (.srt).

    Retorna:
        String Markdown com parágrafos separados por ``\\n\\n``.
    """
    return format_paragraphs(srt_to_plain_text(srt))
