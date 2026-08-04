import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useState, useCallback, useRef } from 'react';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateId() {
  return crypto.randomUUID();
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
}

export function compressImage(file: File, maxWidth = 1200, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onerror = error => reject(error);
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          let width = img.width;
          let height = img.height;

          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(reader.result as string);
            return;
          }

          ctx.drawImage(img, 0, 0, width, height);
          const compressed = canvas.toDataURL('image/jpeg', quality);
          resolve(compressed);
        } catch {
          resolve(reader.result as string);
        }
      };
      img.onerror = () => resolve(reader.result as string);
      img.src = reader.result as string;
    };
  });
}

export const haptics = {
  light: () => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(10);
    }
  },
  medium: () => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(20);
    }
  },
  heavy: () => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(30);
    }
  }
};

type UndoRedoState<T> = { past: T[]; present: T; future: T[] };

/**
 * Undo/redo history.
 *
 * `undo()` and `redo()` RETURN the value that became current, or `undefined`
 * when there was nothing to undo/redo. Callers rely on this to push the value
 * back into their own state:
 *
 *   const newState = undo();
 *   if (newState !== undefined) { ...persist newState... }
 *
 * Previously both functions only queued a `setState` and implicitly returned
 * `undefined`, so that guard never passed: the internal history moved but the
 * editor content never changed, making the undo and redo buttons look dead.
 * They also called `onChange` from inside the state updater, which is a side
 * effect during render-phase work and fired twice under StrictMode.
 */
export function useUndoRedo<T>(initialState: T, onChange?: (state: T) => void) {
  const [state, setState] = useState<UndoRedoState<T>>({
    past: [],
    present: initialState,
    future: []
  });
  const lastSetTime = useRef<number>(Date.now());
  const onChangeRef = useRef(onChange);
  // Mirror of `state` so undo/redo can compute the next value synchronously
  // and hand it straight back to the caller.
  const stateRef = useRef<UndoRedoState<T>>(state);

  onChangeRef.current = onChange;

  const commitState = useCallback((next: UndoRedoState<T>) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const set = useCallback((newState: T) => {
    const now = Date.now();
    const prevState = stateRef.current;

    // Group changes if they happen within 500ms of each other
    const next: UndoRedoState<T> =
      now - lastSetTime.current < 500 && prevState.past.length > 0
        ? { ...prevState, present: newState }
        : { past: [...prevState.past, prevState.present], present: newState, future: [] };

    commitState(next);
    lastSetTime.current = now;
  }, [commitState]);

  const undo = useCallback((): T | undefined => {
    const prevState = stateRef.current;
    if (prevState.past.length === 0) return undefined;

    const previous = prevState.past[prevState.past.length - 1];
    commitState({
      past: prevState.past.slice(0, prevState.past.length - 1),
      present: previous,
      future: [prevState.present, ...prevState.future]
    });

    onChangeRef.current?.(previous);
    return previous;
  }, [commitState]);

  const redo = useCallback((): T | undefined => {
    const prevState = stateRef.current;
    if (prevState.future.length === 0) return undefined;

    const next = prevState.future[0];
    commitState({
      past: [...prevState.past, prevState.present],
      present: next,
      future: prevState.future.slice(1)
    });

    onChangeRef.current?.(next);
    return next;
  }, [commitState]);

  const commit = useCallback(() => {
    lastSetTime.current = 0;
  }, []);

  const reset = useCallback((newState: T) => {
    commitState({
      past: [],
      present: newState,
      future: []
    });
    lastSetTime.current = Date.now();
  }, [commitState]);

  return {
    state: state.present,
    set,
    undo,
    redo,
    commit,
    reset,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0
  };
}
