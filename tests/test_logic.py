"""Tests for the pure helpers. Run: py -3 tests/test_logic.py (or pytest)."""

import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "custom_components" / "busykiosk"))

from logic import next_collections, read_temperature, round_to_step, today_min_max, weather_icon  # noqa: E402

PARIS = timezone(timedelta(hours=1))
to_local = lambda d: d.astimezone(PARIS) if d.tzinfo else d.replace(tzinfo=PARIS)  # noqa: E731
TODAY = date(2026, 10, 31)

TYPES = [
    {"key": "menagers", "match": "ordures ménagères"},
    {"key": "emballages", "match": "emballages"},
    {"key": "verre", "match": "verre"},
    {"key": "verts", "match": "déchets verts"},
    {"key": "encombrants", "match": "encombrants"},
]


def test_weather_icon():
    assert weather_icon("sunny", False) == "sun"
    assert weather_icon("sunny", True) == "night"
    assert weather_icon("partlycloudy", True) == "partly_night"
    assert weather_icon("lightning-rainy", False) == "storm"
    assert weather_icon("whatever", False) == "cloudy"
    assert weather_icon(None, False) == "cloudy"


def test_today_min_max_daily():
    forecast = [
        {"datetime": "2026-10-31T11:00:00+00:00", "temperature": 14.2, "templow": 8.1},
        {"datetime": "2026-11-01T11:00:00+00:00", "temperature": 12, "templow": 5},
    ]
    assert today_min_max(forecast, TODAY, to_local) == (8.1, 14.2)
    # Forecast starting tomorrow: first entry.
    assert today_min_max(forecast[1:], TODAY, to_local) == (5, 12)
    assert today_min_max([], TODAY, to_local) == (None, None)


def test_today_min_max_twice_daily():
    forecast = [
        {"datetime": "2026-10-31T06:00:00+00:00", "temperature": 15, "is_daytime": True},
        {"datetime": "2026-10-31T18:00:00+00:00", "temperature": 6, "is_daytime": False},
    ]
    assert today_min_max(forecast, TODAY, to_local) == (6, 15)


def test_next_collections():
    events = [
        {"summary": "Collecte des Emballages", "start": "2026-11-01"},
        {"summary": "Ordures Ménagères", "start": "2026-11-03"},
        {"summary": "ordures menageres", "start": "2026-11-07"},
        {"summary": "Verre", "start": "2026-10-31"},
        {"summary": "Déchets verts", "start": "2026-11-12T07:00:00+01:00"},
    ]
    items = next_collections(events, TYPES, TODAY, to_local)
    assert [i["type"] for i in items] == ["verre", "emballages", "menagers", "verts", "encombrants"]
    assert [i["text"] for i in items] == ["0", "1", "3", "12", "-"]
    assert items[-1]["days"] is None


def test_read_temperature():
    sensor = SimpleNamespace(domain="sensor", state="19.84", attributes={})
    climate = SimpleNamespace(domain="climate", state="cool", attributes={"current_temperature": 22.5})
    broken = SimpleNamespace(domain="sensor", state="unavailable", attributes={})
    assert read_temperature(sensor) == 19.84
    assert read_temperature(climate) == 22.5
    assert read_temperature(broken) is None
    assert read_temperature(None) is None


def test_round_to_step():
    assert round_to_step(20.3, 0.5, 7, 30) == 20.5
    assert round_to_step(40, 0.5, 7, 30) == 30
    assert round_to_step(19.96, 0.1, 7, 30) == 20.0
    assert round_to_step(20.4, 0, 7, 30) == 20.5


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
