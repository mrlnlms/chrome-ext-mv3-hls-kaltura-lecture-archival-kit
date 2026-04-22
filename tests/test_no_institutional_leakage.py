"""Barreira contra vazamento de URLs/identificadores institucionais.

Este repositório é uma reference implementation genérica. Qualquer commit
que adicione URLs de um LMS específico, nome de instituição, ou identificador
de native host privado num arquivo tracked deve falhar o CI.

A lista de padrões proibidos está hardcoded aqui de propósito — se um novo
padrão for identificado como sensível, adicione à lista FORBIDDEN_PATTERNS.

Este próprio arquivo é excluído do scan (obviamente contém os padrões).
"""
from pathlib import Path
import subprocess

import pytest


# Padrões case-insensitive de coisa que não pode aparecer em código tracked.
# Cada entrada: (pattern, "razão humana pra ser proibido").
FORBIDDEN_PATTERNS = [
    ("mbx.academy",                       "host LMS institucional"),
    ("move-chat-api-prd",                 "backend de chat institucional"),
    ("movelms",                           "provedor LMS institucional"),
    ("lmsdskprd",                         "CDN institucional"),
    ("esalq",                             "identificador da instituição"),
    ("com.mbx.downloader",                "native host name da extensão privada"),
]

# Arquivos excluídos do scan (o próprio teste + nomes óbvios).
EXCLUDED_FILES = {
    "tests/test_no_institutional_leakage.py",
}

# Extensões binárias que não faz sentido grep — pula direto.
BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
    ".pdf", ".zip", ".tar", ".gz",
    ".woff", ".woff2", ".ttf", ".otf",
    ".mp4", ".mp3", ".wav",
}


def _tracked_files() -> list[Path]:
    """Lista arquivos tracked no git, relativo à raiz do repo."""
    repo_root = Path(__file__).resolve().parent.parent
    result = subprocess.run(
        ["git", "ls-files"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=True,
    )
    return [repo_root / line for line in result.stdout.splitlines() if line.strip()]


def _should_scan(path: Path, repo_root: Path) -> bool:
    rel = path.relative_to(repo_root).as_posix()
    if rel in EXCLUDED_FILES:
        return False
    if path.suffix.lower() in BINARY_EXTENSIONS:
        return False
    return True


def test_no_forbidden_patterns_in_tracked_files():
    repo_root = Path(__file__).resolve().parent.parent
    offenders: list[tuple[str, int, str, str]] = []  # (file, line, pattern, reason)

    for path in _tracked_files():
        if not _should_scan(path, repo_root):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue  # binário que escapou do filtro de extensão, ou link quebrado

        lowered = text.lower()
        for pattern, reason in FORBIDDEN_PATTERNS:
            if pattern in lowered:
                # Identifica a linha pra deixar o erro legível.
                for i, line in enumerate(text.splitlines(), start=1):
                    if pattern in line.lower():
                        rel = path.relative_to(repo_root).as_posix()
                        offenders.append((rel, i, pattern, reason))

    if offenders:
        details = "\n".join(
            f"  {f}:{ln}  pattern={p!r}  ({r})" for f, ln, p, r in offenders
        )
        pytest.fail(
            "Padrões institucionais proibidos encontrados em arquivos tracked.\n"
            "Remova o conteúdo sensível ou, se for um novo falso-positivo, "
            "refine o padrão em tests/test_no_institutional_leakage.py.\n\n"
            f"Ocorrências:\n{details}"
        )
