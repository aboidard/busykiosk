"""BusyKiosk: JSON endpoints that the BUSY Bar app polls (the bar pulls, Home Assistant answers).

One endpoint per kind of data, all behind Home Assistant's normal authentication
(header "Authorization: Bearer <long-lived access token>"):

    GET  /api/busykiosk            what is configured (handy to test the token)
    GET  /api/busykiosk/weather    {"icon", "condition", "temp", "temp_min", "temp_max", "utc_offset"}
    GET  /api/busykiosk/heating    {"setpoint", "on", "heating", "mode", "min", "max", "step", "living", "bedroom"}
    POST /api/busykiosk/heating    body {"setpoint": 20.5, "on": true} -> same document as GET
    GET  /api/busykiosk/waste      {"items": [{"type", "days", "text"}, ...]} soonest first

Configured in configuration.yaml (see README.md):

    busykiosk:
      weather: weather.home
      thermostat: climate.thermostat
      living_temperature: sensor.salon_temperature
      bedroom_temperature: climate.chambre
      waste_calendar: calendar.grand_paris_seine_et_oise
"""

from __future__ import annotations

import logging
from datetime import timedelta
from http import HTTPStatus
from typing import Any

import voluptuous as vol
from aiohttp import web
from multidict import CIMultiDict

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
from homeassistant.util import dt as dt_util

from .logic import next_collections, read_temperature, round_to_step, today_min_max, weather_icon

_LOGGER = logging.getLogger(__name__)

DOMAIN = "busykiosk"
VERSION = "0.1.2"

CONF_WEATHER = "weather"
CONF_THERMOSTAT = "thermostat"
CONF_LIVING = "living_temperature"
CONF_BEDROOM = "bedroom_temperature"
CONF_HEAT_MODE = "heat_mode"
CONF_DEFAULT_SETPOINT = "default_setpoint"
CONF_WASTE_CALENDAR = "waste_calendar"
CONF_WASTE_DAYS = "waste_days"
CONF_WASTE_TYPES = "waste_types"

# Calendar summaries -> icon keys on the bar (same patterns as the old Busybar dashboard script).
DEFAULT_WASTE_TYPES = [
    {"key": "menagers", "match": "ordures ménagères"},
    {"key": "emballages", "match": "emballages"},
    {"key": "verre", "match": "verre"},
    {"key": "verts", "match": "déchets verts"},
    {"key": "encombrants", "match": "encombrants"},
]

WASTE_TYPE_SCHEMA = vol.Schema({vol.Required("key"): cv.string, vol.Required("match"): cv.string})

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Optional(CONF_WEATHER): cv.entity_id,
                vol.Optional(CONF_THERMOSTAT): cv.entity_id,
                vol.Optional(CONF_LIVING): cv.entity_id,
                vol.Optional(CONF_BEDROOM): cv.entity_id,
                vol.Optional(CONF_HEAT_MODE, default="heat"): cv.string,
                vol.Optional(CONF_DEFAULT_SETPOINT, default=19.0): vol.Coerce(float),
                vol.Optional(CONF_WASTE_CALENDAR): cv.entity_id,
                vol.Optional(CONF_WASTE_DAYS, default=30): cv.positive_int,
                vol.Optional(CONF_WASTE_TYPES, default=DEFAULT_WASTE_TYPES): vol.All(
                    cv.ensure_list, [WASTE_TYPE_SCHEMA]
                ),
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    conf = config.get(DOMAIN)
    if conf is None:
        return True
    state = {"last_setpoint": None}
    for view in (IndexView, WeatherView, HeatingView, WasteView):
        hass.http.register_view(view(hass, conf, state))
    _LOGGER.info("BusyKiosk endpoints ready under /api/busykiosk")
    return True


class _KeepServerHeaders(CIMultiDict):
    """Response headers that ignore an empty `Server` being written over ours."""

    def update(self, *args: Any, **kwargs: Any) -> None:
        incoming = CIMultiDict(*args, **kwargs)
        incoming.popall("Server", None)
        super().update(incoming)


def _with_server_header(response: web.Response) -> web.Response:
    """Give a response a non-empty `Server` header that Home Assistant can't blank.

    Home Assistant's headers middleware sets `Server: ` (empty) on every response, after
    the handler. The BUSY Bar's HTTP client can't parse an empty header and gives up with
    "inactivity timeout". The middleware can't be changed once the server is running, so the
    response itself refuses that one overwrite. Other headers still go through.
    """
    headers = _KeepServerHeaders(response.headers)
    headers["Server"] = "busykiosk"
    response._headers = headers  # noqa: SLF001
    return response


