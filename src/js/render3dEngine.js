/**
 * render3dEngine.js — the lazy three.js facade (LLD 130 §9)
 *
 * This module is NEVER statically imported; render3d.js pulls it in via a single
 * dynamic `import("./render3dEngine.js")` on first preview entry, so it (and all
 * of three.js) is code-split into its own lazy chunk that never touches the
 * default editor load.
 *
 * Crucially it uses STATIC NAMED imports from "three" (not `import * as THREE` +
 * spread), so Rollup/Vite can tree-shake three's surface down to exactly the
 * classes below — the build-verified acceptance gate in LLD §9. Runtime property
 * access on a dynamically-imported namespace (`(await import("three")).Scene`)
 * defeats that tree-shaking; a static-import facade is the fix.
 */

import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  Shape,
  ShapeGeometry,
  ExtrudeGeometry,
  MeshLambertMaterial,
  Matrix4,
  Vector3,
  DoubleSide,
  FrontSide,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  Shape,
  ShapeGeometry,
  ExtrudeGeometry,
  MeshLambertMaterial,
  Matrix4,
  Vector3,
  DoubleSide,
  FrontSide,
  OrbitControls,
};
