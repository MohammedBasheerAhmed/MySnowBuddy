// Content-side services for the panels in src/sidebar/panelRegistry.js. Each
// feature module exports a plain object of async functions; they are merged into
// the services every sidebar panel receives. Names must be unique: a built-in
// service with the same name in src/content/index.js wins.
//
//   import { accessServices } from './accessDebugger.js';
//   export const FEATURE_SERVICES = { ...accessServices };

import { myWorkServices } from './myWork.js';
import { accessServices } from './accessDebugger.js';
import { healthServices } from './healthScan.js';
import { xrayServices } from './xray.js';
import { impactServices } from './impact.js';

export const FEATURE_SERVICES = { ...myWorkServices, ...accessServices, ...healthServices, ...xrayServices, ...impactServices };
