// Cesium engine factory + "night ops" styling.
//
// Uses CesiumWidget (NOT Viewer): the Viewer bundles Knockout.js, which calls
// `new Function()` and is blocked by our strict CSP (no 'unsafe-eval'). CesiumWidget
// is the eval-free renderer, so the security hardening stays intact.
//
// Data (keyless/free + free Ion token):
//   • Ground basemap: Esri "World Dark Gray Base" — KEYLESS raster, same host as
//     before (services.arcgisonline.com, already allowed by the CSP).
//   • Terrain: Cesium World Terrain (Ion — real AMSL elevation).
//   • Buildings: Cesium OSM Buildings (Ion — real footprints/heights), slate
//     palette by height, lit by a fixed golden-hour sun and casting real shadows
//     when the camera is low enough to see them.
// Everything is limited to the operating region (see lib/geo/region.ts).
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
  HeadingPitchRange,
  JulianDate,
  Rectangle,
  Matrix4,
  ShadowMode,
  Math as CesiumMath,
  type TerrainProvider,
} from "cesium";
import { NORTH_AMERICA, MANHATTAN_VIEW, type Bounds, type TargetView } from "@/lib/geo/region";

const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;

/** True when a usable Ion token is present (real terrain + buildings need it). */
export const hasIonToken = (): boolean => !!ION_TOKEN && ION_TOKEN.length > 20;

const ESRI_DARK =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer";

const OSM_BUILDINGS_ASSET_ID = 96188;

/** Buildings are hidden (and not streamed) above this camera height. */
const BUILDINGS_MAX_HEIGHT_M = 14_000;
/** Shadows are only computed below this camera height (they're invisible and
 *  expensive from higher up). */
const SHADOWS_MAX_HEIGHT_M = 7_000;
/** Camera can't zoom out far enough to see the whole globe. */
const MAX_ZOOM_DISTANCE_M = 6_000_000;
const M_PER_DEG = 111_320;
/** Pitch is forced progressively steeper between these camera heights. */
const STEEPEN_FROM_M = 300_000;
const STEEPEN_TO_M = 3_000_000;

/** Fixed lighting time: a late-June evening over New York (18:30 EDT). Long,
 *  readable shadows and warm side-light; identical on every load. */
const SUN_TIME = JulianDate.fromIso8601("2026-06-21T22:30:00Z");

/** Slate "night ops" building palette, brighter with height so the skyline
 *  reads clearly against the dark ground. Evaluated by Cesium's own CSP-safe
 *  expression engine (not JS eval). */
const BUILDING_STYLE = new Cesium3DTileStyle({
  color: {
    conditions: [
      ["${feature['cesium#estimatedHeight']} >= 200", "color('#c3cfe2')"],
      ["${feature['cesium#estimatedHeight']} >= 100", "color('#94a3bd')"],
      ["${feature['cesium#estimatedHeight']} >= 40", "color('#6b7a96')"],
      ["true", "color('#4a5670')"],
    ],
  },
});

// Module-level provider caches: providers survive widget.destroy() (layers don't
// destroy their providers), so remounting a map — tab switch, navigation — reuses
// the already-fetched metadata instead of re-requesting it.
let imageryPromise: Promise<ArcGisMapServerImageryProvider> | null = null;
let terrainPromise: Promise<TerrainProvider> | null = null;

