import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OutlineEffect } from "three/examples/jsm/effects/OutlineEffect.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AuditoryArt } from "./AuditoryArt";

type AssetState = "loading" | "ready" | "error";
type PunchKind = "left" | "right" | "hook" | "stretch";
type PunchState = {
  kind: PunchKind;
  startedAt: number;
  charge: number;
};
type GamePhase =
  | "loading"
  | "ready"
  | "fighting"
  | "lost"
  | "reveal"
  | "artwork";
type BossAttackKind =
  | "jab"
  | "combo"
  | "hook"
  | "paintShot"
  | "ropeRush"
  | "feint";

type LabActions = {
  startFight: () => void;
  punch: (kind: PunchKind) => void;
  beginStretchCharge: () => void;
  releaseStretchCharge: () => void;
  parry: () => void;
  savePainting: () => void;
  playAgain: () => void;
};

type BossAttack = {
  kind: BossAttackKind;
  startedAt: number;
  impactAt: number;
  recoverAt: number;
  origin: THREE.Vector3;
  target: THREE.Vector3;
  direction: THREE.Vector3;
  hitRadius: number;
  resolved: boolean;
  hitPlayer: boolean;
};

type PaintProjectile = {
  mesh: THREE.Group;
  velocity: THREE.Vector3;
  radius: number;
  expiresAt: number;
  lastTrailAt: number;
  reflected: boolean;
};

type ImpactParticleSlot = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  scale: number;
  color: string;
  expiresAt: number;
  landed: boolean;
};

type CrowdMember = {
  x: number;
  z: number;
  baseY: number;
  facing: number;
  scale: number;
  phase: number;
  speed: number;
  bounce: number;
  cheer: number;
  animated: boolean;
};

const ANIMATIONS: Record<string, string> = {
  Idle: "/assets/optimized/opponent.glb",
  "Lead jab": "/assets/optimized/animations/lead-jab.glb",
  "Punch combo": "/assets/optimized/animations/punch-combo.glb",
  "Heavy hook": "/assets/optimized/animations/heavy-hook.glb",
  Block: "/assets/optimized/animations/block.glb",
  Stunned: "/assets/optimized/animations/stunned.glb",
  Walking: "/assets/optimized/animations/walking.glb",
  Knockout: "/assets/optimized/animations/knockout.glb",
};

const ARM_SEGMENTS = 6;
// Per-segment radial multiplier from shoulder (index 0) to wrist (index 5):
// a soft deltoid taper into a bicep bulge, narrowing through the elbow into
// a tapered forearm, so the arm reads less like a uniform tube.
const ARM_RADIUS_PROFILE = [
  0.96, 1.18, 1.2, 0.94, 0.84, 0.74,
];
const COMIC_WHITE = 0xfffbec;
const COMIC_BLACK = 0x090b16;
const BOSS_MAX_HEALTH = 280;
const BOSS_NAME = "El Chupacabra";
const PLAYER_RADIUS = 0.38;
const BOSS_RADIUS = 0.72;
const ARENA_MIN_X = -6.15;
const ARENA_MAX_X = 6.15;
const ARENA_MIN_Z = -6.15;
const ARENA_MAX_Z = 6.85;
const PAINT_SURFACE_PADDING = 0.45;
const COVERAGE_GRID_SIZE = 8;
const PAINT_LAYER_GRID_SIZE = 64;
const LURE_SAMPLE_COLUMNS = 9;
const LURE_SAMPLE_ROWS = 9;
const PAINT_FLOOR_COLOR = "#b8b5f4";
const PAINT_COLORS = [
  "#14f1ff",
  "#ff2aa1",
  "#ffd02f",
  "#7d5cff",
  "#ff7a1f",
  "#38ff9c",
  "#ff3b3b",
  "#f6f1ff",
  "#1e64ff",
  "#ff5f87",
  "#b7ff2a",
  "#00b8a9",
  "#ff9f1c",
  "#b66dff",
  "#f72585",
  "#43e8d8",
  "#ffe66d",
  "#5637d9",
];
const PAINT_FLOOR_MIN_DISTANCE_SQ = 100 * 100;

function hexToRgb(hex: string) {
  const normalized =
    hex[0] === "#" ? hex.slice(1) : hex;
  const value = parseInt(
    normalized.length === 3
      ? normalized
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : normalized,
    16,
  );
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function colorDistanceSq(a: string, b: string) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const dr = ca.r - cb.r;
  const dg = ca.g - cb.g;
  const db = ca.b - cb.b;
  return dr * dr + dg * dg + db * db;
}

function isNearFloorColor(hex: string) {
  return colorDistanceSq(hex, PAINT_FLOOR_COLOR) < PAINT_FLOOR_MIN_DISTANCE_SQ;
}

function ensureAwayFromFloor(hex: string) {
  if (!isNearFloorColor(hex)) return hex;
  const color = new THREE.Color(hex);
  const floor = new THREE.Color(PAINT_FLOOR_COLOR);
  const hsl = { h: 0, s: 0, l: 0 };
  const floorHsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  floor.getHSL(floorHsl);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    hsl.h = (hsl.h + 0.18 + Math.random() * 0.22) % 1;
    hsl.s = THREE.MathUtils.clamp(Math.max(hsl.s, 0.58) + 0.2, 0.55, 1);
    hsl.l = THREE.MathUtils.clamp(
      hsl.l < floorHsl.l ? hsl.l - 0.1 : hsl.l + 0.14,
      0.22,
      0.72,
    );
    color.setHSL(hsl.h, hsl.s, hsl.l);
    const next = `#${color.getHexString()}`;
    if (!isNearFloorColor(next)) return next;
  }
  return "#ff2aa1";
}

const VISIBLE_PAINT_COLORS = PAINT_COLORS.filter(
  (color) => !isNearFloorColor(color),
);

function jitterHue(hex: string, amount: number) {
  const value = parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  h = (h + (Math.random() - 0.5) * amount * 360 + 360) % 360;
  const color = new THREE.Color();
  color.setHSL(h / 360, THREE.MathUtils.clamp(s, 0, 1), THREE.MathUtils.clamp(l, 0.28, 0.72));
  return ensureAwayFromFloor(`#${color.getHexString()}`);
}

function distancePointToSegment2D(
  point: THREE.Vector3,
  start: THREE.Vector3,
  end: THREE.Vector3,
) {
  const segmentX = end.x - start.x;
  const segmentZ = end.z - start.z;
  const lengthSq = segmentX * segmentX + segmentZ * segmentZ;
  if (lengthSq <= 0.000001) {
    return Math.hypot(point.x - start.x, point.z - start.z);
  }
  const projection = THREE.MathUtils.clamp(
    ((point.x - start.x) * segmentX + (point.z - start.z) * segmentZ) /
      lengthSq,
    0,
    1,
  );
  const closestX = start.x + segmentX * projection;
  const closestZ = start.z + segmentZ * projection;
  return Math.hypot(point.x - closestX, point.z - closestZ);
}

function stripHorizontalRootMotion(clip: THREE.AnimationClip) {
  clip.tracks.forEach((track) => {
    if (
      !track.name.toLowerCase().includes("hips.position") ||
      track.values.length < 3
    ) {
      return;
    }
    const startX = track.values[0];
    const startZ = track.values[2];
    for (let index = 0; index < track.values.length; index += 3) {
      track.values[index] = startX;
      track.values[index + 2] = startZ;
    }
  });
  return clip;
}

function tintGeometry(geometry: THREE.BufferGeometry, color: THREE.Color) {
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let vertex = 0; vertex < count; vertex += 1) {
    colors[vertex * 3] = color.r;
    colors[vertex * 3 + 1] = color.g;
    colors[vertex * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createToonGradient() {
  const bands = new Uint8Array([
    52, 52, 52, 255,
    112, 112, 112, 255,
    190, 190, 190, 255,
    255, 255, 255, 255,
  ]);
  const texture = new THREE.DataTexture(bands, 4, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function createOutlineMaterial(color: number) {
  return new THREE.MeshBasicMaterial({
    color,
    side: THREE.BackSide,
    depthWrite: true,
    toneMapped: false,
  });
}

function addLocalOutline(
  mesh: THREE.Mesh,
  material: THREE.MeshBasicMaterial,
  scale: number,
  name: string,
) {
  const shell = new THREE.Mesh(mesh.geometry, material);
  shell.name = name;
  shell.scale.setScalar(scale);
  shell.castShadow = false;
  shell.receiveShadow = false;
  shell.raycast = () => {};
  mesh.add(shell);
}

function addDualOutline(
  mesh: THREE.Mesh,
  whiteMaterial: THREE.MeshBasicMaterial,
  blackMaterial: THREE.MeshBasicMaterial,
) {
  addLocalOutline(mesh, blackMaterial, 1.16, "ComicOutlineBlack");
  addLocalOutline(mesh, whiteMaterial, 1.075, "ComicOutlineWhite");
}

function makeToonMaterial(
  source: THREE.Material,
  gradientMap: THREE.Texture,
  colorOverride?: number,
  addWhiteRim = false,
) {
  const material = source as THREE.MeshStandardMaterial;
  const color =
    colorOverride === undefined
      ? material.color?.clone() ?? new THREE.Color(0xffffff)
      : new THREE.Color(colorOverride);

  if (colorOverride === undefined && !material.map) {
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    color.setHSL(hsl.h, Math.max(hsl.s, 0.68), Math.max(hsl.l, 0.42));
  }

  const toonMaterial = new THREE.MeshToonMaterial({
    color,
    map: material.map ?? null,
    normalMap: null,
    alphaMap: material.alphaMap ?? null,
    vertexColors: material.vertexColors,
    gradientMap,
    transparent: false,
    opacity: 1,
    side: THREE.FrontSide,
  });

  if (addWhiteRim) {
    toonMaterial.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        `
          float comicFacing = abs(
            dot(normalize(normal), normalize(vViewPosition))
          );
          float comicWhiteRim = smoothstep(0.58, 0.78, 1.0 - comicFacing);
          outgoingLight = mix(
            outgoingLight,
            vec3(1.0, 0.984, 0.925),
            comicWhiteRim * 0.92
          );
          #include <opaque_fragment>
        `,
      );
    };
    toonMaterial.customProgramCacheKey = () => "comic-white-rim-v1";
  }

  return toonMaterial;
}

function ringColorFor(meshName: string, materialName: string, index: number) {
  const label = `${meshName} ${materialName}`.toLowerCase();
  if (label.includes("black")) return COMIC_BLACK;
  if (label.includes("amod") || label.includes("rope")) return 0x14f1ff;
  if (label.includes("material.001")) return 0xff2aa1;
  if (label.includes("ring")) return 0x493bff;
  return [0x8f86ff, 0x14f1ff, 0xff2aa1, 0x3422a8][index % 4];
}

function fighterColorFor(materialName: string, index: number) {
  const label = materialName.toLowerCase();
  if (label.includes("skin") || label.includes("face") || label.includes("head")) {
    return 0xffb47f;
  }
  if (label.includes("hair") || label.includes("shoe")) return 0x17132e;
  if (label.includes("glove")) return 0xff315f;
  return [0x8f5cff, 0x6650e8, 0x14cfe5, 0xff4caf][index % 4];
}

function drawOrganicSplat(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  intensity = 1,
  direction = Math.random() * Math.PI * 2,
) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 0.86;
  context.translate(x, y);

  const lobes = 20 + Math.round(intensity * 7);
  context.beginPath();
  for (let point = 0; point < lobes; point += 1) {
    const angle = (point / lobes) * Math.PI * 2;
    const directionalStretch =
      1 + Math.max(0, Math.cos(angle - direction)) * 0.68 * intensity;
    const wobble = 0.58 + Math.random() * 0.58;
    const distance = radius * wobble * directionalStretch;
    const px = Math.cos(angle) * distance;
    const py = Math.sin(angle) * distance;
    if (point === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
  context.lineJoin = "round";
  context.fillStyle = color;
  context.fill();

  context.globalAlpha = 0.22;
  context.beginPath();
  context.ellipse(
    -radius * 0.12,
    -radius * 0.16,
    radius * 0.58,
    radius * 0.42,
    direction,
    0,
    Math.PI * 2,
  );
  context.fillStyle = "#fff9e8";
  context.fill();

  context.globalAlpha = 0.9;
  const droplets = 13 + Math.round(intensity * 22);
  for (let drop = 0; drop < droplets; drop += 1) {
    const spread = (Math.random() - 0.5) * Math.PI * (1.4 + intensity * 0.35);
    const dropAngle =
      drop < droplets * 0.72
        ? direction + spread
        : Math.random() * Math.PI * 2;
    const distance =
      radius * (0.68 + Math.random() * (1.9 + intensity * 1.15));
    const dropRadius =
      radius * (0.025 + Math.random() * 0.105) * (0.75 + intensity * 0.2);
    context.beginPath();
    context.ellipse(
      Math.cos(dropAngle) * distance,
      Math.sin(dropAngle) * distance,
      dropRadius * (1.1 + Math.random() * 1.7),
      dropRadius,
      dropAngle,
      0,
      Math.PI * 2,
    );
    context.fillStyle = color;
    context.fill();
  }

  context.restore();
}

function drawFlickSplash(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  intensity: number,
  direction: number,
) {
  context.save();
  context.translate(x, y);
  context.rotate(direction);
  context.globalCompositeOperation = "source-over";

  context.globalAlpha = 0.84;
  const flare = 0.75 + intensity * 0.25;
  context.beginPath();
  context.moveTo(radius * 1.1, 0);
  context.quadraticCurveTo(
    radius * 0.4,
    radius * 0.55 * flare,
    -radius * 1.7,
    radius * 0.14,
  );
  context.quadraticCurveTo(-radius * 2.5, 0, -radius * 1.7, -radius * 0.14);
  context.quadraticCurveTo(radius * 0.4, -radius * 0.55 * flare, radius * 1.1, 0);
  context.closePath();
  context.fillStyle = color;
  context.fill();

  context.globalAlpha = 0.9;
  const spikes = 3 + Math.round(intensity * 2.5);
  for (let index = 0; index < spikes; index += 1) {
    const spread = (Math.random() - 0.5) * 0.95;
    const dist = radius * (1.35 + Math.random() * 1.65 * (0.6 + intensity));
    const width = radius * (0.07 + Math.random() * 0.09);
    context.save();
    context.rotate(spread);
    context.beginPath();
    context.moveTo(radius * 0.55, -width);
    context.lineTo(dist, 0);
    context.lineTo(radius * 0.55, width);
    context.closePath();
    context.fillStyle = color;
    context.fill();
    context.restore();
  }
  context.restore();
}

function drawHookCrescent(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  intensity: number,
  direction: number,
) {
  context.save();
  context.translate(x, y);
  context.rotate(direction + Math.PI * 0.5);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 0.84;

  const cappedIntensity = Math.min(intensity, 1.8);
  const sweep = Math.PI * (0.8 + cappedIntensity * 0.1);
  const outer = radius * (0.95 + cappedIntensity * 0.08);
  const inner = radius * 0.4;
  const steps = 22;
  context.beginPath();
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const angle = -sweep / 2 + t * sweep;
    const r = outer * (0.86 + Math.random() * 0.28);
    const px = Math.cos(angle) * r;
    const py = Math.sin(angle) * r;
    if (step === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  for (let step = steps; step >= 0; step -= 1) {
    const t = step / steps;
    const angle = -sweep / 2 + t * sweep;
    const r = inner * (0.65 + Math.random() * 0.5);
    context.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  context.closePath();
  context.fillStyle = color;
  context.fill();

  context.globalAlpha = 0.82;
  const droplets = 10 + Math.round(intensity * 9);
  for (let drop = 0; drop < droplets; drop += 1) {
    const angle = -sweep / 2 + Math.random() * sweep;
    const r = outer * (1 + Math.random() * 0.55);
    const dropRadius = radius * (0.03 + Math.random() * 0.07);
    context.beginPath();
    context.ellipse(
      Math.cos(angle) * r,
      Math.sin(angle) * r,
      dropRadius * 1.5,
      dropRadius,
      angle,
      0,
      Math.PI * 2,
    );
    context.fillStyle = color;
    context.fill();
  }
  context.restore();
}

function drawGoldBurstRing(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
) {
  context.save();
  context.translate(x, y);
  context.globalCompositeOperation = "source-over";

  context.globalAlpha = 0.95;
  context.lineWidth = radius * 0.32;
  context.strokeStyle = color;
  context.beginPath();
  context.arc(0, 0, radius * 0.8, 0, Math.PI * 2);
  context.stroke();

  context.globalAlpha = 0.4;
  context.lineWidth = radius * 0.12;
  context.beginPath();
  context.arc(0, 0, radius * 1.18, 0, Math.PI * 2);
  context.stroke();

  const rays = 11;
  context.globalAlpha = 0.85;
  for (let ray = 0; ray < rays; ray += 1) {
    const angle = (ray / rays) * Math.PI * 2 + Math.random() * 0.14;
    const length = radius * (1.25 + Math.random() * 0.85);
    context.beginPath();
    context.moveTo(Math.cos(angle) * radius * 0.85, Math.sin(angle) * radius * 0.85);
    context.lineTo(Math.cos(angle) * length, Math.sin(angle) * length);
    context.lineWidth = radius * (0.045 + Math.random() * 0.05);
    context.strokeStyle = color;
    context.stroke();
  }
  context.restore();
}

function drawDripStain(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  intensity: number,
  direction: number,
) {
  drawOrganicSplat(context, x, y, radius, color, intensity, direction);
  context.save();
  context.translate(x, y);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 0.82;
  const drips = 4 + Math.round(intensity * 3);
  for (let drip = 0; drip < drips; drip += 1) {
    const dx = (Math.random() - 0.5) * radius * 1.5;
    const startY = radius * (0.15 + Math.random() * 0.25);
    const length = radius * (0.7 + Math.random() * 1.5);
    const width = radius * (0.035 + Math.random() * 0.045);
    context.beginPath();
    context.moveTo(dx - width, startY);
    context.quadraticCurveTo(dx, startY + length * 0.5, dx, startY + length);
    context.quadraticCurveTo(dx, startY + length * 0.5, dx + width, startY);
    context.closePath();
    context.fillStyle = color;
    context.fill();
  }
  context.restore();
}

function drawRayBurst(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
) {
  context.save();
  context.translate(x, y);
  context.globalCompositeOperation = "source-over";
  const rays = 18;
  for (let ray = 0; ray < rays; ray += 1) {
    const angle = (ray / rays) * Math.PI * 2 + Math.random() * 0.16;
    const length = radius * (0.65 + Math.random() * 0.85);
    const baseWidth = radius * (0.22 + Math.random() * 0.12);
    context.globalAlpha = 0.45 + Math.random() * 0.3;
    context.beginPath();
    context.moveTo(
      Math.cos(angle) * radius * 0.28 - Math.sin(angle) * baseWidth,
      Math.sin(angle) * radius * 0.28 + Math.cos(angle) * baseWidth,
    );
    context.lineTo(Math.cos(angle) * length, Math.sin(angle) * length);
    context.lineTo(
      Math.cos(angle) * radius * 0.28 + Math.sin(angle) * baseWidth,
      Math.sin(angle) * radius * 0.28 - Math.cos(angle) * baseWidth,
    );
    context.closePath();
    context.fillStyle = color;
    context.fill();
  }
  context.restore();
}

function drawRibbonLoop(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  direction: number,
) {
  context.save();
  context.translate(x, y);
  context.rotate(direction);
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = color;
  context.lineCap = "round";

  for (let ribbon = 0; ribbon < 3; ribbon += 1) {
    const phase = ribbon * 0.72 + Math.random() * 0.2;
    context.beginPath();
    for (let step = 0; step <= 28; step += 1) {
      const t = step / 28;
      const angle = t * Math.PI * (1.35 + ribbon * 0.14) + phase;
      const taper = Math.sin(t * Math.PI);
      const distance = radius * (0.18 + t * (0.78 + ribbon * 0.12));
      const px = Math.cos(angle) * distance;
      const py = Math.sin(angle) * distance * 0.54;
      if (step === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
      context.lineWidth = Math.max(1.5, radius * 0.12 * taper);
    }
    context.globalAlpha = 0.58 + ribbon * 0.12;
    context.stroke();
  }
  context.restore();
}

function drawLayerStrata(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  underlyingColor: string,
  direction: number,
  depth: number,
) {
  if (depth <= 0) return;
  context.save();
  context.translate(x, y);
  context.rotate(direction);
  context.globalCompositeOperation = "source-over";
  context.lineCap = "round";
  context.strokeStyle = underlyingColor;
  context.setLineDash([
    Math.max(4, radius * 0.14),
    Math.max(5, radius * 0.11),
  ]);

  const bands = Math.min(3, depth);
  for (let band = 0; band < bands; band += 1) {
    context.beginPath();
    context.globalAlpha = 0.5 - band * 0.08;
    context.lineWidth = Math.max(2, radius * (0.07 - band * 0.012));
    context.ellipse(
      0,
      0,
      radius * (0.38 + band * 0.19),
      radius * (0.22 + band * 0.11),
      band * 0.38,
      -Math.PI * 0.78,
      Math.PI * 0.72,
    );
    context.stroke();
  }

  context.setLineDash([]);
  context.globalAlpha = 0.7;
  const chips = 5 + Math.min(10, depth * 3);
  for (let chip = 0; chip < chips; chip += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = radius * (0.16 + Math.random() * 0.62);
    const size = radius * (0.025 + Math.random() * 0.045);
    context.beginPath();
    context.ellipse(
      Math.cos(angle) * distance,
      Math.sin(angle) * distance * 0.68,
      size * (1.4 + Math.random()),
      size,
      angle,
      0,
      Math.PI * 2,
    );
    context.fillStyle = underlyingColor;
    context.fill();
  }
  context.restore();
}

function createPaintCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 768;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("Canvas 2D is unavailable in this browser.");
  }

  context.fillStyle = PAINT_FLOOR_COLOR;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const wash = context.createRadialGradient(384, 384, 32, 384, 384, 520);
  wash.addColorStop(0, "rgba(255, 251, 237, 0.2)");
  wash.addColorStop(0.62, "rgba(125, 92, 255, 0.04)");
  wash.addColorStop(1, "rgba(9, 11, 22, 0.1)");
  context.fillStyle = wash;
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let stain = 0; stain < 10; stain += 1) {
    context.save();
    context.globalAlpha = 0.035 + Math.random() * 0.04;
    context.fillStyle =
      VISIBLE_PAINT_COLORS[stain % VISIBLE_PAINT_COLORS.length];
    context.beginPath();
    context.ellipse(
      Math.random() * canvas.width,
      Math.random() * canvas.height,
      45 + Math.random() * 170,
      18 + Math.random() * 70,
      Math.random() * Math.PI,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
  }

  return { canvas, context };
}

function normalizeModel(
  object: THREE.Object3D,
  targetSize: number,
  dimensions: "height" | "footprint",
) {
  object.updateMatrixWorld(true);
  const initialBox = new THREE.Box3().setFromObject(object);
  const initialSize = initialBox.getSize(new THREE.Vector3());
  const measuredSize =
    dimensions === "height"
      ? initialSize.y
      : Math.max(initialSize.x, initialSize.z);
  const scale = targetSize / Math.max(measuredSize, 0.0001);
  object.scale.multiplyScalar(scale);
  object.updateMatrixWorld(true);

  const finalBox = new THREE.Box3().setFromObject(object);
  const center = finalBox.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= finalBox.min.y;
  object.updateMatrixWorld(true);

  return scale;
}

function createClosedGlove(
  gradientMap: THREE.Texture,
  whiteOutline: THREE.MeshBasicMaterial,
  blackOutline: THREE.MeshBasicMaterial,
) {
  const glove = new THREE.Group();
  const red = new THREE.MeshToonMaterial({
    color: 0xff315f,
    gradientMap,
  });
  const highlight = new THREE.MeshToonMaterial({
    color: 0xff9ab9,
    gradientMap,
  });
  const dark = new THREE.MeshToonMaterial({
    color: 0x21112f,
    gradientMap,
  });

  const fist = new THREE.Mesh(
    new RoundedBoxGeometry(0.29, 0.24, 0.34, 5, 0.065),
    red,
  );
  fist.position.z = -0.08;
  fist.castShadow = true;
  addDualOutline(fist, whiteOutline, blackOutline);
  glove.add(fist);

  const thumb = new THREE.Mesh(
    new THREE.SphereGeometry(0.082, 18, 12),
    red,
  );
  thumb.position.set(0.14, -0.045, 0.01);
  thumb.scale.set(0.82, 1.08, 0.86);
  thumb.castShadow = true;
  addDualOutline(thumb, whiteOutline, blackOutline);
  glove.add(thumb);

  const cuff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.105, 0.125, 0.15, 18, 1, true),
    red,
  );
  cuff.rotation.x = Math.PI * 0.5;
  cuff.position.z = 0.155;
  cuff.castShadow = true;
  addLocalOutline(cuff, blackOutline, 1.13, "ComicOutlineBlack");
  glove.add(cuff);

  const cuffBand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.126, 0.126, 0.045, 18, 1, true),
    dark,
  );
  cuffBand.rotation.x = Math.PI * 0.5;
  cuffBand.position.z = 0.105;
  addLocalOutline(cuffBand, blackOutline, 1.12, "ComicOutlineBlack");
  glove.add(cuffBand);

  const shine = new THREE.Mesh(
    new RoundedBoxGeometry(0.12, 0.025, 0.085, 3, 0.018),
    highlight,
  );
  shine.position.set(-0.055, 0.12, -0.15);
  shine.rotation.z = -0.16;
  glove.add(shine);

  glove.scale.setScalar(0.58);
  return glove;
}

