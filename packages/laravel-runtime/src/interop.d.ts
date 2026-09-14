declare module "php-wasm-loader" {
	import type { PHPLoaderModule } from "@php-wasm/universal";
	export const dependencyFilename: string;
	export const dependenciesTotalSize: number;
	export const init: PHPLoaderModule["init"];
}
declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}
declare module "*.php" {
	const source: string;
	export default source;
}
