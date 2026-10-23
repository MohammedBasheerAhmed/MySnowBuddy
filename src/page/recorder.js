// PAGE-WORLD script (manifest content_scripts entry with "world": "MAIN", run_at document_start, all frames).
// It runs in the ServiceNow page's own JavaScript context so it can see g_form, GlideAjax and GlideRecord. All of the
// logic lives in src/lib/clientTraceRecorder.js (unit tested against fakes); this file only starts it.
//
// Until the tab is armed (sessionStorage 'msb_trace_armed', set by the Client trace panel) it registers one DOM listener
// for the extension's requests, one storage listener and one pageshow listener, and does nothing else. It never throws
// into page code.
import { boot } from '../lib/clientTraceRecorder.js';

boot(window);
