// Pixel-art sprites drawn as string grids: one character per pixel, "." is transparent.
// The app turns them into xpmbitmap elements; tools/gen-assets.mjs reads the same
// grids for the preview page, so keep this file free of imports.

export interface Sprite {
  grid: string[];
  palette: Record<string, string>;
}

// --- Waste collection, 12x8 each (same slot as the original Home Assistant dashboard) ---

/** Household waste: grey trash can, lid with a handle, ribbed body. */
const MENAGERS: Sprite = {
  grid: [
    ".....HH.....",
    ".LLLLLLLLLL.",
    ".RRRRRRRRRR.",
    "..WBDBBDBB..",
    "..WBDBBDBB..",
    "..WBDBBDBB..",
    "...BDBBDB...",
    "...SSSSSS...",
  ],
  palette: { H: "#B0BEC5", L: "#ECEFF1", R: "#90A4AE", W: "#CFD8DC", B: "#9EA7AF", D: "#455A64", S: "#607D8B" },
};

/** Packaging: taped cardboard box seen from above, yellow. */
const EMBALLAGES: Sprite = {
  grid: [
    "...TTTPPTTT.",
    "..TTTPPTTTS.",
    ".TTTPPTTTSS.",
    "FFFPPFFFSSS.",
    "FFFPPFFFSSS.",
    "FFFFFFFFSSS.",
    "FFFFFFFFSS..",
    "FFFFFFFFS...",
  ],
  palette: { T: "#FFE57F", P: "#C79100", F: "#FFC107", S: "#B07800" },
};

/** Glass: bottle with a cork and a shine. */
const VERRE: Sprite = {
  grid: [
    ".....CC.....",
    ".....KK.....",
    "....KLBK....",
    "...KLLBBK...",
    "..KLWBBBSK..",
    "..KLWBBBSK..",
    "..KLBBBBSK..",
    "...KKKKKK...",
  ],
  palette: { C: "#B5651D", K: "#0B5D1E", L: "#69F0AE", W: "#E8FFF2", B: "#00C853", S: "#00873A" },
};

/** Garden waste: little tree with an autumn leaf. */
const VERTS: Sprite = {
  grid: [
    "....KKKK....",
    "..KKLLLLKK..",
    ".KLLLBBLBOK.",
    ".KLBBBBBBSK.",
    "..KBBSBBSK..",
    "...KKTTKK...",
    ".....TT.....",
    "....TTTT....",
  ],
  palette: { K: "#2E5A12", L: "#B2FF59", B: "#64DD17", S: "#33691E", O: "#FF9100", T: "#8D5524" },
};

/** Bulky items: delivery truck. */
const ENCOMBRANTS: Sprite = {
  grid: [
    "KKKKKKKK....",
    "KLLLLLLKKKK.",
    "KBBBBBBKWWLK",
    "KBBBBBBKWBBK",
    "KBBBBBBKBBBK",
    "KSSSSSSSSSSK",
    ".KGGK..KGGK.",
    "..GG....GG..",
  ],
  palette: { K: "#3D0A4F", L: "#E1A6F5", B: "#AB47BC", S: "#6A1B7A", W: "#80DEEA", G: "#CFD8DC" },
};

/** Unknown waste type sent by Home Assistant. */
const UNKNOWN: Sprite = {
  grid: [
    "...KKKKKK...",
    "..KBBBBBBK..",
    "..KBLLLBBK..",
    "..KBBBLBBK..",
    "..KBBLBBBK..",
    "..KBBBBBBK..",
    "..KBBLBBBK..",
    "...KKKKKK...",
  ],
  palette: { K: "#424242", L: "#FFFFFF", B: "#757575" },
};

export const WASTE: Record<string, Sprite> = {
  menagers: MENAGERS,
  emballages: EMBALLAGES,
  verre: VERRE,
  verts: VERTS,
  encombrants: ENCOMBRANTS,
  unknown: UNKNOWN,
};

// --- Heating page ---

/** Flame flicker frames, 7x9: animations/flame.anim plays them while the boiler is heating. */
export const FLAME_FRAMES: string[][] = [
  [
    "...R...",
    "..RR...",
    "..RRR.R",
    ".RROR.R",
    ".ROORRR",
    "RROYORR",
    "ROYYYOR",
    "ROYWYOR",
    ".RRRRR.",
  ],
  [
    "....R..",
    "...RR..",
    "R..RRR.",
    "R.RORR.",
    "RROORR.",
    "RROYORR",
    "ROYYYOR",
    "ROYWYOR",
    ".RRRRR.",
  ],
  [
    "..R....",
    "..RR..R",
    ".RRR..R",
    ".RORR.R",
    ".ROORRR",
    "RROYYOR",
    "ROYYWOR",
    "ROYWYOR",
    ".RRRRR.",
  ],
  [
    "...R...",
    "...RR..",
    "..RRR..",
    ".RROR.R",
    "RROORRR",
    "RROYORR",
    "ROYYYOR",
    "ROYYWOR",
    ".RRRRR.",
  ],
];

/** Lit flame (heating). */
export const FLAME: Sprite = {
  grid: FLAME_FRAMES[0],
  palette: { R: "#FF3D00", O: "#FF9100", Y: "#FFEA00", W: "#FFFFFF" },
};
/** Thermostat on but not heating right now. */
export const FLAME_IDLE: Sprite = {
  grid: FLAME_FRAMES[0],
  palette: { R: "#7A1D00", O: "#8A4A00", Y: "#8A7F00", W: "#8A8A8A" },
};
/** Thermostat off. */
export const FLAME_OFF: Sprite = {
  grid: FLAME_FRAMES[0],
  palette: { R: "#3C3C3C", O: "#555555", Y: "#6A6A6A", W: "#808080" },
};

/** Sofa, 7x5: living room. */
export const SOFA: Sprite = {
  grid: [
    ".LLLLL.",
    "LBBBBBL",
    "LLLLLLL",
    "LSSSSSL",
    "K.....K",
  ],
  palette: { L: "#4FC3F7", B: "#0288D1", S: "#01579B", K: "#B0BEC5" },
};

/** Bed, 7x5: bedroom (A/C). */
export const BED: Sprite = {
  grid: [
    "K......",
    "KWW....",
    "KWWPPPP",
    "KKKKKKK",
    "K.....K",
  ],
  palette: { K: "#B0BEC5", W: "#FFFFFF", P: "#BA68C8" },
};

/** Degree sign, 2x2. */
export const DEGREE = ["##", "##"];
