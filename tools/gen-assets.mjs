#!/usr/bin/env node
// Generates the app's binary assets from code, with no dependencies:
//   src/animations/wx_*.anim      16x16 weather animations (pixel art, 10 fps)
//   src/animations/flame.anim     heating flame flicker
//   src/animations/hop_*.anim     waste icons hopping when the collection is close
//   src/appmeta/icon_*.png        APPS menu icons
//   tools/preview.html            every sprite and animation, scaled up, to review in a browser
//
// Run from the app root (Node 24, or Node 22 with the flag):
//   node --experimental-strip-types tools/gen-assets.mjs
//
// The .anim writer is a port of the busybar skill's make_anim.py ("bicycle1" format,
// firmware repo lib/anim_file/anim_file_format.h): BGRA8888 raw pixels, the first frame
// of each section whole, later frames as only the pixels that changed.

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WASTE, FLAME, FLAME_FRAMES, FLAME_IDLE, FLAME_OFF, SOFA, BED } from "../src/sprites.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 16;
const FPS = 10;

// ---------------------------------------------------------------- .anim writer

const MAGIC = Buffer.from("bicycle1", "ascii");
const COLOR_BGRA8888 = 2;
const HEADER_LEN = 8 + 4 + 2 + 2 + 1 + 1 + 4 + 4 + 4 + 4; // "<8s BBBB HHBB II II"

/** One frame: everything when `previous` is null (a keyframe), else only the pixels that changed. */
function frameBytes(pixels, previous) {
  let maskEnc, maskBits, maskData, changed;
  if (!previous) {
    [maskEnc, maskBits, maskData, changed] = [1, 0, Buffer.alloc(0), pixels]; // FullyWhite
  } else {
    const flags = [];
    for (let i = 0; i < pixels.length; i += 4) flags.push(!pixels.subarray(i, i + 4).equals(previous.subarray(i, i + 4)));
    changed = Buffer.concat(flags.flatMap((f, i) => (f ? [pixels.subarray(i * 4, i * 4 + 4)] : [])));
    if (!flags.some(Boolean)) [maskEnc, maskBits, maskData] = [0, 0, Buffer.alloc(0)]; // FullyBlack: unchanged
    else if (flags.every(Boolean)) [maskEnc, maskBits, maskData] = [1, 0, Buffer.alloc(0)];
    else {
      const bitmap = Buffer.alloc(Math.ceil(flags.length / 8));
      flags.forEach((f, i) => {
        if (f) bitmap[i >> 3] |= 128 >> (i & 7); // MSB first
      });
      [maskEnc, maskBits, maskData] = [4, flags.length, bitmap];
    }
  }
  const header = Buffer.alloc(5);
  header.writeUInt8(0 | (maskEnc << 4), 0); // pixel encoding 0 = raw
  header.writeUInt16LE(maskBits, 1);
  header.writeUInt16LE(changed.length, 3);
  return { data: Buffer.concat([header, maskData, changed]), maskBits, pixelLen: changed.length };
}

function writeAnim(path, frames, width, height, fps, sections) {
  sections = sections ?? [["default", 0, frames.length - 1]];
  const starts = new Set(sections.map(([, start]) => start));
  const encoded = [];
  let maxMask = 0;
  let maxPixels = 0;
  let previous = null;
  frames.forEach((pixels, i) => {
    const f = frameBytes(pixels, starts.has(i) ? null : previous);
    encoded.push(f.data);
    maxMask = Math.max(maxMask, f.maskBits);
    maxPixels = Math.max(maxPixels, f.pixelLen);
    previous = pixels;
  });
  const sectionChunkLen = sections.reduce((n, [name]) => n + 12 + Buffer.byteLength(name) + 1, 0);
  const offsets = [];
  let offset = HEADER_LEN + sectionChunkLen;
  for (const data of encoded) {
    offsets.push(offset);
    offset += data.length;
  }
  const sectionChunk = Buffer.concat(
    sections.map(([name, start, end]) => {
      const b = Buffer.alloc(12);
      b.writeUInt32LE(start, 0);
      b.writeUInt32LE(end, 4);
      b.writeUInt32LE(offsets[start], 8);
      return Buffer.concat([b, Buffer.from(name), Buffer.from([0])]);
    }),
  );
  const framesChunk = Buffer.concat(encoded);
  const h = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(h, 0);
  let o = 8;
  for (const v of [0, width, height, COLOR_BGRA8888]) h.writeUInt8(v, o++);
  h.writeUInt16LE(maxMask, o); o += 2;
  h.writeUInt16LE(maxPixels, o); o += 2;
  h.writeUInt8(fps, o++);
  h.writeUInt8(0, o++);
  h.writeUInt32LE(sectionChunk.length, o); o += 4;
  h.writeUInt32LE(framesChunk.length, o); o += 4;
  h.writeUInt32LE(sections.length, o); o += 4;
  h.writeUInt32LE(frames.length, o);
  writeFileSync(path, Buffer.concat([h, sectionChunk, framesChunk]));
}

