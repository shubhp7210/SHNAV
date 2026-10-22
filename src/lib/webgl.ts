// Cesium needs a WebGL context. Some browsers/environments have WebGL fully
// disabled (sandboxed, no GPU, hardware acceleration off) — detect that so callers
// can fall back to the WebGL-free Map3D canvas renderer instead of a broken map.
let cached: boolean | null = null;

export function hasWebGL(): boolean {
  if (cached !== null) return cached;
  if (typeof document === "undefined") return (cached = false);
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    cached = !!gl;
  } catch {
    cached = false;
  }
  return cached;
}
