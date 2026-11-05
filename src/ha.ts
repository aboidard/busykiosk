// Client for the busykiosk Home Assistant integration (see custom_components/busykiosk): one endpoint per kind of data.
// Responses are small JSON documents shaped for the bar; only the fields drawn are kept.

export interface HaConfig {
  url: string;
  token: string;
}

/** Errors carry a `kind`: `instanceof` on Error subclasses is unreliable in JerryScript. */
export type HaErrorKind = "config" | "auth" | "network" | "http";
export type HaError = Error & { kind: HaErrorKind };

const fail = (kind: HaErrorKind, message: string): HaError => Object.assign(new Error(message), { kind });

export const errorKind = (err: unknown): HaErrorKind =>
  (err as { kind?: HaErrorKind } | null)?.kind ?? "network";

export interface Weather {
  /** Animation name: sun, night, partly, partly_night, cloudy, rain, pouring, storm, snow, fog, wind. */
  icon: string;
  tempMin: number | null;
  tempMax: number | null;
  /** Home Assistant's UTC offset in seconds, used when the bar can't tell its own. */
  utcOffset: number | null;
}

export interface Heating {
  setpoint: number | null;
  /** The thermostat's mode is not "off". */
  on: boolean;
  /** The boiler is actually heating right now. */
  heating: boolean;
  min: number;
  max: number;
  step: number;
  living: number | null;
  bedroom: number | null;
}

export interface WasteItem {
  /** Sprite key: menagers, emballages, verre, verts, encombrants. */
  type: string;
  days: number | null;
  /** What to print under the icon, chosen by Home Assistant. */
  text: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);

async function request(cfg: HaConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  if (!cfg.url) throw fail("config", "no URL");
  if (!cfg.token) throw fail("config", "no token");
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${cfg.token}` };
  const init: RequestInit = { method, headers };
  // Never pass `body: undefined`: the device fetch would send the text "undefined".
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`${cfg.url}${path}`, init);
  } catch (err) {
    throw fail("network", String(err));
  }
  // The device runtime may report the status as a string.
  const status = Number(response.status);
  const text = await response.text();
  if (status === 401 || status === 403) throw fail("auth", `HTTP ${status}`);
  if (status < 200 || status > 299) throw fail(status === 404 ? "config" : "http", `HTTP ${status} ${path}`);
  try {
    return JSON.parse(text);
  } catch {
    // A captive portal or a wrong URL answers with HTML.
    throw fail("network", "not JSON");
  }
}

export async function getWeather(cfg: HaConfig): Promise<Weather> {
  const raw = (await request(cfg, "GET", "/api/busykiosk/weather")) as Record<string, unknown>;
  return {
    icon: str(raw.icon, "cloudy"),
    tempMin: num(raw.temp_min),
    tempMax: num(raw.temp_max),
    utcOffset: num(raw.utc_offset),
  };
}

function parseHeating(raw: Record<string, unknown>): Heating {
  return {
    setpoint: num(raw.setpoint),
    on: raw.on === true,
    heating: raw.heating === true,
    min: num(raw.min) ?? 7,
    max: num(raw.max) ?? 30,
    step: num(raw.step) ?? 0.5,
    living: num(raw.living),
    bedroom: num(raw.bedroom),
  };
}

export async function getHeating(cfg: HaConfig): Promise<Heating> {
  return parseHeating((await request(cfg, "GET", "/api/busykiosk/heating")) as Record<string, unknown>);
}

/** Sends the new thermostat state; Home Assistant answers with the state after the change. */
export async function setHeating(cfg: HaConfig, setpoint: number, on: boolean): Promise<Heating> {
  const raw = await request(cfg, "POST", "/api/busykiosk/heating", { setpoint, on });
  return parseHeating(raw as Record<string, unknown>);
}

export async function getWaste(cfg: HaConfig): Promise<WasteItem[]> {
  const raw = (await request(cfg, "GET", "/api/busykiosk/waste")) as { items?: unknown };
  const items = Array.isArray(raw.items) ? raw.items : [];
  return items.slice(0, 5).map((item: Record<string, unknown>) => ({
    type: str(item.type, "unknown"),
    days: num(item.days),
    text: str(item.text, "-").slice(0, 3),
  }));
}
