// Dev-only (not shipped): fake instance answers for the panels, one file per feature. fakeInstance.js calls
// fixtureRoute(method, url) before its own tables; a fixture answers only the tables it knows and returns null for
// everything else. A fixture module exports `route(method, url /* URL */, body /* string|null */) => Response|null`.
import * as clientTrace from './clienttrace.js';
import * as goto from './goto.js';
import * as notify from './notify.js';
import * as processView from './process.js';
import * as properties from './properties.js';
import * as dataModel from './datamodel.js';
import * as portal from './portal.js';
import * as previewProblems from './previewProblems.js';
import * as doctor from './doctor.js';

const FIXTURES = [doctor, clientTrace, goto, notify, properties, processView, dataModel, portal, previewProblems];

export function fixtureRoute(method, url, body) {
  for (const fixture of FIXTURES) {
    const response = fixture.route(method, url, body);
    if (response) return response;
  }
  return null;
}
