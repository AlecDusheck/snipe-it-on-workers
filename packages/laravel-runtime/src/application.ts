import type { RuntimeSecrets } from "./types";

export interface ApplicationProfile {
	/** PHP appended to the Laravel bootstrap for compatibility overrides. */
	bootstrap?: string;
	/** Per-origin environment defaults, below Worker vars and tenant overrides. */
	environment?: (origin: string) => Record<string, string>;
	/** Wrangler var holding the application's JSON environment defaults. */
	environmentBinding?: string;
	/** Writable directories persisted between requests; those under /app/public are served publicly. */
	storageDirectories?: string[];
	/** Secrets generated once per instance, such as application keys and key files. */
	createSecrets?(creationKey: string): Promise<RuntimeSecrets & { creationKey: string }>;
}
