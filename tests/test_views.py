"""End-to-end tests of the endpoints in a real (test) Home Assistant.

    pip install pytest-homeassistant-custom-component
    cd HA && pytest tests
"""

import pytest
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

CONFIG = {
    "busykiosk": {
        "weather": "weather.maison",
        "thermostat": "climate.thermostat",
        "bedroom_temperature": "climate.chambre_clim",
        "waste_calendar": "calendar.dechets",
    }
}


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture
async def setup(hass: HomeAssistant):
    calls: list[tuple[str, dict]] = []
    today = dt_util.now().date()

    hass.states.async_set("sun.sun", "above_horizon")
    hass.states.async_set("weather.maison", "partlycloudy", {"temperature": 11})
    hass.states.async_set(
        "climate.thermostat",
        "heat",
        {
            "temperature": 20.5,
            "current_temperature": 19.8,
            "hvac_action": "heating",
            "min_temp": 7,
            "max_temp": 30,
            "target_temp_step": 0.5,
            "hvac_modes": ["off", "heat"],
        },
    )
    hass.states.async_set("climate.chambre_clim", "cool", {"current_temperature": 22.1})
    hass.states.async_set("calendar.dechets", "off")

    async def get_forecasts(call: ServiceCall):
        return {
            "weather.maison": {
                "forecast": [{"datetime": f"{today.isoformat()}T12:00:00+00:00", "temperature": 14.4, "templow": 7.6}]
            }
        }

    async def get_events(call: ServiceCall):
        return {
            "calendar.dechets": {
                "events": [
                    {"summary": "Verre", "start": today.isoformat(), "end": today.isoformat()},
                    {"summary": "Ordures ménagères", "start": f"{today.isoformat()}T06:00:00+00:00"},
                ]
            }
        }

    async def climate_call(call: ServiceCall):
        calls.append((call.service, dict(call.data)))
        state = hass.states.get("climate.thermostat")
        attrs = dict(state.attributes)
        mode = state.state
        if call.service == "set_hvac_mode":
            mode = call.data["hvac_mode"]
        else:
            attrs["temperature"] = call.data["temperature"]
        hass.states.async_set("climate.thermostat", mode, attrs)

    hass.services.async_register("weather", "get_forecasts", get_forecasts, supports_response=SupportsResponse.ONLY)
    hass.services.async_register("calendar", "get_events", get_events, supports_response=SupportsResponse.ONLY)
    hass.services.async_register("climate", "set_hvac_mode", climate_call)
    hass.services.async_register("climate", "set_temperature", climate_call)

    assert await async_setup_component(hass, "busykiosk", CONFIG)
    await hass.async_block_till_done()
    return calls


async def test_requires_token(hass, setup, hass_client_no_auth):
    client = await hass_client_no_auth()
    response = await client.get("/api/busykiosk/weather")
    assert response.status == 401


async def test_weather(hass, setup, hass_client):
    client = await hass_client()
    response = await client.get("/api/busykiosk/weather")
    assert response.status == 200
    data = await response.json()
    assert data["icon"] == "partly"
    assert (data["temp_min"], data["temp_max"]) == (7.6, 14.4)
    assert isinstance(data["utc_offset"], int)


async def test_heating_get(hass, setup, hass_client):
    client = await hass_client()
    response = await client.get("/api/busykiosk/heating")
    # Home Assistant blanks `Server` on every response; the bar can't read a response with an empty one.
    assert response.headers["Server"] == "busykiosk"
    data = await response.json()
    assert data == {
        "setpoint": 20.5,
        "on": True,
        "heating": True,
        "mode": "heat",
        "min": 7,
        "max": 30,
        "step": 0.5,
        "living": 19.8,
        "bedroom": 22.1,
    }


async def test_heating_post(hass, setup, hass_client):
    calls = setup
    client = await hass_client()

    data = await (await client.post("/api/busykiosk/heating", json={"setpoint": 21.3, "on": True})).json()
    assert calls == [("set_temperature", {"entity_id": "climate.thermostat", "temperature": 21.5})]
    assert data["setpoint"] == 21.5 and data["on"] is True

    calls.clear()
    data = await (await client.post("/api/busykiosk/heating", json={"setpoint": 18, "on": False})).json()
    assert calls == [("set_hvac_mode", {"entity_id": "climate.thermostat", "hvac_mode": "off"})]
    assert data["on"] is False and data["setpoint"] == 18

    calls.clear()
    data = await (await client.post("/api/busykiosk/heating", json={"setpoint": 19, "on": True})).json()
    assert calls == [
        ("set_hvac_mode", {"entity_id": "climate.thermostat", "hvac_mode": "heat"}),
        ("set_temperature", {"entity_id": "climate.thermostat", "temperature": 19.0}),
    ]
    assert data["on"] is True

    response = await client.post("/api/busykiosk/heating", json={"setpoint": "hot"})
    assert response.status == 400


async def test_waste(hass, setup, hass_client):
    client = await hass_client()
    data = await (await client.get("/api/busykiosk/waste")).json()
    assert data["items"][:2] == [
        {"type": "menagers", "days": 0, "text": "0"},
        {"type": "verre", "days": 0, "text": "0"},
    ]
    assert [i["text"] for i in data["items"][2:]] == ["-", "-", "-"]
