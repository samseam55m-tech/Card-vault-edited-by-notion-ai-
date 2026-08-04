import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { StoreProvider, useStore } from './store';
import MainScreen from './pages/MainScreen';
import EntryPage from './pages/EntryPage';
import ProjectFiles from './pages/ProjectFiles';
import ProjectDetail from './pages/ProjectDetail';
import Statistics from './pages/Statistics';
import PromptGallery from './pages/PromptGallery';
import PromptDetail from './pages/PromptDetail';
import RecycleBin from './pages/RecycleBin';
import Layout from './components/Layout';
import Onboarding from './components/Onboarding';
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'motion/react';
import { clearMorphOrigin, peekMorphOrigin } from './morphOrigin';
import { App as CapApp } from '@capacitor/app';

/**
 * Handles the native hardware back button on Android.
 * If the router can go back, it navigates back; otherwise it exits the app.
 */
function HardwareBackButton() {
  const navigate = useNavigate();
  const location = useLocation();

  // Read the live pathname from a ref instead of a dependency, so the native
  // listener is registered exactly once. With `location.pathname` in the deps,
  // every navigation tore down and re-added the listener; because removal is
  // async (`listener.then(h => h.remove())`) the new listener was frequently
  // registered before the old one was removed, stacking up duplicates that all
  // fired on a single back press (skipping several screens, or exiting the app).
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  useEffect(() => {
    let cancelled = false;
    let handle: { remove: () => Promise<void> } | null = null;

    const listener = CapApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack && pathnameRef.current !== '/') {
        navigate(-1);
      } else {
        CapApp.exitApp();
      }
    });

    // Guard against the effect being torn down before `addListener` resolves,
    // which would otherwise leave an unremovable listener behind.
    void listener.then(h => {
      handle = h;
      if (cancelled) void h.remove();
    });

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [navigate]);

  return null;
}

/**
 * Catches render-time crashes anywhere in the tree. Without this a single
 * thrown error unmounted the whole app and left a blank white screen with no
 * way to recover short of force-quitting.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[App] render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="h-[100dvh] bg-bg-main text-text-main flex flex-col items-center justify-center gap-4 p-6 text-center"
          style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
        >
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-text-muted max-w-xs break-words">
            {this.state.error.message}
          </p>
          <p className="text-xs text-text-muted">Your saved data has not been touched.</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 px-5 py-2.5 bg-text-main text-bg-main rounded-xl font-medium"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * One curve for both directions, so opening and closing feel symmetrical.
 *
 * v1.13.0 used a spring (stiffness 380, damping 34, mass 0.9) and the device
 * reported it as "janky, not smooth". A spring is the wrong tool here: its
 * settle time is unbounded, so the last stretch of the morph is a long
 * low-amplitude tail that keeps a full-screen compositor layer animating after
 * the movement has stopped being visible. That tail is precisely what reads as
 * "not smooth" on a mid-range device. A short tween ends when it says it will.
 *
 * The curve is Material's emphasized-decelerate: quick off the mark, gentle on
 * arrival, no overshoot to re-rasterize.
 */
const MORPH_TWEEN = { duration: 0.3, ease: [0.2, 0, 0, 1] } as const;

// v1.20.0: the close curve is a symmetric ease-IN-OUT, and it is deliberately
// NOT the open's curve any more. Measured from a 57fps capture of the real
// device: the old emphasized-decelerate left only 4.6% of the travel (26px of
// 570px) for the final 100ms, and the fade below sat in exactly that window --
// so the panel arrived, PARKED on the card, and dissolved in place for ~90ms.
// A stationary dissolve is what read as a stutter at the end of the close.
// [0.5, 0, 0.5, 1] carries ~20% of the travel through the last 100ms, so the
// panel is still visibly moving while it fades and it vanishes at the instant
// it lands. See (H). The OPEN keeps MORPH_TWEEN and is confirmed good -- the
// two curves are no longer identical, and that asymmetry is intentional.
const MORPH_EXIT = { duration: 0.3, ease: [0.5, 0, 0.5, 1] } as const;

