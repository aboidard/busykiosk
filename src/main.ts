// BusyKiosk: a Home Assistant dashboard that the bar pulls itself.
//
// Pages rotate every `page_seconds` (60 s by default), starting from page 1:
//   1. weather animation, min/max and "31 Oct, 14:32"
//   2. heating: thermostat setpoint and on/off, living room and bedroom temperatures
//   3. next waste collections
// Knob: previous/next page. OK (knob click): refresh, or on the heating page edit the
// thermostat (knob = setpoint, START = on/off, OK = send, BACK = cancel). BACK: quit.

import { device } from "@shared/device";
import { loadValues, type SettingsValues } from "@shared/settings";
import manifest from "./appmeta/manifest.json";
import { errorKind, getHeating, getWaste, getWeather, setHeating, type HaConfig, type Heating, type WasteItem, type Weather } from "./ha";
import {
  backFrame, COLORS, formatSetpoint, heatingFrame, messageFrame, statusDot, wasteFrame, weatherFrame,
  type El, type HeatingEdit,
} from "./views";

const APP = manifest.id;
const PRIORITY = 50;

type PageId = "weather" | "heating" | "waste";
const PAGES: PageId[] = ["weather", "heating", "waste"];
const PAGE_NAMES: Record<PageId, string> = { weather: "Weather", heating: "Heating", waste: "Waste" };

/** How old each kind of data may get while its page is shown. */
const MAX_AGE_MS: Record<PageId, number> = { weather: 10 * 60e3, heating: 30e3, waste: 30 * 60e3 };
const CHECK_MS = 15e3;
const RETRY_MS = 30e3;
const MAX_BACKOFF_MS = 5 * 60e3;
const AUTH_RETRY_MS = 10 * 60e3;
/** A request that never settles must not block its page forever. */
const STUCK_MS = 45e3;
const EDIT_TIMEOUT_MS = 20e3;
const TOAST_MS = 1500;
const SETTINGS_MS = 5 * 60e3;
const TIME_SYNC_MS = 60 * 60e3;

const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

interface Slot {
  at: number;
  inflightSince: number;
  failures: number;
  retryAt: number;
  error: string | null;
}

interface Config extends HaConfig {
  pageMs: number;
}

async function readConfig(): Promise<Config> {
  // The Settings global is missing on some firmware: fall back to the HTTP API.
  let values: SettingsValues | null = await loadValues();
  if (!values) {
    values = await device
      .AppsSettingsGet({ app_id: APP })
      .then((doc) => (doc.values ?? null) as SettingsValues | null)
      .catch(() => null);
  }
  const v = values ?? {};
  const url = typeof v.ha_url === "string" ? v.ha_url.trim().replace(/\/+$/, "") : "";
  const token = typeof v.ha_token === "string" ? v.ha_token.trim() : "";
  const seconds = typeof v.page_seconds === "number" && isFinite(v.page_seconds) ? v.page_seconds : 60;
  return { url, token, pageMs: Math.max(10, Math.min(300, seconds)) * 1000 };
}

/** UTC offset in seconds from "2025-10-02T14:30:45+04:00" (or "...Z"). */
function parseOffset(timestamp: string): number | null {
  if (/Z$/.test(timestamp)) return 0;
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(timestamp);
  if (!m) return null;
  const s = (Number(m[2]) * 60 + Number(m[3])) * 60;
  return m[1] === "-" ? -s : s;
}

function describe(err: unknown): string {
  const kind = errorKind(err);
  if (kind === "auth") return "Bad token";
  if (kind === "config") return (err as Error).message === "no token" ? "Set token" : (err as Error).message === "no URL" ? "Set HA URL" : "No busykiosk";
  
  return "HA offline: " + (err instanceof Error ? err.message : String(err));
}

/** The front screen only fits the label ("HA offline"); the detail after ": " goes to the back screen. */
const shortError = (error: string | null): string => (error ? error.split(": ")[0] : "Loading...");

/** Cuts text into at most `maxLines` lines of `width` characters (the last one ends with "..." if cut). */
function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < text.length && lines.length < maxLines; i += width) lines.push(text.slice(i, i + width));
  if (lines.length === maxLines && lines.join("").length < text.length) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, width - 3) + "...";
  }
  return lines;
}

