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
//     white/ivory/pearl by height.
// vite-plugin-cesium sets window.CESIUM_BASE_URL so workers/assets resolve.
import {
  Ion,
  CesiumWidget,
  Terrain,
  createWorldTerrainAsync,
  createOsmBuildingsAsync,
  Cesium3DTileStyle,
  ArcGisMapServerImageryProvider,
  ImageryLayer,
  Color,
  Cartesian3,
  Math as CesiumMath,
} from "cesium";

const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;

/** True when a usable Ion token is present (real terrain + buildings need it). */
export const hasIonToken = (): boolean => !!ION_TOKEN && ION_TOKEN.length > 20;

const ESRI_GRAY =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer";

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

export interface EngineResult {
  widget: CesiumWidget;
  geoDataLoaded: boolean;
  warnings: string[];
}

/** Create a styled CesiumWidget in `container`. Never throws for missing geo
 *  data — it degrades and reports via `warnings` so the UI can stay honest. */
export async function createEngine(container: HTMLElement): Promise<EngineResult> {
  const warnings: string[] = [];
  if (hasIonToken()) Ion.defaultAccessToken = ION_TOKEN as string;

  const widget = new CesiumWidget(container, {
    baseLayer: false, // we add the keyless gray basemap ourselves
    // Continuous render — tracking updates the scene every frame. (Perf pass later
    // can switch to requestRenderMode with explicit requestRender on telemetry.)
    requestRenderMode: false,
  });

  styleScene(widget);

  // ── Ground basemap (keyless) ───────────────────────────────────────────────
  try {
    const gray = await ArcGisMapServerImageryProvider.fromUrl(ESRI_GRAY);
    widget.scene.imageryLayers.add(new ImageryLayer(gray));
  } catch {
    warnings.push("Base map imagery unavailable — showing plain ground.");
  }

  let geoDataLoaded = false;

  if (hasIonToken()) {
    try {
      widget.scene.setTerrain(new Terrain(createWorldTerrainAsync()));
      geoDataLoaded = true;
    } catch {
      warnings.push("Terrain data unavailable — using flat ellipsoid.");
    }
    try {
      const osm = await createOsmBuildingsAsync();
      osm.style = BUILDING_STYLE;
      widget.scene.primitives.add(osm);
      geoDataLoaded = true;
    } catch {
      warnings.push("3D building data unavailable for this area.");
    }
  } else {
    warnings.push("No Cesium Ion token — real terrain and buildings are disabled.");
  }

  return { widget, geoDataLoaded, warnings };
}

/** Apply the bright, soft, studio-like "architectural miniature" look. */
function styleScene(widget: CesiumWidget): void {
  const scene = widget.scene;
  const globe = scene.globe;

  globe.baseColor = Color.fromCssColorString("#eef0f3"); // pale cool-gray ground
  globe.enableLighting = false; // even studio lighting, no day/night terminator
  globe.showGroundAtmosphere = false;
  globe.depthTestAgainstTerrain = true;

  scene.backgroundColor = Color.fromCssColorString("#fbfcfe"); // near-white backdrop
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.fog.enabled = true;
  scene.fog.density = 0.0004; // subtle distance fade
  scene.highDynamicRange = false;
  scene.light.intensity = 2.0; // soft ambient fill
}

/** lat/lng/height → Cartesian3 (height = metres above ellipsoid). */
export const toCartesian = (lat: number, lng: number, height = 0): Cartesian3 =>
  Cartesian3.fromDegrees(lng, lat, height);

export { CesiumMath };
