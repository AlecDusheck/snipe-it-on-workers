export const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export async function digest(bytes: BufferSource): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
		n.toString(16).padStart(2, "0"),
	).join("");
}

export const digestText = (text: string): Promise<string> => digest(new TextEncoder().encode(text));

export function sameBytes(
	left: ArrayBufferView | ArrayBuffer,
	right: ArrayBufferView | ArrayBuffer,
): boolean {
	const a =
		left instanceof ArrayBuffer
			? new Uint8Array(left)
			: new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
	const b =
		right instanceof ArrayBuffer
			? new Uint8Array(right)
			: new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
	if (a.length !== b.length) return false;
	if (a.buffer === b.buffer && a.byteOffset === b.byteOffset) return true;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function base64(bytes: Uint8Array): string {
	let value = "";
	for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function createSecrets(creationKey: string) {
	return { appKey: `base64:${base64(crypto.getRandomValues(new Uint8Array(32)))}`, creationKey };
}
