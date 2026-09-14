import { base64, createSecrets } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";
const pem = (kind: string, bytes: ArrayBuffer): string =>
	`-----BEGIN ${kind} KEY-----\n${
		base64(new Uint8Array(bytes))
			.match(/.{1,64}/g)
			?.join("\n") ?? ""
	}\n-----END ${kind} KEY-----\n`;

// Passport signs OAuth tokens with a per-instance RSA key pair.
export async function createSnipeSecrets(creationKey: string) {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	if (!("privateKey" in pair)) throw new Error("RSA key generation returned an unexpected key");
	const privateBytes = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
	const publicBytes = await crypto.subtle.exportKey("spki", pair.publicKey);
	if (!(privateBytes instanceof ArrayBuffer) || !(publicBytes instanceof ArrayBuffer))
		throw new Error("RSA export returned unexpected data");

	return {
		...createSecrets(creationKey),
		files: {
			"/app/storage/oauth-private.key": pem("PRIVATE", privateBytes),
			"/app/storage/oauth-public.key": pem("PUBLIC", publicBytes),
		},
	};
}
