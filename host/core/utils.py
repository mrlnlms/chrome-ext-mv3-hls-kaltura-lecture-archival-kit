"""Utilitários compartilhados do host: sanitização de nomes, HTTP helpers."""

import re
import urllib.request
from pathlib import Path
from typing import Optional

# User-Agent representando um navegador moderno no macOS.
# Usado em todas as requisições HTTP para evitar bloqueios por servidor.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# Conjunto de caracteres proibidos em nomes de arquivo na maioria dos filesystems.
_FORBIDDEN_CHARS = re.compile(r'[/\\:*?"<>|]')


def sanitize_filename(name: str) -> str:
    """Remove caracteres proibidos em filesystems e normaliza espaços.

    Substitui cada caractere proibido por ' - ', depois colapsa sequências
    de espaço em branco em um único espaço e remove espaços nas bordas.
    Preserva unicode (acentos, —, etc.).

    Args:
        name: Nome original (título de aula, por ex.).

    Returns:
        String segura para uso como nome de arquivo.
    """
    # Substitui cada char proibido por ' - '
    result = _FORBIDDEN_CHARS.sub(" - ", name)
    # Colapsa sequências de separadores adjacentes (ex: ' -  - ') num único ' - '
    result = re.sub(r"(\s*-\s*)+", " - ", result)
    # Colapsa múltiplos espaços restantes em um só
    result = re.sub(r" {2,}", " ", result)
    # Remove espaços nas bordas
    return result.strip()


def http_head_content_length(url: str, timeout: float = 30.0) -> Optional[int]:
    """Faz uma requisição HEAD e retorna o valor de Content-Length, se presente.

    Args:
        url: URL completa do recurso.
        timeout: Tempo limite em segundos (padrão 30).

    Returns:
        Content-Length como int, ou None se o header estiver ausente.
    """
    req = urllib.request.Request(url, method="HEAD")
    req.add_header("User-Agent", USER_AGENT)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        value = resp.headers.get("Content-Length")
        if value is None:
            return None
        return int(value)


def http_get_bytes(
    url: str,
    headers: Optional[dict] = None,
    timeout: float = 60.0,
) -> bytes:
    """Faz uma requisição GET e retorna o corpo da resposta como bytes.

    Mescla headers adicionais com o User-Agent padrão.

    Args:
        url: URL completa do recurso.
        headers: Headers extras a enviar (opcional).
        timeout: Tempo limite em segundos (padrão 60).

    Returns:
        Corpo da resposta como bytes.
    """
    req = urllib.request.Request(url)
    req.add_header("User-Agent", USER_AGENT)
    if headers:
        for key, value in headers.items():
            req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def download_file(
    url: str,
    out_path: Path,
    headers: Optional[dict] = None,
    timeout: float = 60.0,
    chunk_size: int = 65536,
) -> int:
    """Baixa um arquivo via GET em streaming, gravando em disco com atomic rename.

    Escreve primeiro em `{out_path}.part` e renomeia pra `out_path` ao final,
    pra garantir que o arquivo de destino só exista se o download completar.
    Se o download falhar no meio, o `.part` fica pra trás e pode ser inspecionado.

    Args:
        url: URL completa do recurso.
        out_path: Caminho do arquivo final.
        headers: Headers extras a enviar (opcional).
        timeout: Tempo limite em segundos (padrão 60).
        chunk_size: Tamanho de cada leitura em bytes (padrão 64 KiB).

    Returns:
        Total de bytes escritos.
    """
    part = out_path.with_suffix(out_path.suffix + ".part")
    req = urllib.request.Request(url)
    req.add_header("User-Agent", USER_AGENT)
    if headers:
        for key, value in headers.items():
            req.add_header(key, value)
    total = 0
    with urllib.request.urlopen(req, timeout=timeout) as resp, part.open("wb") as f:
        while True:
            chunk = resp.read(chunk_size)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
    part.rename(out_path)
    return total