function cloneGlove(prototype: THREE.Group, mirrored = false) {
  const clone = prototype.clone(true);
  clone.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => material.clone())
        : mesh.material.clone();
    }
  });
  if (mirrored) clone.scale.x *= -1;
  return clone;
}

function addPaintPatchesToGlove(glove: THREE.Group, side: -1 | 1) {
  const patches: THREE.Mesh[] = [];
  const patchData = [
    { position: [-0.07, 0.13, -0.24], scale: [0.11, 0.025, 0.075] },
    { position: [0.11, 0.055, -0.21], scale: [0.07, 0.02, 0.105] },
    { position: [-0.13, -0.02, -0.11], scale: [0.055, 0.018, 0.085] },
    { position: [0.025, -0.11, -0.17], scale: [0.12, 0.02, 0.048] },
    { position: [0.09, 0.09, -0.08], scale: [0.055, 0.018, 0.05] },
    { position: [-0.055, 0.03, 0.08], scale: [0.08, 0.018, 0.05] },
  ];

  patchData.forEach((data, index) => {
    const patch = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 7),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(PAINT_COLORS[(index + (side > 0 ? 1 : 0)) % 4]),
        transparent: true,
        opacity: 0.9,
        depthWrite: true,
        toneMapped: false,
      }),
    );
    patch.position.set(
      data.position[0] * side,
      data.position[1],
      data.position[2],
    );
    patch.scale.set(data.scale[0], data.scale[1], data.scale[2]);
    patch.rotation.set(
      Math.random() * 0.35,
      Math.random() * Math.PI,
      Math.random() * 0.5,
    );
    patch.visible = false;
    patch.raycast = () => {};
    glove.add(patch);
    patches.push(patch);
  });

  return patches;
}

function createArm(
  rig: THREE.Group,
  color: number,
  side: -1 | 1,
  placeholderMaterial: THREE.Material,
  gradientMap: THREE.Texture,
  blackOutline: THREE.MeshBasicMaterial,
) {
  const segmentGeometry = new THREE.CylinderGeometry(
    0.042,
    0.047,
    1,
    10,
    1,
    false,
  );
  const segmentMaterial = new THREE.MeshToonMaterial({
    color,
    gradientMap,
  });
  const segments: THREE.Mesh[] = [];
  const joints: THREE.Mesh[] = [];
  const paintPatches: THREE.Mesh[] = [];
  const jointGeometry = new THREE.SphereGeometry(0.045, 10, 8);

  for (let index = 0; index < ARM_SEGMENTS; index += 1) {
    const segment = new THREE.Mesh(segmentGeometry, segmentMaterial);
    segment.castShadow = false;
    addLocalOutline(segment, blackOutline, 1.12, "ComicOutlineBlack");
    const paintPatch = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.049,
        0.054,
        0.52,
        12,
        1,
        true,
        index * 0.91,
        Math.PI * (0.55 + (index % 3) * 0.18),
      ),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(PAINT_COLORS[(index + (side > 0 ? 1 : 0)) % 4]),
        transparent: true,
        opacity: 0.86,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    paintPatch.position.y = (index % 2 === 0 ? -1 : 1) * 0.16;
    paintPatch.visible = false;
    paintPatch.raycast = () => {};
    segment.add(paintPatch);
    paintPatches.push(paintPatch);
    segments.push(segment);
    rig.add(segment);

    const joint = new THREE.Mesh(jointGeometry, segmentMaterial);
    joint.castShadow = false;
    if (index % 2 === 0) {
      addLocalOutline(joint, blackOutline, 1.1, "ComicOutlineBlack");
    }
    joints.push(joint);
    rig.add(joint);
  }

  const gloveAnchor = new THREE.Group();
  const placeholder = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 12, 8),
    placeholderMaterial,
  );
  placeholder.scale.set(1, 0.8, 1.1);
  gloveAnchor.add(placeholder);
  rig.add(gloveAnchor);

  return {
    side,
    segments,
    joints,
    paintPatches,
    gloveAnchor,
    shoulder: new THREE.Vector3(0.34 * side, -0.38, -0.32),
    rest: new THREE.Vector3(0.24 * side, -0.16, -0.95),
    current: new THREE.Vector3(0.24 * side, -0.16, -0.95),
  };
}