const getImagery = () => {
  imageryPromise ??= ArcGisMapServerImageryProvider.fromUrl(ESRI_DARK, {
    // The Canvas services only have tiles through z16 (deeper requests fail
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

export type { TargetView };
/** @deprecated name kept for callers — a target-based view. */
export type InitialView = TargetView;

export interface EngineResult {
  widget: CesiumWidget;
  /** Resolves once basemap/terrain/buildings have been attempted. */
  layers: Promise<{ geoDataLoaded: boolean; warnings: string[] }>;
  /** Restrict globe + camera to `bounds` (degrees). */
  setBounds: (bounds: Bounds) => void;
}

/** Point the camera at a target (no animation) and release the reference frame
 *  so the user can pan/orbit freely afterwards. */
export function setTargetView(widget: CesiumWidget, v: TargetView): void {
  widget.camera.lookAt(
    Cartesian3.fromDegrees(v.lng, v.lat, 0),
    new HeadingPitchRange(CesiumMath.toRadians(v.heading), CesiumMath.toRadians(v.pitch), v.range),
  );
  widget.camera.lookAtTransform(Matrix4.IDENTITY);
  widget.scene.requestRender();
}

/** Create a styled CesiumWidget in `container`. The widget is returned
 *  synchronously with the camera already at `initialView` (Manhattan by
 *  default), so the first frame is the intended view — never a global view.
 *  Data layers load in the background and never throw: failures are reported
 *  via `warnings` so the UI stays honest. */
export function createEngine(container: HTMLElement, initialView: TargetView = MANHATTAN_VIEW): EngineResult {
  if (hasIonToken()) Ion.defaultAccessToken = ION_TOKEN as string;

  const widget = new CesiumWidget(container, {
    baseLayer: false, // we add the keyless basemap ourselves
    // Explicit rendering: frames are drawn only when something changes (camera
    // move, tile arrival, requestRender() from telemetry updates).
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    showRenderLoopErrors: false, // surfaced via scene.renderError instead
    shadows: false,              // toggled by camera height below
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

  setTargetView(widget, initialView);

  // Keep the camera over the operating region and looking at it:
  //  • if a pan leaves the region, pull the camera back to its nearest edge;
  //  • as the camera climbs, steepen the pitch toward straight-down, so a
  //    zoom-out can never end up gazing past the horizon at culled/empty space.
  // Runs in preRender — before the frame's culling — so the corrected camera is
  // the one the frame is drawn with.
  const camera = widget.camera;
  const scratch = new Cartographic();
  widget.scene.preRender.addEventListener(() => {
    // The tracking CameraController locks the camera with lookAt(); leave it be.
    if (!Matrix4.equals(camera.transform, Matrix4.IDENTITY)) return;
    const c = Cartographic.fromCartesian(camera.positionWC, undefined, scratch);
    if (!c) return;
    const margin = (c.height / M_PER_DEG) * 0.45;
    const mLng = Math.min(margin * (Math.PI / 180), (bounds.east - bounds.west) / 2 * 0.95);
    const mLat = Math.min(margin * (Math.PI / 180), (bounds.north - bounds.south) / 2 * 0.95);
    const west = bounds.west + mLng, east = bounds.east - mLng;
    const south = bounds.south + mLat, north = bounds.north - mLat;
    const inside = c.longitude >= west && c.longitude <= east && c.latitude >= south && c.latitude <= north;
    const t = CesiumMath.clamp((c.height - STEEPEN_FROM_M) / (STEEPEN_TO_M - STEEPEN_FROM_M), 0, 1);
    const maxPitch = CesiumMath.lerp(CesiumMath.toRadians(-18), CesiumMath.toRadians(-89), t);
    const pitchOk = camera.pitch <= maxPitch;
    if (inside && pitchOk) return;
    camera.setView({
      destination: Cartesian3.fromRadians(
        CesiumMath.clamp(c.longitude, west, east), CesiumMath.clamp(c.latitude, south, north), c.height,
      ),
      orientation: { heading: camera.heading, pitch: Math.min(camera.pitch, maxPitch), roll: 0 },
    });
  });

  // Shadows only when low enough to see them.
  const syncShadows = () => {
    const low = widget.camera.positionCartographic.height < SHADOWS_MAX_HEIGHT_M;
    if (widget.scene.shadowMap.enabled !== low) {
      widget.scene.shadowMap.enabled = low;
      widget.scene.requestRender();
    }
  };
  syncShadows();
  widget.camera.changed.addEventListener(syncShadows);

  return { widget, layers: loadLayers(widget), setBounds };
}

async function loadLayers(widget: CesiumWidget): Promise<{ geoDataLoaded: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const alive = () => !widget.isDestroyed();

  // ── Ground basemap (keyless) ───────────────────────────────────────────────
  const imagery = getImagery()
    .then((provider) => {
      if (!alive()) return;
      const layer = new ImageryLayer(provider);
      // Deep, slightly cool ground: roads and shoreline stay legible while the
      // lit skyline carries the contrast.
      layer.brightness = 0.62;
      layer.contrast = 1.25;
      layer.saturation = 0.5;
      layer.hue = 0.04;
      widget.scene.imageryLayers.add(layer);
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
  // below are typed.
  const buildings = Cesium3DTileset.fromIonAssetId(OSM_BUILDINGS_ASSET_ID, {
    // Slightly coarser LOD than the default 16 — fewer tiles/draw calls,
    // visually indistinguishable at our viewing distances.
    maximumScreenSpaceError: 20,
    dynamicScreenSpaceError: true,
    // The homepage orbits continuously; culling requests while moving would
    // starve the tileset and the skyline would never stream in.
    cullRequestsWhileMoving: false,
    preloadWhenHidden: false,
    shadows: ShadowMode.ENABLED,
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
      // Re-render as building tiles stream in (explicit render mode).
      osm.tileLoad.addEventListener(() => widget.scene.requestRender());
    })
    .catch(() => { warnings.push("3D building data unavailable for this area."); });

  await Promise.all([imagery, terrain, buildings]);
  if (alive()) widget.scene.requestRender();
  return { geoDataLoaded, warnings };
}

/** Night-ops look: dark ground, slate skyline, warm low sun, atmospheric depth. */
function styleScene(widget: CesiumWidget): void {
  const scene = widget.scene;
  const globe = scene.globe;

  // Fixed sun position — consistent lighting/shadows on every load.
  widget.clock.currentTime = SUN_TIME.clone();
  widget.clock.shouldAnimate = false;

  globe.baseColor = Color.fromCssColorString("#0b0f17");
  globe.enableLighting = false;          // keep the ground evenly readable
  globe.showGroundAtmosphere = true;     // horizon haze for depth
  globe.atmosphereLightIntensity = 4.0;  // keep the haze subtle on the dark ground
  globe.depthTestAgainstTerrain = true;
  globe.shadows = ShadowMode.RECEIVE_ONLY;
  globe.tileCacheSize = 80;
  globe.preloadSiblings = false;
  globe.preloadAncestors = true;

  scene.backgroundColor = Color.fromCssColorString("#06080d");
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = true;
    scene.skyAtmosphere.brightnessShift = -0.35;
    scene.skyAtmosphere.saturationShift = -0.2;
  }
  scene.sun.show = false;
  scene.moon.show = false;
  scene.fog.enabled = true;
  scene.fog.density = 0.00028;
  scene.fog.minimumBrightness = 0.08;
  scene.highDynamicRange = false;
  scene.light.intensity = 2.4;

  const sm = scene.shadowMap;
  sm.size = 2048;
  sm.softShadows = false;
  sm.darkness = 0.45;
  sm.maximumDistance = 3500;

  // Anti-aliasing (WebGL2 only; harmless no-op otherwise).
  try { scene.msaaSamples = 4; } catch { /* unsupported context */ }

  const ssc = scene.screenSpaceCameraController;
  ssc.minimumZoomDistance = 80;
  ssc.maximumZoomDistance = MAX_ZOOM_DISTANCE_M;
  ssc.inertiaSpin = 0.85;
  ssc.inertiaTranslate = 0.85;
  ssc.inertiaZoom = 0.75;
}

/** lat/lng/height → Cartesian3 (height = metres above ellipsoid). */
export const toCartesian = (lat: number, lng: number, height = 0): Cartesian3 =>
  Cartesian3.fromDegrees(lng, lat, height);

export { CesiumMath };
