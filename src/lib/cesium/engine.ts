// Cesium engine factory + premium "architectural miniature" styling.
//
// Uses CesiumWidget (NOT Viewer): the Viewer bundles Knockout.js, which calls
// `new Function()` and is blocked by our strict CSP (no 'unsafe-eval'). CesiumWidget
// is the eval-free renderer, so the security hardening stays intact.
//
// Data (keyless/free + free Ion token decision):
//   • Ground basemap: Esri "World Light Gray Base" — KEYLESS raster (pale gray
//     ground + roads), not satellite — gives the architectural look.
//   • Terrain: Cesium World Terrain (Ion — real AMSL elevation).
//   • Buildings: Cesium OSM Buildings (Ion — real footprints/heights), styled
//     white/ivory/pearl by height. Only streamed when the camera is low enough
//     to see them.
// Everything is limited to the operating region (see lib/geo/region.ts): the
// globe culls tiles outside it and the camera is kept inside it.
// vite-plugin-cesium sets window.CESIUM_BASE_URL so workers/assets resolve.
import {
  Ion,
  CesiumWidget,
  Terrain,
  createWorldTerrainAsync,
  Cesium3DTileStyle,
  Cesium3DTileset,
  ArcGisMapServerImageryProvider,
  ImageryLayer,
  Color,
  Cartesian3,
  Cartographic,
  Rectangle,
  Matrix4,
  Math as CesiumMath,
  type TerrainProvider,
} from "cesium";
import { NORTH_AMERICA, type Bounds } from "@/lib/geo/region";

const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;

/** True when a usable Ion token is present (real terrain + buildings need it). */
export const hasIonToken = (): boolean => !!ION_TOKEN && ION_TOKEN.length > 20;

const ESRI_GRAY =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer";

const OSM_BUILDINGS_ASSET_ID = 96188;

/** Buildings are hidden (and not streamed) above this camera height. */
const BUILDINGS_MAX_HEIGHT_M = 12_000;
/** Camera can't zoom out far enough to see the whole globe. */
const MAX_ZOOM_DISTANCE_M = 6_000_000;
const M_PER_DEG = 111_320;
/** Pitch is forced progressively steeper between these camera heights. */
const STEEPEN_FROM_M = 300_000;
const STEEPEN_TO_M = 3_000_000;

/** White/ivory/pearl building palette, varied by estimated height. Cesium styles
 *  are evaluated by Cesium's own (CSP-safe) expression engine, not JS eval. */
const BUILDING_STYLE = new Cesium3DTileStyle({
  color: {
    conditions: [
      ["${feature['cesium#estimatedHeight']} >= 150", "color('#ffffff')"],
      ["${feature['cesium#estimatedHeight']} >= 70", "color('#f4f1ea')"],
      ["${feature['cesium#estimatedHeight']} >= 25", "color('#ece9e2')"],
      ["true", "color('#e2e0d9')"],
    ],
  },
});

// Module-level provider caches: providers survive widget.destroy() (layers don't
// destroy their providers), so remounting a map — tab switch, navigation — reuses
// the already-fetched metadata instead of re-requesting it.
let imageryPromise: Promise<ArcGisMapServerImageryProvider> | null = null;
let terrainPromise: Promise<TerrainProvider> | null = null;

const getImagery = () => {
  imageryPromise ??= ArcGisMapServerImageryProvider.fromUrl(ESRI_GRAY, {
    // The Canvas gray service only has tiles through z16 (deeper requests fail
    // without CORS headers); Cesium upsamples z16 for closer views.
    maximumLevel: 16,
  }).catch((e) => {
    imageryPromise = null; // allow a retry on the next mount
    throw e;
  });
  return imageryPromise;
};
const getTerrain = () => {
  terrainPromise ??= createWorldTerrainAsync().catch((e) => {
    terrainPromise = null;
    throw e;
  });
  return terrainPromise;
};

export interface InitialView { lat: number; lng: number; height: number; heading?: number; pitch?: number }

