import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { readSessionDisclosure, writeSessionDisclosure, type SessionDisclosureSection } from '../session-disclosure.ts';

export function PersistedDetails({
  sessionId,
  section,
  summary,
  className = '',
  children,
}: {
  sessionId: string;
  section: SessionDisclosureSection;
  summary: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return readSessionDisclosure(window.localStorage, sessionId, section);
    } catch {
      return false;
    }
  });

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const nextOpen = event.currentTarget.open;
    setOpen(nextOpen);
    try {
      writeSessionDisclosure(window.localStorage, sessionId, section, nextOpen);
    } catch {
      // A failed localStorage write must not block disclosure interaction.
    }
  }

  return <details className={className} open={open} onToggle={handleToggle}><summary>{summary}</summary>{children}</details>;
}
