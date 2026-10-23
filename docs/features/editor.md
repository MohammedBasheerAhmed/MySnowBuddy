# The script editor

Where: `src/content/scriptEditor.js` (the DOM and the key map), `src/content/editor.css`, pure logic in `src/lib/` (`editorText.js`,
`completion.js`, `editorDiagnostics.js` and the newer `editorOutline.js`, `editorFormat.js`, `editorChanges.js`, `editorMulti.js`,
`snippets.js`, `editorSnippetSession.js`), data in `src/content/editorData.js`. Tests: `tests/editor.test.js`, `tests/completion.test.js`,
`tests/editorplus.test.js`. Open it with the Edit button on a script field label (in place, over the field), Alt+Shift+E, or the palette
command "Edit the script"; Full screen is a button inside. In the preview harness: `?inline=1&page=script` (or `page=si`) then
`window.__openEditor()`.

The editor is a transparent `<textarea>` over a highlighted copy of the text. Every edit goes through `execCommand('insertText')` so the
browser's undo keeps working. It only changes the form field (it saves the record on "Apply & save" or, in place, on Ctrl+S).

## Audit: what it did before this round, against what a developer expects

Already there (read from the code, all of it on the F1 list):

| Expectation | State before |
|---|---|
| Syntax highlighting, line numbers, bracket matching, auto-closing pairs, smart Enter and Home | had it |
| Completion (methods, GlideRecord fields, dot-walking through reference fields, tables, Script Includes, properties, roles, snippets), fuzzy ranking | had it (dot-walk: `gr.caller_id.` lists the `sys_user` fields once the table is known from `new GlideRecord('incident')` or the rule's table; fields are fetched once per table and cached by `editorData.js`) |
| Hover docs, parameter hints (also for Script Include methods of the same instance, read from their source), go to definition, find all references | had it |
| Problems list, squiggles, quick fixes, F8 next problem | had it |
| Find / replace with regex, case and whole word | had it |
| Go to line (Ctrl+G), comment toggle, move / duplicate / delete lines, indent / outdent | had it |
| Re-indent (Shift+Alt+F) | had it, whitespace at the start of lines only |
| Snippets: 9 names expanded with Tab, one caret position | had it |
| Dry run and Run buttons, output in a panel | had it; the panel could not be closed |
| In place over the form field, full screen | had it |

Missing, and what was done about it:

| Gap | Result |
|---|---|
| Outline / go to symbol | **built** (Ctrl+Shift+O) |
| Format document / selection | **built** (Shift+Alt+F, Format button) |
| What did I change, and revert one hunk | **built** (gutter bars, Changes button, Alt+F3) |
| Multi-cursor, select next occurrence | **built, "lite"** (Ctrl+D, Ctrl+Shift+L, Alt+click) |
| Snippet blanks with Tab, linked copies | **built**, 15 snippets (`si`, `sia`, `br`, `onchange`, ...) |
| Dry run from the keyboard, closable output | **built** (Ctrl+Shift+Enter); the output panel has Copy and Close and Esc closes it |
| Join lines, select line | **built** (Ctrl+J, Ctrl+L) |
| Dot-walk completion, Script Include parameter hints | already existed, nothing to do |
| Not built (ideas): code folding, minimap, rename across Script Includes, block comments toggle, expand selection to the enclosing brackets, sticky scope header | |

## What is new

**Go to symbol (Ctrl+Shift+O, or the breadcrumb button in the footer, or palette "Go to a function in the script").** Lists functions,
`name: function (...)` members, `X.prototype.name = function`, ES6 methods and classes, arrow functions, the Script Include class and its
`type: 'X'` marker, and handlers (`onLoad`, `onChange`, `onSubmit`, `onCellEdit`, `executeRule`, `process`). Type to filter (the same fuzzy
matcher as completion), arrows and Enter to jump. The footer shows where the caret is ("IncidentUtils > getOpen"); clicking it opens the list.
`src/lib/editorOutline.js`. It reads the code with comments, strings and regexes blanked and never runs it. Limits: a `name: function` inside
a ternary can show up as a symbol; anonymous callbacks are not listed; over 300,000 characters the outline is off.

**Format (Shift+Alt+F, the Format button, or palette "Format the script").** With nothing selected it formats the whole script, with lines
selected only those lines. What it does: indentation from the bracket structure, one space after a comma and around `= == === != !== <= >= &&
|| ??` and compound assignments, `if (`, `for (`, `while (`, `switch (`, `catch (`, one space before a block's `{` and in `} else`, no space
before `,` or `;`, no trailing blanks, at most one blank line in a row, no blank lines at the top, one newline at the end. What it never does:
move a brace, join or split a line, change the inside of a string, template literal, regular expression or comment, change `+ - * / < >`
spacing. Safety: after formatting it compares the token stream ignoring whitespace (`==` and `= =` are different tokens) and refuses when
anything differs; it runs a second time and refuses when the result is not identical; it refuses when the new text has a syntax error the old
one did not; it refuses unbalanced brackets and mixed line endings. A refusal is a toast and changes nothing. One undo step (Ctrl+Z). A
fuzz run of 60,000 generated programs gave no refusal and no program that stopped parsing in Node's real parser (see
`tests/editorplus.test.js` for the property tests that stay in the repo).

