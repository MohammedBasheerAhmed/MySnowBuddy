# Why wasn't the email sent? (`/notify`)

For the record on screen: which notifications could fire for it, and how far each one got along the chain
**matched -> event fired -> event processed -> email created -> email sent**. The first broken link is named in a sentence a
developer can act on. Panel name `notify`, slash `/notify` and `/whymail`, icon `mail`. Read-only: nothing is ever written.

Files: `src/lib/notifyTrace.js` (pure rules, unit tested), `src/content/notifyTrace.js` (reads from the instance, services
`notifyReport` and `notifyEmailText`), `src/sidebar/NotifyPanel.jsx` and `notify.css`, `tests/notifytrace.test.js`,
`preview/fixtures/notify.js`, `src/lib/requirements/notify.js` (for the Self-check panel).

## Where it works

| On screen | What the panel does |
| --- | --- |
| Any saved record (incident, change, a custom table) | Lists every notification on the table and its parent tables, active or not, and traces the chosen one |
| `/notify Incident commented` | Same, with that notification chosen; if it is not defined for this table or its parents it says so and links to a notification with a similar name elsewhere |
| An email (`sys_email`) | "Why did it go to these people": the email, what triggered it (the event, or the save), and for each To/Cc/Bcc address which source supplied it (listed user, group, field, event parameter); then the same trace for the notification that made it |
| An event (`sysevent`) | Traces the record the event was queued for and selects the notification that listens to this event |
| A notification (`sysevent_email_action`), or `/notify <name>` on a list page | Which records meet its condition right now (count and examples), who it sends to, the latest events it reacts to and the latest emails it created |

## The chain, and what each step checks

