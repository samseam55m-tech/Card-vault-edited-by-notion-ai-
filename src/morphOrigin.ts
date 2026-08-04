/**
 * The starting geometry for the card → editor morph.
 *
 * WHY THIS EXISTS INSTEAD OF `layoutId`
 * -------------------------------------
 * v1.11.0 gave every card a `layoutId`. That does not mean "animate during the
 * transition" — it permanently enrols the element in motion's layout
 * projection, so every masonry reflow caused by a lazy image decoding mid
 * scroll was animated as a tween. That was the ghosting.
 *
 * v1.12.0 narrowed it to exactly one card at a time, set only on tap. The
 * ghosting went away and the morph stopped animating altogether — most likely
 * because a projection node is registered when the motion component MOUNTS, so
 * a card that mounts with `layoutId === undefined` never joins the shared
 * layout group and the overlay has no partner to morph out of.
 *
 * Both horns of that dilemma come from `layoutId` itself, and neither can be
 * verified here (there is no `node_modules` and no network, so motion's
 * internals are unreadable). So v1.13.0 stops using it for this transition and
 * does the FLIP by hand: measure the card's rect at tap time, stash it here,
 * and let the overlay animate itself from that rect to full screen with plain
 * transforms.
 *
 * The result costs NOTHING during scroll — no element is enrolled in shared
 * layout at any point — and depends only on `getBoundingClientRect` and CSS
 * transforms, whose behaviour is not in doubt.
 */

export type MorphRect = {
	top: number;
	left: number;
	width: number;
	height: number;
};

/**
 * Ids are only ever written on tap and read on the very next navigation, so
 * this never grows in practice. The bound exists purely so a pathological
 * session cannot leak.
 */
const MAX_ORIGINS = 32;

const origins = new Map<string, MorphRect>();

/** Records where a card sat on screen at the moment it was tapped. */
export function setMorphOrigin(id: string, rect: MorphRect | DOMRect): void {
	if (!rect || !rect.width || !rect.height) return;
	if (origins.size >= MAX_ORIGINS) origins.clear();
	origins.set(id, {
		top: rect.top,
		left: rect.left,
		width: rect.width,
		height: rect.height,
	});
}

/**
 * Reads without consuming. The overlay needs the same rect twice — once to
 * morph open and again to morph closed — and the list underneath does not
 * scroll while the overlay covers it, so the rect stays valid for both.
 */
export function peekMorphOrigin(id: string): MorphRect | undefined {
	return origins.get(id);
}

/** Called when the overlay unmounts, once both directions have played. */
export function clearMorphOrigin(id: string): void {
	origins.delete(id);
}
