// Frame builders: data in, DisplayDraw elements out. No I/O here, so the layouts can be
// checked in Node (tools/check-layout.mjs).
//
// Front screen budget (72x16):
//   weather  [anim 16x16][max/min][        "31 Oct, 14:32"]
//   heating  [20.5° large][flame + ON/OFF][sofa 19.8 / bed 18.2]
//   waste    5 slots of 14 px: icon 12x8 on top, days below

import { generateXpm2, textWidth, type DisplayDrawParams } from "@busy-app/busy-lib";
import type { Heating, WasteItem, Weather } from "./ha";
import { BED, DEGREE, FLAME_IDLE, FLAME_OFF, SOFA, WASTE, type Sprite } from "./sprites.ts";

export type El = DisplayDrawParams["elements"][number];

// Literal `font:` properties tell the build which glyph maps to bundle for textWidth().
const TINY = { font: "tiny" } as const;
const SMALL = { font: "small" } as const;
const LARGE = { font: "large" } as const;

const WHITE = "#FFFFFFFF";
const SUBTLE = "#FFFFFF80";
const ORANGE = "#FF9100FF";
const CYAN = "#40C4FFFF";
const GREEN = "#00E676FF";
const RED = "#FF1744FF";
const AMBER = "#FFC400FF";
const BLACK = "#000000FF";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEATHER_ICONS = ["sun", "night", "partly", "partly_night", "cloudy", "rain", "pouring", "storm", "snow", "fog", "wind"];
const HOP_TYPES = ["menagers", "emballages", "verre", "verts", "encombrants"];

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

// XPM strings are built once per sprite and colour.
const xpmCache: Record<string, string> = {};
function xpm(key: string, sprite: Sprite): string {
  if (!xpmCache[key]) xpmCache[key] = generateXpm2({ palette: { ...sprite.palette, ".": "none" }, grid: sprite.grid });
  return xpmCache[key];
}
const degree = (color: string) =>
  xpm(`deg${color}`, { grid: DEGREE, palette: { "#": color === SUBTLE ? "#808080" : color.slice(0, 7) } });

// ---------------------------------------------------------------- page 1: weather + clock

export interface Clock {
  day: number;
  month: number; // 0-11
  hours: number;
  minutes: number;
}

export function weatherFrame(w: Weather | null, clock: Clock): El[] {
  const els: El[] = [];
  if (w) {
    const icon = WEATHER_ICONS.indexOf(w.icon) >= 0 ? w.icon : "cloudy";
    els.push({ id: "wx", type: "animation", path: `animations/wx_${icon}.anim`, loop: true, x: 0, y: 0 });
  }

  const date = `${clock.day} ${MONTHS[clock.month]}, ${pad(clock.hours)}:${pad(clock.minutes)}`;
  const dateX = 72 - textWidth(date, SMALL.font);
  els.push({ id: "dt", type: "text", text: date, ...SMALL, color: WHITE, x: dateX, y: 3 });

  // Max over min, small caps on rows 1-5 and 9-13; the degree sign only when there is room.
  const temps: [string, number | null, string, number][] = [
    ["tmax", w ? w.tempMax : null, ORANGE, -1],
    ["tmin", w ? w.tempMin : null, CYAN, 7],
  ];
  for (const [id, value, color, y] of temps) {
    const text = value === null ? "--" : String(Math.round(value));
    const x = 18;
    els.push({ id, type: "text", text, ...SMALL, color, x, y });
    const right = x + textWidth(text, SMALL.font) + 1;
    if (value !== null && right + 2 < dateX) {
      els.push({ id: `${id}d`, type: "xpmbitmap", data: degree(color), x: right, y: y + 2 });
    }
  }
  return els;
}

// ---------------------------------------------------------------- page 2: heating

export interface HeatingEdit {
  setpoint: number;
  on: boolean;
}

export function formatSetpoint(value: number | null, step: number): string {
  if (value === null) return "--";
  return step < 1 ? value.toFixed(1) : String(Math.round(value));
}

