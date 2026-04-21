#!/usr/bin/env python3
"""Chrome extension native messaging host + CLI.

Dois modos:

  CLI (debug manual):
    python3 host.py --chunk <URL> [--chunk <URL2> ...] \\
        [--subtitles-m3u8 <URL>] --dest <DIR> --title <NAME>

  Native messaging (invocado pelo Chrome — Phase 4):
    python3 host.py --native-messaging
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from host.core import hls_to_mp4, utils


def _print_progress(progress: hls_to_mp4.FfmpegProgress) -> None:
    """Imprime progresso do ffmpeg no stderr."""
    speed_str = f"{progress.speed:.2f}x" if progress.speed is not None else "?"
    print(
        f"[ffmpeg] time={progress.elapsed_seconds:.0f}s speed={speed_str}",
        file=sys.stderr,
    )


def cli_mode(args: argparse.Namespace) -> int:
    """Executa o pipeline HLS → MP4 em modo CLI.

    Passos:
    1. Valida argumentos obrigatórios.
    2. Cria pasta de destino {dest}/{safe_title}/.
    3. Seleciona melhor flavor por probe HEAD.
    4. Deriva a URL da chunklist e invoca ffmpeg.
    5. Imprime "Saved: <path>" no stdout.

    Returns:
        0 em sucesso, 1 em erro.
    """
    # Validação (main já filtra os casos mais óbvios, mas cli_mode é defensivo)
    if not args.chunk:
        print("Erro: pelo menos um --chunk é obrigatório.", file=sys.stderr)
        return 1
    if not args.dest:
        print("Erro: --dest é obrigatório.", file=sys.stderr)
        return 1
    if not args.title:
        print("Erro: --title é obrigatório.", file=sys.stderr)
        return 1

    safe_title = utils.sanitize_filename(args.title)
    dest_dir = Path(args.dest) / safe_title
    dest_dir.mkdir(parents=True, exist_ok=True)

    output_path = dest_dir / f"{safe_title}.mp4"

    # Seleciona o melhor stream disponível entre os chunks fornecidos.
    try:
        best_chunk = hls_to_mp4.pick_best_flavor(args.chunk)
    except ValueError as exc:
        print(f"Erro ao selecionar flavor: {exc}", file=sys.stderr)
        return 1

    cl_url = hls_to_mp4.chunklist_url(best_chunk)

    # TODO: suporte a legendas via --subtitles-m3u8.
    # Converter VTT→SRT requer parsing do master playlist de legendas
    # (múltiplas trilhas, idioma, etc.). Implementar na Phase 4.
    if args.subtitles_m3u8:
        print(
            "Aviso: --subtitles-m3u8 ainda não implementado (Phase 4). "
            "Legendas serão ignoradas.",
            file=sys.stderr,
        )

    try:
        hls_to_mp4.run_ffmpeg(cl_url, output_path, on_progress=_print_progress)
    except RuntimeError as exc:
        print(f"Erro no ffmpeg: {exc}", file=sys.stderr)
        return 1

    print(f"Saved: {output_path}")
    return 0


def native_messaging_mode() -> int:
    """Stub para o modo native messaging (Phase 4)."""
    print("Native messaging mode: not yet implemented (Phase 4)", file=sys.stderr)
    return 2


def main(argv: list[str] | None = None) -> int:
    """Entry point principal. Despacha para cli_mode ou native_messaging_mode.

    Usa parse_known_args para tolerar argumentos extras que o Chrome injeta
    ao invocar o native host (ex: chrome-extension://..., --parent-window=0).

    Args:
        argv: Lista de argumentos (usa sys.argv[1:] se None).

    Returns:
        Código de saída (0 = sucesso, 2 = uso incorreto, 1 = erro de runtime).
    """
    parser = argparse.ArgumentParser(description="HLS archival host")
    parser.add_argument("--native-messaging", action="store_true")
    parser.add_argument("--chunk", action="append", default=[])
    parser.add_argument("--subtitles-m3u8", default=None)
    parser.add_argument("--dest", default=None)
    parser.add_argument("--title", default=None)
    # parse_known_args pra tolerar args extras do Chrome
    args, _unknown = parser.parse_known_args(argv)

    if args.native_messaging:
        return native_messaging_mode()
    if not args.chunk or not args.dest or not args.title:
        parser.print_usage(sys.stderr)
        return 2
    return cli_mode(args)


if __name__ == "__main__":
    sys.exit(main())
