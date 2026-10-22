import { useEffect, useMemo, useRef } from "react";

// A WebGL-free 3D route visualization drawn on a 2D canvas. Used as the fallback
// when the browser can't create a WebGL context (maplibre needs WebGL). It fetches
// real Esri World Imagery satellite tiles for the route area, tilts them into
// perspective, and flies the route/aircraft above. No WebGL, no Google.

export interface Pt { lat: number; lng: number }

interface Props {
  routes: Pt[][];
  progress?: number;
  animate?: boolean;
  durationSec?: number;
  rotate?: boolean;
  interactive?: boolean;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
  label?: string;
}

const DEG = Math.PI / 180;
const G = 1.7;
const TILE = 256;
const SUBDIV = 12;

const lon2tile = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2tile = (lat: number, z: number) => {
  const r = lat * DEG;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

interface Geo { clat: number; clng: number; cosLat: number; scale: number }

function computeGeo(routes: Pt[][]): Geo | null {
  const all = routes.flat();
  if (all.length === 0) return null;
  const clat = all.reduce((s, p) => s + p.lat, 0) / all.length;
  const clng = all.reduce((s, p) => s + p.lng, 0) / all.length;
  const cosLat = Math.cos(clat * DEG);
  let max = 0;
  for (const p of all) max = Math.max(max, Math.abs((p.lng - clng) * cosLat), Math.abs(p.lat - clat));
  const scale = max > 1e-9 ? 0.95 / max : 4000;
  return { clat, clng, cosLat, scale };
}

const toLocal = (g: Geo, lat: number, lng: number): [number, number] =>
  [(lng - g.clng) * g.cosLat * g.scale, (lat - g.clat) * g.scale];
const toGeo = (g: Geo, x: number, z: number) =>
  ({ lng: g.clng + x / (g.cosLat * g.scale), lat: g.clat + z / g.scale });

function lerp(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function along(poly: [number, number][], t: number) {
  if (poly.length < 2) { const p = poly[0] ?? [0, 0]; return { x: p[0], z: p[1], alt: 0 }; }
  const tt = Math.max(0, Math.min(1, t));
  const f = tt * (poly.length - 1);
  const i = Math.min(Math.floor(f), poly.length - 2);
  const [x, z] = lerp(poly[i], poly[i + 1], f - i);
  return { x, z, alt: 0.5 + Math.sin(tt * Math.PI) * 0.32 };
}

// Affine-map a source triangle of `img` onto a destination triangle (clipped) —
// subdividing the plane into a mesh approximates perspective on a 2D canvas.
function texTri(
  ctx: CanvasRenderingContext2D, img: CanvasImageSource,
  sx0: number, sy0: number, sx1: number, sy1: number, sx2: number, sy2: number,
  dx0: number, dy0: number, dx1: number, dy1: number, dx2: number, dy2: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dx0, dy0); ctx.lineTo(dx1, dy1); ctx.lineTo(dx2, dy2); ctx.closePath();
  ctx.clip();
  const u1 = sx1 - sx0, v1 = sy1 - sy0, u2 = sx2 - sx0, v2 = sy2 - sy0;
  const det = u1 * v2 - u2 * v1;
  if (Math.abs(det) < 1e-6) { ctx.restore(); return; }
  const px1 = dx1 - dx0, py1 = dy1 - dy0, px2 = dx2 - dx0, py2 = dy2 - dy0;
  const a = (v2 * px1 - v1 * px2) / det;
  const b = (v2 * py1 - v1 * py2) / det;
  const c = (u1 * px2 - u2 * px1) / det;
  const d = (u1 * py2 - u2 * py1) / det;
  const e = dx0 - a * sx0 - c * sy0;
  const f = dy0 - b * sx0 - d * sy0;
  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

interface MapTex { canvas: HTMLCanvasElement; originPxX: number; originPxY: number; z: number; ready: boolean }

export default function Map3D({
  routes, progress, animate = false, durationSec = 16, rotate = false,
  interactive = false, color = "#e05644", className, style, label,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const yawRef = useRef(-0.6);
  const dragRef = useRef<{ x: number; last: number } | null>(null);
  const progressRef = useRef(progress ?? 0);
  progressRef.current = progress ?? 0;
  const texRef = useRef<MapTex | null>(null);

  const geo = useMemo(() => computeGeo(routes), [routes]);
  const polys = useMemo(
    () => (geo ? routes.map((r) => r.map((p) => toLocal(geo, p.lat, p.lng))) : []),
    [routes, geo],
  );
  // `routes` is usually a fresh array each render, so depend on a STABLE content
  // key; otherwise the tile effect resets each render and tiles never finish.
  const geoRef = useRef(geo); geoRef.current = geo;
  const polyRef = useRef(polys); polyRef.current = polys;
  const geoKey = geo ? `${geo.clat.toFixed(4)}|${geo.clng.toFixed(4)}|${geo.scale.toFixed(3)}` : "";

  useEffect(() => {
    const geo = geoRef.current;
    if (!geo) return;
    texRef.current = null;
    const corners = [toGeo(geo, -G, -G), toGeo(geo, G, -G), toGeo(geo, -G, G), toGeo(geo, G, G)];
    const minLng = Math.min(...corners.map((c) => c.lng));
    const maxLng = Math.max(...corners.map((c) => c.lng));
    const minLat = Math.min(...corners.map((c) => c.lat));
    const maxLat = Math.max(...corners.map((c) => c.lat));
    let z = 16;
    for (; z >= 2; z--) {
      const tw = Math.abs(lon2tile(maxLng, z) - lon2tile(minLng, z));
      const th = Math.abs(lat2tile(maxLat, z) - lat2tile(minLat, z));
      if (tw <= 5 && th <= 5) break;
    }
    // Tile Y increases southward (lat2tile decreases with lat) — take min/max.
    const xMin = Math.floor(Math.min(lon2tile(minLng, z), lon2tile(maxLng, z)));
    const xMax = Math.floor(Math.max(lon2tile(minLng, z), lon2tile(maxLng, z)));
    const yMin = Math.floor(Math.min(lat2tile(minLat, z), lat2tile(maxLat, z)));
    const yMax = Math.floor(Math.max(lat2tile(minLat, z), lat2tile(maxLat, z)));
    const nx = xMax - xMin + 1, ny = yMax - yMin + 1;
    const comp = document.createElement("canvas");
    comp.width = nx * TILE; comp.height = ny * TILE;
    const cctx = comp.getContext("2d");
    if (!cctx) return;
    cctx.fillStyle = "#0b1120"; cctx.fillRect(0, 0, comp.width, comp.height);
    const tex: MapTex = { canvas: comp, originPxX: xMin * TILE, originPxY: yMin * TILE, z, ready: false };
    texRef.current = tex;
    let loaded = 0; const total = nx * ny;
    for (let tx = xMin; tx <= xMax; tx++) {
      for (let ty = yMin; ty <= yMax; ty++) {
        const img = new Image();
        img.onload = () => {
          cctx.drawImage(img, (tx - xMin) * TILE, (ty - yMin) * TILE);
          if (++loaded >= total) tex.ready = true; else tex.ready = loaded > 0;
        };
        img.onerror = () => { if (++loaded >= total && loaded > 0) tex.ready = true; };
        // Esri World Imagery — keyless satellite tiles. Note the {z}/{y}/{x} order.
        const wx = ((tx % 2 ** z) + 2 ** z) % 2 ** z;
        img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${wx}`;
      }
    }
    return () => { texRef.current = null; };
  }, [geoKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const start = performance.now();
    let w = 0, h = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = rect.width; h = rect.height;
      canvas.width = Math.max(1, Math.floor(w));
      canvas.height = Math.max(1, Math.floor(h));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const pitch = 55 * DEG, CAM = 3.0;
    const project = (x: number, y: number, z: number, yaw: number) => {
      const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
      const rx = x * cyaw - z * syaw;
      const rz = x * syaw + z * cyaw;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const ry = y * cp - rz * sp;
      const rz2 = y * sp + rz * cp;
      const s = (Math.min(w, h) * 0.6) / (rz2 + CAM);
      return { sx: w / 2 + rx * s, sy: h * 0.62 - ry * s };
    };

    const drawGrid = (yaw: number) => {
      const N = 16, step = (G * 2) / N;
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(110,140,190,0.10)";
      for (let i = 0; i <= N; i++) {
        const c = -G + i * step;
        let a = project(-G, 0, c, yaw), b = project(G, 0, c, yaw);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
        a = project(c, 0, -G, yaw); b = project(c, 0, G, yaw);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
    };

    const drawMap = (yaw: number) => {
      const tex = texRef.current;
      const geo = geoRef.current;
      if (!geo || !tex || !tex.ready) { drawGrid(yaw); return; }
      const src = (x: number, zc: number) => {
        const gg = toGeo(geo, x, zc);
        return { u: lon2tile(gg.lng, tex.z) * TILE - tex.originPxX, v: lat2tile(gg.lat, tex.z) * TILE - tex.originPxY };
      };
      const step = (G * 2) / SUBDIV;
      for (let i = 0; i < SUBDIV; i++) {
        for (let j = 0; j < SUBDIV; j++) {
          const x0 = -G + i * step, x1 = x0 + step, z0 = -G + j * step, z1 = z0 + step;
          const d00 = project(x0, 0, z0, yaw), d10 = project(x1, 0, z0, yaw);
          const d11 = project(x1, 0, z1, yaw), d01 = project(x0, 0, z1, yaw);
          const s00 = src(x0, z0), s10 = src(x1, z0), s11 = src(x1, z1), s01 = src(x0, z1);
          texTri(ctx, tex.canvas, s00.u, s00.v, s10.u, s10.v, s11.u, s11.v, d00.sx, d00.sy, d10.sx, d10.sy, d11.sx, d11.sy);
          texTri(ctx, tex.canvas, s00.u, s00.v, s11.u, s11.v, s01.u, s01.v, d00.sx, d00.sy, d11.sx, d11.sy, d01.sx, d01.sy);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };

    const draw = (now: number) => {
      const yaw = yawRef.current + (rotate ? (now - start) * 0.00003 : 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#0a1430"); sky.addColorStop(0.55, "#0a0f1e"); sky.addColorStop(1, "#070b14");
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);

      drawMap(yaw);

      polyRef.current.forEach((poly, ri) => {
        if (poly.length < 2) return;
        ctx.strokeStyle = color; ctx.globalAlpha = 0.45; ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < poly.length; i++) {
          const a = along(poly, i / (poly.length - 1));
          const p = project(a.x, a.alt, a.z, yaw);
          if (i === 0) ctx.moveTo(p.sx, p.sy); else ctx.lineTo(p.sx, p.sy);
        }
        ctx.stroke(); ctx.globalAlpha = 1;
        const pad = (gx: number, gz: number, c: string) => {
          const p = project(gx, 0, gz, yaw);
          ctx.fillStyle = c; ctx.globalAlpha = 0.95;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, 5, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(p.sx, p.sy, 12, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        };
        pad(poly[0][0], poly[0][1], color);
        pad(poly[poly.length - 1][0], poly[poly.length - 1][1], "#fbbf24");
        const t = animate ? (((now - start) / (durationSec * 1000)) + ri * 0.23) % 1 : (ri === 0 ? progressRef.current : 0);
        ctx.strokeStyle = "#f0887a"; ctx.lineWidth = 2.5; ctx.beginPath();
        const steps = Math.max(2, Math.floor(t * poly.length));
        for (let i = 0; i <= steps; i++) {
          const a = along(poly, (i / Math.max(1, steps)) * t);
          const p = project(a.x, a.alt, a.z, yaw);
          if (i === 0) ctx.moveTo(p.sx, p.sy); else ctx.lineTo(p.sx, p.sy);
        }
        ctx.stroke();
        const a = along(poly, t);
        const p = project(a.x, a.alt, a.z, yaw), ground = project(a.x, 0, a.z, yaw);
        ctx.strokeStyle = color; ctx.globalAlpha = 0.3; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(ground.sx, ground.sy); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.save(); ctx.translate(p.sx, p.sy);
        ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 16;
        ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0; ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      });

      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.textAlign = "right";
      ctx.fillText("Imagery © Esri, Maxar, Earthstar Geographics", w - 8, h - 8);
      ctx.textAlign = "left";
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onDown = (e: PointerEvent) => { dragRef.current = { x: e.clientX, last: yawRef.current }; };
    const onMove = (e: PointerEvent) => { if (dragRef.current) yawRef.current = dragRef.current.last + (e.clientX - dragRef.current.x) * 0.006; };
    const onUp = () => { dragRef.current = null; };
    if (interactive) {
      canvas.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (interactive) {
        canvas.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }
    };
  }, [geoKey, animate, durationSec, rotate, interactive, color]);

  return (
    <canvas
      ref={canvasRef}
      aria-label={label ?? "3D route map"}
      className={className}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "none", ...style }}
    />
  );
}
