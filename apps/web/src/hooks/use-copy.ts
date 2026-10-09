import { useCallback, useEffect, useRef, useState } from 'react';

const COPIED_RESET_MS = 1500;

/** Copies `text` to the clipboard; `copied` stays true briefly after each copy. */
export function useCopy(text: string): readonly [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  }, [text]);

  return [copied, copy];
}
