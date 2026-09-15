import React from 'react';
import { createRoot } from 'react-dom/client';
import Sidebar from './Sidebar.jsx';

export function mountSidebar(container, { getContext }) {
  const ref = React.createRef();
  const root = createRoot(container);
  root.render(<Sidebar ref={ref} getContext={getContext} />);

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
    runCommand: (command) => ref.current?.runCommand(command),
    registerBackgroundScriptRunner: (fn) => ref.current?.registerBackgroundScriptRunner(fn),
    registerServices: (services) => ref.current?.registerServices(services),
  };
}
