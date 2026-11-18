/**
 * Explicit plugin lifecycle model.
 *
 * Cordis owns the authoritative fiber state; this class mirrors the phase
 * transitions the adapter performs so `pilens_status` and the compatibility
 * tests can assert load → init → enable → disable → unload without reading
 * framework internals.
 */

export type PluginLifecycleState =
	| "PENDING"
	| "LOADING"
	| "ACTIVE"
	| "DEGRADED"
	| "FAILED"
	| "UNLOADING"
	| "DISPOSED";

const ALLOWED: Record<PluginLifecycleState, readonly PluginLifecycleState[]> = {
	PENDING: ["LOADING", "FAILED"],
	LOADING: ["ACTIVE", "DEGRADED", "FAILED", "UNLOADING"],
	ACTIVE: ["DEGRADED", "UNLOADING", "FAILED"],
	DEGRADED: ["ACTIVE", "UNLOADING", "FAILED"],
	FAILED: ["UNLOADING", "DISPOSED"],
	UNLOADING: ["DISPOSED"],
	DISPOSED: [],
};

export interface LifecycleTransition {
	readonly from: PluginLifecycleState;
	readonly to: PluginLifecycleState;
	readonly at: number;
}

export class PluginLifecycle {
	private current: PluginLifecycleState = "PENDING";
	private readonly transitions: LifecycleTransition[] = [];
	private readonly listeners = new Set<
		(transition: LifecycleTransition) => void
	>();

	get state(): PluginLifecycleState {
		return this.current;
	}

	get history(): readonly LifecycleTransition[] {
		return this.transitions;
	}

	/** Move to `next`, rejecting transitions that would skip cleanup phases. */
	transition(next: PluginLifecycleState): LifecycleTransition {
		if (next === this.current) {
			return { from: this.current, to: next, at: Date.now() };
		}
		if (!ALLOWED[this.current].includes(next)) {
			throw new Error(
				`Illegal plugin lifecycle transition ${this.current} -> ${next}`,
			);
		}
		const transition: LifecycleTransition = {
			from: this.current,
			to: next,
			at: Date.now(),
		};
		this.current = next;
		this.transitions.push(transition);
		for (const listener of this.listeners) listener(transition);
		return transition;
	}

	onTransition(
		listener: (transition: LifecycleTransition) => void,
	): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}