/**
 * The card editor, rendered as an overlay ON TOP of the list rather than as a
 * sibling route.
 *
 * The overlay architecture stays exactly as v1.11.0 built it — it was never at
 * fault, and it is also what keeps the list mounted underneath so its scroll
 * offset and filters survive a card round trip structurally.
 *
 * What changed in v1.13.0 is HOW the morph is driven. `layoutId` put us in a
 * bind with no good side: on every card it tweened every masonry reflow
 * (v1.11.0's ghosting), and on one card set at tap time it appears never to
 * register a projection node at all, giving the hard cut the user described as
 * "very static, zero smoothness". So the shared-element machinery is gone and
 * the transition is now a hand-rolled FLIP: the card measures itself on tap
 * (`src/morphOrigin.ts`), and this panel animates from that exact rect to full
 * screen using plain transforms.
 *
 * Motion values are used rather than `initial`/`animate` props on purpose.
 * `initial` is only read when a motion component mounts, and the "from" rect
 * cannot be known until after this panel has been laid out and measured. A
 * motion value can be set synchronously inside `useLayoutEffect` — before the
 * browser paints — so the first painted frame is already the card-sized one,
 * with no flash of the full-screen state and no remount.
 *
 * v1.14.0 corrects three things that made v1.13.0 feel "janky and laggy" with
 * "a visual glitch when the card morph opens":
 *
 *   1. THE GLITCH. Setting a motion value is not synchronous with the DOM —
 *      motion flushes it on its own animation frame — so the promise in the
 *      paragraph above was not actually kept. One full-screen frame still
 *      painted before the card-sized transform landed. The opening transform
 *      is now written onto the node directly, inside the layout effect.
 *   2. THE LAG. The content wrapper now counter-scales the panel, so the
 *      editor's accumulated scale stays 1 for the whole morph and a single
 *      raster is reused instead of the WebView repainting a full-screen
 *      subtree every frame.
 *   3. THE TAIL. The spring became a short, bounded tween (see MORPH_TWEEN).
 *
 * v1.15.0 was driven by frame-by-frame analysis of a 120fps screen recording
 * of the device, which is the first hard evidence this transition has ever
 * had. Three findings, all of which contradict something believed earlier:
 *
 *   A. THE OPEN WAS A BLACK FLASH, NOT A MORPH. For roughly 80ms after the
 *      tap the screen was almost entirely dark, then the editor appeared at
 *      nearly full size. Two things combined. The panel's background is
 *      opaque `bg-bg-main`, and v1.14.0 drove the CONTENT to opacity 0 and
 *      faded it back in — so for as long as the fade had not finished, the
 *      panel was a filled dark rectangle with nothing in it. Meanwhile
 *      mounting `EntryPage` blocks the main thread for ~80ms, so that fade
 *      could not run on time. The content fade is therefore GONE. Because
 *      the wrapper counter-scales, the content is already 1:1 and
 *      undistorted on the very first frame; there was never anything for
 *      that fade to hide.
 *   B. THE TWEEN'S CLOCK WAS RUNNING DURING THE MOUNT. Recorded frames were
 *      bit-identical from 1414ms to 1431ms — the main thread was blocked —
 *      yet `animate()` had been called before that block began. A tween is
 *      time-based, so when frames resumed the morph was already a third of
 *      the way through and simply appeared mid-flight. The animation is now
 *      started after two `requestAnimationFrame`s, so its clock begins on a
 *      frame where the main thread is actually free. The panel sits pinned
 *      at the card's rect until then, which reads as a normal tap delay
 *      rather than as a broken animation.
 *   C. THE CLOSE ENDED IN A HARD CUT. The panel shrank correctly, then a
 *      card-sized crop of the editor — the back button and a sliver of the
 *      hero image — sat on screen for ~52ms before vanishing to reveal the
 *      real card underneath. At card size the counter-scaled content is a
 *      CROP of a full-size page, which looks nothing like the card, so that
 *      final frame was never going to match its destination.
 *
 * The cure for (C) is the one part of Material's container transform that
 * this implementation never had: the container itself cross-fades. The panel
 * now fades in over its first 140ms and out over the last 140ms of the
 * close. `CardItem` never hides the source card, so the real card is
 * underneath the whole time and the closing fade dissolves straight onto it.
 * Whatever latency there is between the tween ending and React committing the
 * unmount is now invisible, because by then the panel is already transparent.
 *
 * (D) v1.16.0 -- THE CROSS-FADE FROM (C) CAUSED GHOSTING. Frame analysis of a
 * second recording showed the editor panel and the real grid card visible
 * SIMULTANEOUSLY, superimposed, for ~20 frames (~250ms) at the end of every
 * close. The user described it exactly: ghosting "just near the original
 * position".
 *
 * A cross-fade is only invisible when the two images are nearly IDENTICAL at
 * the moment they are blended. Material gets that for free because it fades
 * the destination content in inside the container, so the last frame matches.
 * Here they are never alike: at card size the counter-scaled panel is a CROP
 * of a full-size page (see C). So blending them is a double image, and cutting
 * between them is a pop. There is no third option while both are visible.
 *
 * The cure is therefore to make sure they are never both visible AT THE CARD.
 * Two changes, and they only work together:
 *   1. The close uses MORPH_EXIT, an emphasized-ACCELERATE curve. The old
 *      decelerate curve reached ~80% of the way back within ~40% of the
 *      duration and then crawled, so the panel loitered next to the card for
 *      most of the close -- maximising the overlap. Accelerate stays large
 *      early and commits late.
 *   2. The fade completes at ~64% of the close, NOT at the end. The panel is
 *      fully transparent while still visibly larger than the card, and the
 *      last ~90ms of shrinking is invisible.
 * Fading to zero smoothly is never a pop, so an invisible tail is free.
 *
 * ^ BOTH OF THOSE CONCLUSIONS WERE WRONG. Kept verbatim because the reasoning
 * looks sound and reads as obvious in hindsight only once (E) is understood.
 * The last sentence -- "an invisible tail is free" -- is the exact error: a
 * tail that is invisible is a THIRD of the animation the user is still
 * watching. See (E).
 *
 * (E) v1.17.0 -- THE FIX FOR (D) MADE THE CLOSE LOOK CUT OFF. Reported as a
 * "flicking cut" that strained the eyes, which is worse than the ghosting it
 * replaced. (D) removed the double image by making the panel fully transparent
 * at ~64% of the close, and then let the remaining ~36% of the shrink play
 * with nothing on screen. From the user's side that is not a morph at all: the
 * panel disappears in mid-air, well short of the card, and the eye -- which is
 * tracking a moving object -- gets no landing. It then has to re-acquire the
 * card somewhere else. That re-acquisition is the eye strain.
 *
 * The mistake shared by (C), (D) and this one was treating the panel as an
 * EXITING element, which Material says should accelerate away, and treating
 * the fade as the thing that hides the seam. Neither holds here. This panel
 * never leaves the screen -- it LANDS on a target that is already visible and
 * stays visible. The user's own words for the goal are the correct model:
 * maximising and minimising a window. A window being minimised does not
 * dissolve halfway; it travels the whole way to its destination and only stops
 * being a separate object once it is there.
 *
 * So the fade does not get to hide anything except its own last instant:
 *   1. The close is decelerate again, 300ms, mirroring the open exactly. That
 *      curve covers ~96% of the distance in the first 200ms, so the panel
 *      spends the tail of the close ESSENTIALLY AT REST on the card instead of
 *      parked mid-flight. (D) called this "loitering" and treated it as the
 *      defect; it is in fact the only moment at which a swap can be hidden.
 *   2. The fade is confined to 200ms -> 300ms, `easeIn`, so alpha stays near 1
 *      until the panel has arrived and the mid-transparency frames -- the only
 *      ones that can ghost -- fall inside a 2-5px discrepancy.
 * There is no invisible tail any more, and no translucent frame taken while
 * the panel is still travelling. (D)'s dichotomy ("blend = double image, cut =
 * pop, no third option") was false: the third option is to make the two images
 * COINCIDE first and blend only then. Distance, not content, was the variable
 * that mattered -- the content mismatch described in (C) is real but a 2-5px
 * dissolve is small enough that it reads as the content settling.
 *
 * ^ POINT 1 ABOVE IS THE (H) BUG, IN ITS OWN WORDS. "Essentially at rest on
 * the card" was written as the goal. It is a 90ms pause in the middle of a
 * movement the eye is tracking, and the user reported it as a stutter three
 * builds later. Point 2 is sound and survives; what was wrong was scheduling
 * it against a curve that had already stopped moving.
 *
 * (H) v1.20.0 -- THE MOTION ENDED 90ms BEFORE THE ANIMATION DID. Reported as
 * "just stutter lag at end when the card morph back to orginal position...
 * that sutter doesn't come smoothly", with the ghosting of (G) confirmed gone.
 *
 * MEASURED, not reasoned: a 57fps capture of three consecutive closes. Frame
 * pacing was PERFECT -- 18.0ms on every frame, p90 18.0, max 18.0, and not one
 * duplicate frame anywhere in any close. So nothing dropped, nothing stalled,
 * and the main thread was never blocked. Every hypothesis that assumed a
 * dropped frame (the EntryPage unmount landing on the last frame, a settle
 * re-rasterisation, willChange being released) was FALSE.
 *
 * What the frames actually showed: for the first ~210ms the changed region
 * spans the whole screen (panel shrinking, backdrop fading). Then for the last
 * six frames -- ~110ms -- the ONLY thing changing on screen is a STATIONARY
 * card-sized box at fixed coordinates (x 561-1041, y 673-1607 in device px),
 * and the magnitude of that change RISES again over those frames. The gallery
 * around it is pixel-identical to its settled state, which also rules out the
 * masonry-reflow suspect: nothing else on the screen moves at all.
 *
 * That box is the card. The panel had already arrived, and was cross-fading
 * out on the spot. The old curve put 95.5% of the travel in the first 200ms
 * and left 26px for the last 100ms, while the fade ran 200ms -> 300ms -- so
 * the schedule and the curve conspired to guarantee that every translucent
 * frame was also a MOTIONLESS frame. The eye tracks a moving object, loses the
 * motion cue 90ms early, and reads the gap as a hitch on landing.
 *
 * The fix changes the CURVE, not the fade window's alignment with the end:
 * ease-in-out [0.5, 0, 0.5, 1] carries ~20% of the travel (115px) through the
 * final 100ms, and the fade now runs 180ms -> 300ms so alpha reaches 0 exactly
 * as the panel reaches the card. Arrival and disappearance become the same
 * instant, which is what minimising a window actually looks like.
 *
 * INVARIANT: the last visible frame of the close must be a MOVING frame, and
 * the panel must never be both visible and stationary. Check any change to
 * MORPH_EXIT against that, and check it with a capture -- the arithmetic of
 * how much travel remains in the fade window is the thing to compute.
 *
 * Consequently the open and close share a DURATION but no longer share a curve
 * -- see (H), which had to break the curve half of that symmetry. v1.13.0's
 * instinct (both directions should feel alike) still holds perceptually; it was
 * wrong about the mechanism (a spring, whose tail cannot be timed), about the
 * fade phasing, and about identical curves being the way to achieve it. An
 * opening panel is REVEALED and can decelerate into place; a closing panel has
 * to keep moving until it is gone, because it must not stop while still
 * visible.
 *
 * The OPEN is untouched by (E) and has been confirmed smooth on hardware: the
 * panel fades in over its first 140ms while expanding. That is the same
 * translucent-while-moving frame the close was punished for, and it survives
 * for an asymmetric but real reason -- on the way OUT the eye is tracking a
 * shrinking object towards a destination it can already see, so a mismatch
 * near the card is compared directly against the card. On the way IN the
 * destination is the whole screen and there is nothing to compare against.
 * Do not "fix" the open for symmetry's sake without a recording showing a
 * defect in it.
 *
 * Panel opacity is deliberately driven by `initial`/`animate`/`exit` PROPS and
 * not by a motion value. Handing a property to a motion value gives that value
 * ownership of it, which is exactly why v1.13.0's `exit={{ opacity: 0 }}` on
 * the content wrapper was silently inert. Transforms use motion values because
 * they must be set from a measurement before paint; opacity has no such need.
 */
