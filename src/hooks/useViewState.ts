import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * Per-route view state that survives unmounting.
 *
 * `AnimatePresence mode="wait"` in App.tsx unmounts a page completely when you
 * navigate away from it. That is deliberate — it is what makes the page
 * transition work — but it also destroys every piece of `useState` the page
 * held. Opening a card from a filtered, scrolled list and pressing back
 * therefore dropped you at the top of an unfiltered list with the search box
 * empty.
 *
 * The fix is a module-level cache that outlives the component. Three rules
 * govern what belongs in it:
 *
 *   1. CACHE UI STATE, NEVER DATA. The store is the single source of truth for
 *      cards, projects and prompts. Nothing in this file may hold a card, a
 *      tag, or anything derived from them beyond an id or a query string.
 *      Caching data here would resurrect the class of stale-copy bugs that
 *      cost us the restore-clobber and stale-push fixes.
 *   2. CACHE ONLY WHAT THE USER WOULD BE ANNOYED TO LOSE. Search text, sort
 *      order, active filters and scroll offset: yes. Selection mode, open
 *      modals, confirmation dialogs: no — returning to a screen with a delete
 *      confirmation still open would be alarming, not convenient.
 *   3. KEY BY VAULT EPOCH. A cloud restore or sign-out wipe replaces the whole
 *      vault, at which point a remembered search for a card that no longer
 *      exists is noise. Callers fold `vaultEpoch` into their key prefix so the
 *      cache invalidates itself for free.
 *
 * Nothing here is persisted to disk. This is deliberately session-scoped: a
 * cold start should feel clean.
 */

/** Guards against unbounded growth as `vaultEpoch` advances during a session. */
const MAX_CACHE_ENTRIES = 240;

/**
 * How long to keep chasing a scroll target while the list grows underneath us.
 * Generous enough for a long list of lazy images to settle, short enough that
 * a genuinely unreachable target gives up quickly instead of fighting the user.
 */
const SCROLL_RESTORE_BUDGET_MS = 2500;

const viewStateCache = new Map<string, unknown>();
const scrollCache = new Map<string, number>();
const visitedViews = new Set<string>();

/* ------------------------------------------------------------------------
 * SCROLL RESTORE INSTRUMENTATION (v1.13.0)
 *
 * Two fixes have already failed on "scroll position is lost when opening a
 * folder and coming back" — v1.10.0's convergence loop and v1.12.0's
 * deadline-path guard. Both were defensible from reading this file and both
 * were wrong or insufficient, which is strong evidence that the real failure
 * is not where it looks.
 *
 * So v1.13.0 deliberately changes NO behaviour here. It only records what
 * actually happens, in order, so the next fix is aimed at a measurement
 * instead of a hypothesis. The four questions this is built to answer:
 *
 *   1. On leaving a list, is a non-zero value written, and under what key?
 *   2. On returning, is a target read, and is it the SAME key?
 *   3. Does the layout effect run with ready === true, and what is
 *      scrollHeight at that moment?
 *   4. Does the chase reach the target, or abort — and via which path?
 *
 * The log is surfaced in the debug panel (Account menu → sliders icon) and is
 * included in "Copy diagnostics", which is the reliable route on-device.
 * ------------------------------------------------------------------------ */

export type ScrollLogEntry = {
  /** ms since page load, so entries can be read as a timeline. */
  at: number;
  event: string;
  key: string;
  detail: string;
};

/** Small on purpose: this must never become a memory concern on-device. */
const SCROLL_LOG_LIMIT = 80;

const scrollLog: ScrollLogEntry[] = [];