// ---------------------------------------------------------------- tiny canvas

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

class Canvas {
  constructor(w = SIZE, h = SIZE) {
    this.w = w;
    this.h = h;
    this.px = new Array(w * h).fill(null); // "#RRGGBB" or null
  }
  set(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (color && x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = color;
  }
  blit(grid, palette, ox, oy) {
    grid.forEach((row, y) => [...row].forEach((ch, x) => this.set(ox + x, oy + y, palette[ch])));
  }
  /** BGRA bytes for the .anim; transparent pixels are all zero. */
  bgra() {
    const b = Buffer.alloc(this.w * this.h * 4);
    this.px.forEach((c, i) => {
      if (!c) return;
      const [r, g, bl] = hex(c);
      b.set([bl, g, r, 255], i * 4);
    });
    return b;
  }
}

// ---------------------------------------------------------------- weather pieces

const SUN_CORE = [
  "..OOOO..",
  ".OYYYYO.",
  "OYWWYYYO",
  "OYWYYYYO",
  "OYYYYYYO",
  "OYYYYYSO",
  ".OYYYSO.",
  "..OOOO..",
];
const SUN_PAL = { O: "#FF8F00", Y: "#FFD600", W: "#FFFDE7", S: "#FFAB00" };
const RAY = "#FFC400";
const RAY_TIP = "#FF8F00";
const RAY_GLOW = "#FFE57F";

/**
 * Sun with 8 rays of 2 pixels around the core at (ox, oy) top-left. `tip(r)` colors the outer
 * pixel of ray r, clockwise from the top (0 = top, 1 = top right, ... 7 = top left).
 */
function sun(c, ox, oy, tip = () => RAY_TIP) {
  c.blit(SUN_CORE, SUN_PAL, ox, oy);
  for (let i = 1; i <= 2; i++) {
    const color = (r) => (i === 2 ? tip(r) : RAY);
    const d = 1 + i; // gap of one pixel to the core
    for (const k of [3, 4]) {
      c.set(ox + k, oy - d, color(0)); // top
      c.set(ox + 7 + d, oy + k, color(2)); // right
      c.set(ox + k, oy + 7 + d, color(4)); // bottom
      c.set(ox - d, oy + k, color(6)); // left
    }
    c.set(ox + 7 + i, oy - i, color(1));
    c.set(ox + 7 + i, oy + 7 + i, color(3));
    c.set(ox - i, oy + 7 + i, color(5));
    c.set(ox - i, oy - i, color(7));
  }
}

const CLOUD = [
  "....KKKK....",
  "..KKWWWWK...",
  ".KWWWWWWWKK.",
  "KWWWWWWWWWWK",
  "KWWWWWWWWWLK",
  "KLLWWWWWLLLK",
  ".KKKKKKKKKK.",
];
const CLOUD_WHITE = { K: "#78909C", W: "#FFFFFF", L: "#CFD8DC" };
const CLOUD_GREY = { K: "#546E7A", W: "#B0BEC5", L: "#78909C" };
const CLOUD_DARK = { K: "#37474F", W: "#78909C", L: "#546E7A" };
const CLOUD_FLASH = { K: "#90A4AE", W: "#FFFFFF", L: "#ECEFF1" };

/** Crescent moon inside a 9x9 box at (ox, oy). */
function moon(c, ox, oy) {
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      const inA = (x - 4) ** 2 + (y - 4) ** 2 <= 4.6 ** 2;
      const inB = (x - 6.6) ** 2 + (y - 2.6) ** 2 <= 3.9 ** 2;
      if (!inA || inB) continue;
      const edge = (x - 4) ** 2 + (y - 4) ** 2 > 3.6 ** 2;
      c.set(ox + x, oy + y, edge ? "#FBC02D" : "#FFF59D");
    }
  c.set(ox + 2, oy + 5, "#F9A825"); // crater
}

