import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

# Makes custom_components importable as the `custom_components` package.
sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def expose_integration(hass, enable_custom_integrations):
    """Make the repo's custom_components visible to Home Assistant's loader.

    The pytest-homeassistant-custom-component `hass` fixture swaps in its own
    `custom_components` package (testing_config), which hides this repo's.
    """
    import custom_components

    path = str(ROOT / "custom_components")
    if path not in custom_components.__path__:
        custom_components.__path__.append(path)
    yield
