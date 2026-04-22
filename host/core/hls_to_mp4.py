"""Pipeline HLS → MP4: seleção de flavor por probe HEAD e remux via ffmpeg."""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional

from . import utils

# ---------------------------------------------------------------------------
# Constantes / regex
# ---------------------------------------------------------------------------

# Captura os identificadores relevantes de uma URL de chunk Kaltura.
# Exemplo:
#   https://cfvod.kaltura.com/p/123/sp/456/serveFlavor/entryId/0_abc123/
#   v/1/ev/2/flavorId/0_flav1080/name/a.mp4/seg-1-v1-a1.ts
CHUNK_PATH_RE = re.compile(
    r"/p/(?P<partner>\d+)"
    r"/sp/(?P<sub>\d+)"
    r"/serveFlavor/entryId/(?P<entry>[^/]+)"
    r"/v/\d+/ev/\d+"
    r"/flavorId/(?P<flavor>[^/]+)"
    r"/name/[^/]+"
    r"/seg-\d+-v1-a1\.ts"
)

# Segmento final de chunk a ser substituído nas operações de normalização.
SEG_FILENAME_RE = re.compile(r"seg-\d+-v1-a1\.ts$")

# Extrai tempo elapsed do stderr do ffmpeg.
# Exemplo: "time=00:02:15.67"
FFMPEG_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")

# Extrai velocidade de processamento do stderr do ffmpeg.
# Exemplo: "speed= 1.25x"  ou  "speed=1.25x"
FFMPEG_SPEED_RE = re.compile(r"speed=\s*([\d.]+)x")


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ChunkInfo:
    """Identificadores extraídos de uma URL de chunk Kaltura."""
    partner_id: str
    sub: str
    entry_id: str
    flavor_id: str


@dataclass(frozen=True)
class FfmpegProgress:
    """Progresso reportado pelo ffmpeg em uma linha de stderr."""
    elapsed_seconds: float
    speed: Optional[float]


# ---------------------------------------------------------------------------
# Funções de parsing e URL
# ---------------------------------------------------------------------------

def parse_chunk_url(url: str) -> ChunkInfo:
    """Extrai os identificadores Kaltura de uma URL de chunk HLS.

    Args:
        url: URL completa do segmento .ts (padrão Kaltura cfvod).

    Returns:
        ChunkInfo com partner_id, sub, entry_id e flavor_id.

    Raises:
        ValueError: se a URL não corresponder ao padrão esperado.
    """
    m = CHUNK_PATH_RE.search(url)
    if not m:
        raise ValueError(f"URL não corresponde ao padrão Kaltura: {url[:120]}")
    return ChunkInfo(
        partner_id=m.group("partner"),
        sub=m.group("sub"),
        entry_id=m.group("entry"),
        flavor_id=m.group("flavor"),
    )


def chunklist_url(chunk_url: str) -> str:
    """Converte uma URL de chunk .ts na URL da chunklist.m3u8 equivalente.

    Substitui o nome do segmento (seg-N-v1-a1.ts) por chunklist.m3u8,
    mantendo todos os demais parâmetros do path (partner, flavor, etc.).

    Args:
        chunk_url: URL de um segmento .ts do Kaltura.

    Returns:
        URL da chunklist HLS correspondente.
    """
    return SEG_FILENAME_RE.sub("chunklist.m3u8", chunk_url)


# ---------------------------------------------------------------------------
# Seleção de flavor
# ---------------------------------------------------------------------------