/** Star that twinkles: 0 = off, 1 = dim dot, 2 = bright dot, 3 = sparkle "+". */
function star(c, x, y, level) {
  if (level >= 1) c.set(x, y, level === 1 ? "#5C6BC0" : "#FFFFFF");
  if (level === 3) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) c.set(x + dx, y + dy, "#9FA8DA");
}

const TWINKLE = [0, 1, 2, 3, 2, 1, 0, 0, 0, 0];

const BOLT = ["...YY", "..YY.", ".YYYY", "...Y.", "..Y..", ".Y..."];

/** Rain drops falling from row `top` to 15; `cols` = [x, phase]. */
function rain(c, f, top, cols, len, color, tail) {
  const span = SIZE - top;
  for (const [x, phase] of cols) {
    const y = top + ((f + phase) % span);
    c.set(x, y, color);
    for (let i = 1; i < len; i++) if (y - i >= top) c.set(x, y - i, tail);
  }
}

// Spiral curl, 7x6, in drawing order from the end of the line inwards:
//   ..XXX..
//   .X...X.
//   X..X..X
//   .XX...X
//   .....X.
//   ----X..   <- the line comes in on this row
const CURL = [[4, 5], [5, 4], [6, 3], [6, 2], [5, 1], [4, 0], [3, 0], [2, 0], [1, 1], [0, 2], [1, 3], [2, 3], [3, 2]];

/**
 * Wind stroke in the Japanese style: a line on row y from x0 that ends in the spiral curl,
 * whose 7-wide box starts at column ox; the curl rises above the line when `up`, else hangs
 * below it. Returns the pixels in drawing order.
 */
function volute(x0, ox, y, up) {
  const line = Array.from({ length: ox + 4 - x0 }, (_, i) => [x0 + i, y]);
  return [...line, ...CURL.map(([dx, dy]) => [ox + dx, up ? y - 5 + dy : y + 5 - dy])];
}

// Every wind loop is 64 frames, so the leaves' laps, bob and turns all line up.
const WIND_FRAMES = 64;

// Wind snakes slide in from the left edge along a line and coil into a curl's centre,
// counter-clockwise. Two staggered volutes, top left and bottom right, each fed by two
// snakes half a loop apart; the bottom ones run a quarter loop behind the top ones.
const SNAKE_BODY = [
  "#FFFFFF", "#E0F7FA", "#E0F7FA", "#B2EBF2", "#B2EBF2", "#B2EBF2", "#80DEEA", "#80DEEA",
  "#4DD0E1", "#4DD0E1", "#26C6DA", "#26A6B8", "#0097A7", "#00838F", "#006978", "#005662",
]; // head first
const WIND_VOLUTES = [
  // path, snake phases
  [volute(0, 3, 6, true), [0, 32]],
  [volute(0, 9, 13, true), [16, 48]],
];

/** One snake along `path` with its head on pixel `head`. */
function snake(c, path, head) {
  // Tail first, so the brighter pixels near the head win where the path crosses itself.
  for (let i = SNAKE_BODY.length - 1; i >= 0; i--) {
    const p = path[head - i];
    if (p) c.set(p[0], p[1], SNAKE_BODY[i]);
  }
}

// Two-pixel leaves tumbling through a quarter turn every 4 frames.
const LEAF_TURN = [[[0, 0], [1, 0]], [[0, 1], [1, 0]], [[0, 0], [0, 1]], [[0, 0], [1, 1]]];
const LEAF_BOB = [0, -1, -1, 0, 0, 1, 1, 0];