Review of 2026-10-23: the token comparison only protects against what the lexer understands, and five lexer gaps let the formatter change
text inside strings and regexes with every safety check passing. All fixed in `editorText.lex` / `editorFormat.tokenize`, each with a
regression test: a template literal nested in `${...}` (`` `${items.map(i => `<li>${i},x</li>`)}` `` had `, x` put into the HTML); a
regex right after the `)` of `if` / `while` / `for` (`if (x) /a=b/.test(s)`); a division after `i++` or after a property called like a
keyword (`o.return / 2`) followed by a string with a slash on the same line; a no-break space (pasted from a web page) before a regex; and
`??=` / `||=` / `&&=`, which were split into `?? =` (a syntax error). `#private` names and `1e-5` are single tokens now. The property
test now checks the result against an independent parser: esbuild's minified output of every realistic script in the repo (the
snippets, the "new ..." templates, the preview's records and ES5/ES12 scripts with nested templates, regexes, ASI, labels, getters,
classes, emoji, tabs, CRLF), with blanks shuffled, whole and partial, must be byte-identical before and after formatting.
Live check (OOTB "incident events" rule): Format used to pull the statement after a brace-less `if (!transaction)` back to the `if`'s
column. `reindent` now indents the body of a brace-less `if` / `else` / `else if` / `for` / `while` / `do` / `with` one level per header
(nested bodies, `else` lined up with the `if` it belongs to, a body over several lines, a `while` closing a brace-less `do`), tracked per
bracket depth; tested on the exact lines, fixed cases and 300 generated nestings that must come out in exactly the expected layout
with an unchanged esbuild meaning. The editor turns programming-font ligatures off on every layer that draws code (Cascadia Code drew
`!=` as one "not equal" glyph).
Size: one replacement of more than 40,000 characters is refused ("select the part you want formatted") because the browser's own editing
takes several seconds for that much.

**Changes since the record was loaded.** A bar beside the line numbers (green added, amber changed, a red triangle where lines were removed;
click a bar to open the list). The "N changes" button in the footer lists every region with the old and new lines and **Show** and
**Revert** per region, plus **Revert all**; Alt+F3 / Shift+Alt+F3 jump to the next / previous change. "Loaded" means the record as it is
saved on the instance: when the editor opens a field it reads that one column of the record through the Table API (`readSavedFieldValue`
in `editorData.js`), because the form may already hold unsaved text (typed on the form, or synced from an in-place editor that was closed
and opened again). When that cannot be read (a new record, a column the Table API does not return, a failed read, a password-type or
secret-looking field, which is never read) it falls back to the field's text when the editor opened it. After a successful "Apply & save"
or Ctrl+S in place the saved text is the editor's. Line breaks are compared as `\n` (a `\r\n` value no longer makes every line look
changed, and in place it is no longer written back to the form unasked). Reverting is one replacement, so Ctrl+Z puts it back; a Revert
clicked on a row drawn before the text changed is refused instead of reverting the wrong lines. `src/lib/editorChanges.js`: line diff with common start and end skipped first, an exact comparison when the middle is small and unique-line
anchors when it is big.

**Several cursors (Ctrl+D, Ctrl+Shift+L, Alt+click).** Ctrl+D selects the word at the caret, then adds the next occurrence each time (whole words
when it started from a word, wraps round); Ctrl+Shift+L selects every occurrence; Alt+click adds a cursor. Then typing, Backspace, Delete,
Enter, Tab and paste act on every cursor as one change (a clipboard with as many lines as cursors gives each cursor one line). Left, Right,
Home and End move them all (Backspace, Delete and the arrows step over an emoji as one character; before the review they split it into
two broken halves). Paste at several cursors did not work in Chrome before the review: a textarea's paste event carries the text in `data`,
not `dataTransfer` (checked in headless Chrome). Esc, a click, any other key or an undo goes back to one cursor. Not supported: Shift+arrows, Ctrl+arrows,
cut and copy of several selections (these act on the main cursor), IME composition. In a long script a change with cursors far apart is
applied cursor by cursor (so Ctrl+Z undoes one cursor at a time, and a toast says so) and more than 120 cursors there is refused. The cap is
1,000 cursors.