function main(): void {
  let config: Config = { url: "", token: "", pageMs: 60e3 };
  let configAt = 0;
  let page = 0;
  let stopped = false;

  let weather: Weather | null = null;
  let heating: Heating | null = null;
  let waste: WasteItem[] | null = null;
  const slots: Record<PageId, Slot> = {
    weather: { at: 0, inflightSince: 0, failures: 0, retryAt: 0, error: null },
    heating: { at: 0, inflightSince: 0, failures: 0, retryAt: 0, error: null },
    waste: { at: 0, inflightSince: 0, failures: 0, retryAt: 0, error: null },
  };

  let edit: HeatingEdit | null = null;
  let sending = false;
  let toast: { text: string; color: string } | null = null;
  let ledColor: string | null = null;

  let utcOffsetS: number | null = null;
  let timeSyncedAt = 0;

  let pageTimer: ReturnType<typeof setTimeout> | null = null;
  let clockTimer: ReturnType<typeof setTimeout> | null = null;
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const checkTimer = setInterval(() => check(), CHECK_MS);

  // ------------------------------------------------------------ drawing

  /** Elements on screen, by id, as last sent. */
  let shown = new Map<string, string>();
  let resendAll = false;
  let drawing = false;
  let redrawPending = false;

  function clock() {
    const offset = utcOffsetS ?? (weather && weather.utcOffset !== null ? weather.utcOffset : 0);
    const d = new Date(Date.now() + offset * 1000);
    return { day: d.getUTCDate(), month: d.getUTCMonth(), hours: d.getUTCHours(), minutes: d.getUTCMinutes() };
  }

  function frontFrame(): El[] {
    const id = PAGES[page];
    if (toast) return messageFrame(toast.text, toast.color);
    const slot = slots[id];
    let els: El[];
    if (id === "weather") {
      // The clock never needs Home Assistant.
      els = weatherFrame(weather, clock());
    } else if (id === "heating") {
      els = heating ? heatingFrame(heating, edit) : messageFrame(shortError(slot.error));
    } else {
      els = waste ? wasteFrame(waste) : messageFrame(shortError(slot.error));
    }
    if (sending) els.push(statusDot("amber"));
    else if (slot.error && els.length && els[0].id !== "msg") els.push(statusDot("red"));
    return els;
  }

  function hints(): string[] {
    const id = PAGES[page];
    const error = slots[id].error;
    // The back screen has room for the whole message: 2 lines of ~24 characters.
    const lines = [`BusyKiosk - ${page + 1}/${PAGES.length} ${PAGE_NAMES[id]}`];
    if (error) lines.push(...wrap(error, 24, 2));
    else lines.push("HA: connected");
    if (edit) lines.push("Knob: setpoint", "START: on/off", "OK: send  BACK: cancel");
    else if (id === "heating" && heating) lines.push("Knob: page", "OK: edit thermostat", "BACK: quit");
    else lines.push("Knob: page", "OK: refresh", "BACK: quit");
    return lines;
  }

  async function draw(): Promise<void> {
    if (stopped) return;
    if (drawing) {
      redrawPending = true;
      return;
    }
    drawing = true;
    try {
      const elements = frontFrame().concat(backFrame(hints()));
      const next = new Map<string, string>();
      const changed: El[] = [];
      for (const el of elements) {
        const json = JSON.stringify(el);
        next.set(el.id, json);
        if (resendAll || shown.get(el.id) !== json) changed.push(el);
      }
      const removed: string[] = [];
      shown.forEach((_, id) => {
        if (!next.has(id)) removed.push(id);
      });
      const led = ledColor;
      resendAll = false;
      ledColor = null;
      if (removed.length) await device.DisplayClear({ application_name: APP, element_ids: removed });
      if (changed.length) {
        const params = { application_name: APP, priority: PRIORITY, elements: changed };
        await device.DisplayDraw(led ? { ...params, led_notification_color: led } : params);
      }
      shown = next;
    } catch (err) {
      // Screen state unknown: resend everything next time.
      shown = new Map();
      throw err;
    } finally {
      drawing = false;
      if (redrawPending && !stopped) {
        redrawPending = false;
        void draw().catch(report);
      }
    }
  }

  const redraw = () => void draw().catch(report);

  // ------------------------------------------------------------ data

  async function refreshConfig(force: boolean): Promise<void> {
    if (!force && Date.now() - configAt < SETTINGS_MS) return;
    const before = `${config.url}|${config.token}`;
    config = await readConfig();
    configAt = Date.now();
    if (`${config.url}|${config.token}` !== before) {
      // New address or token: retry everything right away.
      for (const id of PAGES) slots[id].retryAt = 0;
    }
  }

  async function syncTime(): Promise<void> {
    if (Date.now() - timeSyncedAt < TIME_SYNC_MS) return;
    timeSyncedAt = Date.now();
    try {
      const offset = parseOffset((await device.TimeGet()).timestamp);
      if (offset !== null) utcOffsetS = offset;
    } catch (err) {
      report(err);
    }
  }

  async function load(id: PageId, force: boolean): Promise<void> {
    const slot = slots[id];
    const now = Date.now();
    if (slot.inflightSince && now - slot.inflightSince < STUCK_MS) return;
    if (!force && (now - slot.at < MAX_AGE_MS[id] || now < slot.retryAt)) return;
    slot.inflightSince = now;
    try {
      await refreshConfig(force);
      if (id === "weather") weather = await getWeather(config);
      else if (id === "heating") heating = await getHeating(config);
      else waste = await getWaste(config);
      slot.at = Date.now();
      slot.failures = 0;
      slot.error = null;
    } catch (err) {
      report(err);
      slot.failures += 1;
      slot.error = describe(err);
      const kind = errorKind(err);
      const backoff = kind === "auth" ? AUTH_RETRY_MS : Math.min(RETRY_MS * Math.pow(2, slot.failures - 1), MAX_BACKOFF_MS);
      // Missing settings are re-read on every check, so they are picked up quickly.
      slot.retryAt = Date.now() + (kind === "config" ? CHECK_MS : backoff);
      if (kind === "config") configAt = 0;
    } finally {
      slot.inflightSince = 0;
    }
    if (!stopped && PAGES[page] === id) redraw();
  }

  /** Periodic check: keep the visible page's data fresh. */
  function check(): void {
    if (stopped) return;
    void syncTime().then(() => load(PAGES[page], false)).catch(report);
  }

  // ------------------------------------------------------------ pages and timers

  function schedulePage(): void {
    if (pageTimer) clearTimeout(pageTimer);
    pageTimer = null;
    if (stopped || edit) return;
    pageTimer = setTimeout(() => {
      pageTimer = null;
      showPage(page + 1);
    }, config.pageMs);
  }

  function showPage(index: number): void {
    page = (index + PAGES.length) % PAGES.length;
    // A new page resends all of its elements, which also restores anything another app wiped.
    resendAll = true;
    schedulePage();
    redraw();
    void load(PAGES[page], false).catch(report);
  }

  function scheduleClock(): void {
    if (stopped) return;
    // Wake just after each minute boundary; only the date/time text changes.
    clockTimer = setTimeout(() => {
      clockTimer = null;
      if (PAGES[page] === "weather") redraw();
      scheduleClock();
    }, 60e3 - (Date.now() % 60e3) + 50);
  }

  function showToast(text: string, color: string): void {
    toast = { text, color };
    ledColor = color;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toast = null;
      redraw();
    }, TOAST_MS);
    redraw();
  }

  // ------------------------------------------------------------ thermostat editing

  function armEditTimeout(): void {
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      editTimer = null;
      endEdit();
    }, EDIT_TIMEOUT_MS);
  }

  function startEdit(): void {
    if (!heating || heating.setpoint === null) return;
    edit = { setpoint: heating.setpoint, on: heating.on };
    armEditTimeout();
    schedulePage(); // paused while editing
    redraw();
  }

  function endEdit(): void {
    edit = null;
    if (editTimer) clearTimeout(editTimer);
    editTimer = null;
    schedulePage();
    redraw();
  }

  function nudgeSetpoint(delta: number): void {
    if (!edit || !heating) return;
    const step = heating.step > 0 ? heating.step : 0.5;
    const value = Math.round((edit.setpoint + delta * step) / step) * step;
    edit.setpoint = Math.max(heating.min, Math.min(heating.max, value));
    armEditTimeout();
    redraw();
  }

  async function send(): Promise<void> {
    if (!edit) return;
    const { setpoint, on } = edit;
    edit = null;
    if (editTimer) clearTimeout(editTimer);
    editTimer = null;
    sending = true;
    redraw();
    try {
      heating = await setHeating(config, setpoint, on);
      slots.heating.at = Date.now();
      slots.heating.error = null;
      sending = false;
      showToast(on ? `Set ${formatSetpoint(setpoint, heating.step)}` : "Heating off", COLORS.GREEN);
    } catch (err) {
      report(err);
      sending = false;
      showToast(errorKind(err) === "auth" ? "Bad token" : "Not sent", COLORS.RED);
      // Show what the thermostat really is.
      void load("heating", true).catch(report);
    }
    schedulePage();
  }

  // ------------------------------------------------------------ input

  const unbind = listen("input", (event) => {
    if (stopped || sending) return;

    if (event.key === "encoder") {
      if (edit) nudgeSetpoint(event.delta);
      else showPage(page + event.delta);
      return;
    }
    if (event.action !== "short") return;

    if (event.key === "ok") {
      if (edit) void send().catch(report);
      else if (PAGES[page] === "heating" && heating && heating.setpoint !== null) startEdit();
      else {
        configAt = 0;
        void load(PAGES[page], true).catch(report);
      }
      return;
    }

    if (event.key === "start") {
      if (edit) {
        edit.on = !edit.on;
        armEditTimeout();
        redraw();
      }
      return;
    }

    if (event.key !== "back") return;
    if (edit) {
      endEdit();
      return;
    }
    quit();
  });

  function quit(): void {
    stopped = true;
    for (const t of [pageTimer, clockTimer, editTimer, toastTimer]) if (t) clearTimeout(t);
    clearInterval(checkTimer);
    // The listener is the last handle: release it after this callback returns.
    void device
      .DisplayClear({ application_name: APP })
      .catch(report)
      .then(() => setTimeout(unbind, 0));
  }

  // ------------------------------------------------------------ start: page 1

  void refreshConfig(true)
    .then(syncTime)
    .catch(report)
    .then(() => {
      if (stopped) return;
      showPage(0);
      // Warm the other pages so they don't open on "Loading...".
      void load("heating", false).catch(report);
      void load("waste", false).catch(report);
    });
  scheduleClock();
}

main();