const wrap = (x) => ((x % SIZE) + SIZE) % SIZE;

/** Leaves ride across at 1 px every 2 frames, two laps per wind loop. */
function leaves(c, f, list) {
  for (const [x0, y0, [tip, stem], phase] of list) {
    const x = x0 + Math.floor(f / 2);
    const y = y0 + LEAF_BOB[Math.floor((f + phase) / 4) % 8];
    const [[ax, ay], [bx, by]] = LEAF_TURN[Math.floor((f + phase) / 4) % 4];
    c.set(wrap(x + ax), y + ay, tip);
    c.set(wrap(x + bx), y + by, stem);
  }
}

// ---------------------------------------------------------------- weather animations

const ANIMS = {
  sun: () =>
    // Rays stay put; a soft glow goes round their tips, one ray every 5 frames.
    Array.from({ length: 40 }, (_, f) => {
      const c = new Canvas();
      sun(c, 4, 4, (r) => (r === Math.floor(f / 5) ? RAY_GLOW : RAY_TIP));
      return c;
    }),

  night: () =>
    Array.from({ length: 30 }, (_, f) => {
      const c = new Canvas();
      moon(c, 1, 3);
      star(c, 12, 2, TWINKLE[f % 10]);
      star(c, 13, 9, TWINKLE[(f + 4) % 10]);
      star(c, 9, 13, TWINKLE[(f + 7) % 10]);
      star(c, 7, 1, f % 15 < 7 ? 1 : 2);
      return c;
    }),

  partly: () =>
    Array.from({ length: 40 }, (_, f) => {
      const c = new Canvas();
      // The sun stays still: at this spot most of its rays fall off the canvas, and pulsing
      // the few that remain looked like a single ray twitching.
      sun(c, 7, 1);
      const dx = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1][f % 20];
      c.blit(CLOUD, CLOUD_WHITE, 0 + dx, 8);
      return c;
    }),

  partly_night: () =>
    Array.from({ length: 40 }, (_, f) => {
      const c = new Canvas();
      moon(c, 6, 0);
      star(c, 2, 2, TWINKLE[f % 10]);
      star(c, 15, 9, TWINKLE[(f + 5) % 10]);
      const dx = f % 20 < 10 ? 0 : 1;
      c.blit(CLOUD, CLOUD_WHITE, 0 + dx, 8);
      return c;
    }),

  cloudy: () =>
    Array.from({ length: 40 }, (_, f) => {
      const c = new Canvas();
      const phase = f % 40 < 20 ? 0 : 1;
      c.blit(CLOUD, CLOUD_GREY, 4 - phase, 2);
      c.blit(CLOUD, CLOUD_WHITE, 0 + phase, 8);
      return c;
    }),

  rain: () =>
    Array.from({ length: 8 }, (_, f) => {
      const c = new Canvas();
      c.blit(CLOUD, CLOUD_GREY, 2, 1);
      rain(c, f, 8, [[4, 0], [7, 5], [10, 2], [13, 6]], 2, "#40C4FF", "#0277BD");
      return c;
    }),

  pouring: () =>
    Array.from({ length: 8 }, (_, f) => {
      const c = new Canvas();
      c.blit(CLOUD, CLOUD_DARK, 2, 1);
      rain(c, f, 8, [[3, 0], [5, 4], [7, 1], [9, 6], [11, 3], [13, 7]], 3, "#40C4FF", "#0277BD");
      return c;
    }),

  storm: () =>
    Array.from({ length: 20 }, (_, f) => {
      const c = new Canvas();
      const flash = f === 4 || f === 5 || f === 8;
      rain(c, f, 8, [[3, 0], [12, 5], [14, 2]], 2, "#40C4FF", "#0277BD");
      c.blit(CLOUD, flash ? CLOUD_FLASH : CLOUD_DARK, 2, 1);
      if (flash || f === 6) c.blit(BOLT, { Y: f === 6 ? "#FFAB00" : "#FFEA00" }, 6, 8);
      return c;
    }),

  snow: () =>
    Array.from({ length: 32 }, (_, f) => {
      const c = new Canvas();
      c.blit(CLOUD, CLOUD_WHITE, 2, 0);
      const sway = (p) => [0, 1, 1, 0, 0, -1, -1, 0][Math.floor((f + p) / 2) % 8];
      for (const [x, p] of [[4, 0], [8, 10], [12, 5], [6, 14]]) {
        const y = 7 + (Math.floor((f + p) / 2) % 9);
        c.set(x + sway(p), y, "#FFFFFF");
      }
      // One big flake, 3x3 "+".
      const by = 7 + (Math.floor(f / 4) % 9);
      const bx = 10 + sway(3);
      c.set(bx, by, "#FFFFFF");
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) c.set(bx + dx, by + dy, "#B3E5FC");
      return c;
    }),

  fog: () =>
    Array.from({ length: 16 }, (_, f) => {
      const c = new Canvas();
      const lines = [
        [3, "######..####....", 1, "#B0BEC5"],
        [6, "..########...###", -1, "#ECEFF1"],
        [9, "####...#######..", 1, "#90A4AE"],
        [12, ".#####....######", -1, "#CFD8DC"],
      ];
      for (const [y, pat, dir, color] of lines) {
        const shift = Math.floor(f / 2) * dir;
        for (let x = 0; x < SIZE; x++) if (pat[(((x - shift) % 16) + 16) % 16] === "#") c.set(x, y, color);
      }
      return c;
    }),

  wind: () =>
    Array.from({ length: WIND_FRAMES }, (_, f) => {
      const c = new Canvas();
      for (const [path, phases] of WIND_VOLUTES)
        for (const phase of phases) snake(c, path, (f + phase) % WIND_FRAMES);
      leaves(c, f, [
        [0, 4, ["#FFAB40", "#E65100"], 0],
        [8, 11, ["#AED581", "#558B2F"], 16],
      ]);
      return c;
    }),
};