**Snippet blanks.** Type a name and press Tab (or accept it from the suggestion list): `gr`, `grget`, `gra`, `gdt`, `info`, `err`, `try`, `fn`,
`ajax`, `si` (Script Include), `sia` (client-callable Script Include), `br` (Business Rule), `onchange`, `onload`, `onsubmit`. The blanks are
highlighted and selected one after another; Tab moves on, Shift+Tab goes back, Esc stops. A name used twice in a template (the class name in
`si`) is a linked copy that follows what you type. The session ends instead of guessing if you edit anywhere else, and it will not overwrite a
copy you changed by hand. Syntax in `src/lib/snippets.js` (`${1:default}`, `$1`, `$0`, `\$`). A name at the end of a comment or inside a
string is not expanded (`// see the gr` + Tab used to put a GlideRecord query, live code from its second line, into the comment).

**Dry run (Ctrl+Shift+Enter) and the output panel.** Runs the selection, or the whole script, through the same background runner as the
Dry run button (GlideRecord writes intercepted). The keyboard never starts a real run. New: if the script does things a dry run cannot hold
back (outbound REST, events, `setProperty`, attachments, flows, direct SQL, `eval`; the list is `analyzeScriptRisk`'s "unintercepted" findings) the
editor asks first, for the button as well as the key. The output panel has a title, Copy and Close, and Esc closes it. The header of the output
says that only GlideRecord writes are intercepted. One run at a time: a second click or key press while a run is going only says so. A held
key repeats keydown: Ctrl+S, Ctrl+Shift+S, Ctrl+Enter and Ctrl+Shift+Enter act on the first press only (before the review a held Ctrl+S in
place started one apply and save per repeat, read from the code), apply/save is single-flight too, and synthetic key events from a page script still do nothing.

**Smaller things.** Ctrl+J joins the line with the next (refuses when it would comment out the next line, break a string, or change what
JavaScript reads: a line ending in `return` / `throw` / `break` / `continue` with code on the next line, or a next line starting with `++` /
`--`), Ctrl+L selects the line
(again for the next). In place, the narrow editor hides the footer hints and tightens the buttons (container query on the editor), and F1 uses the
whole editor. Tab indents, so from the keyboard there was no way to reach the buttons and lists (the Changes list's Revert, the header
buttons): Ctrl+M switches Tab to moving the focus, as in VS Code, and back.

## Keys added (all on the F1 list)

Ctrl+Shift+O, Ctrl+D, Ctrl+Shift+L, Alt+click, Ctrl+L, Ctrl+J, Ctrl+M, Alt+F3 / Shift+Alt+F3, Ctrl+Shift+Enter (was Apply and close; Ctrl+Enter still is).
The editor keeps these keystrokes from reaching the page (the overlay stops propagation); the browser's own shortcuts for Ctrl+D (bookmark), Ctrl+L
(address bar), Ctrl+J (downloads) and Ctrl+Shift+O (bookmark manager) are cancelled by the editor only while it has focus. Ctrl+S, Ctrl+Enter and Esc
keep their meaning.

## Assumptions that need a live-instance check

* The four browser shortcuts above are cancelled by `preventDefault` in the editor. Chrome lets pages do that for these, but only a real Chrome
  tab proves it (headless puppeteer sends events straight to the page).
* Everything was exercised in the preview harness against a fake form; the in-place sync to the real `g_form` (`setFieldValue`) is unchanged code.
* Dry run output through the real runner (`runBackgroundScript`, `extractScriptOutput`) was exercised against the harness' fake `sys.scripts.do`,
  which answers every script with one line. The real output format is the existing one.
* Alt+click in a real browser on Windows (no menu key side effect expected).
* The saved-text read: `GET /api/now/table/<table>?sysparm_query=sys_id=<id>&sysparm_fields=sys_id,<field>` must return the script exactly
  as the form loaded it (same trailing newline, no leading newline dropped by the form's textarea). If a real form differs from the record
  in a systematic way, every script would open showing a one-line change.
* `g_form.setValue` on a script field with the syntax editor (CodeMirror) after Revert all / Format in place: the visible field follows.
* Performance: typing in a 6,000-line script stays at about 50 ms per key in the harness. One big native `execCommand` replacement is quadratic in
  the number of lines (400 lines 0.4 s, 1,600 lines 4.5 s, measured in plain Chrome, not specific to this code); that is why replacements over
  40,000 characters are refused or split.