def pick_best_flavor(chunk_urls: Iterable[str]) -> str:
    """Escolhe a melhor flavor por probe HEAD (maior Content-Length).

    Normaliza cada URL para o segmento 1 antes de fazer HEAD, para comparar
    chunks equivalentes entre flavors. Retorna a URL normalizada (seg-1).

    Args:
        chunk_urls: URLs de chunks de diferentes flavors da mesma aula.

    Returns:
        URL normalizada (seg-1-v1-a1.ts) da flavor com maior chunk.

    Raises:
        ValueError: se a lista estiver vazia ou nenhuma URL responder.
    """
    urls = list(chunk_urls)
    if not urls:
        raise ValueError("Nenhuma URL de chunk fornecida.")

    # Normaliza todos pra seg-1 pra comparação justa entre flavors.
    normalized = [SEG_FILENAME_RE.sub("seg-1-v1-a1.ts", u) for u in urls]

    results: list[tuple[str, int]] = []
    for norm_url in normalized:
        try:
            size = utils.http_head_content_length(norm_url) or 0
            results.append((norm_url, size))
        except Exception:
            # HEAD falhou — ignora essa flavor.
            pass

    if not results:
        raise ValueError("Nenhuma flavor respondeu ao probe HEAD.")

    # Ordena decrescente por tamanho e retorna a maior.
    results.sort(key=lambda x: x[1], reverse=True)
    return results[0][0]


# ---------------------------------------------------------------------------
# Parse de progresso do ffmpeg
# ---------------------------------------------------------------------------

def parse_ffmpeg_progress(line: str) -> Optional[FfmpegProgress]:
    """Parseia uma linha de stderr do ffmpeg em busca de progresso.

    Extrai o tempo elapsed (time=HH:MM:SS.ff) e opcionalmente a velocidade
    (speed=N.Nx). Retorna None se a linha não contiver time=.

    Args:
        line: Uma linha de texto do stderr do ffmpeg.

    Returns:
        FfmpegProgress se a linha tiver time=, None caso contrário.
    """
    tm = FFMPEG_TIME_RE.search(line)
    if not tm:
        return None

    hours = int(tm.group(1))
    minutes = int(tm.group(2))
    seconds = float(tm.group(3))
    elapsed = hours * 3600 + minutes * 60 + seconds

    sm = FFMPEG_SPEED_RE.search(line)
    speed: Optional[float] = float(sm.group(1)) if sm else None

    return FfmpegProgress(elapsed_seconds=elapsed, speed=speed)


# ---------------------------------------------------------------------------
# Invocação do ffmpeg
# ---------------------------------------------------------------------------

def run_ffmpeg(
    chunklist: str,
    output_path: Path,
    on_progress: Optional[Callable[[FfmpegProgress], None]] = None,
) -> None:
    """Remux um stream HLS em MP4 via ffmpeg (cópia de streams, sem re-encode).

    Invoca: ffmpeg -y -loglevel info -i <chunklist> -c copy
                   -bsf:a aac_adtstoasc <output_path>

    Lê stderr linha a linha e chama on_progress para cada linha com time=.
    Levanta RuntimeError se o ffmpeg terminar com exit code != 0.

    Args:
        chunklist: URL da chunklist.m3u8 a ser baixada.
        output_path: Caminho do arquivo MP4 de saída.
        on_progress: Callback opcional chamado com FfmpegProgress a cada linha
                     de progresso.

    Raises:
        RuntimeError: se o ffmpeg terminar com código de saída diferente de 0.
    """
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel", "info",
        "-i", chunklist,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        str(output_path),
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    stderr_tail: list[str] = []
    try:
        assert proc.stderr is not None
        for line in proc.stderr:
            line = line.rstrip("\n")
            # Mantém tail limitado pra mensagem de erro em caso de falha.
            stderr_tail.append(line)
            if len(stderr_tail) > 100:
                stderr_tail.pop(0)

            if on_progress is not None:
                progress = parse_ffmpeg_progress(line)
                if progress is not None:
                    on_progress(progress)
    finally:
        if proc.stderr:
            proc.stderr.close()
        proc.wait()

    if proc.returncode != 0:
        tail_text = "\n".join(stderr_tail[-30:])
        raise RuntimeError(
            f"ffmpeg encerrou com código {proc.returncode}.\n"
            f"Últimas linhas do stderr:\n{tail_text}"
        )
