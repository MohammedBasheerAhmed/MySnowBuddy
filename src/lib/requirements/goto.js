// What the "go to anything" feature needs from the instance, for the Self-check panel (src/lib/requirements/index.js).
// One entry per table: { feature, table, columns: [...], optional?: true, note?: "why" }.
//
// Generated from the kind catalogue in src/lib/goTo.js, so the list cannot drift from what the palette really asks for.
// Every entry is optional: a table that does not exist or cannot be read only removes that kind from the results.

import { GOTO_REQUIREMENTS } from '../goTo.js';

export const REQUIREMENTS = GOTO_REQUIREMENTS;
