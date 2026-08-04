import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Tracks scroll direction from ANY scrollable element on the page and
 * returns a `barsVisible` flag suitable for hiding/showing UI chrome.
 *
 * Behaviour:
 *  - Bars start visible.
 *  - Any downward scroll hides them.
 *  - They stay hidden while the user is idle (no "reset to visible on stop").
 *  - A small upward scroll (>= threshold) brings them back.
 *  - If the scroll container is at the very top, bars are always visible.
 *  - Near the very bottom of the scroll container, direction changes are
 *    ignored to prevent jitter from overscroll bounce.
 *  - State changes are debounced to prevent rapid toggling.
 *
 * Uses a capture-phase listener on `document` so it works with any
 * nested scroll container (scroll events don't bubble but are visible
 * during capture).
 *
 * @param threshold minimum delta in px before a direction change registers (default 8)
 * @param options.enabled  When false the hook is inert and always reports
 *   `barsVisible: true`. Auto-hide only makes sense on long scrolling list
 *   pages; on detail pages it caused the chrome to be hidden while the page
 *   still reserved space for it, leaving a blank gap at the top.
 * @param options.resetKey Change this (e.g. to the current route) to force the
 *   bars back to visible. Without it the hidden/visible state leaked across
 *   navigations: scrolling a gallery down and then opening a card carried the
 *   "hidden" state into the new page.
 */
export function useScrollDirection(
  threshold = 8,
  options: { enabled?: boolean; resetKey?: string } = {},
): { barsVisible: boolean } {
  const { enabled = true, resetKey } = options;
  const [barsVisible, setBarsVisible] = useState(true);
  // Mirror of `barsVisible` so the scroll handler can read the current value
  // without being re-created (and re-bound) on every toggle.
  const barsVisibleRef = useRef(true);
  const scrollTopMap = useRef(new WeakMap<EventTarget, number>());
  const lastToggleTime = useRef(0);
  const pendingDirection = useRef<boolean | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Minimum ms between state changes to prevent rapid toggling / jitter.
  // Raised from 100ms: at 100ms the bars could flip ~10x/second during a
  // normal flick, which is what made scrolling feel twitchy and "chunky".
  const DEBOUNCE_MS = 250;
  // How close to the bottom (px) we ignore direction changes
  const BOTTOM_DEAD_ZONE = 20;
  // Don't hide the chrome until the user has scrolled meaningfully down the
  // page. Prevents the header yo-yoing on short content.
  const HIDE_AFTER_PX = 64;

  const handleScroll = useCallback(
    (e: Event) => {
      if (!enabled) return;
      const target = e.target;
      if (!target || !(target instanceof HTMLElement)) return;

      // Ignore scrollers that opt out (slide-over panels such as the account
      // panel and the nav drawer). Previously ANY scroll anywhere in the
      // document drove the app chrome, so scrolling the account panel hid /
      // showed the header and bottom nav of the page behind it.
      if (target.closest('[data-chrome-scroll-ignore="true"]')) return;

      const currentScrollTop = target.scrollTop;
      const lastScrollTop = scrollTopMap.current.get(target) ?? currentScrollTop;
      const delta = currentScrollTop - lastScrollTop;

      // Always show bars when at the very top
      if (currentScrollTop <= 0) {
        scrollTopMap.current.set(target, currentScrollTop);
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        pendingDirection.current = null;
        setBarsVisible(true);
        lastToggleTime.current = Date.now();
        return;
      }

      // Dead zone near the bottom — ignore fluctuations from overscroll bounce
      const maxScroll = target.scrollHeight - target.clientHeight;
      if (maxScroll > 0 && currentScrollTop >= maxScroll - BOTTOM_DEAD_ZONE) {
        scrollTopMap.current.set(target, currentScrollTop);
        return; // Do nothing, keep current state
      }

      if (Math.abs(delta) < threshold) return;

      const newVisible = delta < 0 || currentScrollTop < HIDE_AFTER_PX; // up = show, down = hide
      scrollTopMap.current.set(target, currentScrollTop);

      // Nothing to do if the state already matches.
      if (newVisible === barsVisibleRef.current && pendingDirection.current === null) return;

      // Debounce: if we recently toggled, queue the change
      const now = Date.now();
      if (now - lastToggleTime.current < DEBOUNCE_MS) {
        pendingDirection.current = newVisible;
        if (!debounceTimer.current) {
          debounceTimer.current = setTimeout(() => {
            debounceTimer.current = null;
            if (pendingDirection.current !== null) {
              setBarsVisible(pendingDirection.current);
              lastToggleTime.current = Date.now();
              pendingDirection.current = null;
            }
          }, DEBOUNCE_MS);
        }
        return;
      }

      pendingDirection.current = null;
      setBarsVisible(newVisible);
      lastToggleTime.current = now;
    },
    [threshold, enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', handleScroll, { capture: true } as EventListenerOptions);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [handleScroll, enabled]);

  // Force the chrome back on whenever the route changes or auto-hide is turned
  // off, and drop any queued toggle so a pending hide can't fire on the new page.
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    pendingDirection.current = null;
    lastToggleTime.current = 0;
    scrollTopMap.current = new WeakMap<EventTarget, number>();
    barsVisibleRef.current = true;
    setBarsVisible(true);
  }, [resetKey, enabled]);

  useEffect(() => {
    barsVisibleRef.current = barsVisible;
  }, [barsVisible]);

  return { barsVisible: enabled ? barsVisible : true };
}