export interface EngineResult {
  widget: CesiumWidget;
  /** Resolves once basemap/terrain/buildings have been attempted. */
  layers: Promise<{ geoDataLoaded: boolean; warnings: string[] }>;
  /** Restrict globe + camera to `bounds` (degrees). */
  setBounds: (bounds: Bounds) => void;
}

/** Create a styled CesiumWidget in `container`. The widget is returned
 *  synchronously with the camera already at `initialView`, so the first frame is
 *  the intended view — no fly-in from space. Data layers load in the background
 *  and never throw: failures are reported via `warnings` so the UI stays honest. */
export function createEngine(container: HTMLElement, initialView?: InitialView): EngineResult {
  if (hasIonToken()) Ion.defaultAccessToken = ION_TOKEN as string;

  const widget = new CesiumWidget(container, {
    baseLayer: false, // we add the keyless gray basemap ourselves
    // Explicit rendering: frames are drawn only when something changes (camera
    // move, tile arrival, requestRender() from telemetry updates).
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    showRenderLoopErrors: false, // surfaced via scene.renderError instead
  });

  styleScene(widget);

  let bounds: Rectangle = Rectangle.fromDegrees(
    NORTH_AMERICA.west, NORTH_AMERICA.south, NORTH_AMERICA.east, NORTH_AMERICA.north,
  );
  const setBounds = (b: Bounds) => {
    bounds = Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
    widget.scene.globe.cartographicLimitRectangle = bounds;
    widget.scene.requestRender();
  };
  setBounds(NORTH_AMERICA);

  if (initialView) {
    widget.camera.setView({
      destination: Cartesian3.fromDegrees(initialView.lng, initialView.lat, initialView.height),
      orientation: {
        heading: CesiumMath.toRadians(initialView.heading ?? 0),
        pitch: CesiumMath.toRadians(initialView.pitch ?? -90),
        roll: 0,
      },
    });
  }

  // Keep the camera over the operating region and looking at it:
  //  • if a pan leaves the region, pull the camera back to its nearest edge;
  //  • as the camera climbs, steepen the pitch toward straight-down, so a
  //    zoom-out can never end up gazing past the horizon at culled/empty space.
  // Runs in preRender — i.e. before the frame's culling — so the corrected
  // camera is the one the frame is drawn with. (Mutating the camera inside
  // camera.changed happens mid-frame and left explicit-render frames blank.)
  const camera = widget.camera;
  const scratch = new Cartographic();
  widget.scene.preRender.addEventListener(() => {
    // The tracking CameraController locks the camera with lookAt(); leave it be.
    if (!Matrix4.equals(camera.transform, Matrix4.IDENTITY)) return;
    const c = Cartographic.fromCartesian(camera.positionWC, undefined, scratch);
    if (!c) return;
    // Allowed camera area shrinks with height, so a high camera stays over the
    // middle of the region rather than a corner (degrees ≈ ground half-width seen).
    const margin = (c.height / M_PER_DEG) * 0.45;
    const mLng = Math.min(margin * (Math.PI / 180), (bounds.east - bounds.west) / 2 * 0.95);
    const mLat = Math.min(margin * (Math.PI / 180), (bounds.north - bounds.south) / 2 * 0.95);
    const west = bounds.west + mLng, east = bounds.east - mLng;
    const south = bounds.south + mLat, north = bounds.north - mLat;
    const inside = c.longitude >= west && c.longitude <= east && c.latitude >= south && c.latitude <= north;
    const t = CesiumMath.clamp((c.height - STEEPEN_FROM_M) / (STEEPEN_TO_M - STEEPEN_FROM_M), 0, 1);
    const maxPitch = CesiumMath.lerp(CesiumMath.toRadians(-30), CesiumMath.toRadians(-89), t);
    const pitchOk = camera.pitch <= maxPitch;
    if (inside && pitchOk) return;
    camera.setView({
      destination: Cartesian3.fromRadians(
        CesiumMath.clamp(c.longitude, west, east), CesiumMath.clamp(c.latitude, south, north), c.height,
      ),
      orientation: { heading: camera.heading, pitch: Math.min(camera.pitch, maxPitch), roll: 0 },
    });
  });

  return { widget, layers: loadLayers(widget), setBounds };
}