function logScroll(event: string, key: string, detail: Record<string, unknown> = {}): void {
  const entry: ScrollLogEntry = {
    at: Math.round(typeof performance !== 'undefined' ? performance.now() : Date.now()),
    event,
    key,
    detail: Object.entries(detail)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v) : String(v)}`)
      .join(' '),
  };
  scrollLog.push(entry);
  if (scrollLog.length > SCROLL_LOG_LIMIT) scrollLog.shift();
  // Also emitted to the console so it can be read live over chrome://inspect.
  console.log(`[scroll] ${entry.event} ${entry.key} ${entry.detail}`);
}

/** Newest first, for display. */
export function getScrollLog(): ScrollLogEntry[] {
  return scrollLog.slice().reverse();
}

export function clearScrollLog(): void {
  scrollLog.length = 0;
}

function remember(cache: Map<string, unknown> | Map<string, number>, key: string, value: never) {
  if (cache.size > MAX_CACHE_ENTRIES && !cache.has(key)) {
    // Old epochs are dead weight; drop everything rather than pay for LRU
    // bookkeeping on a cache this small and this cheap to rebuild.
    cache.clear();
  }
  (cache as Map<string, unknown>).set(key, value);
}

/**
 * Drops every cached view. Call this when the vault is replaced wholesale and
 * the caller cannot fold an epoch into its keys.
 */
export function clearViewStateCache(): void {
  viewStateCache.clear();
  scrollCache.clear();
  visitedViews.clear();
}

/**
 * A drop-in replacement for `useState` whose value survives unmount.
 *
 * Deliberately mirrors the `useState` signature so a page can adopt it one
 * line at a time with no other changes:
 *
 *   const [searchQuery, setSearchQuery] = useStickyState(`${viewKey}:q`, '');
 *
 * The cache holds the live reference, so non-serialisable values such as `Set`
 * work exactly as they do in local state.
 */
export function useStickyState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    viewStateCache.has(key) ? (viewStateCache.get(key) as T) : initial,
  );

  useEffect(() => {
    remember(viewStateCache, key, value as never);
  }, [key, value]);

  return [value, setValue];
}

/**
 * Saves and restores the scroll offset of a scroll container.
 *
 * `ready` must be false until the list actually has its content, otherwise the
 * restore runs against a container that is still one viewport tall and clamps
 * to zero. It restores exactly once per mount; later `ready` churn is ignored
 * so a background re-render cannot yank the user back up the page.
 */
export function useScrollRestoration<T extends HTMLElement>(key: string, ready: boolean) {
  const ref = useRef<T | null>(null);
  const hasRestored = useRef(false);
  // True while we are chasing the target. The scroll listener below must not
  // record the intermediate positions we cause ourselves, or a restore that
  // gets interrupted would overwrite the real target with a clamped value and
  // the next visit would land in the wrong place.
  const isRestoring = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ready || hasRestored.current) {
      // Question 3: did the effect even get to do anything?
      logScroll('mount:skipped', key, {
        hasEl: !!el,
        ready,
        alreadyRestored: hasRestored.current,
      });
      return;
    }
    hasRestored.current = true;

    const target = scrollCache.get(key);
    // Questions 2 and 3 together: what target was read under this exact key,
    // and how tall is the container at the moment we try to use it? A
    // scrollHeight barely larger than clientHeight means the list has not laid
    // out yet and any assignment will clamp.
    logScroll('mount:read', key, {
      target: target ?? 'none',
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
    });
    if (!target || target <= 0) return;

    // A single assignment is not enough. Cards render lazy-loaded images with
    // no reserved height, so at first layout the list is a fraction of its
    // eventual size and `scrollTop = target` silently clamps to the bottom of
    // a short page. Assigning repeatedly as the content grows converges:
    // each attempt pulls more images into view, which makes the list taller,
    // which lets the next attempt get closer.
    let cancelled = false;
    let raf = 0;
    let observer: ResizeObserver | null = null;
    let attempts = 0;
    const startedAt = Date.now();
    const deadline = startedAt + SCROLL_RESTORE_BUDGET_MS;

    // v1.14.0: `stop` no longer writes to the cache under ANY circumstances.
    //
    // It is the success path, the deadline path AND the effect cleanup, and a
    // teardown fundamentally cannot tell a real user position from a clamped
    // mid-chase one or from a detached-element zero. Removing the parameter
    // removes the whole category. Exactly two places may now record: the
    // scroll listener (a genuine user-driven position) and `onUserAbort` (the
    // user grabbed the list mid-restore, so where they landed IS their
    // position).
    const stop = () => {
      if (cancelled) return;
      cancelled = true;
      isRestoring.current = false;
      if (raf) cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
      el.removeEventListener('pointerdown', onUserAbort);
      el.removeEventListener('touchstart', onUserAbort);
      el.removeEventListener('wheel', onUserAbort);
    };

    // Wrapped so the log can name WHICH gesture aborted the chase. Suspect two
    // is that the very tap or back-gesture that returned the user to the list
    // fires here on frame one and kills the restore before it starts.
    // Behaviourally identical to passing `stop` directly: the old listeners
    // received an Event, which is truthy, so `recordPosition` was true.
    const onUserAbort = (e: Event) => {
      logScroll('abort:user', key, {
        via: e.type,
        at: el.scrollTop,
        target,
        afterMs: Date.now() - startedAt,
        attempts,
      });
      // One of only two legitimate writes. The user is physically touching the
      // list, so it is attached, laid out, and this reading is real.
      if (el.isConnected) remember(scrollCache, key, el.scrollTop as never);
      stop();
    };

    const attempt = () => {
      if (cancelled) return;
      attempts++;
      if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) <= 1) {
        // Question 4, the good outcome.
        logScroll('reached', key, {
          target,
          attempts,
          afterMs: Date.now() - startedAt,
          scrollHeight: el.scrollHeight,
        });
        stop();
        return;
      }
      if (Date.now() > deadline) {
        // Question 4, the bad outcome. `maxScrollTop` says whether the list
        // ever grew tall enough for the target to be reachable at all.
        logScroll('deadline', key, {
          target,
          stuckAt: el.scrollTop,
          attempts,
          scrollHeight: el.scrollHeight,
          maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
        });
        // Ran out of time without ever reaching the target. Whatever we are
        // sitting on now is a CLAMPED value, not the user's real position —
        // writing it back would overwrite a perfectly good target with
        // something near zero and permanently poison every later visit to
        // this view. Give up and leave the cached target untouched so the
        // next attempt still has something correct to aim at. (`stop` no
        // longer records at all, so this is now guaranteed rather than
        // requested.)
        stop();
        return;
      }
      raf = requestAnimationFrame(attempt);
    };

    isRestoring.current = true;

    // Any deliberate touch hands control straight back to the user. Chasing a
    // target while someone is already scrolling would feel like the app
    // fighting them, which is worse than landing in the wrong place.
    el.addEventListener('pointerdown', onUserAbort, { passive: true });
    el.addEventListener('touchstart', onUserAbort, { passive: true });
    el.addEventListener('wheel', onUserAbort, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => attempt());
      observer.observe(el);
      if (el.firstElementChild) observer.observe(el.firstElementChild);
    }

    attempt();
    // Now genuinely inert: `stop()` tears the chase down without touching the
    // cache, so neither an effect re-run nor an unmount mid-restore can
    // overwrite a good target any more.
    return () => {
      logScroll('effect:cleanup', key, {
        restoring: isRestoring.current,
        at: el.scrollTop,
        target,
        afterMs: Date.now() - startedAt,
      });
      stop();
    };
  }, [key, ready]);

  /**
   * THE v1.14.0 FIX. This is a LAYOUT effect, not a passive one, and that one
   * word is most of the repair.
   *
   * The v1.13.0 instrumentation settled it on the first run. Every single
   * `write:unmount` recorded `value=0` — on a list whose `maxScrollTop` was
   * 6848, immediately after a `write:scroll:first` had correctly recorded a
   * real offset, three times over, across three different keys. That is not a
   * clamp; a clamp lands on a plausible number. It is exactly zero every time.
   *
   * A passive effect's cleanup runs AFTER React has detached the DOM node. A
   * detached element has no scrolling box, so `scrollTop` reads 0 by
   * definition. So this code was never measuring a bad position — it was
   * measuring nothing at all, and then writing that nothing straight over the
   * correct value the scroll listener had already cached. The next visit read
   * `target=0`, hit the `target <= 0` early return, and never even started the
   * convergence loop. That is why v1.10.0's loop and v1.12.0's deadline guard
   * both looked right and both changed nothing: neither was ever reached.
   *
   * A layout cleanup runs during the commit, while the element is still in the
   * document. It also runs before the incoming route's layout effect, which
   * fixes a second latent hazard the log exposed — the new page was reading
   * the cache before the old page had written to it.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Belt and braces against the same failure mode: the last offset seen while
    // the element was demonstrably alive and reporting.
    let lastGood = el.scrollTop;
    // Only the first genuine write per mount is logged. Logging every scroll
    // event would flood an 80-entry buffer within one flick and push the
    // interesting mount and cleanup entries out of it.
    let loggedFirstWrite = false;
    const onScroll = () => {
      if (isRestoring.current) return;
      lastGood = el.scrollTop;
      if (!loggedFirstWrite) {
        loggedFirstWrite = true;
        logScroll('write:scroll:first', key, { value: el.scrollTop });
      }
      remember(scrollCache, key, el.scrollTop as never);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      const connected = el.isConnected;
      // A live element reading 0 when the listener last saw a positive offset
      // is the same lie in a different coat: had the user genuinely scrolled
      // back to the top, a scroll event would have fired and moved `lastGood`
      // to 0 with it. Trust the listener over the teardown in both cases.
      const suspect = el.scrollTop === 0 && lastGood > 0;
      const value = connected && !suspect ? el.scrollTop : lastGood;
      logScroll('write:unmount', key, {
        value,
        connected,
        raw: el.scrollTop,
        suspect,
        suppressed: isRestoring.current,
      });
      if (isRestoring.current) return;
      remember(scrollCache, key, value as never);
    };
  }, [key]);

  return ref;
}

/**
 * True when this view has already been shown once this session.
 *
 * Used to suppress entrance animations on back-navigation. Replaying a
 * staggered cascade over a list the user has already seen reads as a flicker,
 * not as polish. The answer is frozen at mount so the current render is
 * consistent with itself.
 */
export function useIsReturnVisit(key: string): boolean {
  const [isReturn] = useState(() => visitedViews.has(key));

  useEffect(() => {
    if (visitedViews.size > MAX_CACHE_ENTRIES) visitedViews.clear();
    visitedViews.add(key);
  }, [key]);

  return isReturn;
}