class _BusyKioskView(HomeAssistantView):
    requires_auth = True

    def __init__(self, hass: HomeAssistant, conf: dict, state: dict) -> None:
        self.hass = hass
        self.conf = conf
        self.state = state

    def _entity(self, key: str) -> str:
        entity_id = self.conf.get(key)
        if not entity_id:
            raise _with_server_header(web.HTTPNotFound(text=f"busykiosk: '{key}' is not configured"))
        return entity_id

    def json(self, result: Any, status_code: HTTPStatus | int = HTTPStatus.OK, headers: Any = None) -> web.Response:
        return _with_server_header(super().json(result, status_code, headers))

    def _error(self, message: str, status: HTTPStatus = HTTPStatus.BAD_GATEWAY) -> web.Response:
        _LOGGER.warning("busykiosk: %s", message)
        return self.json({"error": message}, status_code=status)


class IndexView(_BusyKioskView):
    url = "/api/busykiosk"
    name = "api:busykiosk"

    async def get(self, request: web.Request) -> web.Response:
        return self.json(
            {
                "version": VERSION,
                "weather": self.conf.get(CONF_WEATHER),
                "thermostat": self.conf.get(CONF_THERMOSTAT),
                "living_temperature": self.conf.get(CONF_LIVING),
                "bedroom_temperature": self.conf.get(CONF_BEDROOM),
                "waste_calendar": self.conf.get(CONF_WASTE_CALENDAR),
            }
        )


class WeatherView(_BusyKioskView):
    url = "/api/busykiosk/weather"
    name = "api:busykiosk:weather"

    async def get(self, request: web.Request) -> web.Response:
        entity_id = self._entity(CONF_WEATHER)
        state = self.hass.states.get(entity_id)
        if state is None:
            return self._error(f"{entity_id} not found", HTTPStatus.NOT_FOUND)

        sun = self.hass.states.get("sun.sun")
        night = sun is not None and sun.state == "below_horizon"
        now = dt_util.now()

        temp_min, temp_max = None, None
        for kind in ("daily", "twice_daily", "hourly"):
            forecast = await self._forecast(entity_id, kind)
            if forecast:
                if kind == "hourly":
                    forecast = [f for f in forecast if f.get("datetime", "")[:10] == now.date().isoformat()]
                    temps = [f.get("temperature") for f in forecast if f.get("temperature") is not None]
                    if temps:
                        temp_min, temp_max = min(temps), max(temps)
                else:
                    temp_min, temp_max = today_min_max(forecast, now.date(), dt_util.as_local)
                break

        offset = now.utcoffset()
        return self.json(
            {
                "condition": state.state,
                "icon": weather_icon(state.state, night),
                "temp": state.attributes.get("temperature"),
                "temp_min": temp_min,
                "temp_max": temp_max,
                "utc_offset": int(offset.total_seconds()) if offset else 0,
            }
        )

    async def _forecast(self, entity_id: str, kind: str) -> list[dict]:
        try:
            response = await self.hass.services.async_call(
                "weather",
                "get_forecasts",
                {"entity_id": entity_id, "type": kind},
                blocking=True,
                return_response=True,
            )
        except (HomeAssistantError, vol.Invalid) as err:
            # Not every weather integration offers every forecast type.
            _LOGGER.debug("busykiosk: no %s forecast for %s: %s", kind, entity_id, err)
            return []
        return ((response or {}).get(entity_id) or {}).get("forecast") or []