async function loadLayers(widget: CesiumWidget): Promise<{ geoDataLoaded: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const alive = () => !widget.isDestroyed();

  // ── Ground basemap (keyless) ───────────────────────────────────────────────
  const imagery = getImagery()
    .then((provider) => {
      if (alive()) widget.scene.imageryLayers.add(new ImageryLayer(provider));
    })
    .catch(() => { warnings.push("Base map imagery unavailable — showing plain ground."); });

  let geoDataLoaded = false;
  if (!hasIonToken()) {
    warnings.push("No Cesium Ion token — real terrain and buildings are disabled.");
    await imagery;
    return { geoDataLoaded, warnings };
  }

  const terrain = getTerrain()
    .then((provider) => {
      if (!alive()) return;
      widget.scene.setTerrain(new Terrain(Promise.resolve(provider)));
      geoDataLoaded = true;
    })
    .catch(() => { warnings.push("Terrain data unavailable — using flat ellipsoid."); });

  // Cesium OSM Buildings (Ion asset 96188) — loaded directly so the LOD options
  // below are typed (createOsmBuildingsAsync's typings omit tileset options).
  const buildings = Cesium3DTileset.fromIonAssetId(OSM_BUILDINGS_ASSET_ID, {
    // Coarser LOD than the default 16 — far fewer tiles/draw calls, visually
    // indistinguishable at our viewing distances.
    maximumScreenSpaceError: 24,
    dynamicScreenSpaceError: true,
    cullRequestsWhileMoving: true,
    preloadWhenHidden: false,
  })
    .then((osm) => {
      if (!alive()) { osm.destroy(); return; }
      osm.style = BUILDING_STYLE;
      widget.scene.primitives.add(osm);
      geoDataLoaded = true;
      // Only stream/draw buildings when the camera is low enough to see them.
      const sync = () => {
        const h = widget.camera.positionCartographic.height;
        const show = h < BUILDINGS_MAX_HEIGHT_M;
        if (osm.show !== show) { osm.show = show; widget.scene.requestRender(); }
      };
      sync();
      widget.camera.changed.addEventListener(sync);
    })
    .catch(() => { warnings.push("3D building data unavailable for this area."); });

  await Promise.all([imagery, terrain, buildings]);
  if (alive()) widget.scene.requestRender();
  return { geoDataLoaded, warnings };
}

/** Apply the bright, soft, studio-like "architectural miniature" look. */
function styleScene(widget: CesiumWidget): void {
  const scene = widget.scene;
  const globe = scene.globe;

  globe.baseColor = Color.fromCssColorString("#eef0f3"); // pale cool-gray ground
  globe.enableLighting = false; // even studio lighting, no day/night terminator
  globe.showGroundAtmosphere = false;
  globe.depthTestAgainstTerrain = true;
  globe.tileCacheSize = 60;           // default 100 — region-limited, needs fewer
  globe.preloadSiblings = false;
  globe.preloadAncestors = true;

  scene.backgroundColor = Color.fromCssColorString("#fbfcfe"); // near-white backdrop
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.fog.enabled = true;
  scene.fog.density = 0.0004; // subtle distance fade
  scene.highDynamicRange = false;
  scene.light.intensity = 2.0; // soft ambient fill

  const ssc = scene.screenSpaceCameraController;
  ssc.minimumZoomDistance = 80;
  ssc.maximumZoomDistance = MAX_ZOOM_DISTANCE_M;
}

/** lat/lng/height → Cartesian3 (height = metres above ellipsoid). */
export const toCartesian = (lat: number, lng: number, height = 0): Cartesian3 =>
  Cartesian3.fromDegrees(lng, lat, height);

export { CesiumMath };
