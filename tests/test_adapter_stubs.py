"""Stubs de adapter Python levantam NotImplementedError."""
import pytest
from pathlib import Path

from host.adapters.skeleton import chat_to_markdown, materials_downloader


def test_chat_to_markdown_raises_not_implemented():
    with pytest.raises(NotImplementedError):
        chat_to_markdown.chat_to_markdown({}, Path("/tmp"), "title")


def test_download_materials_raises_not_implemented():
    with pytest.raises(NotImplementedError):
        materials_downloader.download_materials({}, "bearer-token", Path("/tmp"))
