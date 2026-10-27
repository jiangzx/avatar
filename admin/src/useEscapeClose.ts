import { useEffect } from 'react';

/** Close a dialog with Escape even when the focus trap does not own the key event. */
export function useEscapeClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Capture before AntD's focus trap can stop propagation.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
}