1. **Matched.** Active; defined on this table or a parent; the trigger is complete (an event is chosen, or Inserted/Updated is
   ticked); an insert-only notification created after the record could not have fired; an update-only one on a record that was
   never updated could not; the encoded `condition`, judged against THIS record by asking the Table API for
   `sys_id=<id>^<condition>` (the sys_id is put in front of every `^NQ` group so an OR of groups cannot match other rows) and
   explained in words by the existing rule evaluator (`evaluateQuery` in `src/lib/ruleExplain.js`: "assigned_to is (empty),
   must not be empty"). A condition that depends on the save (`changes`, `changes to`) or on the viewer (dynamic, `javascript:`)
   is "cannot tell". An advanced condition script is shown and never run: "cannot tell".
2. **Event fired.** Only for event notifications: a `sysevent` row named like `event_name` for this record. If none: the event
   was never queued; the panel lists what WAS queued and flags a near-identical name (a typo). On an old record, absence is only
   "cannot tell" because processed events are cleaned out after about 7 days by default.
3. **Event processed.** The latest event: processed / error / scheduled (`process_on` in the future) / waiting / stuck in `ready`
   for 30 minutes or more.
4. **Email created.** `sys_email` rows for the record that came from this notification. The link is exact: the email's
   `headers` start with `X-ServiceNow-Source:Notification-<sys_id of the notification>`, and `sys_email_log` (`email`, `event`,
   `notification`) names the notification and the event for each email (read for the record's emails, 40 ids per request, at
   most 100 emails; a log entry wins over the header). Only an email that has neither (no headers yet, no log entry) is matched by
   the subject template. For an event notification an email the log ties to an event answers for that event; otherwise only
   emails created after the latest event count, so "the earlier events sent but the latest did not" is visible. If there is
   none, the recipients decide the
   sentence: nobody listed, a recipient field empty on this record, every recipient dropped (inactive, notifications disabled,
   no address, all email devices inactive), or the person who fired the event being the only recipient while "Send to event
   creator" is off (the classic gotcha).
5. **Email sent.** The latest email: `sent` (the mail server took it), `send-ready` (waiting; stuck after 15 minutes),
   `send-ignored` (the instance chose not to send; the reason text is shown), `send-failed` (the error string is shown).

Evidence beats inference: if an email exists for the occurrence, the notification evidently matched, so a failing condition or
an inactive flag now is shown as a warning ("this may have changed since"), not as the cause.

Guards added in review (each has a regression test in `tests/notifytrace.test.js`):

- **Hidden tables.** The Table API answers a table the user may not read with `200` and no rows, not a `403`. So when the
  record's events (or emails) come back empty, one unfiltered one-row read checks the user can see `sysevent` (or `sys_email`)
  at all; if not, the step is "cannot tell: your account sees no rows of sysevent at all", never "the event was never queued".
  The same for `sys_properties`: if none of the four mail properties comes back, the mail settings are "not checked", never
  "nothing unusual".
- **Inbound replies** (`sys_email.type` starting `received`) carry the record and often the subject ("RE: ..."), so they are
  never counted as an email the notification created.
- **Emails that name no notification.** An email with no X-ServiceNow-Source notification line and no email log entry can only
  be matched by subject, which a template or mail script can change. If such an email exists for the record in the same window
  (since the latest event), "no email was created" becomes "cannot tell" and points at "Other emails for this record". With the
  header and the log this is rare. An email whose header names a different source (a script) is known not to be this
  notification's and is never matched by subject. If `sys_email_log` cannot be read, a note says so and the header still works.
- **A condition field the record does not have.** The instance drops a query term on an unknown field and then says "yes", so a
  "met" answer for a condition that uses a field missing from the record read is "cannot tell".
- **Record-save notifications** have no event to anchor the latest occurrence: a "Sent" email older than the latest save says so.
- **Groups.** At most 25 recipient groups have their members read (one request each); a group whose members were not read (cap
  or error) is "members not read", never "has no members", and the email step is then "cannot tell".

Steps after the first failure are shown as "Not reached" (a notification without an event shows "Not used" for the two event
steps). A later step that also fails on its own evidence shows "Also stopped".

## Recipients

For the chosen notification: listed users, listed groups (member count, inactive members), `recipient_fields` read on the
record (a user, a group, a list of either, or an address; dot-walked fields are read with a second query), event parameter 1/2
when the notification says they carry recipients, and the "Send to event creator" setting. Each person gets "Gets it" or
"Left out" with the reasons: inactive; `sys_user.notification` disabled (unless the notification has Force delivery); is the event
creator; no email address; all email devices inactive. Locked out is a note, not a reason. "Event creator" is the user on the
latest matching event (`sysevent.user_id` / `user_name`), or for a save notification the user who made the last save
(`sys_updated_by`).

## Instance switches

Read, never changed: `glide.email.smtp.active` ("email sending is switched off on this instance"), `glide.email.test.user`
(all mail redirected to one address), `glide.email.default.sender` (read, not judged), `glide.installation.production`, and the
host name (dev/test/stage) for the "not production" note. A property that does not exist is not reported. If the properties
cannot be read, the panel says that a switched-off setting would not show.

## What the UI shows

A notification picker (event-fired first, then condition-met, then the rest, inactive last; filter box above 8), the verdict
(colour and words), the five steps, "Who would get it", the events and emails for the notification with a safe text preview of
each email (tags stripped, secrets redacted, never HTML; mail whose subject looks like a password or code is not shown), links
to every record, and "Copy summary as Markdown" (names, and addresses masked as `b***@acme.example`). Empty state (no
notifications on the table), could-not-read states per section (notifications, events, emails, people, mail settings).

## Confirmed live 2026-10-23 (Table API on the owner's PDI)

- `sysevent_email_action` has `name`, `collection`, `active`, `generation_type` (`engine` = on insert/update, `event`,
  `triggered`), `event_name`, `action_insert`, `action_update`, `condition`, `advanced_condition`, `recipient_users`,
  `recipient_groups`, `recipient_fields`, `send_self`, `event_parm_1`, `event_parm_2`, `subject`, and both `mandatory` and
  `force_delivery` (also `weight`, `template`, `exclude_delegates`, `subscribable`, `digestable`, `type` and more, not read).
- `sys_email` has **no `notification` column**. Its columns: `blind_copied`, `body`, `body_text`, `checkpoint`, `content_type`,
  `copied`, `deleted`, `direct`, `error_string`, `headers`, `importance`, `instance` (the record's sys_id), `mailbox`,
  `message_id`, `notification_type` (the transport, `SMTP`, not a link), `receive_type`, `recipients`, `reply_to`, `state`
  (`ready`, ...), `status`, `subject`, `target_table` (the record's table), `type` (`send-ready`, `sent`, ...), `uid`, `user`,
  `user_id`, `weight`.
- The email -> notification link is the first header line `X-ServiceNow-Source:Notification-<sys_id>` (seen on real incident
  emails). It is parsed strictly, one line at a time, CRLF or LF; headers are never shown or copied.
- `sys_email_log` exists with `email`, `event`, `notification` (references).
- `sysevent.instance` is the record's sys_id; `sysevent.table`, `queue` and `state` (`processed`, ...) exist.

## Assumptions that still need a live-instance check

They are also in `src/lib/requirements/notify.js` so the Self-check panel can test them.

- `sysevent`: `parm1`, `parm2`, `processed`, `process_on`, and `user_id` / `user_name` for the event creator. Event times are
  shown as UTC.
- Whether every email a notification creates carries the X-ServiceNow-Source header from the start (a `send-ready` email may not
  have headers yet; the email log covers that case) and whether `sys_email_log` has an entry for every such email.
- `force_delivery` ("Force delivery") is taken as the box that sends to a user whose `sys_user.notification` is Disable;
  `mandatory` (users cannot unsubscribe) is not read. Which of the two overrides a disabled user is not verified, so the
  wording names only Force delivery.
- Notification `weight` is not read: when several notifications fire for the same record and recipient, only the heaviest is
  sent, which can explain a "no email" that the tracer reports as "nothing above stops it".
- Partial ACLs (a user who can see some rows of `sysevent` or `sys_email`, but not this record's) cannot be detected; the tracer
  is meant for admins and developers with read access to those tables.
- `sysevent` is a rotated table; whether the cleanup is about 7 days on every instance is not verified.
- On the notification page, its emails come from `sys_email_log` (`notification = <id>`, newest 30 entries, at most 10 emails).
  When the log is unreadable or has none, the newest 100 emails with `target_table = <notification table>` are checked by header
  (subject as the last resort), so for a notification on `task` the emails of incidents are not listed (said in a note).
- `sys_user.notification` value 1 / label "Disable" = notifications disabled; `locked_out`; `email`.
- `sys_user_group.email` / `include_members` (only mentioned as a note); `sys_user_grmember.group` / `user`.
- `cmn_notif_device`: `user`, `type` (contains "email"), `active`, `email_address`. If it cannot be read the check is skipped
  and the panel says so.
- Event processing is "stuck" at 30 minutes in `ready`, an email "stuck" at 15 minutes in `send-ready`, event cleanup at about 7
  days: judgement numbers in `src/lib/notifyTrace.js` (`STUCK_EVENT_MINUTES`, `STUCK_EMAIL_MINUTES`, `EVENT_RETENTION_DAYS`).
- "Send to event creator" only removes the creator when it is off; it does not add the creator when on.
- The Table API `instance=<sys_id>` query on `sys_email` and `sysevent` can be slow on a very large table if `instance` is not
  indexed; a timeout shows up as a could-not-read note.

## Known limits

- Scripts are never run: advanced conditions, mail scripts and the flow or script behind a "Triggered" notification are
  invisible, and reported as such.
- Conditions are judged against the record as it is now, not as it was at the moment of the save.
- Digest and delayed delivery, user notification preferences per notification (`cmn_notif_message`), email filters, delegates
  and the outbound mail server itself are not read. "Sent" is the last thing the instance can say; spam filters are beyond it.
- Unsaved edits on the form are not used; the saved record is what the instance sees.

## Verified so far

Unit tests (`tests/notifytrace.test.js`) for every failure mode, plus two end-to-end tests that run `src/content/notifyTrace.js`
against the fixture (including `?mail=acl`, a user who sees no rows of `sysevent`, `sys_email` or `sys_properties`); the
preview harness with `preview/fixtures/notify.js` (an incident with eight notifications, one per failure mode, emails shaped
like real ones: headers with the X-ServiceNow-Source line, no notification column, and a `sys_email_log`; `?mail=off` and
`?mail=test` show the instance switches, `?mail=acl` the hidden tables, `?mail=nolog` an unreadable email log). Note: in the preview the System properties fixture
now answers before this one, so `?mail=off|test|acl` do not change the mail banner there (the unit and end-to-end tests do).
Open it with `?open=notify`, `?open=notify&q=assigned`, `?record=sys_email:p1&open=notify`,
`?record=sysevent_email_action:p1_escalation&open=notify`, `?record=sysevent:e2&open=notify`.