// ---------------------------------------------------------------- PNG icons

function png(path, grid, palette) {
  const h = grid.length;
  const w = grid[0].length;
  const rows = Buffer.concat(
    grid.map((row) => Buffer.concat([Buffer.from([0]), ...[...row].map((ch) => Buffer.from(palette[ch]))])),
  );
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// Front: a little house with a lit window (Home Assistant kiosk).
const ICON_FRONT = [
  "...RR...",
  "..RRRR..",
  ".RRRRRR.",
  "RRRRRRRR",
  ".WWWWWW.",
  ".WYYWDW.",
  ".WYYWDW.",
  ".WWWWDW.",
];
const ICON_FRONT_PAL = {
  ".": [0, 0, 0, 0],
  R: [3, 169, 244, 255],
  W: [236, 239, 241, 255],
  Y: [255, 214, 0, 255],
  D: [121, 85, 72, 255],
};

// Back: greyscale line art of the same house.
const ICON_BACK = [
  ".....#.....",
  "....#.#....",
  "...#...#...",
  "..#.....#..",
  ".#.......#.",
  "###########",
  ".#.......#.",
  ".#.##..#.#.",
  ".#.##..#.#.",
  ".#.....#.#.",
  ".#########.",
];
const ICON_BACK_PAL = { ".": [0, 0, 0, 0], "#": [255, 255, 255, 255] };

// ---------------------------------------------------------------- run

const animDir = join(ROOT, "src", "animations");
mkdirSync(animDir, { recursive: true });
const preview = {};
for (const [name, build] of Object.entries(ANIMS)) {
  const frames = build();
  writeAnim(join(animDir, `wx_${name}.anim`), frames.map((c) => c.bgra()), SIZE, SIZE, FPS);
  preview[`wx_${name}`] = { w: SIZE, h: SIZE, fps: FPS, frames: frames.map((c) => c.px) };
  console.log(`wrote src/animations/wx_${name}.anim (${frames.length} frames)`);
}
// Flame flicker, 7x9 at 6 fps.
{
  const order = [0, 1, 0, 2, 3, 2];
  const frames = order.map((i) => {
    const c = new Canvas(7, 9);
    c.blit(FLAME_FRAMES[i], FLAME.palette, 0, 0);
    return c;
  });
  writeAnim(join(animDir, "flame.anim"), frames.map((c) => c.bgra()), 7, 9, 6);
  preview.flame_anim = { w: 7, h: 9, fps: 6, frames: frames.map((c) => c.px) };
  console.log("wrote src/animations/flame.anim");
}

// Waste icons hopping (collection today or tomorrow): 12x9 canvas, one spare row on top;
// the app draws them at y = -1 so the resting icon sits where the static one does.
for (const [name, s] of Object.entries(WASTE)) {
  if (name === "unknown") continue;
  const hop = [1, 1, 1, 1, 1, 1, 1, 0, 0, 1];
  const frames = hop.map((y) => {
    const c = new Canvas(12, 9);
    c.blit(s.grid, s.palette, 0, y);
    return c;
  });
  writeAnim(join(animDir, `hop_${name}.anim`), frames.map((c) => c.bgra()), 12, 9, FPS);
  preview[`hop_${name}`] = { w: 12, h: 9, fps: FPS, frames: frames.map((c) => c.px) };
  console.log(`wrote src/animations/hop_${name}.anim`);
}

png(join(ROOT, "src", "appmeta", "icon_front_8x8.png"), ICON_FRONT, ICON_FRONT_PAL);
png(join(ROOT, "src", "appmeta", "icon_back_11x11.png"), ICON_BACK, ICON_BACK_PAL);
console.log("wrote src/appmeta/icon_front_8x8.png, icon_back_11x11.png");

const still = (grid, palette) => {
  const c = new Canvas(grid[0].length, grid.length);
  c.blit(grid, palette, 0, 0);
  return { w: c.w, h: c.h, fps: 1, frames: [c.px] };
};
for (const [name, s] of Object.entries(WASTE)) preview[`waste_${name}`] = still(s.grid, s.palette);
preview.flame = still(FLAME.grid, FLAME.palette);
preview.flame_idle = still(FLAME_IDLE.grid, FLAME_IDLE.palette);
preview.flame_off = still(FLAME_OFF.grid, FLAME_OFF.palette);
preview.sofa = still(SOFA.grid, SOFA.palette);
preview.bed = still(BED.grid, BED.palette);
const rgbaPal = (pal) => Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, v[3] ? `#${v.slice(0, 3).map((n) => n.toString(16).padStart(2, "0")).join("")}` : null]));
preview.icon_front = still(ICON_FRONT, rgbaPal(ICON_FRONT_PAL));
preview.icon_back = still(ICON_BACK, rgbaPal(ICON_BACK_PAL));

