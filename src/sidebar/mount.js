import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import Sidebar from './Sidebar.jsx';

export function mountSidebar(container, { getContext, instance = null, onOpenPalette = null }) {
  const ref = React.createRef();
  const root = createRoot(container);
  // Synchronous so ref.current exists when the caller registers services right after mounting.
  flushSync(() => root.render(<Sidebar ref={ref} getContext={getContext} instance={instance} onOpenPalette={onOpenPalette} />));

  return {
    open: () => ref.current?.open(),
    close: () => ref.current?.close(),
    toggle: () => ref.current?.toggle(),
    notify: (text) => ref.current?.notify(text),
    openBackgroundScriptPanel: () => ref.current?.openBackgroundScriptPanel(),
    openComparePanel: () => ref.current?.openComparePanel(),
    openSearchPanel: () => ref.current?.openSearchPanel(),
    openUpdateSetPanel: () => ref.current?.openUpdateSetPanel(),
    openRestPanel: () => ref.current?.openRestPanel(),
    openPromptPanel: (kind) => ref.current?.openPromptPanel(kind),
    openQueryPanel: () => ref.current?.openQueryPanel(),
    openLogTailPanel: () => ref.current?.openLogTailPanel(),
    openVersionPanel: () => ref.current?.openVersionPanel(),
    openFieldPanel: () => ref.current?.openFieldPanel(),
    openRemotePanel: () => ref.current?.openRemotePanel(),
    openAtfPanel: () => ref.current?.openAtfPanel(),
    openScopePanel: () => ref.current?.openScopePanel(),
    openAutomationPanel: () => ref.current?.openAutomationPanel(),
    runCommand: (command) => ref.current?.runCommand(command),
    sendPrompt: (label, prompt) => ref.current?.sendPrompt(label, prompt),
    registerBackgroundScriptRunner: (fn) => ref.current?.registerBackgroundScriptRunner(fn),
    registerServices: (services) => ref.current?.registerServices(services),
  };
}
