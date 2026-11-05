#!/usr/bin/env node
// Renders every page with sample data as ASCII art and checks that each front element
// stays inside 72x16. Text is drawn as its cap box ("#"), sprites from their grids.
//   npm run check

import * as fonts from "@busy-app/busy-lib/fonts";
import { registerFontMaps, textWidth } from "@busy-app/busy-lib";
import { heatingFrame, wasteFrame, weatherFrame } from "../src/views.ts";

registerFontMaps({ fonts: Object.assign({}, ...Object.values(fonts).map((f) => f.fonts)) });

// Measured cap boxes (busybar skill font table): rows lit below the line-box top.
const CAPS = { tiny: [1, 4], small: [2, 5], large: [2, 9] };
const ANIM_SIZE = { flame: [7, 9], wx: [16, 16], hop: [12, 9] };

function box(el) {
  if (el.type === "text") {
    const w = textWidth(el.text, el.font);
    const [top, h] = CAPS[el.font];
    const x = el.align === "top_mid" ? el.x - Math.floor(w / 2) : el.x;
    return { x, y: el.y + top, w, h, ch: "#" };
  }
  if (el.type === "xpmbitmap") {
    const [w, h] = el.data.split("\n")[1].split(" ").map(Number);
    return { x: el.x, y: el.y, w, h, ch: "o" };
  }
  if (el.type === "animation") {
    const key = Object.keys(ANIM_SIZE).find((k) => el.path.includes(`/${k}`));
    const [w, h] = ANIM_SIZE[key];
    // Hop animations have one spare row on top.
    return { x: el.x, y: el.y + (key === "hop" ? 1 : 0), w, h: h - (key === "hop" ? 1 : 0), ch: "@" };
  }
  return { x: el.x, y: el.y, w: el.width, h: el.height, ch: "=" };
}

let failures = 0;
function show(name, els) {
  const grid = Array.from({ length: 16 }, () => Array(72).fill("."));
  for (const el of [...els].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0))) {
    const b = box(el);
    if (b.x < 0 || b.y < 0 || b.x + b.w > 72 || b.y + b.h > 16) {
      console.log(`  OUT OF SCREEN: ${el.id} x=${b.x} y=${b.y} w=${b.w} h=${b.h}`);
      failures++;
    }
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) if (grid[y]?.[x] !== undefined) grid[y][x] = b.ch;
  }
  console.log(`\n${name}`);
  console.log(grid.map((r) => `|${r.join("")}|`).join("\n"));
}

const clock = { day: 31, month: 9, hours: 14, minutes: 32 };
show("weather", weatherFrame({ icon: "rain", tempMin: 8, tempMax: 14, utcOffset: 3600 }, clock));
show("weather, cold", weatherFrame({ icon: "snow", tempMin: -12, tempMax: -3, utcOffset: 3600 }, { ...clock, day: 1 }));
show("weather, no data", weatherFrame(null, clock));

const heating = { setpoint: 20.5, on: true, heating: true, min: 7, max: 30, step: 0.5, living: 19.8, bedroom: 18.2 };
show("heating", heatingFrame(heating, null));
show("heating, editing", heatingFrame(heating, { setpoint: 21, on: false }));
show("heating, off", heatingFrame({ ...heating, on: false, heating: false, living: null }, null));

show(
  "waste",
  wasteFrame([
    { type: "verre", days: 0, text: "0" },
    { type: "emballages", days: 1, text: "1" },
    { type: "menagers", days: 3, text: "3" },
    { type: "verts", days: 12, text: "12" },
    { type: "encombrants", days: null, text: "-" },
  ]),
);

console.log(failures ? `\n${failures} element(s) out of screen` : "\nall elements inside 72x16");
process.exit(failures ? 1 : 0);
