// What the "notify" feature (Why wasn't the email sent?) needs from the instance, for the Self-check panel
// (src/lib/requirements/index.js). One entry per table: { feature, table, columns: [...], optional?: true, note?: "why" }.
// sysevent_email_action, sys_email, sys_email_log and sysevent were checked on a live PDI on 2026-10-23;
// docs/features/notify.md lists what is confirmed and what is still assumed.

const FEATURE = 'Email tracer';

export const REQUIREMENTS = [
  {
    feature: FEATURE,
    table: 'sysevent_email_action',
    columns: ['name', 'collection', 'active', 'event_name', 'action_insert', 'action_update', 'condition', 'recipient_users', 'recipient_groups', 'recipient_fields', 'send_self', 'subject'],
    note: 'The notifications that could fire for a record: its table, trigger, condition and who it sends to.',
  },
  {
    feature: FEATURE,
    table: 'sysevent_email_action',
    columns: ['generation_type', 'advanced_condition', 'event_parm_1', 'event_parm_2', 'force_delivery'],
    optional: true,
    note: 'generation_type tells event / record-save / triggered apart (otherwise guessed from event_name and the insert/update boxes); advanced_condition is shown, never run; the parm columns say whether the event carries recipients; force_delivery ("Force delivery") is taken to override a user whose Notification is Disable.',
  },
  {
    feature: FEATURE,
    table: 'sysevent',
    columns: ['name', 'state', 'table', 'instance', 'parm1', 'parm2', 'queue', 'processed', 'process_on'],
    note: 'The events fired for the record (instance = the record sys_id). If instance were missing, every event would match, so rows are checked after they come back.',
  },
  {
    feature: FEATURE,
    table: 'sysevent',
    columns: ['user_id', 'user_name'],
    optional: true,
    note: 'Who fired the event: that person is left out unless "Send to event creator" is on.',
  },
  {
    feature: FEATURE,
    table: 'sys_email',
    columns: ['headers', 'status', 'instance', 'target_table', 'type', 'state', 'subject', 'recipients', 'error_string'],
    note: 'The emails created for the record (instance = the record sys_id) and what became of them. headers names the notification that made each one ("X-ServiceNow-Source:Notification-<sys_id>"); sys_email has no notification column (confirmed live 2026-10-23).',
  },
  {
    feature: FEATURE,
    table: 'sys_email',
    columns: ['copied', 'blind_copied', 'body', 'body_text'],
    optional: true,
    note: 'copied and blind_copied list Cc and Bcc; body_text and body are only read for the text preview.',
  },
  {
    feature: FEATURE,
    table: 'sys_email_log',
    columns: ['email', 'event', 'notification'],
    optional: true,
    note: 'The platform log tying each email to the event and the notification that produced it. Without it the email header still names the notification.',
  },
  {
    feature: FEATURE,
    table: 'sys_user',
    columns: ['name', 'user_name', 'email', 'active', 'locked_out', 'notification'],
    note: 'Per recipient: active, locked out, empty email address, and the Notification setting (1 = Disabled).',
  },
  {
    feature: FEATURE,
    table: 'sys_user_group',
    columns: ['name', 'active'],
    note: 'Groups on the notification (and groups held in a recipient field).',
  },
  {
    feature: FEATURE,
    table: 'sys_user_group',
    columns: ['email', 'include_members'],
    optional: true,
    note: 'A group with its own address is mentioned as a note.',
  },
  {
    feature: FEATURE,
    table: 'sys_user_grmember',
    columns: ['group', 'user'],
    note: 'Members of a recipient group.',
  },
  {
    feature: FEATURE,
    table: 'cmn_notif_device',
    columns: ['user', 'type', 'active', 'email_address'],
    optional: true,
    note: 'A user whose email notification devices are all inactive gets no mail. Without this table the check is skipped and said so.',
  },
  {
    feature: FEATURE,
    table: 'sys_properties',
    columns: ['name', 'value', 'type'],
    note: 'Read only for glide.email.smtp.active, glide.email.test.user, glide.email.default.sender and glide.installation.production (nothing secret).',
  },
];