// `key` is declared here only because React's own types are unresolved in this
// sandbox (see §3.1 of the handover), so JSX hands `key` through as a normal
// prop and TypeScript rejects it otherwise. React still consumes it as a key.
function EntryOverlay({ id }: { id: string; key?: string }) {
  const navigate = useNavigate();
  // The LIVE location, deliberately not the frozen one below. See `closing`.
  const liveLocation = useLocation();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scaleX = useMotionValue(1);
  const scaleY = useMotionValue(1);
  // There is deliberately no content-opacity motion value any more. v1.14.0
  // hid the content and faded it in, which is what made the open read as a
  // black flash on the device: an opaque panel with invisible content is just
  // a dark rectangle, and the fade could not run on schedule because mounting
  // EntryPage blocks the main thread for ~80ms. The content is visible from
  // frame one, undistorted, because the wrapper counter-scales.

  // The v1.13.0 note reasoned that counter-scaling would be "far more expensive"
  // than a cross-fade because it meant counter-scaling every child. That was
  // the wrong mental model: there is exactly ONE element to counter-scale, this
  // wrapper, and counter-scaling it is cheaper than not doing so.
  //
  // Scaling a box re-rasterizes its contents at the new scale. Scaling the
  // panel down to card size and back up therefore forces the WebView to repaint
  // a full-screen editor on every frame of the tween — the reported lag. With
  // the wrapper counter-scaling, the content's accumulated scale is 1 from the
  // first frame to the last, so the raster is produced once and the GPU merely
  // moves and clips it.
  //
  // It also removes the text distortion outright rather than disguising it,
  // which is what the cross-fade was there for.
  // (G) COUNTER-SCALING IS CORRECT FOR THE OPEN AND WRONG FOR THE CLOSE.
  // Full compensation holds the content at 1:1 on every frame, which is exactly
  // why the open is crisp and cheap. But it also means that at CARD size the
  // panel is a CROP of a full-screen editor -- a giant `< Title` header and the
  // top-left corner of the body. This file has said so since v1.15.0: "a
  // card-sized crop of the editor looks nothing like the card". That crop IS
  // the afterimage sitting on top of the settled card in the user's photo.
  //
  // No fade timing can cure it. Fade late and the crop is visible on top of the
  // card (v1.18.0, reported). Fade early and the panel disappears while still
  // mid-flight (v1.16.0, reported). Those are the only two options while the
  // last frame is a crop, which is why three builds of timing work went in
  // circles: the geometry was wrong, not the schedule.
  //
  // So the compensation is RAMPED OUT on the close only. `morphComp` is 1 for
  // the entire open -- identical maths to the previous line, so the open is
  // behaviourally untouched -- and runs to 0 as the panel shrinks, letting the
  // content scale down WITH the panel. The final frame becomes the whole editor
  // minimised into the card's box rather than a corner of it, which is both the
  // "minimise a window" behaviour that was asked for and a silhouette the card
  // can actually be cross-faded against.
  //
  // Read with `.get()` instead of a multi-value `useTransform` deliberately:
  // the transformer re-runs whenever scaleX ticks, and scaleX ticks on every
  // frame morphComp does, because one tween drives both.
  const morphComp = useMotionValue(1);
  const invScaleX = useTransform(scaleX, v => {
    const inv = v === 0 ? 1 : 1 / v;
    return 1 + (inv - 1) * morphComp.get();
  });
  const invScaleY = useTransform(scaleY, v => {
    const inv = v === 0 ? 1 : 1 / v;
    return 1 + (inv - 1) * morphComp.get();
  });

  // (F) THE CLOSING MORPH CANNOT BE EXPRESSED AS `exit` VALUES. x/y/scaleX/scaleY
  // are motion values handed to `style`, and a motion value owns its property
  // outright: animation props for that key are silently ignored. This component's
  // own doc comment states that rule -- and then v1.13.0..v1.17.0 broke it, by
  // spreading the card-sized `fromValues` into `exit`. Those four keys were inert
  // for four consecutive builds, so the close never morphed at ALL. It faded a
  // full-screen panel out where it stood. That single defect produced every
  // close-side report: a translucent full-size panel sitting over the gallery is
  // what "ghosting" (v1.15.0) actually was, and shortening that same fade is what
  // turned it into "cut off rather than morphing back into place" (v1.16.0+).
  // Retiming an animation that was never running is why v1.17.0 looked identical.
  //
  // So `exit` now carries ONLY opacity -- the one property the panel really owns
  // via props. Its 300ms duration is still load-bearing: it is what keeps this
  // component mounted long enough for the transform tween to play. The transforms
  // are driven imperatively, exactly as the OPEN always was. The open worked for
  // precisely that reason, which is why only the close was ever broken.
  const [exitTarget, setExitTarget] = useState<Record<string, any> | null>(null);
  // Card-sized values, snapshotted on open and read back at close time.
  const exitValuesRef = useRef<{ x: number; y: number; scaleX: number; scaleY: number } | null>(null);

  useLayoutEffect(() => {
    const el = panelRef.current;
    const from = peekMorphOrigin(id);
    // No recorded rect means the editor was reached some other way — a cold
    // start straight onto /entry/:id, or the hardware back button landing
    // forward into it. There is nothing to morph from, so the panel simply
    // appears; that is correct, not a failure.
    if (!el || !from) return;

    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return;

    const fromValues = {
      x: from.left - to.left,
      y: from.top - to.top,
      scaleX: from.width / to.width,
      scaleY: from.height / to.height,
    };

    x.set(fromValues.x);
    y.set(fromValues.y);
    scaleX.set(fromValues.scaleX);
    scaleY.set(fromValues.scaleY);
    // Close by dissolving the panel onto the real card once it has ARRIVED on
    // it -- never in mid-flight. Two opposite failures bracket this line, and
    // they are the same mistake twice: alpha below 1 at a moment when the panel
    // and the card do not occupy the same box. Fading too early showed the card
    // straight through the translucent panel (ghosting, v1.15.0). Finishing the
    // fade too early left the panel invisible for the last third of the shrink,
    // so the close looked cut off (v1.16.0).
    exitValuesRef.current = fromValues;
    // Full compensation for the whole of the open. See (G).
    morphComp.set(1);
    setExitTarget({
      // No transform keys here, deliberately -- they would be ignored. (F).
      opacity: 0,
      transition: {
        ...MORPH_EXIT,
        // Fade runs 180ms -> 300ms of the 300ms close and ENDS exactly when the
        // panel lands, so arrival and disappearance are the same instant. Under
        // the v1.20.0 ease-in-out the panel still has ~20% of its travel left at
        // 180ms, so every translucent frame is also a MOVING frame -- there is
        // no stationary dissolve left for the eye to read as a hitch. (H).
        // Do not push this window later, and do not restore the decelerate
        // curve underneath it: alpha must reach 0 AS the panel arrives, never
        // while it sits parked on the card. `easeIn` still keeps alpha high
        // early, so the mid-transparency frames land close to the card.
        opacity: { duration: 0.12, delay: 0.18, ease: 'easeIn' },
      },
    });

    // The glitch fix, and the reason this effect exists at all. `.set()` above
    // updates motion's internal value but does NOT write to the DOM until
    // motion's next animation frame, so there was one painted frame of the
    // panel at full screen, unscaled, before the card-sized transform arrived.
    // Writing the identical transform straight onto the node here — still
    // inside the layout effect, still before paint — guarantees the first
    // frame the user sees is already card-sized. Motion overwrites it with the
    // same value a frame later and animates on from there, so nothing fights.
    el.style.transform =
      `translate3d(${fromValues.x}px, ${fromValues.y}px, 0) ` +
      `scale(${fromValues.scaleX}, ${fromValues.scaleY})`;
    const inner = contentRef.current;
    if (inner) {
      inner.style.transform = `scale(${1 / fromValues.scaleX}, ${1 / fromValues.scaleY})`;
    }

    // Do NOT start the tween here. This effect runs inside the same commit
    // that mounts EntryPage, and that mount blocks the main thread for ~80ms
    // on this device (proven: recorded frames are bit-identical across that
    // window). A tween is time-based, so starting it now burns a third of its
    // duration behind a frozen screen and the morph appears mid-flight.
    //
    // Two frames of delay instead: the first rAF fires after the blocking
    // commit has painted, the second guarantees at least one clean frame has
    // actually shipped. The panel holds at the card's rect until then, which
    // reads as an ordinary tap delay instead of a broken animation.
    let controls: Array<{ stop: () => void }> = [];
    let firstRaf = 0;
    let secondRaf = 0;
    firstRaf = requestAnimationFrame(() => {
      secondRaf = requestAnimationFrame(() => {
        controls = [
          animate(x, 0, MORPH_TWEEN),
          animate(y, 0, MORPH_TWEEN),
          animate(scaleX, 1, MORPH_TWEEN),
          animate(scaleY, 1, MORPH_TWEEN),
        ];
      });
    });

    return () => {
      cancelAnimationFrame(firstRaf);
      cancelAnimationFrame(secondRaf);
      controls.forEach(c => c.stop());
    };
  }, [id, x, y, scaleX, scaleY]);

  // The live route flips back to the gallery the instant the user taps close,
  // while AnimatePresence keeps this component mounted to play its exit. That
  // flip IS the close signal, and it is the very same mechanism `frozenLocation`
  // below already depends on. It catches the backdrop tap, Escape and the
  // hardware back button identically, because all three go through the router.
  const closing = liveLocation.pathname !== `/entry/${id}`;

  useLayoutEffect(() => {
    if (!closing) return;
    const from = exitValuesRef.current;
    // Nothing recorded means the panel never morphed IN (a cold start straight
    // onto /entry/:id), so there is no card to morph back to and the opacity
    // fade on its own is the correct behaviour.
    if (!from) return;

    // No double rAF here, unlike the open. That delay exists only to wait out
    // the ~80ms main-thread block from mounting EntryPage; on the way out
    // nothing mounts, so the very next frame is already free. Adding it here
    // would burn 2 frames of a 300ms close behind an unnecessary wait.
    const controls = [
      animate(x, from.x, MORPH_EXIT),
      animate(y, from.y, MORPH_EXIT),
      animate(scaleX, from.scaleX, MORPH_EXIT),
      animate(scaleY, from.scaleY, MORPH_EXIT),
      // Releases the counter-scale on the same curve, so the content shrinks
      // with the panel and the last frame is a minimised page, not a crop. (G)
      animate(morphComp, 0, MORPH_EXIT),
    ];
    return () => controls.forEach(c => c.stop());
  }, [closing, x, y, scaleX, scaleY, morphComp]);

  // Released only once both directions have played and the overlay is gone.
  useEffect(() => () => clearMorphOrigin(id), [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  // Frozen on purpose. The URL returns to the list the instant the user taps
  // back, but the closing morph is still playing and `EntryPage` is still
  // mounted calling `useParams()`. Matching against the live location would
  // yield an undefined id mid-animation and blank the editor out before it had
  // finished shrinking back into its card.
  const frozenLocation = useMemo(
    () => ({ pathname: `/entry/${id}`, search: '', hash: '', state: null, key: 'entry-overlay' }),
    [id]
  );

  return (
    <>
      <motion.div
        className="absolute inset-0 z-[91] bg-black/40"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={() => navigate(-1)}
      />
      <motion.div
        ref={panelRef}
        style={{
          x,
          y,
          scaleX,
          scaleY,
          transformOrigin: 'top left',
          // Promotes the panel to its own compositor layer for the life of the
          // overlay, so the WebView rasterizes it and transforms it rather than
          // repainting it. The overlay unmounts when the card closes, so this
          // does not leave a layer pinned for the rest of the session.
          willChange: 'transform',
          backfaceVisibility: 'hidden',
        }}
        // Opacity via props, not a motion value — see the note on ownership in
        // this component's doc comment. The panel dissolves in over the card
        // instead of replacing it instantly, which hides the fact that a
        // card-sized crop of the editor looks nothing like the card.
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={exitTarget ?? { opacity: 0 }}
        transition={{ ...MORPH_TWEEN, opacity: { duration: 0.14, ease: 'easeOut' } }}
        className="absolute inset-0 z-[92] flex flex-col overflow-hidden bg-bg-main"
      >
        <motion.div
          ref={contentRef}
          className="flex-1 min-h-0 flex flex-col"
          // This wrapper only ever counter-scales. It has no opacity of its
          // own in either direction: the container fade on the parent panel is
          // what covers the content mismatch now, and fading both would double
          // up. The content is fully visible for every frame of the morph.
          style={{
            scaleX: invScaleX,
            scaleY: invScaleY,
            transformOrigin: 'top left',
            willChange: 'transform',
            backfaceVisibility: 'hidden',
          }}
        >
          <Routes location={frozenLocation}>
            <Route path="/entry/:id" element={<EntryPage />} />
          </Routes>
        </motion.div>
      </motion.div>
    </>
  );
}

function AnimatedRoutes() {
  const location = useLocation();
  // The editor routes seed their local draft state once on mount and never
  // resync from the store. Folding `vaultEpoch` into their keys means a cloud
  // restore or sign-out wipe remounts them against the restored vault, instead
  // of leaving a stale draft mounted that autosaves itself back over the
  // restore a second later. This applies to the overlay below exactly as it
  // did to the old `/entry/:id` route — do not drop it.
  const { vaultEpoch } = useStore();

  const entryMatch = matchPath('/entry/:id', location.pathname);
  const entryId = entryMatch?.params?.id;

  // While the editor overlay is open the list below must keep rendering the
  // page the user came from, so we hold the last non-editor location.
  const backgroundRef = useRef(location);
  if (!entryId) backgroundRef.current = location;

  // Cold-starting directly on /entry/:id leaves no previous list to fall back
  // on; the main screen stands in, otherwise nothing renders underneath.
  const background = entryId
    ? matchPath('/entry/:id', backgroundRef.current.pathname)
      ? { ...location, pathname: '/' }
      : backgroundRef.current
    : location;

  return (
    <>
      <AnimatePresence mode="wait">
        <Routes location={background}>
          <Route path="/" element={<motion.div key="main" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="h-full flex flex-col"><MainScreen /></motion.div>} />
          <Route path="/entry" element={<motion.div key={`entry-new-${vaultEpoch}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="h-full flex flex-col"><EntryPage /></motion.div>} />
          <Route path="/projects" element={<motion.div key="projects" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="h-full flex flex-col"><ProjectFiles /></motion.div>} />
          <Route path="/project/:id" element={<motion.div key={`project-${background.pathname}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="h-full flex flex-col"><ProjectDetail /></motion.div>} />
          <Route path="/prompts" element={<motion.div key="prompts" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="h-full flex flex-col"><PromptGallery /></motion.div>} />
          <Route path="/prompt/:id" element={<motion.div key={`prompt-${background.pathname}-${vaultEpoch}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="h-full flex flex-col"><PromptDetail /></motion.div>} />
          <Route path="/bin" element={<motion.div key="bin" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="h-full flex flex-col"><RecycleBin /></motion.div>} />
          <Route path="/stats" element={<motion.div key="stats" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="h-full flex flex-col"><Statistics /></motion.div>} />
        </Routes>
      </AnimatePresence>
      <AnimatePresence>
        {entryId && <EntryOverlay key={`entry-${entryId}-${vaultEpoch}`} id={entryId} />}
      </AnimatePresence>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <StoreProvider>
        <BrowserRouter>
          <HardwareBackButton />
          <Layout>
            <AnimatedRoutes />
          </Layout>
          {/* Renders above everything on a fresh install only; self-hides once
              the store reports `hasOnboarded`. */}
          <Onboarding />
        </BrowserRouter>
      </StoreProvider>
    </ErrorBoundary>
  );
}
