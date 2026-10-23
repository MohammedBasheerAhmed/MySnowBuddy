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
import { queryServices } from './queryTools.js';
import { saveTraceServices } from './saveTrace.js';
import { hotspotServices } from './hotspots.js';
import { fieldUsageServices } from './fieldUsage.js';
import { recordCompareServices } from './recordCompare.js';
import { fieldHistoryServices } from './fieldHistory.js';
import { insightServices } from './insight.js';
import { failureServices } from './failures.js';
import { recentChangesServices } from './recentChanges.js';
import { releaseNotesServices } from './releaseNotes.js';
import { ruleExplainServices } from './ruleExplain.js';
import { testDataServices } from './testData.js';
import { testKitServices } from './testKit.js';
import { clientTraceServices } from './clientTrace.js';
import { notifyServices } from './notifyTrace.js';
import { processServices } from './processView.js';
import { propertyServices } from './properties.js';
import { dataModelServices } from './dataModel.js';
import { portalServices } from './portalInspector.js';
import { previewProblemServices } from './previewProblems.js';
import { doctorServices } from './doctor.js';

export const FEATURE_SERVICES = { ...myWorkServices, ...accessServices, ...healthServices, ...xrayServices, ...impactServices, ...queryServices, ...failureServices, ...insightServices };

// Save trace (src/content/saveTrace.js) joins the services after the line above so it never competes for that line.
Object.assign(FEATURE_SERVICES, saveTraceServices);

// Recent changes and release notes (src/content/recentChanges.js, releaseNotes.js).
Object.assign(FEATURE_SERVICES, recentChangesServices, releaseNotesServices);

// Test data (src/content/testData.js).
Object.assign(FEATURE_SERVICES, testDataServices);

// Why did (or didn't) my rule run? (src/content/ruleExplain.js).
Object.assign(FEATURE_SERVICES, ruleExplainServices);

// Hot spots (src/content/hotspots.js).
Object.assign(FEATURE_SERVICES, hotspotServices);

// Where is this field used? (src/content/fieldUsage.js).
Object.assign(FEATURE_SERVICES, fieldUsageServices);

// Compare with another record (src/content/recordCompare.js).
Object.assign(FEATURE_SERVICES, recordCompareServices);

// History of a field (src/content/fieldHistory.js).
Object.assign(FEATURE_SERVICES, fieldHistoryServices);

// Test kit: run against a record, unit tests, ATF finder, snapshots, access matrix (src/content/testKit.js).
Object.assign(FEATURE_SERVICES, testKitServices);

// Batch added 2026-10-23: client trace, email tracer, process view, properties, data model, portal inspector, preview problems, self-check.
// Service names must start with the feature's own prefix (see each module) so two features never collide.
Object.assign(FEATURE_SERVICES, clientTraceServices, notifyServices, processServices, propertyServices, dataModelServices, portalServices, previewProblemServices, doctorServices);
