"""Pure helpers for BusyKiosk: no Home Assistant imports, so they can be tested on their own."""

from __future__ import annotations

import unicodedata
from datetime import date, datetime
from typing import Any

# Home Assistant weather conditions -> animation names on the bar (animations/wx_<name>.anim).
CONDITION_ICONS = {
    "sunny": "sun",
    "clear-night": "night",
    "partlycloudy": "partly",
    "cloudy": "cloudy",
    "rainy": "rain",
    "pouring": "pouring",
    "lightning": "storm",
    "lightning-rainy": "storm",
    "exceptional": "storm",
    "snowy": "snow",
    "snowy-rainy": "snow",
    "hail": "snow",
    "fog": "fog",
    "windy": "wind",
    "windy-variant": "wind",
}


def weather_icon(condition: str | None, night: bool) -> str:
    """Animation name for a weather condition; partly cloudy and sunny follow day and night."""
    icon = CONDITION_ICONS.get(condition or "", "cloudy")
    if night and icon == "sun":
        return "night"
    if night and icon == "partly":
        return "partly_night"
    return icon


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # NaN


def _local_date(value: Any, to_local) -> date | None:
    """Date of a forecast/calendar timestamp ("2025-10-31" or an ISO datetime), in local time."""
    if isinstance(value, datetime):
        return to_local(value).date()
    if isinstance(value, date):
        return value
    text = str(value or "")
    if len(text) == 10:
        try:
            return date.fromisoformat(text)
        except ValueError:
            return None
    try:
        return to_local(datetime.fromisoformat(text.replace("Z", "+00:00"))).date()
    except ValueError:
        return None


def today_min_max(forecast: list[dict], today: date, to_local) -> tuple[float | None, float | None]:
    """Today's (min, max) from a daily or twice-daily forecast; the first entry when none is for today."""
    entries = [f for f in forecast if _local_date(f.get("datetime"), to_local) == today] or forecast[:1]
    highs = [n for n in (_number(f.get("temperature")) for f in entries) if n is not None]
    lows = [n for n in (_number(f.get("templow")) for f in entries) if n is not None]
    if not lows and len(entries) > 1:
        # Twice-daily forecasts without templow: the night entry's temperature is the low.
        lows = highs
    return (min(lows) if lows else None, max(highs) if highs else None)


def normalize(text: str) -> str:
    """Lowercase without accents, so "Déchets verts" matches "dechets verts"."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


def next_collections(events: list[dict], types: list[dict], today: date, to_local) -> list[dict]:
    """For each waste type, days until its next collection, sorted soonest first.

    events: calendar.get_events results ({"summary", "start", ...}).
    types: [{"key": "verre", "match": "verre"}, ...] in the order to keep for ties.
    """
    rows = []
    for index, waste in enumerate(types):
        pattern = normalize(waste["match"])
        days = None
        for event in events:
            if pattern not in normalize(event.get("summary", "")):
                continue
            start = _local_date(event.get("start"), to_local)
            if start is None:
                continue
            delta = max(0, (start - today).days)
            if days is None or delta < days:
                days = delta
        rows.append((days if days is not None else 10_000, index, waste["key"], days))
    rows.sort()
    return [
        {"type": key, "days": days, "text": "-" if days is None else str(days)}
        for _, _, key, days in rows
    ]


def read_temperature(state) -> float | None:
    """Temperature of a sensor (its state) or of a climate entity (its current_temperature)."""
    if state is None:
        return None
    if state.domain == "climate":
        return _number(state.attributes.get("current_temperature"))
    return _number(state.state)


def round_to_step(value: float, step: float, low: float, high: float) -> float:
    step = step if step and step > 0 else 0.5
    return max(low, min(high, round(round(value / step) * step, 2)))