class HeatingView(_BusyKioskView):
    url = "/api/busykiosk/heating"
    name = "api:busykiosk:heating"

    def _document(self, override: dict[str, Any] | None = None) -> dict[str, Any] | None:
        entity_id = self._entity(CONF_THERMOSTAT)
        state = self.hass.states.get(entity_id)
        if state is None:
            return None
        attrs = state.attributes
        setpoint = attrs.get("temperature")
        if setpoint is not None:
            self.state["last_setpoint"] = setpoint
        else:
            # Many thermostats drop their setpoint while off; keep one so the bar can still edit it.
            setpoint = self.state["last_setpoint"] or self.conf[CONF_DEFAULT_SETPOINT]

        living_id = self.conf.get(CONF_LIVING)
        bedroom_id = self.conf.get(CONF_BEDROOM)
        # Without a living room sensor, the thermostat's own reading is the living room.
        living = read_temperature(self.hass.states.get(living_id)) if living_id else read_temperature(state)
        bedroom = read_temperature(self.hass.states.get(bedroom_id)) if bedroom_id else None

        document = {
            "setpoint": setpoint,
            "on": state.state not in ("off", "unavailable", "unknown"),
            "heating": attrs.get("hvac_action") == "heating",
            "mode": state.state,
            "min": attrs.get("min_temp", 7),
            "max": attrs.get("max_temp", 30),
            "step": attrs.get("target_temp_step") or 0.5,
            "living": living,
            "bedroom": bedroom,
        }
        document.update(override or {})
        return document

    async def get(self, request: web.Request) -> web.Response:
        document = self._document()
        if document is None:
            return self._error(f"{self.conf.get(CONF_THERMOSTAT)} not found", HTTPStatus.NOT_FOUND)
        return self.json(document)

    async def post(self, request: web.Request) -> web.Response:
        entity_id = self._entity(CONF_THERMOSTAT)
        state = self.hass.states.get(entity_id)
        if state is None:
            return self._error(f"{entity_id} not found", HTTPStatus.NOT_FOUND)
        try:
            body = await request.json()
        except ValueError:
            return self._error("body is not JSON", HTTPStatus.BAD_REQUEST)
        if not isinstance(body, dict):
            return self._error("body must be an object", HTTPStatus.BAD_REQUEST)

        on = body.get("on")
        setpoint = body.get("setpoint")
        if on is not None and not isinstance(on, bool):
            return self._error("'on' must be true or false", HTTPStatus.BAD_REQUEST)
        if setpoint is not None:
            if isinstance(setpoint, bool) or not isinstance(setpoint, (int, float)):
                return self._error("'setpoint' must be a number", HTTPStatus.BAD_REQUEST)
            attrs = state.attributes
            setpoint = round_to_step(
                float(setpoint),
                attrs.get("target_temp_step") or 0.5,
                attrs.get("min_temp", 7),
                attrs.get("max_temp", 30),
            )

        override: dict[str, Any] = {}
        try:
            if on is False:
                if state.state != "off":
                    await self._call("set_hvac_mode", {"hvac_mode": "off"})
                override.update(on=False, heating=False, mode="off")
                if setpoint is not None:
                    # Remembered for the next time it is turned on from the bar.
                    self.state["last_setpoint"] = setpoint
                    override["setpoint"] = setpoint
            else:
                if on is True and state.state in ("off", "unavailable", "unknown"):
                    mode = self._heat_mode(state)
                    await self._call("set_hvac_mode", {"hvac_mode": mode})
                    override.update(on=True, mode=mode)
                if setpoint is not None:
                    await self._call("set_temperature", {"temperature": setpoint})
                    self.state["last_setpoint"] = setpoint
                    override["setpoint"] = setpoint
        except (HomeAssistantError, vol.Invalid) as err:
            return self._error(f"thermostat refused: {err}")

        # The thermostat may report its new state a little later: answer with what was asked.
        return self.json(self._document(override))

    def _heat_mode(self, state) -> str:
        wanted = self.conf[CONF_HEAT_MODE]
        modes = [m for m in state.attributes.get("hvac_modes", []) if m != "off"]
        return wanted if wanted in modes or not modes else modes[0]

    async def _call(self, service: str, data: dict) -> None:
        await self.hass.services.async_call(
            "climate", service, {"entity_id": self.conf[CONF_THERMOSTAT], **data}, blocking=True
        )


class WasteView(_BusyKioskView):
    url = "/api/busykiosk/waste"
    name = "api:busykiosk:waste"

    async def get(self, request: web.Request) -> web.Response:
        entity_id = self._entity(CONF_WASTE_CALENDAR)
        calendar = self.hass.states.get(entity_id)
        if calendar is None:
            return self._error(f"{entity_id} not found", HTTPStatus.NOT_FOUND)
        if calendar.state == "unavailable":
            # calendar.get_events silently skips unavailable entities.
            return self._error(f"{entity_id} is unavailable (check its integration)", HTTPStatus.SERVICE_UNAVAILABLE)
        # From the start of today, so a collection this morning still shows "0".
        start = dt_util.start_of_local_day()
        end = start + timedelta(days=self.conf[CONF_WASTE_DAYS])
        try:
            response = await self.hass.services.async_call(
                "calendar",
                "get_events",
                {"entity_id": entity_id, "start_date_time": start.isoformat(), "end_date_time": end.isoformat()},
                blocking=True,
                return_response=True,
            )
        except (HomeAssistantError, vol.Invalid) as err:
            return self._error(f"calendar {entity_id}: {err}")
        events = ((response or {}).get(entity_id) or {}).get("events") or []
        items = next_collections(events, self.conf[CONF_WASTE_TYPES], start.date(), dt_util.as_local)
        return self.json({"items": items})