export function heatingFrame(h: Heating, edit: HeatingEdit | null): El[] {
  const els: El[] = [];
  const setpoint = edit ? edit.setpoint : h.setpoint;
  const on = edit ? edit.on : h.on;

  // Setpoint: large caps on rows 3-11. In edit mode it is inverted on an amber block.
  const text = formatSetpoint(setpoint, h.step);
  const width = textWidth(text, LARGE.font);
  const spColor = edit ? BLACK : on ? WHITE : SUBTLE;
  if (edit) {
    els.push({
      id: "sp_bg", type: "rectangle", x: 0, y: 1, width: width + 5, height: 13,
      fill: "solid", fill_colors: [AMBER], border_width: 0, radius: 1,
    });
  }
  els.push({ id: "sp", type: "text", text, ...LARGE, color: spColor, x: 1, y: 1, z_index: 1 });
  if (setpoint !== null) {
    els.push({ id: "sp_deg", type: "xpmbitmap", data: degree(spColor), x: width + 2, y: 3, z_index: 1 });
  }

  // Flame: flickers while heating, dim when on but idle, grey when off.
  if (on && h.heating && !edit) {
    els.push({ id: "fl_a", type: "animation", path: "animations/flame.anim", loop: true, x: 32, y: 0 });
  } else {
    const sprite = on ? FLAME_IDLE : FLAME_OFF;
    els.push({ id: "fl_s", type: "xpmbitmap", data: xpm(on ? "fl_idle" : "fl_off", sprite), x: 32, y: 0 });
  }
  els.push({
    id: "onoff", type: "text", text: on ? "ON" : "OFF", ...TINY,
    color: edit ? AMBER : on ? GREEN : RED, x: 36, y: 10, align: "top_mid",
  });

  // Living room and bedroom temperatures.
  const rooms: [string, Sprite, number | null, number][] = [
    ["liv", SOFA, h.living, 1],
    ["bed", BED, h.bedroom, 9],
  ];
  for (const [id, sprite, value, y] of rooms) {
    els.push({ id: `${id}_i`, type: "xpmbitmap", data: xpm(id, sprite), x: 46, y });
    const t = value === null ? "--" : value.toFixed(1);
    els.push({ id: `${id}_t`, type: "text", text: t, ...SMALL, color: SUBTLE, x: 55, y: y - 2 });
  }
  return els;
}

// ---------------------------------------------------------------- page 3: waste collection

export function wasteFrame(items: WasteItem[]): El[] {
  const els: El[] = [];
  items.slice(0, 5).forEach((item, i) => {
    const x = i * 14 + 1;
    const urgent = item.days !== null && item.days <= 1;
    if (urgent && HOP_TYPES.indexOf(item.type) >= 0) {
      // Same slot, one spare row on top for the hop.
      els.push({ id: `w${i}a`, type: "animation", path: `animations/hop_${item.type}.anim`, loop: true, x, y: -1 });
    } else {
      const sprite = WASTE[item.type] || WASTE.unknown;
      els.push({ id: `w${i}s`, type: "xpmbitmap", data: xpm(`w_${item.type}`, sprite), x, y: 0 });
    }
    const color = item.days === null ? SUBTLE : item.days === 0 ? RED : item.days === 1 ? AMBER : WHITE;
    els.push({ id: `n${i}`, type: "text", text: item.text, ...SMALL, color, x: x + 6, y: 8, align: "top_mid" });
  });
  if (!items.length) els.push(...messageFrame("No collection", SUBTLE));
  return els;
}

// ---------------------------------------------------------------- shared

export function messageFrame(text: string, color = SUBTLE): El[] {
  return [{ id: "msg", type: "text", text, ...SMALL, color, x: 36, y: 3, align: "top_mid" }];
}

/** 2x2 dot in the top-right corner: red = Home Assistant unreachable, amber = sending. */
export function statusDot(color: "red" | "amber"): El {
  return {
    id: "dot", type: "rectangle", x: 70, y: 0, width: 2, height: 2,
    fill: "solid", fill_colors: [color === "red" ? RED : AMBER], border_width: 0, z_index: 5,
  };
}

/** Lines on the 160x80 greyscale back screen (kept within 145 px: status icons on the right). */
export function backFrame(lines: string[]): El[] {
  return lines.slice(0, 6).map((text, i) => ({
    id: `b${i}`, type: "text", text, ...SMALL, color: i === 0 ? WHITE : SUBTLE, x: 2, y: 2 + i * 12, display: "back",
  }));
}

export const COLORS = { GREEN, RED, AMBER };
