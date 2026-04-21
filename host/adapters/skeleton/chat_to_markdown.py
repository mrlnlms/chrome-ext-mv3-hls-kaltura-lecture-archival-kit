"""Converte o chat capturado pelo adapter em Markdown legível.

Interface esperada pelo host core:
    chat_to_markdown(captures: dict, output_dir: Path, title: str) -> list[Path]

`captures` é o state.adapterState recebido do service worker, tipicamente:
    {
        "chat_conversations": {...},
        "chat_questions":     {...},
        "chat_pinned":        {...},
    }

A implementação específica de plataforma decide como renderizar cada
canal em arquivos .md / .json em `output_dir`.
"""
from __future__ import annotations

from pathlib import Path


def chat_to_markdown(captures: dict, output_dir: Path, title: str) -> list[Path]:
    """Stub: levanta NotImplementedError. Implemente no seu adapter."""
    raise NotImplementedError(
        "chat_to_markdown precisa ser implementado por um adapter real. "
        "Veja extension/adapters/skeleton/README.md para orientação."
    )
