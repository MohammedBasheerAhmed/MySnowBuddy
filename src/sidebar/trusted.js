// Real user input only. Scripts on the ServiceNow page can dispatch synthetic
// events (element.click(), new KeyboardEvent(...)); those carry isTrusted ===
// false. Every handler that confirms, approves, runs, writes, pushes, moves,
// impersonates or switches scope is wrapped with trusted() so only a person at
// the keyboard or mouse can trigger it. Works for React synthetic events
// (checks nativeEvent) and plain DOM events alike.

/** True only for an event the browser generated from real user input. */
export function isTrustedEvent(event) {
  return (event?.nativeEvent ?? event)?.isTrusted === true;
}

/** Wraps an event handler so it runs only for trusted events; synthetic ones are ignored. */
export function trusted(handler) {
  return function trustedHandler(event, ...rest) {
    if (!isTrustedEvent(event)) return undefined;
    return handler.call(this, event, ...rest);
  };
}

/** Same check for plain addEventListener handlers (content-script UI built without React). */
export const trustedDom = trusted;
