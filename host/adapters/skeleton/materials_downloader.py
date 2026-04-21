"""Baixa materiais autenticados da plataforma.

Interface esperada pelo host core:
    download_materials(captures: dict, auth_token: str, output_dir: Path) -> list[Path]

`captures` é o state.adapterState contendo a resposta do materials API:
    {"materials_raw": {...}}

O adapter específico extrai a lista de arquivos, faz GET autenticado com
Bearer token em `auth_token`, e escreve em `output_dir`.
"""
from __future__ import annotations

from pathlib import Path


def download_materials(captures: dict, auth_token: str, output_dir: Path) -> list[Path]:
    """Stub: levanta NotImplementedError. Implemente no seu adapter."""
    raise NotImplementedError(
        "download_materials precisa ser implementado por um adapter real. "
        "Veja extension/adapters/skeleton/README.md para orientação."
    )
