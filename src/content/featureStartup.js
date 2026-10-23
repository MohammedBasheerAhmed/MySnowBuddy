// Features that need to run once when a ServiceNow page loads (not only when their panel is opened) list their
// `install` here. Each call is isolated: one feature failing to start never stops the others or the page.

import { install as installClientTrace } from './clientTrace.js';
import { install as installPortalInspector } from './portalInspector.js';

const STARTERS = [
  ['client trace', installClientTrace],
  ['portal inspector', installPortalInspector],
];

/** @param {{ shadow: ShadowRoot, toast: object, sidebar: object }} deps */
export function installFeatures(deps) {
  STARTERS.forEach(([label, start]) => {
    try {
      start(deps);
    } catch (err) {
      console.error(`[NowBuddy] ${label} failed to start`, err);
    }
  });
}
