// Built-in code snippets. Entries are [category, title, code]. {{name}} placeholders
// are filled from the page (table, sys_id, selection, instance) or asked for.

export const SNIPPET_CATEGORIES = ['GlideRecord', 'Aggregate', 'Dates', 'Client', 'Server', 'REST', 'Utility', 'Logging', 'Custom'];

const ENTRIES = [
  ['GlideRecord', 'Query records', "var gr = new GlideRecord('{{table}}');\ngr.addQuery('{{field_name}}', '{{value}}');\ngr.setLimit(100);\ngr.query();\nwhile (gr.next()) {\n    gs.info(gr.getUniqueValue());\n}"],
  ['GlideRecord', 'Get one record by sys_id', "var gr = new GlideRecord('{{table}}');\nif (gr.get('{{sys_id}}')) {\n    gs.info(gr.getDisplayValue());\n}"],
  ['GlideRecord', 'Insert a record', "var gr = new GlideRecord('{{table}}');\ngr.initialize();\ngr.setValue('{{field_name}}', '{{value}}');\nvar sysId = gr.insert();\ngs.info('Created ' + sysId);"],
  ['GlideRecord', 'Update matching records', "var gr = new GlideRecord('{{table}}');\ngr.addQuery('{{field_name}}', '{{value}}');\ngr.setLimit(100);\ngr.query();\nwhile (gr.next()) {\n    gr.setValue('{{target_field}}', '{{new_value}}');\n    gr.setWorkflow(false); // skip business rules\n    gr.autoSysFields(false); // keep sys_updated_*\n    gr.update();\n}"],
  ['GlideRecord', 'Delete matching records (count first)', "var gr = new GlideRecord('{{table}}');\ngr.addEncodedQuery('{{encoded_query}}');\ngr.query();\ngs.info('Would delete ' + gr.getRowCount() + ' records');\n// gr.deleteMultiple(); // uncomment once the count is right"],
  ['GlideRecord', 'Filter with OR condition', "var gr = new GlideRecord('{{table}}');\nvar qc = gr.addQuery('{{field_a}}', '{{value_a}}');\nqc.addOrCondition('{{field_b}}', '{{value_b}}');\ngr.query();\nwhile (gr.next()) {\n    gs.info(gr.getUniqueValue());\n}"],
  ['GlideRecord', 'Dot-walk a reference', "var gr = new GlideRecord('{{table}}');\ngr.setLimit(10);\ngr.query();\nwhile (gr.next()) {\n    gs.info(gr.getValue('{{reference_field}}') + ' -> ' + gr.{{reference_field}}.getDisplayValue());\n}"],
  ['GlideRecord', 'Secure query (respects ACLs)', "var gr = new GlideRecordSecure('{{table}}');\ngr.addEncodedQuery('{{encoded_query}}');\ngr.query();\nwhile (gr.next()) {\n    gs.info(gr.getUniqueValue());\n}"],
  ['GlideRecord', 'Show changed fields in a Business Rule', "var changed = [];\nvar fields = current.getFields();\nfor (var i = 0; i < fields.size(); i++) {\n    var name = fields.get(i).getName();\n    if (current.getElement(name).changes()) {\n        changed.push(name + ': ' + previous.getValue(name) + ' -> ' + current.getValue(name));\n    }\n}\ngs.info(changed.join('\\n'));"],
  ['Aggregate', 'Count records', "var ga = new GlideAggregate('{{table}}');\nga.addEncodedQuery('{{encoded_query}}');\nga.addAggregate('COUNT');\nga.query();\nif (ga.next()) {\n    gs.info('Count: ' + ga.getAggregate('COUNT'));\n}"],
  ['Aggregate', 'Count grouped by a field', "var ga = new GlideAggregate('{{table}}');\nga.addAggregate('COUNT');\nga.groupBy('{{group_field}}');\nga.orderByAggregate('COUNT');\nga.query();\nwhile (ga.next()) {\n    gs.info(ga.getDisplayValue('{{group_field}}') + ': ' + ga.getAggregate('COUNT'));\n}"],
  ['Aggregate', 'Find duplicates of a field', "var ga = new GlideAggregate('{{table}}');\nga.addAggregate('COUNT', '{{field_name}}');\nga.groupBy('{{field_name}}');\nga.addHaving('COUNT', '>', 1);\nga.query();\nwhile (ga.next()) {\n    gs.info(ga.getValue('{{field_name}}') + ' x ' + ga.getAggregate('COUNT', '{{field_name}}'));\n}"],
  ['Dates', 'Add days to a date', "var gdt = new GlideDateTime();\ngdt.addDaysUTC({{days}});\ngs.info(gdt.getDisplayValue());"],
  ['Dates', 'Difference between two dates', "var start = new GlideDateTime('{{start}}');\nvar end = new GlideDateTime('{{end}}');\nvar ms = GlideDateTime.subtract(start, end).getNumericValue();\ngs.info('Days: ' + (ms / 86400000));"],
  ['Dates', 'Query records from the last N days', "var gr = new GlideRecord('{{table}}');\ngr.addEncodedQuery('sys_created_on>=javascript:gs.daysAgoStart({{days}})');\ngr.query();\ngs.info(gr.getRowCount());"],
  ['Dates', 'Check business hours with a schedule', "var schedule = new GlideSchedule('{{schedule_sys_id}}');\nvar when = new GlideDateTime();\ngs.info('In schedule: ' + schedule.isInSchedule(when));"],
  ['Client', 'Get and set a form field', "var value = g_form.getValue('{{field_name}}');\ng_form.setValue('{{field_name}}', '{{value}}');"],
  ['Client', 'onChange guard', "function onChange(control, oldValue, newValue, isLoading, isTemplate) {\n    if (isLoading || newValue === '') {\n        return;\n    }\n    // {{what_to_do}}\n}"],
  ['Client', 'GlideAjax call (client)', "var ga = new GlideAjax('{{script_include}}');\nga.addParam('sysparm_name', '{{method}}');\nga.addParam('sysparm_value', g_form.getValue('{{field_name}}'));\nga.getXMLAnswer(function (answer) {\n    // handle answer\n});"],
  ['Client', 'Make a field mandatory and read-only', "g_form.setMandatory('{{field_name}}', true);\ng_form.setReadOnly('{{field_name}}', true);"],
  ['Client', 'Show a form message', "g_form.addInfoMessage('{{message}}');\n// g_form.addErrorMessage('{{message}}');\n// g_form.showFieldMsg('{{field_name}}', '{{message}}', 'error');"],
  ['Server', 'Client-callable Script Include', "var {{class_name}} = Class.create();\n{{class_name}}.prototype = Object.extendsObject(global.AbstractAjaxProcessor, {\n    {{method}}: function () {\n        var input = this.getParameter('sysparm_value');\n        return input;\n    },\n\n    type: '{{class_name}}'\n});"],
  ['Server', 'Script Include class', "var {{class_name}} = Class.create();\n{{class_name}}.prototype = {\n    initialize: function () {},\n\n    {{method}}: function () {\n    },\n\n    type: '{{class_name}}'\n};"],
  ['Server', 'Business Rule skeleton', "(function executeRule(current, previous /*null when async*/) {\n    // {{what_to_do}}\n})(current, previous);"],
  ['Server', 'Add an attachment', "var attachment = new GlideSysAttachment();\nattachment.write(current, '{{file_name}}', 'text/plain', '{{content}}');"],
  ['Server', 'Fire an event', "gs.eventQueue('{{event_name}}', current, '{{parm1}}', '{{parm2}}');"],
  ['REST', 'Outbound REST message', "var request = new sn_ws.RESTMessageV2();\nrequest.setEndpoint('{{endpoint}}');\nrequest.setHttpMethod('GET');\nrequest.setRequestHeader('Accept', 'application/json');\nvar response = request.execute();\nif (response.getStatusCode() === 200) {\n    var body = JSON.parse(response.getBody());\n    gs.info(JSON.stringify(body));\n} else {\n    gs.error('Request failed: ' + response.getStatusCode());\n}"],
  ['REST', 'Scripted REST resource', "(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    var id = request.pathParams.id;\n    response.setStatus(200);\n    response.setBody({ id: id });\n})(request, response);"],
  ['Utility', 'Get a system property', "var value = gs.getProperty('{{property_name}}', '{{default_value}}');"],
  ['Utility', 'Check a role', "if (gs.hasRole('{{role}}')) {\n    // allowed\n}"],
  ['Utility', 'Array of sys_ids from a query', "var ids = [];\nvar gr = new GlideRecord('{{table}}');\ngr.addEncodedQuery('{{encoded_query}}');\ngr.query();\nwhile (gr.next()) {\n    ids.push(gr.getUniqueValue());\n}\ngs.info(ids.join(','));"],
  ['Utility', 'Parse and stringify JSON safely', "var data;\ntry {\n    data = JSON.parse('{{json}}');\n} catch (e) {\n    gs.error('Invalid JSON: ' + e.message);\n}"],
  ['Logging', 'Log with a source', "gs.info('{{message}}', '{{source}}');"],
  ['Logging', 'Log an object', "gs.info(JSON.stringify({{variable}}, null, 2));"],
  ['Logging', 'Log a caught error', "try {\n    // work\n} catch (e) {\n    gs.error('{{source}}: ' + e.message + '\\n' + e.stack);\n}"],
  ['Logging', 'Time a block of code', "var started = new GlideDateTime().getNumericValue();\n// work\nvar elapsed = new GlideDateTime().getNumericValue() - started;\ngs.info('Took ' + elapsed + ' ms');"],
];

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const BUILTIN_SNIPPETS = ENTRIES.map(([category, title, template]) => ({
  id: `builtin.snip.${slug(category)}.${slug(title)}`,
  title,
  category,
  description: '',
  template,
}));
