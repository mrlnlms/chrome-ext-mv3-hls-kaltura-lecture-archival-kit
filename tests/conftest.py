"""Configuração do pytest: path setup + fixtures compartilhadas."""
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT))
FIXTURES_DIR = Path(__file__).parent / "fixtures"
