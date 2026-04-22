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

# Bootstrap sys.path: garante que `host.core` e `host.adapters` sejam
# importáveis tanto quando invocado via `python -m host.host` (do repo)
# quanto standalone (instalado em ~/.kaltura-lecture-host/ pelo install.sh,
# invocado como `python3 /caminho/ate/host.py`).
_this_file = Path(__file__).resolve()
_parent = _this_file.parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

try:
    from host.core import hls_to_mp4, native_messaging, utils
except ModuleNotFoundError:
    # Standalone: o host.py foi copiado diretamente sem a subpasta `host/`.
    # Adiciona o próprio diretório ao sys.path e importa core/ como top-level.
    sys.path.insert(0, str(_this_file.parent))
    from core import hls_to_mp4, native_messaging, utils  # type: ignore


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
    """Lê uma request JSON de stdin, roda o pipeline, reporta progresso e encerra.

    Request shape:
        {
            "chunks": ["<url>", "<url2>", ...],     # obrigatório
            "dest": "<dir>",                         # obrigatório
            "title": "<name>",                       # obrigatório
            "subtitles_m3u8": "<url>",              # opcional (Phase 4.5+)
            "metadata": {...},                      # opcional
        }

    Mensagens de saída:
        {"type": "progress", "phase": "video", "elapsed_seconds": N, "speed": N}
        {"type": "done", "folder": "<path>"}
        {"type": "error", "message": "<str>"}

    Após 'done' ou 'error', chama os._exit() pra matar threads daemon.
    """
    import os  # local import; top-level já tem outros
    try:
        request = native_messaging.read_message()
        if request is None:
            native_messaging.send({"type": "error", "message": "No request on stdin"})
            os._exit(1)

        chunks = request.get("chunks", [])
        dest = request.get("dest")
        title = request.get("title")
        if not chunks or not dest or not title:
            native_messaging.send({
                "type": "error",
                "message": "Missing required fields (chunks/dest/title)",
            })
            os._exit(1)

        dest_folder = Path(dest) / utils.sanitize_filename(title)
        dest_folder.mkdir(parents=True, exist_ok=True)
        output_mp4 = dest_folder / f"{utils.sanitize_filename(title)}.mp4"

        native_messaging.send({"type": "progress", "phase": "selecting_flavor"})
        best = hls_to_mp4.pick_best_flavor(chunks)
        chunklist = hls_to_mp4.chunklist_url(best)

        def on_progress(p: hls_to_mp4.FfmpegProgress) -> None:
            native_messaging.send({
                "type": "progress",
                "phase": "video",
                "elapsed_seconds": p.elapsed_seconds,
                "speed": p.speed,
            })

        hls_to_mp4.run_ffmpeg(chunklist, output_mp4, on_progress=on_progress)

        native_messaging.send({
            "type": "done",
            "folder": str(dest_folder),
        })
        os._exit(0)
    except Exception as exc:
        native_messaging.send({"type": "error", "message": str(exc)})
        os._exit(1)


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