writeFileSync(
  join(ROOT, "tools", "preview.html"),
  `<!doctype html><meta charset="utf-8"><title>BusyKiosk sprites</title>
<style>body{background:#111;color:#ccc;font:13px system-ui;margin:16px}div{display:inline-block;margin:10px;text-align:center}canvas{display:block;image-rendering:pixelated;background:#000;margin-bottom:4px}</style>
<h3>BusyKiosk – sprites (12x scale, LED look)</h3><main></main>
<script>
const S=${JSON.stringify(preview)};
const main=document.querySelector("main");
for (const [name,s] of Object.entries(S)) {
  const d=document.createElement("div"), c=document.createElement("canvas"), k=12;
  c.width=s.w*k; c.height=s.h*k; d.append(c, name); main.append(d);
  const g=c.getContext("2d"); let f=0;
  const draw=()=>{ g.fillStyle="#000"; g.fillRect(0,0,c.width,c.height);
    s.frames[f].forEach((p,i)=>{ const x=i%s.w, y=(i/s.w)|0;
      g.fillStyle=p||"#151515"; g.beginPath(); g.roundRect(x*k+1,y*k+1,k-2,k-2,3); g.fill(); });
    f=(f+1)%s.frames.length; };
  draw(); if (s.frames.length>1) setInterval(draw, 1000/s.fps);
}
</script>`,
);
console.log("wrote tools/preview.html");