export function AssetLab() {
  const mountRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<LabActions | null>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const impactFrameRef = useRef<HTMLDivElement>(null);
  const [loadingMessage, setLoadingMessage] = useState("Preparing renderer");
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [gamePhase, setGamePhase] = useState<GamePhase>("loading");
  const [playerHealth, setPlayerHealth] = useState(100);
  const [bossHealth, setBossHealth] = useState(BOSS_MAX_HEALTH);
  const [bossMaxHealth, setBossMaxHealth] = useState(BOSS_MAX_HEALTH);
  const [stretchCharge, setStretchCharge] = useState(0);
  const [bossTell, setBossTell] = useState("");
  const [combatMessage, setCombatMessage] = useState("");
  const [soundCombo, setSoundCombo] = useState(0);
  const [parryActive, setParryActive] = useState(false);
  const [aimLocked, setAimLocked] = useState(false);
  const [easyMode, setEasyMode] = useState(false);
  const easyModeRef = useRef(false);
  useEffect(() => {
    easyModeRef.current = easyMode;
  }, [easyMode]);
  const [assets, setAssets] = useState<Record<string, AssetState>>({
    ring: "loading",
    glove: "loading",
    boxer: "loading",
  });

  const allAssetsReady = Object.values(assets).every(
    (state) => state === "ready",
  );
  useEffect(() => {
    if (gamePhase === "loading" && allAssetsReady) {
      const frame = window.requestAnimationFrame(() => {
        setGamePhase("ready");
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [allAssetsReady, gamePhase]);

  useEffect(() => {
    if (!mountRef.current) return;

    const mount = mountRef.current;
    let disposed = false;
    const auditoryArt = new AuditoryArt((combo) => {
      if (!disposed) setSoundCombo(combo);
    });
    let animationFrame = 0;
    let mixer: THREE.AnimationMixer | null = null;
    let currentAction: THREE.AnimationAction | null = null;
    let bossModel: THREE.Group | null = null;
    let glovePrototype: THREE.Group | null = null;
    let opponentGlovesAttached = false;
    let baseCharacterScale = 1;
    let arenaSurfaceY = 0.34;
    let bossNeedsGrounding = true;
    let activePunch: PunchState | null = null;
    let pendingPlayerHit:
      | { kind: PunchKind; resolvesAt: number; charge: number }
      | null = null;
    let stretchChargeStartedAt = 0;
    let stretchCharging = false;
    let lastStretchChargeUiAt = 0;
    let phaseValue: GamePhase = "loading";
    let playerHealthValue = 100;
    let bossHealthValue = BOSS_MAX_HEALTH;
    let bossMaxHealthValue = BOSS_MAX_HEALTH;
    let paintLoadValue = 0;
    let nextPlayerPunchAt = 0;
    let nextBossAttackAt = Number.POSITIVE_INFINITY;
    let bossAttack: BossAttack | null = null;
    let currentAnimationName = "";
    let nextBossStrafeAt = 0;
    let bossStrafeDirection: -1 | 1 = 1;
    const bossVelocity = new THREE.Vector3();
    let lureTarget: THREE.Vector3 | null = null;
    let previousLureTarget: THREE.Vector3 | null = null;
    let lureTargetChosenAt = 0;
    let lureCommitUntil = 0;
    let nextLureEvaluationAt = 0;
    let nextRopeRushAt = Number.POSITIVE_INFINITY;
    let cameraYaw = 0;
    let cameraPitch = 0;
    let parryStartedAt = 0;
    let parryUntil = 0;
    let parryReadyAt = 0;
    let sidestepReadyAt = 0;
    let sidestepUntil = 0;
    let lastPlayerMoveAt = 0;
    let recentAttackKinds: BossAttackKind[] = [];
    let recentParryAttempts: number[] = [];
    let forcedNextAttack: BossAttackKind | null = null;
    let revealStartedAt = 0;
    let revealStartPosition = new THREE.Vector3();
    let revealFinished = false;
    let revealWon = true;
    let easyModeActive = false;
    let finisherFreezeUntil = 0;
    let finisherFlightStarted = false;
    let finisherFlightLastAt = 0;
    let lastFinisherPaintAt = 0;
    let lastFinisherPaintPoint: THREE.Vector2 | null = null;
    const finisherVelocity = new THREE.Vector3();
    let finisherPaintColor = VISIBLE_PAINT_COLORS[1];
    let lastMovementPaintAt = 0;
    let lastMovementPoint: THREE.Vector2 | null = null;
    let lastMovementWorld: THREE.Vector3 | null = null;
    let lastBossPaintAt = 0;
    let lastBossPaintPoint: THREE.Vector2 | null = null;
    let jabSide: -1 | 1 = -1;
    let combatMessageUntil = 0;
    let hitStopUntil = 0;
    let cameraShake = 0;
    let fovKick = 0;
    let impactRoll = 0;
    let bossImpactStartedAt = 0;
    let bossImpactUntil = 0;
    let bossImpactStrength = 0;
    let paintEventCounter = 0;
    let movementPaintColor = VISIBLE_PAINT_COLORS[0];
    const paintedCells = new Set<string>();
    const paintLayerDepth = new Uint8Array(
      PAINT_LAYER_GRID_SIZE * PAINT_LAYER_GRID_SIZE,
    );
    const projectiles: PaintProjectile[] = [];
    const pressedKeys = new Set<string>();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const clipCache = new Map<string, THREE.AnimationClip>();
    const clock = new THREE.Clock();
    const gltfLoader = new GLTFLoader();
    const scene = new THREE.Scene();
    const toonGradient = createToonGradient();
    const whiteOutline = createOutlineMaterial(COMIC_WHITE);
    const blackOutline = createOutlineMaterial(COMIC_BLACK);
    scene.background = new THREE.Color(0x070913);
    scene.fog = new THREE.FogExp2(0x070913, 0.027);

    const camera = new THREE.PerspectiveCamera(
      47,
      mount.clientWidth / mount.clientHeight,
      0.03,
      120,
    );
    camera.position.set(0, 2.25, 6.6);
    scene.add(camera);

    let lastAppliedFov = camera.fov;
    const moveInput = new THREE.Vector2();
    const moveForward = new THREE.Vector3();
    const moveRight = new THREE.Vector3();
    const moveDelta = new THREE.Vector3();
    const cameraShakeOffset = new THREE.Vector3();
    const unitScaleOne = new THREE.Vector3(1, 1, 1);
    let bossGroundOffset = Number.NaN;

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
    });
    const isCompactViewport = mount.clientWidth < 720;
    const renderPixelRatio = Math.min(
      window.devicePixelRatio || 1,
      isCompactViewport ? 1 : 1.15,
    );
    renderer.setPixelRatio(renderPixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    mount.appendChild(renderer.domElement);
    const outlineEffect = new OutlineEffect(renderer, {
      defaultThickness: 0.008,
      defaultColor: [0.035, 0.043, 0.086],
      defaultAlpha: 1,
      defaultKeepAlive: true,
    });

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.1, 0);
    controls.enableDamping = true;
    controls.minDistance = 3.8;
    controls.maxDistance = 13;
    controls.maxPolarAngle = Math.PI * 0.48;

    scene.add(new THREE.HemisphereLight(0xe8f5ff, 0x251248, 1.75));

    const keyLight = new THREE.SpotLight(
      0xfff2d6,
      34,
      28,
      Math.PI / 5,
      0.35,
      1,
    );
    keyLight.position.set(3.5, 8.5, 4);
    keyLight.target.position.set(0, 0, 0);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(256, 256);
    keyLight.shadow.bias = -0.001;
    scene.add(keyLight, keyLight.target);

    const cyanLight = new THREE.PointLight(0x14f1ff, 9, 9, 2);
    cyanLight.position.set(-4, 2.5, 1.5);
    scene.add(cyanLight);

    const magentaLight = new THREE.PointLight(0xff2aa1, 8, 8, 2);
    magentaLight.position.set(4, 2.2, -2);
    scene.add(magentaLight);

    const crowdGroup = new THREE.Group();
    crowdGroup.name = "ArenaCrowd";
    const crowdMembers: CrowdMember[] = [];
    const addCrowdBank = (
      bank: "back" | "left" | "right",
      rows: number,
      columns: number,
    ) => {
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const across =
            columns === 1 ? 0 : column / (columns - 1) - 0.5;
          const isBack = bank === "back";
          const x = isBack
            ? across * 20.4 + (Math.random() - 0.5) * 0.25
            : (bank === "left" ? -1 : 1) *
              (11.1 + row * 0.82 + Math.random() * 0.14);
          const z = isBack
            ? -11.35 - row * 0.86 + (Math.random() - 0.5) * 0.18
            : across * 15.2 - 0.3 + (Math.random() - 0.5) * 0.24;
          const facing = Math.atan2(-x, -z);
          crowdMembers.push({
            x,
            z,
            baseY: 0.48 + row * 0.46,
            facing,
            scale: 0.82 + Math.random() * 0.32,
            phase: Math.random() * Math.PI * 2,
            speed: 1.35 + Math.random() * 1.45,
            bounce: 0.035 + Math.random() * 0.075,
            cheer: Math.random(),
            animated: row === 0,
          });
        }
      }
    };
    addCrowdBank("back", 3, 14);
    addCrowdBank("left", 2, 8);
    addCrowdBank("right", 2, 8);

    const crowdBodyGeometry = new THREE.BoxGeometry(0.42, 0.72, 0.25);
    const crowdHeadGeometry = new THREE.SphereGeometry(0.21, 8, 6);
    const crowdArmGeometry = new THREE.CylinderGeometry(0.05, 0.065, 0.62, 5);
    const crowdLegGeometry = new THREE.CylinderGeometry(0.065, 0.075, 0.58, 5);
    const crowdHairGeometry = new THREE.SphereGeometry(0.218, 7, 5);
    const crowdBodyMaterial = new THREE.MeshToonMaterial({
      color: 0xffffff,
      gradientMap: toonGradient,
    });
    const crowdSkinMaterial = new THREE.MeshToonMaterial({
      color: 0xffffff,
      gradientMap: toonGradient,
    });
    const crowdArmMaterial = new THREE.MeshToonMaterial({
      color: 0xffffff,
      gradientMap: toonGradient,
    });
    const crowdLegMaterial = new THREE.MeshToonMaterial({
      color: 0xffffff,
      gradientMap: toonGradient,
    });
    const crowdHairMaterial = new THREE.MeshToonMaterial({
      color: 0xffffff,
      gradientMap: toonGradient,
    });
    const crowdBodies = new THREE.InstancedMesh(
      crowdBodyGeometry,
      crowdBodyMaterial,
      crowdMembers.length,
    );
    const crowdHeads = new THREE.InstancedMesh(
      crowdHeadGeometry,
      crowdSkinMaterial,
      crowdMembers.length,
    );
    const crowdLeftArms = new THREE.InstancedMesh(
      crowdArmGeometry,
      crowdArmMaterial,
      crowdMembers.length,
    );
    const crowdRightArms = new THREE.InstancedMesh(
      crowdArmGeometry,
      crowdArmMaterial,
      crowdMembers.length,
    );
    const crowdLeftLegs = new THREE.InstancedMesh(
      crowdLegGeometry,
      crowdLegMaterial,
      crowdMembers.length,
    );
    const crowdRightLegs = new THREE.InstancedMesh(
      crowdLegGeometry,
      crowdLegMaterial,
      crowdMembers.length,
    );
    const crowdHair = new THREE.InstancedMesh(
      crowdHairGeometry,
      crowdHairMaterial,
      crowdMembers.length,
    );
    const crowdMeshes = [
      crowdBodies,
      crowdHeads,
      crowdLeftArms,
      crowdRightArms,
      crowdLeftLegs,
      crowdRightLegs,
      crowdHair,
    ];
    const animatedCrowdMeshes = [
      crowdBodies,
      crowdHeads,
      crowdLeftArms,
      crowdRightArms,
    ];
    const staticCrowdMeshes = [
      crowdLeftLegs,
      crowdRightLegs,
      crowdHair,
    ];
    crowdMeshes.forEach((mesh) => {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      mesh.material.userData.outlineParameters = { visible: false };
      crowdGroup.add(mesh);
    });

    const shirtColors = [
      0x14f1ff,
      0xff2aa1,
      0xffd02f,
      0x7d5cff,
      0xff5f87,
      0x38ff9c,
      0xf6f1ff,
      0xff7a1f,
    ];
    const skinColors = [
      0x5a321f,
      0x7a452b,
      0xa76846,
      0xc98c68,
      0xe3b08c,
      0xf1c9a5,
    ];
    const trouserColors = [0x101325, 0x201c42, 0x303846, 0x4d255c, 0x172f3a];
    const hairColors = [0x090b16, 0x26150f, 0x4a2b19, 0x7d4d2a, 0xd0a063];
    crowdMembers.forEach((member, index) => {
      crowdBodies.setColorAt(
        index,
        new THREE.Color(shirtColors[index % shirtColors.length]),
      );
      const skin = new THREE.Color(
        skinColors[(index * 5 + Math.floor(member.phase * 10)) % skinColors.length],
      );
      crowdHeads.setColorAt(index, skin);
      crowdLeftArms.setColorAt(index, skin);
      crowdRightArms.setColorAt(index, skin);
      const trousers = new THREE.Color(
        trouserColors[(index * 3) % trouserColors.length],
      );
      crowdLeftLegs.setColorAt(index, trousers);
      crowdRightLegs.setColorAt(index, trousers);
      crowdHair.setColorAt(
        index,
        new THREE.Color(hairColors[(index * 7) % hairColors.length]),
      );
    });
    crowdBodies.instanceColor!.needsUpdate = true;
    crowdHeads.instanceColor!.needsUpdate = true;
    crowdLeftArms.instanceColor!.needsUpdate = true;
    crowdRightArms.instanceColor!.needsUpdate = true;
    crowdLeftLegs.instanceColor!.needsUpdate = true;
    crowdRightLegs.instanceColor!.needsUpdate = true;
    crowdHair.instanceColor!.needsUpdate = true;

    // Tiered bleacher risers + seat treads are built as raw geometry and
    // merged into two meshes total (instead of one mesh per row) so a much
    // more detailed, stepped stadium silhouette costs the same two draw
    // calls as the old flat single-box-per-row stands did in aggregate.
    const riserColor = new THREE.Color(0x14121f);
    const seatBandColors = [0x1a2038, 0x241a3a, 0x1a2038, 0x1a2f3c, 0x241a3a];
    const riserGeometries: THREE.BufferGeometry[] = [];
    const treadGeometries: THREE.BufferGeometry[] = [];

    const addBleacherRow = (
      width: number,
      depth: number,
      height: number,
      center: THREE.Vector3,
      seatColor: THREE.Color,
    ) => {
      const riser = tintGeometry(
        new THREE.BoxGeometry(width, height, depth),
        riserColor,
      );
      riser.translate(center.x, center.y, center.z);
      riserGeometries.push(riser);

      const tread = tintGeometry(
        new THREE.BoxGeometry(width, 0.07, depth + 0.14),
        seatColor,
      );
      tread.translate(center.x, center.y + height / 2 + 0.035, center.z);
      treadGeometries.push(tread);
    };

    for (let row = 0; row < 5; row += 1) {
      const height = 0.4 + row * 0.06;
      addBleacherRow(
        22.4,
        0.9,
        height,
        new THREE.Vector3(0, 0.26 + row * 0.45, -11.35 - row * 0.86),
        new THREE.Color(seatBandColors[row % seatBandColors.length]),
      );
    }
    ([-1, 1] as const).forEach((side) => {
      for (let row = 0; row < 4; row += 1) {
        const height = 0.4 + row * 0.06;
        addBleacherRow(
          0.9,
          16.4,
          height,
          new THREE.Vector3(side * (11.1 + row * 0.82), 0.26 + row * 0.45, -0.3),
          new THREE.Color(seatBandColors[row % seatBandColors.length]),
        );
      }
    });

    // Ringside barricade: a solid kickboard wall with an ad-board accent
    // stripe, sitting in the gap between the ring and the first bleacher row.
    const barricadeHeight = 0.78;
    const addBarricadeSegment = (
      width: number,
      depth: number,
      center: THREE.Vector3,
      stripeColor: number,
    ) => {
      const wall = tintGeometry(
        new THREE.BoxGeometry(width, barricadeHeight, depth),
        riserColor,
      );
      wall.translate(center.x, barricadeHeight / 2, center.z);
      riserGeometries.push(wall);

      const stripe = tintGeometry(
        new THREE.BoxGeometry(width, 0.17, depth + 0.02),
        new THREE.Color(stripeColor),
      );
      stripe.translate(center.x, barricadeHeight * 0.6, center.z);
      riserGeometries.push(stripe);
    };
    addBarricadeSegment(17.5, 0.16, new THREE.Vector3(0, 0, -8.5), 0xff2aa1);
    ([-1, 1] as const).forEach((side) => {
      addBarricadeSegment(
        0.16,
        12.6,
        new THREE.Vector3(side * 7.9, 0, -0.3),
        0x14f1ff,
      );
    });

    const standMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: toonGradient,
    });
    standMaterial.userData.outlineParameters = { visible: false };
    const seatMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: toonGradient,
    });
    seatMaterial.userData.outlineParameters = { visible: false };

    const riserMesh = new THREE.Mesh(
      mergeGeometries(riserGeometries),
      standMaterial,
    );
    riserMesh.receiveShadow = true;
    crowdGroup.add(riserMesh);

    const treadMesh = new THREE.Mesh(
      mergeGeometries(treadGeometries),
      seatMaterial,
    );
    treadMesh.receiveShadow = true;
    crowdGroup.add(treadMesh);

    const railMaterial = new THREE.MeshBasicMaterial({
      color: COMIC_WHITE,
      toneMapped: false,
    });
    railMaterial.userData.outlineParameters = { visible: false };
    const backRail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 22.8, 8),
      railMaterial,
    );
    backRail.rotation.z = Math.PI * 0.5;
    backRail.position.set(0, 1.32, -10.86);
    crowdGroup.add(backRail);
    ([-1, 1] as const).forEach((side) => {
      const sideRail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 16.8, 8),
        railMaterial,
      );
      sideRail.rotation.x = Math.PI * 0.5;
      sideRail.position.set(side * 10.62, 1.32, -0.3);
      crowdGroup.add(sideRail);
    });

    const barricadeRailMaterial = new THREE.MeshBasicMaterial({
      color: 0x0a0a0a,
      toneMapped: false,
    });
    barricadeRailMaterial.userData.outlineParameters = { visible: false };
    const barricadeRail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 17.5, 6),
      barricadeRailMaterial,
    );
    barricadeRail.rotation.z = Math.PI * 0.5;
    barricadeRail.position.set(0, barricadeHeight + 0.16, -8.5);
    crowdGroup.add(barricadeRail);
    ([-1, 1] as const).forEach((side) => {
      const sideBarricadeRail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 12.6, 6),
        barricadeRailMaterial,
      );
      sideBarricadeRail.rotation.x = Math.PI * 0.5;
      sideBarricadeRail.position.set(side * 7.9, barricadeHeight + 0.16, -0.3);
      crowdGroup.add(sideBarricadeRail);
    });

    scene.add(crowdGroup);

    const crowdDummy = new THREE.Object3D();
    const setCrowdMatrix = (
      mesh: THREE.InstancedMesh,
      index: number,
      member: CrowdMember,
      localX: number,
      localY: number,
      localZ: number,
      yRotation: number,
      zRotation: number,
      scale: number,
    ) => {
      const cos = Math.cos(member.facing);
      const sin = Math.sin(member.facing);
      crowdDummy.position.set(
        member.x + localX * cos + localZ * sin,
        member.baseY + localY,
        member.z - localX * sin + localZ * cos,
      );
      crowdDummy.rotation.order = "YXZ";
      crowdDummy.rotation.set(0, yRotation, zRotation);
      crowdDummy.scale.setScalar(scale);
      crowdDummy.updateMatrix();
      mesh.setMatrixAt(index, crowdDummy.matrix);
    };

    const applyBodyHeadArms = (
      member: CrowdMember,
      index: number,
      wave: number,
      secondary: number,
      excitement: number,
    ) => {
      const bounce =
        Math.max(0, wave) * member.bounce * excitement +
        secondary * member.bounce * 0.18;
      const scale = member.scale;
      const cheerLift =
        member.cheer > 0.58
          ? 0.55 + Math.max(0, wave) * 0.6 * excitement
          : 0.2 + Math.max(0, secondary) * 0.28;
      setCrowdMatrix(
        crowdBodies,
        index,
        member,
        0,
        0.94 * scale + bounce,
        0,
        member.facing,
        secondary * 0.035,
        scale,
      );
      setCrowdMatrix(
        crowdHeads,
        index,
        member,
        0,
        1.47 * scale + bounce * 1.12,
        0,
        member.facing,
        wave * 0.025,
        scale,
      );
      setCrowdMatrix(
        crowdLeftArms,
        index,
        member,
        -0.29 * scale,
        (0.98 + cheerLift * 0.18) * scale + bounce,
        0,
        member.facing,
        -0.42 - cheerLift,
        scale,
      );
      setCrowdMatrix(
        crowdRightArms,
        index,
        member,
        0.29 * scale,
        (0.98 + cheerLift * 0.18) * scale + bounce,
        0,
        member.facing,
        0.42 + cheerLift,
        scale,
      );
    };

    let crowdStaticInitialized = false;
    let lastCrowdUpdateAt = Number.NEGATIVE_INFINITY;
    const updateCrowd = (now: number) => {
      const updateInterval = phaseValue === "reveal" ? 50 : 100;
      if (now - lastCrowdUpdateAt < updateInterval) return;
      lastCrowdUpdateAt = now;
      const time = now * 0.001;
      const excitement =
        phaseValue === "reveal"
          ? 1.75
          : phaseValue === "fighting"
            ? 1.15
            : 0.78;
      // Only the front row of each bank ("near") is animated every tick —
      // the deeper rows are barely legible from ring level, so they're
      // posed once and left static to keep the per-tick crowd cost small.
      crowdMembers.forEach((member, index) => {
        const scale = member.scale;
        if (member.animated) {
          const wave = Math.sin(time * member.speed + member.phase);
          const secondary = Math.sin(
            time * (member.speed * 0.47) + member.phase * 2,
          );
          applyBodyHeadArms(member, index, wave, secondary, excitement);
        } else if (!crowdStaticInitialized) {
          applyBodyHeadArms(member, index, 0, 0, excitement);
        }
        if (!crowdStaticInitialized) {
          setCrowdMatrix(
            crowdHair,
            index,
            member,
            0,
            1.61 * scale,
            -0.015,
            member.facing,
            0,
            scale * 0.72,
          );
          setCrowdMatrix(
            crowdLeftLegs,
            index,
            member,
            -0.12 * scale,
            0.34 * scale,
            0,
            member.facing,
            0,
            scale,
          );
          setCrowdMatrix(
            crowdRightLegs,
            index,
            member,
            0.12 * scale,
            0.34 * scale,
            0,
            member.facing,
            0,
            scale,
          );
        }
      });
      animatedCrowdMeshes.forEach((mesh) => {
        mesh.instanceMatrix.needsUpdate = true;
      });
      if (!crowdStaticInitialized) {
        staticCrowdMeshes.forEach((mesh) => {
          mesh.instanceMatrix.needsUpdate = true;
        });
        crowdStaticInitialized = true;
      }
    };

    const shadowFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(38, 38),
      new THREE.MeshToonMaterial({
        color: COMIC_BLACK,
        gradientMap: toonGradient,
      }),
    );
    shadowFloor.rotation.x = -Math.PI / 2;
    shadowFloor.position.y = -0.03;
    shadowFloor.receiveShadow = true;
    shadowFloor.material.userData.outlineParameters = { visible: false };
    scene.add(shadowFloor);

    const paint = createPaintCanvas();
    const paintTexture = new THREE.CanvasTexture(paint.canvas);
    let paintTextureDirty = false;
    const markPaintTextureDirty = () => {
      paintTextureDirty = true;
    };
    paintTexture.colorSpace = THREE.SRGBColorSpace;
    paintTexture.anisotropy = Math.min(
      2,
      renderer.capabilities.getMaxAnisotropy(),
    );

    const paintPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: paintTexture,
        depthWrite: true,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    paintPlane.userData.outlineParameters = { visible: false };
    paintPlane.rotation.x = -Math.PI / 2;
    paintPlane.position.set(
      (ARENA_MIN_X + ARENA_MAX_X) * 0.5,
      arenaSurfaceY + 0.018,
      (ARENA_MIN_Z + ARENA_MAX_Z) * 0.5,
    );
    paintPlane.scale.set(
      ARENA_MAX_X - ARENA_MIN_X + PAINT_SURFACE_PADDING * 2,
      ARENA_MAX_Z - ARENA_MIN_Z + PAINT_SURFACE_PADDING * 2,
      1,
    );
    paintPlane.receiveShadow = true;
    paintPlane.renderOrder = 4;
    scene.add(paintPlane);

    const attackMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.78, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffd02f,
        transparent: true,
        opacity: 0.58,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    attackMarker.rotation.x = -Math.PI / 2;
    attackMarker.position.y = arenaSurfaceY + 0.055;
    attackMarker.visible = false;
    attackMarker.renderOrder = 8;
    scene.add(attackMarker);

    const chargeLane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xff2aa1,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    chargeLane.rotation.x = -Math.PI / 2;
    chargeLane.position.y = arenaSurfaceY + 0.045;
    chargeLane.visible = false;
    chargeLane.renderOrder = 7;
    scene.add(chargeLane);

    const handlerGroup = new THREE.Group();
    handlerGroup.name = "RingsideHandler";
    const handlerPurple = new THREE.MeshToonMaterial({
      color: 0x493bff,
      gradientMap: toonGradient,
    });
    const handlerGold = new THREE.MeshToonMaterial({
      color: 0xffd02f,
      gradientMap: toonGradient,
    });
    const handlerSkin = new THREE.MeshToonMaterial({
      color: 0xffb47f,
      gradientMap: toonGradient,
    });
    const handlerBody = new THREE.Mesh(
      new RoundedBoxGeometry(0.42, 0.72, 0.28, 3, 0.08),
      handlerPurple,
    );
    handlerBody.position.y = 0.87;
    const handlerHead = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 16, 10),
      handlerSkin,
    );
    handlerHead.position.y = 1.4;
    const handlerHat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.19, 0.2, 14),
      handlerGold,
    );
    handlerHat.position.y = 1.62;
    const handlerLeftArm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.065, 0.065, 0.72, 10),
      handlerSkin,
    );
    const handlerRightArm = handlerLeftArm.clone();
    handlerLeftArm.position.set(-0.34, 0.98, 0);
    handlerRightArm.position.set(0.34, 0.98, 0);
    handlerLeftArm.rotation.z = -0.72;
    handlerRightArm.rotation.z = 0.72;
    const handlerLeftLeg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 0.65, 10),
      handlerPurple,
    );
    const handlerRightLeg = handlerLeftLeg.clone();
    handlerLeftLeg.position.set(-0.13, 0.34, 0);
    handlerRightLeg.position.set(0.13, 0.34, 0);
    [
      handlerBody,
      handlerHead,
      handlerHat,
      handlerLeftArm,
      handlerRightArm,
      handlerLeftLeg,
      handlerRightLeg,
    ].forEach((part) => {
      part.castShadow = true;
      addLocalOutline(part, blackOutline, 1.08, "ComicOutlineBlack");
      handlerGroup.add(part);
    });
    handlerGroup.position.set(-3, arenaSurfaceY, -4.3);
    scene.add(handlerGroup);

    const puppetLines = [-0.22, 0.22].map((offset) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        new THREE.Vector3(),
      ]);
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
          color: offset < 0 ? 0x14f1ff : 0xff2aa1,
          transparent: true,
          opacity: 0.24,
          toneMapped: false,
        }),
      );
      line.visible = false;
      scene.add(line);
      return line;
    });

    const firstPersonRig = new THREE.Group();
    camera.add(firstPersonRig);
    const leftArm = createArm(
      firstPersonRig,
      0xd39a74,
      -1,
      new THREE.MeshToonMaterial({
        color: 0x14f1ff,
        gradientMap: toonGradient,
      }),
      toonGradient,
      blackOutline,
    );
    const rightArm = createArm(
      firstPersonRig,
      0xd39a74,
      1,
      new THREE.MeshToonMaterial({
        color: 0xff2aa1,
        gradientMap: toonGradient,
      }),
      toonGradient,
      blackOutline,
    );
    const playerPaintPatches: THREE.Mesh[] = [
      ...leftArm.paintPatches,
      ...rightArm.paintPatches,
    ];

    const updateArm = (
      arm: ReturnType<typeof createArm>,
      punch: PunchState | null,
      now: number,
    ) => {
      const isThisArm =
        punch &&
        (punch.kind === "stretch" ||
          (punch.kind === "left" && arm.side === -1) ||
          (punch.kind === "right" && arm.side === 1) ||
          (punch.kind === "hook" && arm.side === 1));
      const isHook = Boolean(
        punch?.kind === "hook" && arm.side === 1 && isThisArm,
      );
      const duration =
        punch?.kind === "stretch"
          ? 620 + punch.charge * 180
          : punch?.kind === "hook"
            ? 620
            : 340;
      const elapsed = punch ? now - punch.startedAt : duration;
      const normalized = THREE.MathUtils.clamp(elapsed / duration, 0, 1);
      const target = arm.rest.clone();
      let extension = 0;
      if (isThisArm && !isHook && normalized < 1) {
        const strike = Math.sin(normalized * Math.PI);
        extension =
          strike *
          (punch?.kind === "stretch"
            ? 2.7 + punch.charge * 2.45
            : 1.08);
        target.z -= extension;
        target.y += strike * 0.12;
        if (punch?.kind === "stretch") target.x *= 0.62;
      }

      if (isHook && normalized < 1) {
        const windupTarget = new THREE.Vector3(0.93, 0.02, -0.58);
        const contactTarget = new THREE.Vector3(-0.2, -0.05, -1.58);
        if (normalized < 0.24) {
          const windup = THREE.MathUtils.smoothstep(normalized / 0.24, 0, 1);
          target.lerpVectors(arm.rest, windupTarget, windup);
        } else if (normalized < 0.58) {
          const drive = THREE.MathUtils.smoothstep(
            (normalized - 0.24) / 0.34,
            0,
            1,
          );
          target.lerpVectors(windupTarget, contactTarget, drive);
          target.y += Math.sin(drive * Math.PI) * 0.18;
        } else {
          const recovery = THREE.MathUtils.smoothstep(
            (normalized - 0.58) / 0.42,
            0,
            1,
          );
          target.lerpVectors(contactTarget, arm.rest, recovery);
        }
      }

      arm.current.lerp(target, isThisArm ? (isHook ? 0.56 : 0.42) : 0.18);
      arm.gloveAnchor.position.copy(arm.current);
      if (isHook) {
        const drive = THREE.MathUtils.clamp((normalized - 0.18) / 0.5, 0, 1);
        const followThrough = Math.sin(drive * Math.PI);
        arm.gloveAnchor.rotation.z = -0.32 - followThrough * 0.72;
        arm.gloveAnchor.rotation.y = -0.75 + drive * 1.55;
        arm.gloveAnchor.rotation.x = followThrough * 0.36;
      } else {
        arm.gloveAnchor.rotation.x = THREE.MathUtils.lerp(
          arm.gloveAnchor.rotation.x,
          0,
          0.24,
        );
        arm.gloveAnchor.rotation.y = THREE.MathUtils.lerp(
          arm.gloveAnchor.rotation.y,
          0,
          0.24,
        );
        arm.gloveAnchor.rotation.z = THREE.MathUtils.lerp(
          arm.gloveAnchor.rotation.z,
          0,
          0.24,
        );
      }

      const controlA = arm.shoulder
        .clone()
        .add(new THREE.Vector3(0.04 * arm.side, -0.03, -0.26));
      const controlB = arm.current
        .clone()
        .add(new THREE.Vector3(0.1 * arm.side, -0.08, 0.28 + extension * 0.06));
      if (isHook) {
        const drive = THREE.MathUtils.clamp((normalized - 0.16) / 0.5, 0, 1);
        const arc = Math.sin(drive * Math.PI);
        controlA.x += 0.72 * (0.5 + arc);
        controlA.z += 0.24 * arc;
        controlB.x += 0.48 * (1 - drive) - 0.22 * drive;
        controlB.y += 0.2 * arc;
        controlB.z += 0.34 * arc;
      }
      const curve = new THREE.CubicBezierCurve3(
        arm.shoulder,
        controlA,
        controlB,
        arm.current,
      );
      const up = new THREE.Vector3(0, 1, 0);

      arm.segments.forEach((segment, index) => {
        const start = curve.getPoint(index / ARM_SEGMENTS);
        const end = curve.getPoint((index + 1) / ARM_SEGMENTS);
        const direction = end.clone().sub(start);
        const length = direction.length();
        segment.position.copy(start).add(end).multiplyScalar(0.5);
        segment.quaternion.setFromUnitVectors(up, direction.normalize());
        const pulse =
          punch?.kind === "stretch" && isThisArm
            ? 1 + Math.sin(index * 0.9 + now * 0.012) * 0.08
            : 1;
        const armRadius = pulse * (ARM_RADIUS_PROFILE[index] ?? 1);
        segment.scale.set(armRadius, length * 1.04, armRadius);
        arm.joints[index].position.copy(end);
        arm.joints[index].scale.setScalar(armRadius);
      });
    };

    const attachOpponentGloves = () => {
      if (
        !bossModel ||
        !glovePrototype ||
        opponentGlovesAttached ||
        baseCharacterScale <= 0
      ) {
        return;
      }

      let rightHand: THREE.Bone | null = null;
      let leftHand: THREE.Bone | null = null;
      bossModel.traverse((child) => {
        if (!(child as THREE.Bone).isBone) return;
        const compactName = child.name.toLowerCase().replace(/[^a-z]/g, "");
        if (compactName.endsWith("righthand")) rightHand = child as THREE.Bone;
        if (compactName.endsWith("lefthand")) leftHand = child as THREE.Bone;
      });

      const attach = (
        bone: THREE.Bone | null,
        mirrored: boolean,
        rotation: number,
      ) => {
        if (!bone || !glovePrototype) return;
        const glove = cloneGlove(glovePrototype, mirrored);
        glove.name = mirrored ? "OpponentLeftGlove" : "OpponentRightGlove";
        glove.scale.multiplyScalar(1 / baseCharacterScale);
        glove.rotation.set(-Math.PI * 0.5, 0, rotation);
        bone.add(glove);
      };

      attach(rightHand, false, -Math.PI * 0.5);
      attach(leftHand, true, Math.PI * 0.5);
      opponentGlovesAttached = Boolean(rightHand || leftHand);
    };

    const setPlayerGloves = () => {
      if (!glovePrototype) return;
      const apply = (
        arm: ReturnType<typeof createArm>,
        mirrored: boolean,
        rotation: number,
      ) => {
        arm.gloveAnchor.clear();
        const glove = cloneGlove(glovePrototype as THREE.Group, mirrored);
        glove.rotation.set(0, rotation, mirrored ? -0.08 : 0.08);
        glove.position.z = -0.1;
        playerPaintPatches.push(
          ...addPaintPatchesToGlove(glove, mirrored ? -1 : 1),
        );
        arm.gloveAnchor.add(glove);
      };

      apply(leftArm, true, -0.1);
      apply(rightArm, false, 0.1);
      updatePaintLoadVisuals();
    };

    const updatePaintLoadVisuals = () => {
      const baseStains = Math.min(6, playerPaintPatches.length);
      const visibleCount =
        baseStains +
        Math.round(
          (playerPaintPatches.length - baseStains) * (paintLoadValue / 100),
        );
      playerPaintPatches.forEach((patch, index) => {
        patch.visible =
          ((index * 7) % Math.max(1, playerPaintPatches.length)) < visibleCount;
      });
    };

    const playClip = (clip: THREE.AnimationClip) => {
      if (!mixer) return;
      if (currentAnimationName === clip.name && currentAction?.isRunning()) {
        return;
      }
      const nextAction = mixer.clipAction(clip);
      nextAction.reset();
      nextAction.setEffectiveWeight(1);
      const timeScale =
        clip.name === "Lead jab"
          ? 1.85
          : clip.name === "Punch combo"
            ? 1.55
            : clip.name === "Heavy hook"
              ? 1.28
              : clip.name === "Walking"
                ? 1.25
                : clip.name === "Stunned"
                  ? 1.05
                  : 1;
      nextAction.setEffectiveTimeScale(timeScale);
      const loops = clip.name === "Idle" || clip.name === "Walking";
      nextAction.setLoop(loops ? THREE.LoopRepeat : THREE.LoopOnce, loops ? Infinity : 1);
      nextAction.clampWhenFinished = !loops;
      const locomotion =
        clip.name === "Idle" ||
        clip.name === "Walking" ||
        currentAnimationName === "Idle" ||
        currentAnimationName === "Walking";
      const blendDuration = locomotion ? 0.32 : 0.2;
      if (currentAction && currentAction !== nextAction) {
        currentAction.fadeOut(blendDuration);
        nextAction.fadeIn(blendDuration);
      }
      nextAction.play();
      currentAction = nextAction;
      currentAnimationName = clip.name;
    };

    const preloadAnimationClips = async () => {
      const entries = Object.entries(ANIMATIONS).filter(
        ([name]) => name !== "Idle" && name !== "Knockout",
      );
      await Promise.all(
        entries.map(async ([name, path]) => {
          if (clipCache.has(name)) return;
          const source = await gltfLoader.loadAsync(path);
          const sourceClip = source.animations[0];
          if (!sourceClip) throw new Error(`${name} contains no animation clip.`);
          const clip = stripHorizontalRootMotion(sourceClip.clone());
          clip.name = name;
          clipCache.set(name, clip);
        }),
      );
    };

    const playAnimation = (name: string) => {
      if (!mixer) {
        setLoadingMessage("Boxer is still loading");
        return;
      }

      const cached = clipCache.get(name);
      if (cached) {
        setLoadingMessage("");
        playClip(cached);
        return;
      }

      const path = ANIMATIONS[name];
      if (!path) return;
      setLoadingMessage(`Loading ${name}`);
      gltfLoader.load(
        path,
        (source) => {
          if (disposed) return;
          const sourceClip = source.animations[0];
          if (!sourceClip) {
            setFatalError(`${name} contains no animation clip.`);
            return;
          }
          const clip = stripHorizontalRootMotion(sourceClip.clone());
          clip.name = name;
          clipCache.set(name, clip);
          setLoadingMessage("");
          playClip(clip);
        },
        undefined,
        (error) => {
          console.error(error);
          if (!disposed) {
            setFatalError(`Could not load the ${name} animation.`);
            setLoadingMessage("");
          }
        },
      );
    };

    const resetCamera = () => {
      camera.position.set(0, arenaSurfaceY + 1.55, 4.93);
      controls.target.set(0, arenaSurfaceY + 1.08, -1.2);
      controls.update();
      const view = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
      cameraYaw = view.y;
      cameraPitch = view.x;
      camera.rotation.order = "YXZ";
      camera.rotation.set(cameraPitch, cameraYaw, 0);
    };

    const showCombatMessage = (message: string, duration = 850) => {
      setCombatMessage(message);
      combatMessageUntil = performance.now() + duration;
    };

    const worldToPaint = (world: THREE.Vector3) => {
      const width = Math.max(paintPlane.scale.x, 0.001);
      const depth = Math.max(paintPlane.scale.y, 0.001);
      return new THREE.Vector2(
        THREE.MathUtils.clamp(
          ((world.x - paintPlane.position.x) / width + 0.5) *
            paint.canvas.width,
          28,
          paint.canvas.width - 28,
        ),
        THREE.MathUtils.clamp(
          ((world.z - paintPlane.position.z) / depth + 0.5) *
            paint.canvas.height,
          28,
          paint.canvas.height - 28,
        ),
      );
    };

    const paintGridCoordinate = (point: THREE.Vector2) => ({
      x: THREE.MathUtils.clamp(
        Math.floor(
          (point.x / paint.canvas.width) * PAINT_LAYER_GRID_SIZE,
        ),
        0,
        PAINT_LAYER_GRID_SIZE - 1,
      ),
      y: THREE.MathUtils.clamp(
        Math.floor(
          (point.y / paint.canvas.height) * PAINT_LAYER_GRID_SIZE,
        ),
        0,
        PAINT_LAYER_GRID_SIZE - 1,
      ),
    });

    const layerDepthAt = (point: THREE.Vector2) => {
      const grid = paintGridCoordinate(point);
      return paintLayerDepth[grid.y * PAINT_LAYER_GRID_SIZE + grid.x];
    };

    const canvasColorAt = (point: THREE.Vector2) => {
      const pixel = paint.context.getImageData(
        Math.round(point.x),
        Math.round(point.y),
        1,
        1,
      ).data;
      return `rgb(${pixel[0]} ${pixel[1]} ${pixel[2]})`;
    };

    const paintDensityAroundWorld = (world: THREE.Vector3) => {
      const offsets = [
        [0, 0],
        [-0.42, 0],
        [0.42, 0],
        [0, -0.42],
        [0, 0.42],
      ] as const;
      let total = 0;
      offsets.forEach(([x, z]) => {
        const sample = world.clone().add(new THREE.Vector3(x, 0, z));
        total += layerDepthAt(worldToPaint(sample)) / 7;
      });
      return total / offsets.length;
    };

    const chooseLowPaintLureTarget = (now: number) => {
      if (!bossModel) return;
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestTarget: THREE.Vector3 | null = null;
      for (let row = 0; row < LURE_SAMPLE_ROWS; row += 1) {
        const rowT = row / (LURE_SAMPLE_ROWS - 1);
        for (let column = 0; column < LURE_SAMPLE_COLUMNS; column += 1) {
          const columnT = column / (LURE_SAMPLE_COLUMNS - 1);
          const candidate = new THREE.Vector3(
            THREE.MathUtils.lerp(
              ARENA_MIN_X + BOSS_RADIUS + 0.35,
              ARENA_MAX_X - BOSS_RADIUS - 0.35,
              columnT,
            ),
            arenaSurfaceY,
            THREE.MathUtils.lerp(
              ARENA_MIN_Z + BOSS_RADIUS + 0.35,
              ARENA_MAX_Z - BOSS_RADIUS - 0.35,
              rowT,
            ),
          );
          const playerDistance = candidate.distanceTo(camera.position);
          if (playerDistance < 2.05 || playerDistance > 6.1) continue;
          const bossDistance = candidate.distanceTo(bossModel.position);
          const paintDensity = paintDensityAroundWorld(candidate);
          const freshCanvas = 1 - THREE.MathUtils.clamp(paintDensity, 0, 1);
          const idealPlayerDistance =
            1 -
            THREE.MathUtils.clamp(
              Math.abs(playerDistance - 3.75) / 2.4,
              0,
              1,
            );
          const travelEconomy =
            1 - THREE.MathUtils.clamp(bossDistance / 9.5, 0, 1);
          const edgeClearance =
            Math.min(columnT, 1 - columnT, rowT, 1 - rowT) * 2;
          const repeatPenalty =
            previousLureTarget &&
            candidate.distanceToSquared(previousLureTarget) < 3.2
              ? 1.35
              : 0;
          const score =
            freshCanvas * 5.2 +
            idealPlayerDistance * 1.2 +
            travelEconomy * 0.6 +
            edgeClearance * 0.45 -
            repeatPenalty +
            Math.random() * 0.16;
          if (score > bestScore) {
            bestScore = score;
            bestTarget = candidate;
          }
        }
      }
      if (!bestTarget) return;
      previousLureTarget = lureTarget?.clone() ?? previousLureTarget;
      lureTarget = bestTarget;
      lureTargetChosenAt = now;
      lureCommitUntil = now + 3600 + Math.random() * 1000;
      nextLureEvaluationAt = now + 1450;
    };

    const registerPaintDisk = (point: THREE.Vector2, radius: number) => {
      const center = paintGridCoordinate(point);
      const gridRadius = Math.max(
        1,
        Math.ceil(
          (radius / paint.canvas.width) * PAINT_LAYER_GRID_SIZE,
        ),
      );
      for (let y = center.y - gridRadius; y <= center.y + gridRadius; y += 1) {
        if (y < 0 || y >= PAINT_LAYER_GRID_SIZE) continue;
        for (
          let x = center.x - gridRadius;
          x <= center.x + gridRadius;
          x += 1
        ) {
          if (x < 0 || x >= PAINT_LAYER_GRID_SIZE) continue;
          if (
            (x - center.x) * (x - center.x) +
              (y - center.y) * (y - center.y) >
            gridRadius * gridRadius
          ) {
            continue;
          }
          const index = y * PAINT_LAYER_GRID_SIZE + x;
          paintLayerDepth[index] = Math.min(7, paintLayerDepth[index] + 1);
        }
      }
    };

    const registerPaintStroke = (
      start: THREE.Vector2,
      end: THREE.Vector2,
      width: number,
    ) => {
      const length = start.distanceTo(end);
      const steps = Math.max(1, Math.ceil(length / Math.max(8, width * 0.65)));
      for (let step = 0; step <= steps; step += 1) {
        registerPaintDisk(start.clone().lerp(end, step / steps), width * 0.72);
      }
    };

    const nextPaintColor = (point: THREE.Vector2, offset = 0) => {
      paintEventCounter += 1;
      const spatial =
        Math.floor(point.x / 96) * 3 +
        Math.floor(point.y / 88) * 5 +
        paintEventCounter * 7 +
        offset;
      const base = VISIBLE_PAINT_COLORS[
        ((spatial % VISIBLE_PAINT_COLORS.length) +
          VISIBLE_PAINT_COLORS.length) %
          VISIBLE_PAINT_COLORS.length
      ];
      return jitterHue(base, 0.065);
    };

    const strokeOrganicLine = (
      start: THREE.Vector2,
      end: THREE.Vector2,
      color: string,
      width: number,
      spray = 0.35,
    ) => {
      const midpoint = start.clone().lerp(end, 0.5);
      const previousDepth = layerDepthAt(midpoint);
      const underlyingColor = canvasColorAt(midpoint);
      paint.context.save();
      paint.context.lineCap = "round";
      paint.context.lineJoin = "round";
      const direction = end.clone().sub(start);
      const perpendicular = new THREE.Vector2(-direction.y, direction.x);
      if (perpendicular.lengthSq() > 0) perpendicular.normalize();

      [
        { alpha: 0.18, width: width * 1.9 },
        { alpha: 0.48, width: width * 1.34 },
        { alpha: 0.9, width },
      ].forEach((layer, index) => {
        const jitter = (Math.random() - 0.5) * width * 0.75;
        const mid = start
          .clone()
          .lerp(end, 0.5)
          .addScaledVector(perpendicular, jitter);
        paint.context.beginPath();
        paint.context.moveTo(
          start.x + (Math.random() - 0.5) * width * 0.3,
          start.y + (Math.random() - 0.5) * width * 0.3,
        );
        paint.context.quadraticCurveTo(
          mid.x,
          mid.y,
          end.x + (Math.random() - 0.5) * width * 0.3,
          end.y + (Math.random() - 0.5) * width * 0.3,
        );
        paint.context.strokeStyle = color;
        paint.context.globalAlpha = layer.alpha;
        paint.context.lineWidth =
          layer.width * (0.9 + Math.random() * 0.22 + index * 0.02);
        paint.context.stroke();
      });

      paint.context.globalAlpha = 0.86;
      const drops = Math.round(2 + spray * 9);
      for (let index = 0; index < drops; index += 1) {
        const along = Math.random();
        const center = start.clone().lerp(end, along);
        center.addScaledVector(
          perpendicular,
          (Math.random() - 0.5) * width * (1.5 + spray * 2.2),
        );
        const radius = 1.4 + Math.random() * width * 0.23 * (0.7 + spray);
        paint.context.beginPath();
        paint.context.ellipse(
          center.x,
          center.y,
          radius * (1 + Math.random()),
          radius,
          Math.random() * Math.PI,
          0,
          Math.PI * 2,
        );
        paint.context.fillStyle = color;
        paint.context.fill();
      }
      paint.context.restore();
      if (previousDepth > 0 && Math.random() < 0.48) {
        drawLayerStrata(
          paint.context,
          midpoint.x,
          midpoint.y,
          Math.max(12, width * 1.4),
          underlyingColor,
          Math.atan2(end.y - start.y, end.x - start.x),
          previousDepth,
        );
      }
      registerPaintStroke(start, end, width);
      markPaintTextureDirty();
    };

    const markFreshCanvas = (world: THREE.Vector3, gain = 6) => {
      const point = worldToPaint(world);
      const cellX = THREE.MathUtils.clamp(
        Math.floor((point.x / paint.canvas.width) * COVERAGE_GRID_SIZE),
        0,
        COVERAGE_GRID_SIZE - 1,
      );
      const cellY = THREE.MathUtils.clamp(
        Math.floor((point.y / paint.canvas.height) * COVERAGE_GRID_SIZE),
        0,
        COVERAGE_GRID_SIZE - 1,
      );
      const key = `${cellX}:${cellY}`;
      if (paintedCells.has(key)) return;
      paintedCells.add(key);
      movementPaintColor =
        VISIBLE_PAINT_COLORS[
          (paintedCells.size * 5 + cellX * 3 + cellY) %
            VISIBLE_PAINT_COLORS.length
        ];
      const wasLoaded = paintLoadValue >= 100;
      paintLoadValue = Math.min(100, paintLoadValue + gain);
      updatePaintLoadVisuals();
      if (!wasLoaded && paintLoadValue >= 100) {
        showCombatMessage("HOOK LOADED", 900);
      }
    };

    const drawCombatMark = (
      type: "jab" | "hook" | "stretch" | "parry" | "damage" | "knockout",
      world: THREE.Vector3,
      strength = 1,
      contributesToLoad = true,
    ) => {
      const point = worldToPaint(world);
      const source = worldToPaint(camera.position);
      const impactDirection = Math.atan2(
        point.y - source.y,
        point.x - source.x,
      );
      const previousDepth = layerDepthAt(point);
      const underlyingColor = canvasColorAt(point);
      let layerColor = "#ffd02f";
      let layerRadius = 42 * strength;

      if (type === "parry") {
        layerColor = nextPaintColor(point, 2);
        layerRadius = 44 * strength;
        drawGoldBurstRing(paint.context, point.x, point.y, 50 * strength, "#ffd02f");
        drawRibbonLoop(
          paint.context,
          point.x,
          point.y,
          42 * strength,
          layerColor,
          impactDirection,
        );
      } else if (type === "hook") {
        const hookColor = nextPaintColor(point, 9);
        const hookRadius = 38 + Math.min(strength, 2.15) * 11;
        layerColor = hookColor;
        layerRadius = hookRadius;
        drawHookCrescent(
          paint.context,
          point.x,
          point.y,
          hookRadius,
          hookColor,
          1.15 + Math.min(strength, 2.15) * 0.35,
          impactDirection,
        );
        const smearStart = point
          .clone()
          .add(
            new THREE.Vector2(
              Math.cos(impactDirection + Math.PI) *
                (44 + Math.min(strength, 2.15) * 10),
              Math.sin(impactDirection + Math.PI) *
                (44 + Math.min(strength, 2.15) * 10),
            ),
          );
        strokeOrganicLine(
          smearStart,
          point,
          hookColor,
          10 + Math.min(strength, 2.15) * 4,
          0.72,
        );
      } else if (type === "stretch") {
        const stretchColor = nextPaintColor(point, 4);
        layerColor = stretchColor;
        layerRadius = 38 * strength;
        strokeOrganicLine(source, point, stretchColor, 18 * strength, 1.1);
        drawFlickSplash(
          paint.context,
          point.x,
          point.y,
          46 * strength,
          stretchColor,
          0.9 * strength,
          impactDirection,
        );
        if (paintEventCounter % 2 === 0) {
          drawRibbonLoop(
            paint.context,
            point.x,
            point.y,
            34 * strength,
            nextPaintColor(point, 7),
            impactDirection + Math.PI * 0.5,
          );
        }
      } else if (type === "damage") {
        const damageColor = ensureAwayFromFloor(
          VISIBLE_PAINT_COLORS[
            (paintEventCounter * 3 + 6) % VISIBLE_PAINT_COLORS.length
          ],
        );
        layerColor = damageColor;
        layerRadius = 58 * strength;
        drawDripStain(
          paint.context,
          point.x,
          point.y,
          72 * strength,
          damageColor,
          1.1,
          impactDirection + (Math.random() - 0.5) * 0.6,
        );
      } else if (type === "knockout") {
        const knockoutColor = nextPaintColor(point, 11);
        layerColor = knockoutColor;
        layerRadius = 132 * strength;
        drawOrganicSplat(
          paint.context,
          point.x,
          point.y,
          150 * strength,
          knockoutColor,
          2.2,
          impactDirection,
        );
        drawRayBurst(paint.context, point.x, point.y, 200 * strength, "#ffd02f");
      } else {
        const color = nextPaintColor(point, jabSide < 0 ? 0 : 5);
        layerColor = color;
        layerRadius = 34 * strength;
        if (paintEventCounter % 3 === 0) {
          drawRibbonLoop(
            paint.context,
            point.x,
            point.y,
            34 * strength,
            color,
            impactDirection,
          );
        } else {
          drawFlickSplash(
            paint.context,
            point.x,
            point.y,
            40 * strength,
            color,
            0.6,
            impactDirection + (Math.random() - 0.5) * 0.4,
          );
        }
      }

      if (previousDepth > 0) {
        drawLayerStrata(
          paint.context,
          point.x,
          point.y,
          Math.max(20, layerRadius),
          underlyingColor,
          impactDirection,
          previousDepth,
        );
      }
      registerPaintDisk(point, Math.max(18, layerRadius));

      markPaintTextureDirty();
      if (contributesToLoad && type !== "damage") {
        markFreshCanvas(
          world,
          type === "hook" ? 12 : type === "knockout" ? 18 : 4,
        );
      }
      return layerColor;
    };

    const cutWhiteStreak = (
      from: THREE.Vector2,
      to: THREE.Vector2,
      width: number,
    ) => {
      paint.context.save();
      paint.context.globalCompositeOperation = "destination-out";
      paint.context.globalAlpha = 0.85;
      paint.context.lineCap = "round";
      paint.context.lineWidth = width;
      paint.context.beginPath();
      paint.context.moveTo(from.x, from.y);
      paint.context.lineTo(to.x, to.y);
      paint.context.stroke();
      paint.context.restore();

      paint.context.save();
      paint.context.globalCompositeOperation = "source-over";
      paint.context.globalAlpha = 0.55;
      paint.context.strokeStyle = "#fffbec";
      paint.context.lineWidth = width * 0.55;
      paint.context.lineCap = "round";
      paint.context.beginPath();
      paint.context.moveTo(from.x, from.y);
      paint.context.lineTo(to.x, to.y);
      paint.context.stroke();
      paint.context.restore();

      markPaintTextureDirty();
    };

    // A fixed-capacity InstancedMesh replaces what used to be up to 120
    // individually allocated THREE.Mesh particles (up to 120 extra draw
    // calls during a flurry of hits) with a single draw call; "dead" slots
    // are just scaled to zero rather than added/removed from the scene.
    const IMPACT_PARTICLE_CAPACITY = 48;
    const impactParticleGeometry = new THREE.IcosahedronGeometry(1, 0);
    const impactParticleMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.94,
      toneMapped: false,
    });
    impactParticleMaterial.userData.outlineParameters = { visible: false };
    const impactParticleMesh = new THREE.InstancedMesh(
      impactParticleGeometry,
      impactParticleMaterial,
      IMPACT_PARTICLE_CAPACITY,
    );
    impactParticleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    impactParticleMesh.frustumCulled = false;
    impactParticleMesh.castShadow = false;
    impactParticleMesh.receiveShadow = false;
    const impactDummy = new THREE.Object3D();
    impactDummy.scale.setScalar(0);
    impactDummy.updateMatrix();
    for (let slot = 0; slot < IMPACT_PARTICLE_CAPACITY; slot += 1) {
      impactParticleMesh.setMatrixAt(slot, impactDummy.matrix);
    }
    scene.add(impactParticleMesh);
    const impactParticleSlots: (ImpactParticleSlot | null)[] = new Array(
      IMPACT_PARTICLE_CAPACITY,
    ).fill(null);
    let activeImpactParticles = 0;
    const impactColorScratch = new THREE.Color();

    const spawnImpactParticles = (
      world: THREE.Vector3,
      color: string,
      count: number,
      force: number,
    ) => {
      let spawned = 0;
      for (
        let slot = 0;
        slot < IMPACT_PARTICLE_CAPACITY && spawned < count;
        slot += 1
      ) {
        if (impactParticleSlots[slot]) continue;
        const radius = 0.018 + Math.random() * 0.052;
        const particleColor = Math.random() < 0.14 ? "#17132e" : color;
        const position = world
          .clone()
          .add(
            new THREE.Vector3(
              (Math.random() - 0.5) * 0.28,
              (Math.random() - 0.5) * 0.24,
              (Math.random() - 0.5) * 0.28,
            ),
          );
        const away = world.clone().sub(camera.position).setY(0).normalize();
        const velocity = away
          .multiplyScalar(0.65 + Math.random() * force)
          .add(
            new THREE.Vector3(
              (Math.random() - 0.5) * force * 1.4,
              1.2 + Math.random() * force * 1.45,
              (Math.random() - 0.5) * force * 1.4,
            ),
          );
        impactParticleSlots[slot] = {
          position,
          velocity,
          scale: radius,
          color: particleColor,
          expiresAt: performance.now() + 950 + Math.random() * 620,
          landed: false,
        };
        activeImpactParticles += 1;
        spawned += 1;
        impactDummy.position.copy(position);
        impactDummy.scale.setScalar(radius);
        impactDummy.updateMatrix();
        impactParticleMesh.setMatrixAt(slot, impactDummy.matrix);
        impactParticleMesh.setColorAt(
          slot,
          impactColorScratch.set(particleColor),
        );
      }
      if (spawned > 0) {
        impactParticleMesh.instanceMatrix.needsUpdate = true;
        if (impactParticleMesh.instanceColor) {
          impactParticleMesh.instanceColor.needsUpdate = true;
        }
      }
    };

    const triggerFlash = (color: string, intensity: number) => {
      const element = flashRef.current;
      if (!element) return;
      element.style.backgroundColor = color;
      element.animate(
        [{ opacity: Math.min(0.85, intensity) }, { opacity: 0 }],
        { duration: 220, easing: "ease-out" },
      );
    };

    const triggerImpactFrame = (
      world: THREE.Vector3,
      color: string,
      strength: number,
    ) => {
      if (reducedMotion) return;
      const element = impactFrameRef.current;
      if (!element) return;
      const projected = world.clone().project(camera);
      element.style.setProperty(
        "--impact-x",
        `${THREE.MathUtils.clamp((projected.x * 0.5 + 0.5) * 100, 12, 88)}%`,
      );
      element.style.setProperty(
        "--impact-y",
        `${THREE.MathUtils.clamp((-projected.y * 0.5 + 0.5) * 100, 12, 82)}%`,
      );
      element.style.setProperty("--impact-color", color);
      element.style.setProperty(
        "--impact-angle",
        `${-18 + Math.random() * 16}deg`,
      );
      element.animate(
        [
          { opacity: 0, transform: "scale(1.08)", offset: 0 },
          { opacity: 1, transform: "scale(0.985)", offset: 0.04 },
          { opacity: 1, transform: "scale(1)", offset: 0.17 },
          { opacity: 0.16, transform: "scale(1.015)", offset: 0.18 },
          { opacity: 0, transform: "scale(1.04)", offset: 1 },
        ],
        {
          duration: 190 + Math.min(35, strength * 18),
          easing: "steps(2, end)",
        },
      );
    };

    const triggerImpact = (
      kind: "jab" | "hook" | "parry" | "hurt" | "shot",
      world: THREE.Vector3,
      color: string,
      strength = 1,
      finisher = false,
      paintGesture?: { kind: PunchKind; charge: number; loaded: boolean },
    ) => {
      const now = performance.now();
      hitStopUntil = Math.max(
        hitStopUntil,
        now +
          (kind === "parry"
            ? 96
            : kind === "hook"
              ? Math.min(92, 72 + 14 * strength)
              : kind === "hurt"
                ? Math.min(105, 54 + 28 * strength)
                : 48),
      );
      cameraShake = Math.max(
        cameraShake,
        (kind === "hook" ? 0.2 : kind === "hurt" ? 0.17 : 0.08) * strength,
      );
      fovKick = Math.max(
        fovKick,
        (kind === "hook" ? 5 : kind === "hurt" ? 3.8 : 2.4) * strength,
      );
      if (kind === "hook") {
        impactRoll = Math.max(impactRoll, 0.016 * strength);
        bossImpactStartedAt = now;
        bossImpactUntil = now + 210;
        bossImpactStrength = Math.max(bossImpactStrength, strength);
        if (!finisher) triggerImpactFrame(world, color, strength);
      }
      spawnImpactParticles(
        world,
        color,
        Math.round((kind === "hook" ? 18 : kind === "parry" ? 12 : 8) * strength),
        (kind === "hook" ? 2.1 : 1.25) * strength,
      );
      auditoryArt.playImpact(paintGesture?.kind ?? kind, color, strength, {
        buildCombo: Boolean(paintGesture),
        charge: paintGesture?.charge,
        finisher,
        loaded: paintGesture?.loaded,
      });
      triggerFlash(
        kind === "hook" ? color : "#ffffff",
        kind === "hook" ? 0.42 * strength : 0.28 * strength,
      );
      renderer.domElement.animate(
        [
          {
            filter:
              kind === "hook"
                ? "brightness(1.85) saturate(1.6)"
                : "brightness(1.42) saturate(1.42)",
          },
          { filter: "brightness(1) saturate(1)" },
        ],
        { duration: kind === "hook" ? 220 : 95, easing: "ease-out" },
      );
    };

    const beginReveal = (finalKind: PunchKind | null, won: boolean) => {
      if (phaseValue !== "fighting") return;
      const now = performance.now();
      phaseValue = "reveal";
      revealWon = won;
      revealFinished = false;
      setGamePhase("reveal");
      setBossTell("");
      hideAttackTelegraphs();
      stretchCharging = false;
      setStretchCharge(0);
      revealStartedAt = now;
      revealStartPosition = camera.position.clone();
      finisherFreezeUntil = now;
      finisherFlightStarted = false;
      finisherFlightLastAt = now;
      lastFinisherPaintAt = 0;
      lastFinisherPaintPoint = bossModel
        ? worldToPaint(bossModel.position)
        : null;
      if (won && bossModel) {
        const launchDirection = bossModel.position
          .clone()
          .sub(camera.position)
          .setY(0);
        if (launchDirection.lengthSq() < 0.001) launchDirection.set(0.35, 0, -1);
        launchDirection.normalize();
        finisherVelocity
          .copy(launchDirection)
          .multiplyScalar(11.8)
          .setY(4.8);
      }
      controls.enabled = false;
      setCombatMessage("");
      combatMessageUntil = 0;
      auditoryArt.finish(won);
      if (document.pointerLockElement === renderer.domElement) {
        void document.exitPointerLock?.();
      }
      if (won) {
        drawCombatMark(
          "knockout",
          bossModel?.position.clone() ?? new THREE.Vector3(0, arenaSurfaceY, -1),
          finalKind === "hook" ? 1.25 : 1,
        );
        playAnimation("Knockout");
      } else {
        drawCombatMark("damage", camera.position.clone(), 1.4);
        playAnimation("Idle");
        firstPersonRig.rotation.x = -0.45;
      }
    };

    const damageBoss = (amount: number, kind: PunchKind) => {
      bossHealthValue = Math.max(0, bossHealthValue - amount);
      setBossHealth(bossHealthValue);
      if (bossHealthValue <= 0) {
        beginReveal(kind, true);
      }
    };

    const resolvePlayerHit = (kind: PunchKind, charge = 0) => {
      if (phaseValue !== "fighting" || !bossModel) return;
      const bossCenter = bossModel.position
        .clone()
        .add(new THREE.Vector3(0, 1.08, 0));
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.normalize();
      const ray = new THREE.Ray(camera.position.clone(), forward);
      const toCenter = bossCenter.clone().sub(ray.origin);
      const projectedDistance = toCenter.dot(ray.direction);
      const closest = ray.at(
        Math.max(0, projectedDistance),
        new THREE.Vector3(),
      );
      const aimRadius =
        kind === "hook" ? 0.56 : kind === "stretch" ? 0.66 + charge * 0.24 : 0.72;
      const range =
        kind === "stretch"
          ? 3.2 + charge * 3.8
          : kind === "hook"
            ? 2.6
            : 2.48;

      if (
        projectedDistance <= 0 ||
        projectedDistance > range ||
        closest.distanceToSquared(bossCenter) > aimRadius * aimRadius
      ) {
        return;
      }

      const loadedHook = kind === "hook" && paintLoadValue >= 100;
      const damage =
        kind === "hook"
          ? loadedHook
            ? 52
            : 24
          : kind === "stretch"
            ? Math.round(12 + charge * 25)
            : 11;
      const markType =
        kind === "hook" ? "hook" : kind === "stretch" ? "stretch" : "jab";
      const markStrength =
        kind === "hook"
          ? loadedHook
            ? 2.15
            : 1.25
          : kind === "stretch"
            ? 0.8 + charge * 1.3
            : 1;
      const markColor = drawCombatMark(
        markType,
        bossModel.position,
        markStrength,
      );
      const impactPoint = closest.clone();
      const impactColor = markColor ?? (kind === "hook" ? "#ff2aa1" : "#14f1ff");
      const willKnockOut = bossHealthValue - damage <= 0;
      if (willKnockOut) finisherPaintColor = ensureAwayFromFloor(impactColor);
      triggerImpact(
        kind === "hook" ? "hook" : "jab",
        impactPoint,
        impactColor,
        kind === "stretch" ? 0.85 + charge * 0.7 : loadedHook ? 1.35 : 1,
        willKnockOut,
        { kind, charge, loaded: loadedHook },
      );

      if (loadedHook) {
        paintLoadValue = 0;
        updatePaintLoadVisuals();
        bossAttack = null;
        nextBossAttackAt = performance.now() + 1450;
        playAnimation("Stunned");
        showCombatMessage("PAINT BREAK", 950);
        const knockback = bossModel.position
          .clone()
          .sub(camera.position)
          .setY(0)
          .normalize()
          .multiplyScalar(0.7);
        bossModel.position.add(knockback);
      } else if (kind === "hook") {
        const recoil = bossModel.position
          .clone()
          .sub(camera.position)
          .setY(0)
          .normalize()
          .multiplyScalar(0.22);
        bossModel.position.add(recoil);
      }
      damageBoss(damage, kind);
    };

    const beginPlayerPunch = (kind: PunchKind, charge = 0) => {
      const now = performance.now();
      if (phaseValue !== "fighting" || activePunch || now < nextPlayerPunchAt) {
        return;
      }

      const actualKind =
        kind === "left" || kind === "right"
          ? jabSide < 0
            ? "left"
            : "right"
          : kind;
      jabSide *= -1;
      activePunch = { kind: actualKind, startedAt: now, charge };
      pendingPlayerHit = {
        kind: actualKind,
        charge,
        resolvesAt:
          now +
          (actualKind === "hook"
            ? 318
            : actualKind === "stretch"
              ? 310 + charge * 115
              : 112),
      };
      nextPlayerPunchAt =
        now +
        (actualKind === "hook"
          ? 680
          : actualKind === "stretch"
            ? 720 + charge * 180
            : 360);
      auditoryArt.playGesture(
        actualKind,
        actualKind === "hook"
          ? 1.4
          : actualKind === "stretch"
            ? 1 + charge
            : 0.65,
      );
    };

    const beginStretchCharge = () => {
      const now = performance.now();
      if (
        phaseValue !== "fighting" ||
        stretchCharging ||
        activePunch ||
        now < nextPlayerPunchAt
      ) {
        return;
      }
      stretchCharging = true;
      stretchChargeStartedAt = now;
      lastStretchChargeUiAt = 0;
      setStretchCharge(1);
    };

    const releaseStretchCharge = () => {
      if (!stretchCharging) return;
      const now = performance.now();
      const charge = THREE.MathUtils.clamp(
        (now - stretchChargeStartedAt) / 1550,
        0.06,
        1,
      );
      stretchCharging = false;
      setStretchCharge(0);
      beginPlayerPunch("stretch", charge);
    };

    const attemptParry = () => {
      if (phaseValue !== "fighting") return;
      const now = performance.now();
      if (now < parryReadyAt) return;
      parryStartedAt = now;
      parryUntil = now + 245;
      parryReadyAt = now + 560;
      recentParryAttempts.push(now);
      recentParryAttempts = recentParryAttempts.filter(
        (time) => now - time < 4000,
      );
      setParryActive(true);
      window.setTimeout(() => {
        if (!disposed) setParryActive(false);
      }, 255);
    };

    const performSidestep = () => {
      if (phaseValue !== "fighting") return;
      const now = performance.now();
      if (now < sidestepReadyAt) return;
      const moveX =
        (pressedKeys.has("d") || pressedKeys.has("arrowright") ? 1 : 0) -
        (pressedKeys.has("a") || pressedKeys.has("arrowleft") ? 1 : 0);
      const moveZ =
        (pressedKeys.has("s") || pressedKeys.has("arrowdown") ? 1 : 0) -
        (pressedKeys.has("w") || pressedKeys.has("arrowup") ? 1 : 0);
      const input = new THREE.Vector2(moveX, moveZ);
      if (input.lengthSq() === 0) return;
      input.normalize();
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3(-forward.z, 0, forward.x);
      const dashDirection = right
        .multiplyScalar(input.x)
        .addScaledVector(forward, -input.y)
        .normalize();
      const before = camera.position.clone();
      camera.position.addScaledVector(dashDirection, 1.05);
      camera.position.x = THREE.MathUtils.clamp(
        camera.position.x,
        ARENA_MIN_X + PLAYER_RADIUS,
        ARENA_MAX_X - PLAYER_RADIUS,
      );
      camera.position.z = THREE.MathUtils.clamp(
        camera.position.z,
        ARENA_MIN_Z + PLAYER_RADIUS,
        ARENA_MAX_Z - PLAYER_RADIUS,
      );
      sidestepReadyAt = now + 650;
      sidestepUntil = now + 220;
      cutWhiteStreak(worldToPaint(before), worldToPaint(camera.position), 26);
      auditoryArt.playDash();
      showCombatMessage("SLIP", 420);
    };

    const requestAimCapture = () => {
      try {
        const request = renderer.domElement.requestPointerLock?.();
        if (request) void request.catch(() => {});
      } catch {
        // Pointer lock is optional; keyboard/touch controls still work without it.
      }
    };

    const startFight = () => {
      if (phaseValue === "fighting" || !bossModel || !glovePrototype) return;
      easyModeActive = easyModeRef.current;
      bossMaxHealthValue = easyModeActive
        ? Math.round(BOSS_MAX_HEALTH / 2)
        : BOSS_MAX_HEALTH;
      bossHealthValue = bossMaxHealthValue;
      setBossMaxHealth(bossMaxHealthValue);
      setBossHealth(bossHealthValue);
      phaseValue = "fighting";
      setGamePhase("fighting");
      setCombatMessage("FIGHT!");
      combatMessageUntil = performance.now() + 1000;
      nextBossAttackAt = performance.now() + 1900;
      nextRopeRushAt = performance.now() + 12000;
      nextLureEvaluationAt = performance.now() + 500;
      lureTarget = null;
      previousLureTarget = null;
      lastPlayerMoveAt = performance.now();
      resetCamera();
      controls.enabled = false;
      firstPersonRig.visible = true;
      playAnimation("Idle");
      void auditoryArt.start();
      requestAimCapture();
    };

    const savePainting = () => {
      const anchor = document.createElement("a");
      anchor.download = `boxing-canvas-${Date.now()}.png`;
      anchor.href = paint.canvas.toDataURL("image/png");
      anchor.click();
    };

    actionsRef.current = {
      startFight,
      punch: beginPlayerPunch,
      beginStretchCharge,
      releaseStretchCharge,
      parry: attemptParry,
      savePainting,
      playAgain: () => window.location.reload(),
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      pressedKeys.add(key);
      if (
        phaseValue === "fighting" &&
        (key === " " ||
          key === "arrowup" ||
          key === "arrowdown" ||
          key === "arrowleft" ||
          key === "arrowright")
      ) {
        event.preventDefault();
      }
      if (
        phaseValue === "fighting" &&
        document.pointerLockElement !== renderer.domElement &&
        !event.repeat &&
        (key === "w" ||
          key === "a" ||
          key === "s" ||
          key === "d" ||
          key === "arrowup" ||
          key === "arrowdown" ||
          key === "arrowleft" ||
          key === "arrowright")
      ) {
        requestAimCapture();
      }
      if (key === "f" && !event.repeat) attemptParry();
      if (key === "q" && !event.repeat) beginPlayerPunch("left");
      if ((key === "e" || key === " ") && !event.repeat) {
        beginPlayerPunch("hook");
      }
      if (key === "r" && !event.repeat) beginStretchCharge();
      if (key === "shift" && !event.repeat) performSidestep();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      pressedKeys.delete(key);
      if (key === "r") releaseStretchCharge();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        phaseValue === "fighting" &&
        document.pointerLockElement !== renderer.domElement &&
        event.pointerType !== "touch"
      ) {
        requestAimCapture();
      }
      if (event.button === 0) beginPlayerPunch("left");
      if (event.button === 2) beginPlayerPunch("hook");
    };
    const onAimPointerMove = (event: PointerEvent) => {
      if (
        phaseValue !== "fighting" ||
        document.pointerLockElement === renderer.domElement ||
        event.pointerType === "touch"
      ) {
        return;
      }
      cameraYaw -= event.movementX * 0.00165;
      cameraPitch = THREE.MathUtils.clamp(
        cameraPitch - event.movementY * 0.0014,
        -0.62,
        0.42,
      );
    };
    const onMouseMove = (event: MouseEvent) => {
      if (
        phaseValue !== "fighting" ||
        document.pointerLockElement !== renderer.domElement
      ) {
        return;
      }
      cameraYaw -= event.movementX * 0.00235;
      cameraPitch = THREE.MathUtils.clamp(
        cameraPitch - event.movementY * 0.00195,
        -0.62,
        0.42,
      );
      camera.rotation.set(cameraPitch, cameraYaw, 0, "YXZ");
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const onPointerLockChange = () => {
      const locked = document.pointerLockElement === renderer.domElement;
      setAimLocked(locked);
    };
    const onPointerLockError = () => {
      setAimLocked(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("pointermove", onAimPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("pointerlockerror", onPointerLockError);

    gltfLoader.load(
      "/assets/boxing_ring.glb",
      (gltf) => {
        if (disposed) return;
        const ring = gltf.scene;
        ring.name = "BoxingRing";
        ring.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.castShadow = false;
            mesh.receiveShadow = true;
            if (Array.isArray(mesh.material)) {
              mesh.material = mesh.material.map((material, index) =>
                makeToonMaterial(
                  material,
                  toonGradient,
                  ringColorFor(mesh.name, material.name, index),
                ),
              );
            } else {
              mesh.material = makeToonMaterial(
                mesh.material,
                toonGradient,
                ringColorFor(mesh.name, mesh.material.name, 0),
              );
            }
          }
        });
        normalizeModel(ring, 16, "footprint");
        scene.add(ring);

        const downwardRay = new THREE.Raycaster(
          new THREE.Vector3(0, 8, 0),
          new THREE.Vector3(0, -1, 0),
          0,
          16,
        );
        const centerHits = downwardRay.intersectObject(ring, true);
        if (centerHits.length) {
          arenaSurfaceY = centerHits[0].point.y;
        }

        paintPlane.position.set(
          (ARENA_MIN_X + ARENA_MAX_X) * 0.5,
          arenaSurfaceY + 0.018,
          (ARENA_MIN_Z + ARENA_MAX_Z) * 0.5,
        );
        paintPlane.scale.set(
          ARENA_MAX_X - ARENA_MIN_X + PAINT_SURFACE_PADDING * 2,
          ARENA_MAX_Z - ARENA_MIN_Z + PAINT_SURFACE_PADDING * 2,
          1,
        );

        const ringBox = new THREE.Box3().setFromObject(ring);
        const ringCenter = ringBox.getCenter(new THREE.Vector3());
        const ringSize = ringBox.getSize(new THREE.Vector3());
        const farRopeZ = ringCenter.z - ringSize.z * 0.42;
        const ropeLength = ringSize.x * 0.78;
        handlerGroup.position.set(-3, arenaSurfaceY, farRopeZ - 0.62);
        attackMarker.position.y = arenaSurfaceY + 0.055;
        chargeLane.position.y = arenaSurfaceY + 0.05;
        const comicRopes = new THREE.Group();
        comicRopes.name = "ComicRopes";
        const ropeColors = [0x14f1ff, 0xff2aa1, 0x14f1ff];

        ropeColors.forEach((color, index) => {
          const addRopeLayer = (
            radius: number,
            layerColor: number,
            name: string,
          ) => {
            const rope = new THREE.Mesh(
              new THREE.CylinderGeometry(radius, radius, ropeLength, 12, 1),
              new THREE.MeshBasicMaterial({
                color: layerColor,
                toneMapped: false,
              }),
            );
            rope.name = name;
            rope.rotation.z = Math.PI * 0.5;
            rope.position.set(
              ringCenter.x,
              arenaSurfaceY + 0.78 + index * 0.42,
              farRopeZ,
            );
            comicRopes.add(rope);
          };

          addRopeLayer(0.065, COMIC_BLACK, `RopeBlack${index}`);
          addRopeLayer(0.046, COMIC_WHITE, `RopeWhite${index}`);
          addRopeLayer(0.03, color, `RopeColor${index}`);
        });

        [-1, 1].forEach((side) => {
          const post = new THREE.Mesh(
            new RoundedBoxGeometry(0.34, 1.85, 0.34, 4, 0.07),
            new THREE.MeshToonMaterial({
              color: side < 0 ? 0x493bff : 0xff2aa1,
              gradientMap: toonGradient,
            }),
          );
          post.position.set(
            ringCenter.x + side * ropeLength * 0.5,
            arenaSurfaceY + 0.92,
            farRopeZ,
          );
          addDualOutline(post, whiteOutline, blackOutline);
          comicRopes.add(post);
        });
        scene.add(comicRopes);

        camera.position.set(0, arenaSurfaceY + 1.55, 4.93);
        controls.target.set(0, arenaSurfaceY + 1.08, -1.53);
        controls.update();
        bossNeedsGrounding = true;
        setAssets((current) => ({ ...current, ring: "ready" }));
      },
      undefined,
      (error) => {
        console.error(error);
        if (!disposed) {
          setAssets((current) => ({ ...current, ring: "error" }));
          setFatalError("The boxing ring could not be loaded.");
        }
      },
    );

    try {
      glovePrototype = createClosedGlove(
        toonGradient,
        whiteOutline,
        blackOutline,
      );
      setPlayerGloves();
      attachOpponentGloves();
      queueMicrotask(() => {
        if (!disposed) {
          setAssets((current) => ({ ...current, glove: "ready" }));
        }
      });
    } catch (error) {
      console.error(error);
      queueMicrotask(() => {
        if (disposed) return;
        setAssets((current) => ({ ...current, glove: "error" }));
        setFatalError("The procedural boxing gloves could not be created.");
      });
    }

    gltfLoader.load(
      "/assets/optimized/opponent.glb",
      (gltf) => {
        if (disposed) return;
        const fighter = gltf.scene;
        fighter.name = "MixamoBoxer";
        fighter.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.visible = true;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = true;
            if (Array.isArray(mesh.material)) {
              mesh.material = mesh.material.map((material, index) =>
                makeToonMaterial(
                  material,
                  toonGradient,
                  fighterColorFor(material.name, index),
                  true,
                ),
              );
            } else {
              mesh.material = makeToonMaterial(
                mesh.material,
                toonGradient,
                fighterColorFor(mesh.material.name, 0),
                true,
              );
            }
          }
        });
        baseCharacterScale = normalizeModel(fighter, 1.9, "height");
        fighter.position.z = -1.53;
        scene.add(fighter);
        bossModel = fighter;
        attachOpponentGloves();
        bossNeedsGrounding = true;

        mixer = new THREE.AnimationMixer(fighter);
        const idleClip = gltf.animations[0];
        if (idleClip) {
          stripHorizontalRootMotion(idleClip);
          idleClip.name = "Idle";
          clipCache.set("Idle", idleClip);
          playClip(idleClip);
        }
        window.setTimeout(() => {
          if (disposed) return;
          const box = new THREE.Box3().setFromObject(fighter);
          const size = box.getSize(new THREE.Vector3());
          let meshCount = 0;
          let skinnedMeshCount = 0;
          fighter.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) meshCount += 1;
            if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
              skinnedMeshCount += 1;
            }
          });
          console.info("[Boxer diagnostics]", {
            meshCount,
            skinnedMeshCount,
            size: size.toArray().map((value) => Number(value.toFixed(3))),
            surfaceY: Number(arenaSurfaceY.toFixed(3)),
          });
        }, 750);
        setLoadingMessage("Loading fight animations");
        void preloadAnimationClips()
          .then(() => {
            if (disposed) return;
            setAssets((current) => ({ ...current, boxer: "ready" }));
            setLoadingMessage("");
          })
          .catch((error) => {
            console.error(error);
            if (disposed) return;
            setAssets((current) => ({ ...current, boxer: "error" }));
            setFatalError("The opponent animations could not be prepared.");
            setLoadingMessage("");
          });
      },
      (progress) => {
        if (!progress.total || disposed) return;
        const percent = Math.round((progress.loaded / progress.total) * 100);
        setLoadingMessage(`Loading boxer ${percent}%`);
      },
      (error) => {
        console.error(error);
        if (!disposed) {
          setAssets((current) => ({ ...current, boxer: "error" }));
          setFatalError("The Mixamo boxer could not be loaded.");
          setLoadingMessage("");
        }
      },
    );

    const hideAttackTelegraphs = () => {
      attackMarker.visible = false;
      chargeLane.visible = false;
      puppetLines.forEach((line) => {
        line.visible = false;
      });
    };

    const showAttackTelegraph = (attack: BossAttack) => {
      hideAttackTelegraphs();
      const markerMaterial = attackMarker.material as THREE.MeshBasicMaterial;
      if (attack.kind === "ropeRush") {
        const midpoint = attack.origin.clone().lerp(attack.target, 0.5);
        const distance = attack.origin.distanceTo(attack.target);
        chargeLane.visible = true;
        chargeLane.position.set(midpoint.x, arenaSurfaceY + 0.05, midpoint.z);
        chargeLane.scale.set(1.28, distance, 1);
        chargeLane.rotation.z = Math.atan2(
          attack.direction.x,
          attack.direction.z,
        );
        attackMarker.visible = true;
        attackMarker.position.set(
          camera.position.x,
          arenaSurfaceY + 0.06,
          attack.origin.z,
        );
        attackMarker.scale.setScalar(1.7);
        markerMaterial.color.set(0xffd02f);
        puppetLines.forEach((line) => {
          line.visible = true;
        });
        return;
      }

      attackMarker.visible = true;
      attackMarker.position.set(
        attack.target.x,
        arenaSurfaceY + 0.055,
        attack.target.z,
      );
      const markerScale =
        attack.kind === "hook"
          ? 1.35
          : attack.kind === "paintShot"
            ? 1.1
            : 0.88;
      attackMarker.scale.setScalar(markerScale);
      markerMaterial.color.set(
        attack.kind === "paintShot"
          ? 0x14f1ff
          : attack.kind === "hook"
            ? 0xff2aa1
            : 0xffd02f,
      );
    };

    const beginBossAttack = (now: number) => {
      if (!bossModel || phaseValue !== "fighting") return;
      const phase =
        bossHealthValue / bossMaxHealthValue > 0.66
          ? 1
          : bossHealthValue / bossMaxHealthValue > 0.33
            ? 2
            : 3;
      const toPlayer = camera.position.clone().sub(bossModel.position).setY(0);
      const distance = toPlayer.length();
      const roll = Math.random();
      const turtling = now - lastPlayerMoveAt > 2200;
      recentParryAttempts = recentParryAttempts.filter(
        (time) => now - time < 4000,
      );
      const parryMashing = recentParryAttempts.length >= 2;
      let kind: BossAttackKind;
      if (forcedNextAttack) {
        kind = forcedNextAttack;
        forcedNextAttack = null;
      } else if (now >= nextRopeRushAt) {
        kind = "ropeRush";
        nextRopeRushAt = now + 13500 + Math.random() * 4500;
      } else if (
        parryMashing &&
        phase >= 2 &&
        distance <= 2.85 &&
        Math.random() < 0.6
      ) {
        kind = "feint";
        recentParryAttempts = [];
      } else if (phase >= 2 && (distance > 3.25 || roll < 0.2 + phase * 0.04)) {
        kind = "paintShot";
      } else if (distance > 2.85) {
        nextBossAttackAt = now + (turtling ? 120 : 280);
        return;
      } else if (roll < 0.27 + phase * 0.04 + (turtling ? 0.12 : 0)) {
        kind = "hook";
      } else if (roll < 0.63 + (turtling ? 0.08 : 0)) {
        kind = "combo";
      } else {
        kind = "jab";
      }

      if (
        (kind === "jab" || kind === "hook" || kind === "combo") &&
        recentAttackKinds.length === 2 &&
        recentAttackKinds[0] === kind &&
        recentAttackKinds[1] === kind
      ) {
        const alternatives = (
          ["jab", "hook", "combo"] as BossAttackKind[]
        ).filter((candidate) => candidate !== kind);
        kind =
          alternatives[Math.floor(Math.random() * alternatives.length)];
      }

      const maximumMeleeStartRange =
        kind === "jab" ? 1.92 : kind === "combo" ? 2.16 : kind === "hook" ? 2.48 : null;
      if (
        maximumMeleeStartRange !== null &&
        distance > maximumMeleeStartRange
      ) {
        lureTarget = null;
        lureCommitUntil = 0;
        nextLureEvaluationAt = now + 900;
        nextBossAttackAt = now + 110;
        return;
      }

      if (kind === "jab" || kind === "hook" || kind === "combo") {
        recentAttackKinds = [recentAttackKinds[1] ?? kind, kind];
      }

      let origin = bossModel.position.clone();
      let target = camera.position.clone();
      let telegraph = 360;
      let recovery = 360;
      let hitRadius = 0.62;
      if (kind === "combo") {
        telegraph = 500;
        recovery = 490;
        hitRadius = 0.75;
      } else if (kind === "hook") {
        telegraph = 760;
        recovery = 620;
        hitRadius = 0.98;
      } else if (kind === "feint") {
        telegraph = 300;
        recovery = 90;
        hitRadius = 0.62;
      } else if (kind === "paintShot") {
        telegraph = 720;
        recovery = 680;
        hitRadius = 0.48;
      } else if (kind === "ropeRush") {
        const fromRight = camera.position.x < 0;
        origin = new THREE.Vector3(
          fromRight ? ARENA_MAX_X - 0.28 : ARENA_MIN_X + 0.28,
          arenaSurfaceY,
          THREE.MathUtils.clamp(
            camera.position.z + (Math.random() - 0.5) * 0.8,
            ARENA_MIN_Z + 0.5,
            ARENA_MAX_Z - 0.5,
          ),
        );
        target = new THREE.Vector3(
          fromRight ? ARENA_MIN_X + 0.28 : ARENA_MAX_X - 0.28,
          arenaSurfaceY,
          origin.z,
        );
        telegraph = 1120;
        recovery = 960;
        hitRadius = 0.88;
      }
      if (easyModeActive) {
        telegraph *= 1.4;
        recovery *= 1.15;
      }
      const direction = target.clone().sub(origin).setY(0).normalize();
      bossAttack = {
        kind,
        startedAt: now,
        impactAt: now + telegraph,
        recoverAt: now + telegraph + recovery,
        origin,
        target,
        direction,
        hitRadius,
        resolved: false,
        hitPlayer: false,
      };
      showAttackTelegraph(bossAttack);
      setBossTell(
        kind === "ropeRush"
          ? "ROPE RUSH"
          : kind === "paintShot"
            ? "PAINT THROW"
            : kind === "hook"
              ? "HOOK"
              : "",
      );
      playAnimation(
        kind === "hook"
          ? "Heavy hook"
          : kind === "combo"
            ? "Punch combo"
            : kind === "ropeRush"
              ? "Walking"
              : "Lead jab",
      );
    };

    const applyPlayerDamage = (
      damage: number,
      impactPoint: THREE.Vector3,
      strength = 1,
    ) => {
      if (phaseValue !== "fighting") return;
      const scaledDamage = easyModeActive
        ? Math.max(1, Math.round(damage * 0.6))
        : damage;

      drawCombatMark("damage", camera.position, 0.72 + strength * 0.35);
      triggerImpact("hurt", impactPoint, "#7b123d", strength);

      const push = camera.position
        .clone()
        .sub(impactPoint)
        .setY(0)
        .normalize()
        .multiplyScalar(0.34 * strength);
      camera.position.add(push);

      if (easyModeActive) {
        const reflectDamage = Math.max(14, Math.round(scaledDamage * 2.75));
        showCombatMessage("DRIP BACK", 720);
        damageBoss(reflectDamage, "hook");
        return;
      }

      playerHealthValue = Math.max(0, playerHealthValue - scaledDamage);
      setPlayerHealth(playerHealthValue);

      if (playerHealthValue <= 0) {
        beginReveal(null, false);
      }
    };

    const launchPaintProjectile = (attack: BossAttack) => {
      if (!bossModel) return;
      const group = new THREE.Group();
      const blobMaterial = new THREE.MeshBasicMaterial({
        color: 0x14f1ff,
        transparent: true,
        opacity: 0.92,
        toneMapped: false,
      });
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.27, 16, 11),
        blobMaterial,
      );
      core.scale.set(1.15, 0.86, 1);
      group.add(core);
      for (let lobe = 0; lobe < 5; lobe += 1) {
        const satellite = new THREE.Mesh(
          new THREE.SphereGeometry(0.09 + Math.random() * 0.08, 10, 7),
          blobMaterial,
        );
        satellite.position.set(
          (Math.random() - 0.5) * 0.42,
          (Math.random() - 0.5) * 0.34,
          (Math.random() - 0.5) * 0.42,
        );
        group.add(satellite);
      }
      group.position
        .copy(bossModel.position)
        .add(new THREE.Vector3(0, 1.28, 0));
      const target = attack.target.clone();
      target.y = camera.position.y - 0.08;
      const velocity = target
        .sub(group.position)
        .normalize()
        .multiplyScalar(
          5.8 + (3 - (bossHealthValue / bossMaxHealthValue) * 3) * 0.45,
        );
      scene.add(group);
      projectiles.push({
        mesh: group,
        velocity,
        radius: 0.34,
        expiresAt: performance.now() + 3200,
        lastTrailAt: 0,
        reflected: false,
      });
      auditoryArt.playImpact("shot", "#14f1ff", 0.8);
    };

    const resolveBossAttack = (attack: BossAttack, now: number) => {
      if (!bossModel || phaseValue !== "fighting") return;
      if (attack.kind === "paintShot") {
        launchPaintProjectile(attack);
        return;
      }
      if (attack.kind === "ropeRush") return;
      if (attack.kind === "feint") return;

      const reach =
        attack.kind === "hook" ? 1.36 : attack.kind === "combo" ? 1.18 : 1.04;
      const hitCenter = bossModel.position
        .clone()
        .addScaledVector(attack.direction, reach);
      const overlap =
        Math.hypot(
          camera.position.x - hitCenter.x,
          camera.position.z - hitCenter.z,
        ) <=
        attack.hitRadius + PLAYER_RADIUS;
      if (!overlap) return;

      if (now <= sidestepUntil) {
        showCombatMessage("SLIP", 500);
        bossAttack = null;
        hideAttackTelegraphs();
        nextBossAttackAt = now + 900;
        return;
      }

      const impactPoint = hitCenter
        .clone()
        .add(new THREE.Vector3(0, 1.16, 0));
      const parried =
        parryStartedAt <= attack.impactAt && parryUntil >= attack.impactAt;
      if (parried) {
        drawCombatMark(
          "parry",
          bossModel.position,
          attack.kind === "hook" ? 1.35 : 1,
        );
        triggerImpact("parry", impactPoint, "#ffd02f", 1.05);
        damageBoss(14, "left");
        showCombatMessage("PARRY", 620);
        setBossTell("");
        playAnimation("Stunned");
        bossAttack = null;
        hideAttackTelegraphs();
        nextBossAttackAt = now + 1250;
        return;
      }

      const damage =
        attack.kind === "hook" ? 13 : attack.kind === "combo" ? 9 : 6;
      applyPlayerDamage(
        damage,
        impactPoint,
        attack.kind === "hook" ? 1.25 : 0.85,
      );
    };

    const removeProjectile = (index: number) => {
      const projectile = projectiles[index];
      projectile.mesh.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material) => material.dispose());
        } else {
          mesh.material.dispose();
        }
      });
      scene.remove(projectile.mesh);
      projectiles.splice(index, 1);
    };

    const updateProjectiles = (delta: number, now: number) => {
      for (let index = projectiles.length - 1; index >= 0; index -= 1) {
        const projectile = projectiles[index];
        const previous = projectile.mesh.position.clone();
        projectile.velocity.y -= delta * 1.15;
        projectile.mesh.position.addScaledVector(projectile.velocity, delta);
        projectile.mesh.rotation.x += delta * 5.5;
        projectile.mesh.rotation.y += delta * 7.2;

        if (now - projectile.lastTrailAt > 58) {
          const trailPoint = projectile.mesh.position.clone();
          trailPoint.y = arenaSurfaceY;
          const from = worldToPaint(previous);
          const to = worldToPaint(trailPoint);
          strokeOrganicLine(from, to, "#14f1ff", 5, 0.8);
          projectile.lastTrailAt = now;
        }

        if (
          projectile.reflected &&
          bossModel &&
          distancePointToSegment2D(
            bossModel.position,
            previous,
            projectile.mesh.position,
          ) <=
            BOSS_RADIUS + projectile.radius
        ) {
          const hitPoint = bossModel.position
            .clone()
            .add(new THREE.Vector3(0, 1.1, 0));
          drawCombatMark("parry", bossModel.position, 1.2);
          triggerImpact("parry", hitPoint, "#ffd02f", 1.1);
          damageBoss(24, "left");
          removeProjectile(index);
          continue;
        }

        if (
          !projectile.reflected &&
          distancePointToSegment2D(
            camera.position,
            previous,
            projectile.mesh.position,
          ) <=
            PLAYER_RADIUS + projectile.radius &&
          Math.abs(projectile.mesh.position.y - camera.position.y) < 0.9
        ) {
          if (now <= parryUntil) {
            projectile.reflected = true;
            const target = bossModel
              ? bossModel.position.clone().add(new THREE.Vector3(0, 1.05, 0))
              : projectile.mesh.position
                  .clone()
                  .add(new THREE.Vector3(0, 0, -1));
            projectile.velocity
              .copy(target.sub(projectile.mesh.position).normalize())
              .multiplyScalar(8.2);
            triggerImpact(
              "parry",
              projectile.mesh.position,
              "#ffd02f",
              1.15,
            );
            drawCombatMark("parry", camera.position, 0.8);
            continue;
          }
          applyPlayerDamage(9, projectile.mesh.position, 0.8);
          drawCombatMark("jab", projectile.mesh.position, 1.15, false);
          removeProjectile(index);
          continue;
        }

        const outOfBounds =
          projectile.mesh.position.x < ARENA_MIN_X - 0.5 ||
          projectile.mesh.position.x > ARENA_MAX_X + 0.5 ||
          projectile.mesh.position.z < ARENA_MIN_Z - 0.5 ||
          projectile.mesh.position.z > ARENA_MAX_Z + 0.5;
        if (
          projectile.mesh.position.y <= arenaSurfaceY + 0.06 ||
          now >= projectile.expiresAt ||
          outOfBounds
        ) {
          const floorPoint = projectile.mesh.position.clone();
          floorPoint.y = arenaSurfaceY;
          drawCombatMark("jab", floorPoint, 0.9, false);
          removeProjectile(index);
        }
      }
    };

    const updateBossAI = (delta: number, now: number) => {
      if (!bossModel) return;
      const toPlayer = camera.position.clone().sub(bossModel.position).setY(0);
      const distance = Math.max(toPlayer.length(), 0.001);
      const towardPlayer = toPlayer.clone().divideScalar(distance);

      const facingDirection = bossAttack?.direction ?? towardPlayer;
      bossModel.rotation.y = THREE.MathUtils.lerp(
        bossModel.rotation.y,
        Math.atan2(facingDirection.x, facingDirection.z),
        Math.min(1, delta * 4.2),
      );

      if (bossAttack) {
        bossVelocity.multiplyScalar(Math.max(0, 1 - delta * 9));
        if (bossAttack.kind === "ropeRush" && now < bossAttack.impactAt) {
          const stagingProgress = THREE.MathUtils.smoothstep(
            (now - bossAttack.startedAt) /
              (bossAttack.impactAt - bossAttack.startedAt),
            0,
            1,
          );
          bossModel.position.lerp(
            bossAttack.origin,
            Math.min(1, 0.08 + stagingProgress * 0.1),
          );
        }
        return;
      }

      if (now >= nextBossStrafeAt) {
        bossStrafeDirection = Math.random() < 0.5 ? -1 : 1;
        nextBossStrafeAt = now + 700 + Math.random() * 900;
      }
      const lureReached =
        lureTarget !== null &&
        bossModel.position.distanceToSquared(lureTarget) < 0.42;
      const playerFollowed =
        lureTarget !== null &&
        Math.hypot(
          camera.position.x - lureTarget.x,
          camera.position.z - lureTarget.z,
        ) < 2.2;
      const lurePainted =
        lureTarget !== null && paintDensityAroundWorld(lureTarget) > 0.48;
      const lureExpired =
        lureTarget !== null && now - lureTargetChosenAt > 6800;
      if (
        now >= nextLureEvaluationAt &&
        (!lureTarget ||
          lureExpired ||
          (now >= lureCommitUntil &&
            ((lureReached && playerFollowed) || lurePainted)))
      ) {
        chooseLowPaintLureTarget(now);
      }

      const phase =
        bossHealthValue / bossMaxHealthValue > 0.66
          ? 1
          : bossHealthValue / bossMaxHealthValue > 0.33
            ? 2
            : 3;
      const desired = new THREE.Vector3();
      if (distance > 2.45) {
        desired.copy(towardPlayer).multiplyScalar(1.85 + phase * 0.24);
      } else if (distance < 1.38) {
        desired.copy(towardPlayer).multiplyScalar(-1.65 - phase * 0.16);
      } else {
        desired
          .set(towardPlayer.z, 0, -towardPlayer.x)
          .multiplyScalar(bossStrafeDirection * (1.28 + phase * 0.18));
        desired.addScaledVector(towardPlayer, (distance - 1.9) * 0.9);
      }

      if (lureTarget) {
        const toLure = lureTarget.clone().sub(bossModel.position).setY(0);
        const lureDistance = toLure.length();
        if (lureDistance > 0.22) {
          const lureDirection = toLure.divideScalar(lureDistance);
          const playerToLure = Math.hypot(
            camera.position.x - lureTarget.x,
            camera.position.z - lureTarget.z,
          );
          const lureDesired = lureDirection.multiplyScalar(
            1.65 + phase * 0.22,
          );
          const lureWeight =
            distance > 4.7
              ? 0.24
              : playerToLure < 1.8
                ? 0.32
                : THREE.MathUtils.clamp(0.58 + lureDistance * 0.035, 0.58, 0.74);
          desired.lerp(lureDesired, lureWeight);
        }
      }

      bossVelocity.lerp(desired, Math.min(1, delta * 2.8));
      bossModel.position.addScaledVector(bossVelocity, delta);
      bossModel.position.x = THREE.MathUtils.clamp(
        bossModel.position.x,
        ARENA_MIN_X + BOSS_RADIUS,
        ARENA_MAX_X - BOSS_RADIUS,
      );
      bossModel.position.z = THREE.MathUtils.clamp(
        bossModel.position.z,
        ARENA_MIN_Z + BOSS_RADIUS,
        ARENA_MAX_Z - BOSS_RADIUS,
      );
      const speedSq = bossVelocity.lengthSq();
      const walkThreshold =
        currentAnimationName === "Walking" ? 0.045 : 0.16;
      playAnimation(speedSq > walkThreshold ? "Walking" : "Idle");
    };

    const updateRopeRush = (now: number) => {
      if (
        !bossModel ||
        !bossAttack ||
        bossAttack.kind !== "ropeRush" ||
        now < bossAttack.impactAt
      ) {
        return;
      }
      const attack = bossAttack;
      const activeEnd = attack.impactAt + 700;
      if (now <= activeEnd) {
        const previous = bossModel.position.clone();
        const progress = THREE.MathUtils.smoothstep(
          (now - attack.impactAt) / (activeEnd - attack.impactAt),
          0,
          1,
        );
        bossModel.position.lerpVectors(attack.origin, attack.target, progress);
        playAnimation("Walking");
        const overlap =
          distancePointToSegment2D(
            camera.position,
            previous,
            bossModel.position,
          ) <=
          PLAYER_RADIUS + attack.hitRadius;
        if (overlap && !attack.hitPlayer) {
          attack.hitPlayer = true;
          const impactPoint = bossModel.position
            .clone()
            .add(new THREE.Vector3(0, 1.05, 0));
          if (now <= parryUntil) {
            drawCombatMark("parry", bossModel.position, 1.4);
            triggerImpact("parry", impactPoint, "#ffd02f", 1.25);
            damageBoss(20, "left");
            showCombatMessage("ROPE CUT", 720);
          } else {
            applyPlayerDamage(18, impactPoint, 1);
          }
        }
      } else {
        playAnimation("Stunned");
      }
    };

    const updateHandlerRig = (now: number) => {
      const ropeAttack =
        bossAttack?.kind === "ropeRush" ? bossAttack : null;
      if (ropeAttack) {
        const stageProgress = THREE.MathUtils.clamp(
          (now - ropeAttack.startedAt) /
            Math.max(1, ropeAttack.impactAt - ropeAttack.startedAt),
          0,
          1,
        );
        const runProgress =
          now < ropeAttack.impactAt
            ? stageProgress * 0.2
            : 0.2 +
              THREE.MathUtils.clamp(
                (now - ropeAttack.impactAt) / 700,
                0,
                1,
              ) *
                0.8;
        handlerGroup.position.x = THREE.MathUtils.lerp(
          ropeAttack.origin.x,
          ropeAttack.target.x,
          runProgress,
        );
        handlerGroup.position.y =
          arenaSurfaceY + Math.abs(Math.sin(now * 0.018)) * 0.08;
        handlerLeftArm.rotation.z = -1.15 + Math.sin(now * 0.022) * 0.3;
        handlerRightArm.rotation.z = 1.15 - Math.sin(now * 0.022) * 0.3;
      } else {
        handlerGroup.position.x = Math.sin(now * 0.00038) * 2.6;
        handlerGroup.position.y =
          arenaSurfaceY + Math.abs(Math.sin(now * 0.004)) * 0.035;
        handlerLeftArm.rotation.z = -0.72;
        handlerRightArm.rotation.z = 0.72;
      }

      if (!bossModel || !ropeAttack) return;
      const activeBoss = bossModel;
      handlerGroup.updateMatrixWorld(true);
      activeBoss.updateMatrixWorld(true);
      puppetLines.forEach((line, index) => {
        const positions = line.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        const hand = new THREE.Vector3(
          index === 0 ? -0.36 : 0.36,
          1.12,
          0,
        );
        handlerGroup.localToWorld(hand);
        const bossPoint = activeBoss.position
          .clone()
          .add(new THREE.Vector3(index === 0 ? -0.22 : 0.22, 1.45, 0));
        positions.setXYZ(0, hand.x, hand.y, hand.z);
        positions.setXYZ(1, bossPoint.x, bossPoint.y, bossPoint.z);
        positions.needsUpdate = true;
      });
    };

    const enforceFighterSeparation = () => {
      if (!bossModel) return;
      const separation = camera.position.clone().sub(bossModel.position).setY(0);
      let distance = separation.length();
      if (distance < 0.001) {
        separation.set(1, 0, 0);
        distance = 1;
      }
      const minimum = PLAYER_RADIUS + BOSS_RADIUS;
      if (distance >= minimum) return;
      const correction = separation
        .divideScalar(distance)
        .multiplyScalar(minimum - distance);
      camera.position.addScaledVector(correction, 0.68);
      bossModel.position.addScaledVector(correction, -0.32);
      camera.position.x = THREE.MathUtils.clamp(
        camera.position.x,
        ARENA_MIN_X + PLAYER_RADIUS,
        ARENA_MAX_X - PLAYER_RADIUS,
      );
      camera.position.z = THREE.MathUtils.clamp(
        camera.position.z,
        ARENA_MIN_Z + PLAYER_RADIUS,
        ARENA_MAX_Z - PLAYER_RADIUS,
      );
    };

    const updateImpactParticles = (delta: number, now: number) => {
      if (activeImpactParticles === 0) return;
      let matrixDirty = false;
      for (let slot = 0; slot < IMPACT_PARTICLE_CAPACITY; slot += 1) {
        const particle = impactParticleSlots[slot];
        if (!particle) continue;

        particle.velocity.y -= delta * 5.4;
        particle.position.addScaledVector(particle.velocity, delta);
        particle.scale *= 1 + delta * 0.32;

        if (!particle.landed && particle.position.y <= arenaSurfaceY + 0.035) {
          particle.landed = true;
          const point = worldToPaint(particle.position);
          registerPaintDisk(point, 4 + particle.scale * 18);
          paint.context.fillStyle = particle.color;
          paint.context.beginPath();
          paint.context.arc(
            point.x,
            point.y,
            3 + particle.scale * 14,
            0,
            Math.PI * 2,
          );
          paint.context.fill();
          markPaintTextureDirty();
        }

        if (particle.landed || now >= particle.expiresAt) {
          impactParticleSlots[slot] = null;
          activeImpactParticles -= 1;
          impactDummy.position.set(0, -1000, 0);
          impactDummy.scale.setScalar(0);
          impactDummy.updateMatrix();
          impactParticleMesh.setMatrixAt(slot, impactDummy.matrix);
          matrixDirty = true;
          continue;
        }

        impactDummy.position.copy(particle.position);
        impactDummy.scale.setScalar(particle.scale);
        impactDummy.updateMatrix();
        impactParticleMesh.setMatrixAt(slot, impactDummy.matrix);
        matrixDirty = true;
      }
      if (matrixDirty) {
        impactParticleMesh.instanceMatrix.needsUpdate = true;
      }
    };

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    const render = () => {
      const rawDelta = Math.min(clock.getDelta(), 0.05);
      const now = performance.now();
      const finisherFrozen =
        phaseValue === "reveal" && now < finisherFreezeUntil;
      const delta = now < hitStopUntil || finisherFrozen ? 0 : rawDelta;
      mixer?.update(delta);
      updateImpactParticles(
        finisherFrozen ? 0 : rawDelta,
        finisherFrozen ? revealStartedAt : now,
      );
      updateProjectiles(delta, finisherFrozen ? revealStartedAt : now);
      if (
        phaseValue === "fighting" ||
        (bossAttack !== null && bossAttack.kind === "ropeRush")
      ) {
        updateHandlerRig(finisherFrozen ? revealStartedAt : now);
      }
      updateCrowd(finisherFrozen ? revealStartedAt : now);

      if (bossModel && bossNeedsGrounding) {
        bossModel.updateMatrixWorld(true);
        const bossBox = new THREE.Box3().setFromObject(bossModel);
        const correction = arenaSurfaceY - bossBox.min.y + 0.02;
        if (Number.isFinite(correction)) {
          bossModel.position.y += correction;
          bossGroundOffset = bossModel.position.y;
          bossModel.updateMatrixWorld(true);
        }
        bossNeedsGrounding = false;
      } else if (bossModel && Number.isFinite(bossGroundOffset)) {
        bossModel.position.y = bossGroundOffset;
      }

      if (phaseValue === "loading") {
        firstPersonRig.visible = false;
        const previewAngle = now * 0.000105 - Math.PI * 0.22;
        const previewTarget = new THREE.Vector3(0, arenaSurfaceY + 1.05, -0.45);
        camera.up.set(0, 1, 0);
        camera.position.set(
          Math.cos(previewAngle) * 17.2,
          arenaSurfaceY + 7.1 + Math.sin(now * 0.00031) * 0.45,
          Math.sin(previewAngle) * 17.2 - 0.7,
        );
        camera.lookAt(previewTarget);
        controls.target.copy(previewTarget);
        if (bossModel) {
          bossModel.visible = true;
          bossModel.rotation.y = Math.atan2(
            camera.position.x - bossModel.position.x,
            camera.position.z - bossModel.position.z,
          );
        }
      } else if (phaseValue === "fighting" && bossModel) {
        if (stretchCharging && now - lastStretchChargeUiAt > 45) {
          const charge = THREE.MathUtils.clamp(
            (now - stretchChargeStartedAt) / 1550,
            0,
            1,
          );
          setStretchCharge(Math.round(charge * 100));
          lastStretchChargeUiAt = now;
        }

        const moveX =
          (pressedKeys.has("d") || pressedKeys.has("arrowright") ? 1 : 0) -
          (pressedKeys.has("a") || pressedKeys.has("arrowleft") ? 1 : 0);
        const moveZ =
          (pressedKeys.has("s") || pressedKeys.has("arrowdown") ? 1 : 0) -
          (pressedKeys.has("w") || pressedKeys.has("arrowup") ? 1 : 0);
        moveInput.set(moveX, moveZ);
        if (moveInput.lengthSq() > 0) {
          lastPlayerMoveAt = now;
          moveInput.normalize();
          camera.getWorldDirection(moveForward);
          moveForward.y = 0;
          moveForward.normalize();
          moveRight.set(-moveForward.z, 0, moveForward.x);
          moveDelta
            .copy(moveRight)
            .multiplyScalar(moveInput.x)
            .addScaledVector(moveForward, -moveInput.y)
            .normalize();
          const sprinting = pressedKeys.has("shift");
          const speed =
            (sprinting ? 7.05 : 4.7) * (stretchCharging ? 0.58 : 1);
          camera.position.x = THREE.MathUtils.clamp(
            camera.position.x + moveDelta.x * speed * delta,
            ARENA_MIN_X + PLAYER_RADIUS,
            ARENA_MAX_X - PLAYER_RADIUS,
          );
          camera.position.z = THREE.MathUtils.clamp(
            camera.position.z + moveDelta.z * speed * delta,
            ARENA_MIN_Z + PLAYER_RADIUS,
            ARENA_MAX_Z - PLAYER_RADIUS,
          );

          if (
            now - lastMovementPaintAt > 90 &&
            (!lastMovementWorld ||
              lastMovementWorld.distanceToSquared(camera.position) > 0.01)
          ) {
            const point = worldToPaint(camera.position);
            if (lastMovementPoint) {
              strokeOrganicLine(
                lastMovementPoint,
                point,
                movementPaintColor,
                sprinting ? 18 : 13,
                sprinting ? 0.85 : 0.5,
              );
            }
            lastMovementPoint = point;
            if (lastMovementWorld) {
              lastMovementWorld.copy(camera.position);
            } else {
              lastMovementWorld = camera.position.clone();
            }
            lastMovementPaintAt = now;
            markFreshCanvas(camera.position, sprinting ? 7 : 6);
          }
        } else {
          lastMovementPoint = null;
          lastMovementWorld = null;
        }

        updateBossAI(delta, now);
        updateRopeRush(now);
        enforceFighterSeparation();
        camera.position.y = arenaSurfaceY + 1.55;
        camera.rotation.set(cameraPitch, cameraYaw, 0, "YXZ");

        if (now - lastBossPaintAt > 100) {
          const bossPoint = worldToPaint(bossModel.position);
          if (
            lastBossPaintPoint &&
            lastBossPaintPoint.distanceToSquared(bossPoint) > 3.5
          ) {
            strokeOrganicLine(
              lastBossPaintPoint,
              bossPoint,
              VISIBLE_PAINT_COLORS[
                (Math.floor(now / 1600) * 3 + 13) %
                  VISIBLE_PAINT_COLORS.length
              ],
              10,
              0.42,
            );
          }
          lastBossPaintPoint = bossPoint;
          lastBossPaintAt = now;
        }

        if (pendingPlayerHit && now >= pendingPlayerHit.resolvesAt) {
          const pending = pendingPlayerHit;
          pendingPlayerHit = null;
          resolvePlayerHit(pending.kind, pending.charge);
        }

        if (!bossAttack && now >= nextBossAttackAt) {
          beginBossAttack(now);
        }

        if (bossAttack && now >= bossAttack.impactAt && !bossAttack.resolved) {
          const attack = bossAttack;
          attack.resolved = true;
          resolveBossAttack(attack, now);
          if (attack.kind !== "ropeRush") attackMarker.visible = false;
        }

        if (bossAttack && now >= bossAttack.recoverAt) {
          const finishedKind = bossAttack.kind;
          bossAttack = null;
          setBossTell("");
          hideAttackTelegraphs();
          if (finishedKind === "feint") {
            forcedNextAttack = "hook";
            nextBossAttackAt = now + 90;
          } else {
            const pressure = 1 - bossHealthValue / bossMaxHealthValue;
            nextBossAttackAt =
              now +
              1150 +
              Math.random() * 600 -
              pressure * 250 +
              (easyModeActive ? 500 : 0);
          }
          playAnimation("Idle");
        }

        if (bossAttack && now < bossAttack.impactAt) {
          const pulse = 0.62 + Math.sin(now * 0.018) * 0.2;
          (attackMarker.material as THREE.MeshBasicMaterial).opacity = pulse;
          (chargeLane.material as THREE.MeshBasicMaterial).opacity =
            0.22 + Math.sin(now * 0.022) * 0.1;
        }
      } else if (phaseValue === "reveal") {
        const target = paintPlane.position.clone();
        const elapsed = now - revealStartedAt;
        const crowdMoveProgress = THREE.MathUtils.clamp(
          (elapsed - 1450) / 1650,
          0,
          1,
        );
        const craneProgress = THREE.MathUtils.clamp(
          (elapsed - 5600) / 3300,
          0,
          1,
        );
        const settleProgress = THREE.MathUtils.clamp(
          (elapsed - 8900) / 900,
          0,
          1,
        );
        const crowdMoveEase = THREE.MathUtils.smootherstep(
          crowdMoveProgress,
          0,
          1,
        );
        const craneEase = THREE.MathUtils.smootherstep(craneProgress, 0, 1);
        const settleEase = THREE.MathUtils.smoothstep(settleProgress, 0, 1);
        const fightFocus = bossModel?.position
          .clone()
          .add(new THREE.Vector3(0, 1.05, 0)) ?? target.clone();
        const crowdScanPosition = new THREE.Vector3(
          0,
          arenaSurfaceY + 4.65,
          9.4,
        );
        const overheadPosition = target
          .clone()
          .add(new THREE.Vector3(0.3, 15.6, 0.38));
        const finalPosition = target
          .clone()
          .add(new THREE.Vector3(0, 15.25, 0.01));

        let lookTarget = bossModel?.position
          .clone()
          .add(new THREE.Vector3(0, 1.05, 0)) ?? target.clone();

        if (elapsed < 1450 && bossModel && revealWon) {
          if (!finisherFlightStarted) {
            finisherFlightStarted = true;
            finisherFlightLastAt = now;
            drawOrganicSplat(
              paint.context,
              lastFinisherPaintPoint?.x ?? paint.canvas.width * 0.5,
              lastFinisherPaintPoint?.y ?? paint.canvas.height * 0.5,
              72,
              finisherPaintColor,
              1.7,
            );
            markPaintTextureDirty();
          }
          const flightDelta = THREE.MathUtils.clamp(
            (now - finisherFlightLastAt) / 1000,
            0,
            0.05,
          );
          finisherFlightLastAt = now;
          finisherVelocity.y -= flightDelta * 6.4;
          bossModel.position.addScaledVector(finisherVelocity, flightDelta);
          bossModel.rotation.x += flightDelta * 5.8;
          bossModel.rotation.z += flightDelta * 7.4;
          bossModel.updateMatrixWorld(true);

          const floorWorld = bossModel.position.clone();
          floorWorld.y = arenaSurfaceY;
          const flightPaintPoint = worldToPaint(floorWorld);
          if (lastFinisherPaintPoint) {
            strokeOrganicLine(
              lastFinisherPaintPoint,
              flightPaintPoint,
              finisherPaintColor,
              22 + Math.sin(now * 0.021) * 5,
              1.28,
            );
          }
          if (now - lastFinisherPaintAt > 68) {
            drawOrganicSplat(
              paint.context,
              flightPaintPoint.x,
              flightPaintPoint.y,
              11 + Math.random() * 13,
              finisherPaintColor,
              0.75 + Math.random() * 0.5,
              Math.atan2(finisherVelocity.z, finisherVelocity.x),
            );
            registerPaintDisk(flightPaintPoint, 24);
            spawnImpactParticles(
              bossModel.position.clone().add(new THREE.Vector3(0, 0.45, 0)),
              finisherPaintColor,
              7,
              1.35,
            );
            lastFinisherPaintAt = now;
            markPaintTextureDirty();
          }
          lastFinisherPaintPoint = flightPaintPoint;

          const flightProgress = THREE.MathUtils.smootherstep(
            THREE.MathUtils.clamp(elapsed / 1450, 0, 1),
            0,
            1,
          );
          const flightCamera = revealStartPosition
            .clone()
            .add(new THREE.Vector3(0, 1.35, 2.4));
          camera.position.lerpVectors(
            revealStartPosition,
            flightCamera,
            flightProgress,
          );
          lookTarget.copy(bossModel.position).add(new THREE.Vector3(0, 0.7, 0));
        } else if (elapsed < 3100) {
          const postFreezePosition = revealWon
            ? revealStartPosition.clone().add(new THREE.Vector3(0, 1.35, 2.4))
            : revealStartPosition.clone();
          camera.position.lerpVectors(
            postFreezePosition,
            crowdScanPosition,
            crowdMoveEase,
          );
        } else if (elapsed < 5600) {
          camera.position.copy(crowdScanPosition);
        } else if (elapsed < 8900) {
          camera.position.lerpVectors(
            crowdScanPosition,
            overheadPosition,
            craneEase,
          );
        } else {
          camera.position.lerpVectors(
            overheadPosition,
            finalPosition,
            settleEase,
          );
        }

        const crowdEntry = THREE.MathUtils.smootherstep(
          THREE.MathUtils.clamp((elapsed - 1450) / 1500, 0, 1),
          0,
          1,
        );
        const crowdScan = THREE.MathUtils.smootherstep(
          THREE.MathUtils.clamp((elapsed - 2950) / 2450, 0, 1),
          0,
          1,
        );
        const paintingFocus = THREE.MathUtils.smootherstep(
          THREE.MathUtils.clamp((elapsed - 5600) / 2900, 0, 1),
          0,
          1,
        );
        const leftCrowd = new THREE.Vector3(
          -10.2,
          arenaSurfaceY + 2.65,
          -12.3,
        );
        const rightCrowd = new THREE.Vector3(
          10.2,
          arenaSurfaceY + 2.65,
          -12.3,
        );
        const crowdFocus = leftCrowd.lerp(rightCrowd, crowdScan);
        if (elapsed >= 1450) {
          lookTarget = fightFocus
            .clone()
            .lerp(crowdFocus, crowdEntry)
            .lerp(target, paintingFocus);
        }
        const overheadBlend = THREE.MathUtils.smootherstep(
          THREE.MathUtils.clamp((elapsed - 5900) / 2500, 0, 1),
          0,
          1,
        );
        const cameraUp = new THREE.Vector3(0, 1, 0)
          .lerp(new THREE.Vector3(0, 0, -1), overheadBlend)
          .normalize();
        const lookMatrix = new THREE.Matrix4().lookAt(
          camera.position,
          lookTarget,
          cameraUp,
        );
        const cinematicQuaternion = new THREE.Quaternion().setFromRotationMatrix(
          lookMatrix,
        );
        camera.quaternion.slerp(
          cinematicQuaternion,
          elapsed < 5600 ? 0.075 : 0.11,
        );
        firstPersonRig.visible = elapsed < 220;
        if (bossModel) bossModel.visible = revealWon ? elapsed < 1650 : true;

        if (elapsed >= 9800 && !revealFinished) {
          revealFinished = true;
          phaseValue = revealWon ? "artwork" : "lost";
          setGamePhase(revealWon ? "artwork" : "lost");
          setCombatMessage("");
          camera.up.set(0, 0, -1);
          controls.target.copy(target);
          controls.minDistance = 10;
          controls.maxDistance = 18;
          controls.maxPolarAngle = Math.PI * 0.16;
          controls.enabled = true;
          controls.update();
        }
      } else {
        controls.update();
      }

      updateArm(leftArm, activePunch, now);
      updateArm(rightArm, activePunch, now);
      if (bossModel && phaseValue !== "reveal") {
        if (now < bossImpactUntil) {
          const impactProgress = THREE.MathUtils.clamp(
            (now - bossImpactStartedAt) /
              Math.max(1, bossImpactUntil - bossImpactStartedAt),
            0,
            1,
          );
          const deformation =
            Math.sin(impactProgress * Math.PI) * bossImpactStrength;
          bossModel.scale.set(
            baseCharacterScale * (1 + deformation * 0.11),
            baseCharacterScale * (1 - deformation * 0.14),
            baseCharacterScale * (1 + deformation * 0.08),
          );
          bossModel.rotation.z = -deformation * 0.1;
          rightArm.gloveAnchor.scale.set(
            0.86,
            1.08 + deformation * 0.04,
            1.1 + deformation * 0.03,
          );
        } else {
          bossModel.scale.setScalar(baseCharacterScale);
          bossModel.rotation.z = THREE.MathUtils.lerp(
            bossModel.rotation.z,
            0,
            Math.min(1, rawDelta * 18),
          );
          rightArm.gloveAnchor.scale.lerp(
            unitScaleOne,
            Math.min(1, rawDelta * 20),
          );
          bossImpactStrength = 0;
        }
      }
      if (activePunch?.kind === "hook") {
        const hookProgress = THREE.MathUtils.clamp(
          (now - activePunch.startedAt) / 620,
          0,
          1,
        );
        const torsoDrive = Math.sin(
          THREE.MathUtils.clamp((hookProgress - 0.12) / 0.62, 0, 1) * Math.PI,
        );
        firstPersonRig.rotation.y = -torsoDrive * 0.13;
        firstPersonRig.rotation.z = -torsoDrive * 0.055;
        firstPersonRig.position.x = -torsoDrive * 0.045;
      } else {
        firstPersonRig.rotation.y = THREE.MathUtils.lerp(
          firstPersonRig.rotation.y,
          0,
          0.18,
        );
        firstPersonRig.rotation.z = THREE.MathUtils.lerp(
          firstPersonRig.rotation.z,
          0,
          0.18,
        );
        firstPersonRig.position.x = THREE.MathUtils.lerp(
          firstPersonRig.position.x,
          0,
          0.18,
        );
      }

      if (
        activePunch &&
        now - activePunch.startedAt >
          (activePunch.kind === "stretch"
            ? 820 + activePunch.charge * 180
            : activePunch.kind === "hook"
              ? 650
              : 365)
      ) {
        activePunch = null;
      }

      if (combatMessageUntil && now >= combatMessageUntil) {
        combatMessageUntil = 0;
        setCombatMessage("");
      }

      fovKick = THREE.MathUtils.lerp(
        fovKick,
        0,
        Math.min(1, rawDelta * 10),
      );
      const hookAnticipation =
        activePunch?.kind === "hook"
          ? -1.8 *
            Math.sin(
              THREE.MathUtils.clamp(
                (now - activePunch.startedAt) / 255,
                0,
                1,
              ) * Math.PI,
            )
          : 0;
      camera.fov = 47 + (reducedMotion ? 0 : fovKick + hookAnticipation);
      if (Math.abs(camera.fov - lastAppliedFov) > 0.05) {
        camera.updateProjectionMatrix();
        lastAppliedFov = camera.fov;
      }

      const baseCameraRoll = camera.rotation.z;
      if (
        !reducedMotion &&
        phaseValue === "fighting" &&
        (cameraShake > 0.001 || impactRoll > 0.001)
      ) {
        const trauma = cameraShake * cameraShake;
        cameraShakeOffset.set(
          (Math.random() - 0.5) * trauma,
          (Math.random() - 0.5) * trauma * 0.7,
          (Math.random() - 0.5) * trauma * 0.45 - impactRoll * 1.7,
        );
        camera.position.add(cameraShakeOffset);
        camera.rotation.z +=
          impactRoll + (Math.random() - 0.5) * trauma * 0.12;
      } else {
        cameraShakeOffset.set(0, 0, 0);
      }
      cameraShake = THREE.MathUtils.lerp(
        cameraShake,
        0,
        Math.min(1, rawDelta * 10),
      );
      impactRoll = THREE.MathUtils.lerp(
        impactRoll,
        0,
        Math.min(1, rawDelta * 14),
      );
      if (paintTextureDirty) {
        paintTexture.needsUpdate = true;
        paintTextureDirty = false;
      }
      outlineEffect.render(scene, camera);
      if (cameraShakeOffset.lengthSq() > 0) {
        camera.position.sub(cameraShakeOffset);
      }
      camera.rotation.z = baseCameraRoll;
      animationFrame = requestAnimationFrame(render);
    };
    render();

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("pointermove", onAimPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("pointerlockerror", onPointerLockError);
      controls.dispose();
      crowdGroup.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material) => material.dispose());
        } else {
          mesh.material.dispose();
        }
      });
      renderer.dispose();
      paintTexture.dispose();
      impactParticleGeometry.dispose();
      impactParticleMaterial.dispose();
      toonGradient.dispose();
      whiteOutline.dispose();
      blackOutline.dispose();
      auditoryArt.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
      actionsRef.current = null;
    };
  }, []);

  return (
    <main className={`asset-lab phase-${gamePhase}`}>
      <div ref={mountRef} className="viewport" aria-label="3D boxing arena" />
      <div ref={flashRef} className="impact-flash" aria-hidden="true" />
      <div
        ref={impactFrameRef}
        className="impact-frame"
        aria-hidden="true"
      >
        <span className="impact-frame-wash" />
        <span className="impact-frame-blot">
          {Array.from({ length: 12 }, (_, index) => (
            <i key={index} />
          ))}
        </span>
        <span className="impact-frame-scrape" />
      </div>

      {gamePhase === "fighting" && (
        <section className="fight-hud" aria-label="Fight health">
          <div className="health-block player-health">
            <div className="health-label">
              <span>HP // You</span>
              <strong>{playerHealth}</strong>
            </div>
            <div
              className="health-track"
              role="progressbar"
              aria-label="Player health"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={playerHealth}
            >
              <span style={{ width: `${playerHealth}%` }} />
            </div>
          </div>
          <div className="health-block boss-health">
            <div className="health-label">
              <strong>{bossHealth}</strong>
              <span>{BOSS_NAME}</span>
            </div>
            <div
              className="health-track"
              role="progressbar"
              aria-label="Boss health"
              aria-valuemin={0}
              aria-valuemax={bossMaxHealth}
              aria-valuenow={bossHealth}
            >
              <span
                style={{ width: `${(bossHealth / bossMaxHealth) * 100}%` }}
              />
            </div>
          </div>
        </section>
      )}

      {gamePhase === "fighting" && soundCombo > 1 && (
        <div className="sound-combo" role="status" aria-live="polite">
          <span>Sonic combo</span>
          <strong>×{soundCombo}</strong>
          <i aria-hidden="true" />
          <i aria-hidden="true" />
          <i aria-hidden="true" />
          <i aria-hidden="true" />
        </div>
      )}

      {(gamePhase === "loading" || gamePhase === "ready") && (
        <section className="start-experience" aria-label="Boxing Canvas">
          <h2 className="paint-title" aria-label="Boxing Canvas">
            <span aria-hidden="true">
              <i>B</i><i>o</i><i>x</i><i>i</i><i>n</i><i>g</i>
            </span>
            <strong aria-hidden="true">
              <i>C</i><i>a</i><i>n</i><i>v</i><i>a</i><i>s</i>
            </strong>
          </h2>
          <p className="paint-subtitle" aria-label="Fight to the death">
            <span aria-hidden="true">
              <i>f</i>
              <i>i</i>
              <i>g</i>
              <i>h</i>
              <i>t</i>
              <i className="paint-space"> </i>
              <i>t</i>
              <i>o</i>
              <i className="paint-space"> </i>
              <i>t</i>
              <i>h</i>
              <i>e</i>
              <i className="paint-space"> </i>
              <i>d</i>
              <i>e</i>
              <i>a</i>
              <i>t</i>
              <i>h</i>
            </span>
          </p>
          <p
            className="auditory-tagline"
            aria-label="Every brushstroke becomes a note"
          >
            <span className="sonic-wave" aria-hidden="true">
              <i /><i /><i /><i /><i />
            </span>
            <span className="sonic-phrase" aria-hidden="true">
              {["Every", "brushstroke", "becomes", "a", "note"].map(
                (word) => (
                  <strong className="sonic-word" key={word}>
                    {Array.from(word).map((letter, index) => (
                      <i key={`${word}-${index}`}>{letter}</i>
                    ))}
                  </strong>
                ),
              )}
            </span>
            <span className="sonic-wave sonic-wave-reverse" aria-hidden="true">
              <i /><i /><i /><i /><i />
            </span>
          </p>
          <label className="easy-mode-toggle">
            <input
              type="checkbox"
              checked={easyMode}
              onChange={(event) => setEasyMode(event.target.checked)}
            />
            Easy mode
          </label>
          <div className="control-cheatsheet" aria-label="Controls">
            <span>
              <kbd>W A S D</kbd> <kbd>↑ ↓ ← →</kbd> Move
            </span>
            <span>
              <kbd>Space</kbd> <kbd>E</kbd> Hook
            </span>
            <span>
              <kbd>Q</kbd> Jab · <kbd>R</kbd> Stretch
            </span>
            <span>
              <kbd>F</kbd> Parry · <kbd>Shift</kbd> Dash
            </span>
          </div>
          <button
            className="enter-button"
            type="button"
            disabled={!allAssetsReady}
            onClick={() => actionsRef.current?.startFight()}
          >
            Start
          </button>
        </section>
      )}

      {gamePhase === "fighting" && (
        <>
          <div className="movement-hint" aria-label="Movement controls">
            <strong>Move</strong>
            <div className="movement-keys">
              <kbd>W A S D</kbd>
              <kbd>↑ ↓ ← →</kbd>
            </div>
            <span>Mouse aim · Shift dash/sprint</span>
          </div>
          <div className="combat-controls" aria-label="Combat controls">
            <button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                actionsRef.current?.punch("left");
              }}
            >
              <kbd>Q</kbd> Jab
            </button>
            <button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                actionsRef.current?.punch("hook");
              }}
            >
              <kbd>Space</kbd> <kbd>E</kbd> Hook
            </button>
            <button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                actionsRef.current?.beginStretchCharge();
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                actionsRef.current?.releaseStretchCharge();
              }}
              onPointerCancel={() => actionsRef.current?.releaseStretchCharge()}
            >
              <kbd>R</kbd> Hold stretch
            </button>
            <button
              className={parryActive ? "active" : ""}
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                actionsRef.current?.parry();
              }}
            >
              <kbd>F</kbd> Parry
            </button>
          </div>
          {!aimLocked && (
            <div className="aim-lock-hint" role="status">
              Click the ring to free-look with no edge limit
            </div>
          )}
          {stretchCharge > 0 && (
            <div className="stretch-charge" role="status">
              <span>Stretch pressure</span>
              <div className="stretch-charge-track">
                <i style={{ width: `${stretchCharge}%` }} />
              </div>
              <strong>{stretchCharge}%</strong>
            </div>
          )}
          <div className="reticle" aria-hidden="true">
            <span className="reticle-dot" />
          </div>
        </>
      )}

      {bossTell && gamePhase === "fighting" && (
        <div
          className={`boss-tell ${
            bossTell.includes("HOOK") ? "danger" : ""
          }`}
          role="status"
        >
          {bossTell}
        </div>
      )}

      {combatMessage && (
        <div className="combat-message" aria-live="polite">
          {combatMessage}
        </div>
      )}

      {gamePhase === "lost" && (
        <section className="lost-card" aria-labelledby="loss-title">
          <p id="loss-title" className="lost-message">
            Better luck next time.
          </p>
          <div className="artwork-actions">
            <button
              type="button"
              onClick={() => actionsRef.current?.savePainting()}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => actionsRef.current?.playAgain()}
            >
              Try again
            </button>
          </div>
        </section>
      )}

      {gamePhase === "reveal" && (
        <div className="cinematic-bars" aria-hidden="true" />
      )}

      {gamePhase === "artwork" && (
        <section className="artwork-card" aria-label="Painting actions">
          <div className="artwork-actions">
            <button
              type="button"
              onClick={() => actionsRef.current?.savePainting()}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => actionsRef.current?.playAgain()}
            >
              Try again
            </button>
          </div>
        </section>
      )}

      {loadingMessage && (
        <div className="loading" role="status" aria-live="polite">
          {loadingMessage}
        </div>
      )}

      {fatalError && (
        <div className="fatal" role="alert">
          Fight setup error: {fatalError}
        </div>
      )}
    </main>
  );
}
