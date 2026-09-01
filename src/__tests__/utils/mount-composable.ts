import { createApp, defineComponent, h, type InjectionKey } from "vue";

export interface MountComposableOptions {
	provide?: Array<[InjectionKey<any> | string | symbol, any]>;
}

/**
 * Mount a Vue composable inside a minimal app for testing.
 * Returns the composable's return value and a cleanup function.
 */
export function mountComposable<T>(
	composable: () => T,
	options?: MountComposableOptions,
): {
	result: T;
	unmount: () => void;
} {
	let result!: T;

	const app = createApp(
		defineComponent({
			setup() {
				result = composable();
				return () => h("div");
			},
		}),
	);

	if (options?.provide) {
		for (const [key, value] of options.provide) {
			app.provide(key, value);
		}
	}

	const container = document.createElement("div");
	app.mount(container);

	return {
		result,
		unmount: () => app.unmount(),
	};
}
