import sys
from pathlib import Path

# Makes custom_components importable as the `custom_components` package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
