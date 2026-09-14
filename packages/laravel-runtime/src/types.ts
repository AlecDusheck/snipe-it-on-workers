import type { HTTPMethod } from "@php-wasm/universal";
import type { FileReference } from "./files";

export interface RuntimeSecrets {
	appKey: string;
	files?: Record<string, string>;
}

/** A built release; every artifact is verified against the manifest digests. */
export interface Release {
	/** Directory name and catalog name, such as `snipeit-8.7.2`. */
	name: string;
	version: string;
	phpVersion?: string;
	compatibilityDate: string;
	files: {
		worker: string;
		wasm: string;
		index: string;
	};
	/** The application archive, shipped as fixed-size parts so single files can be read on demand. */
	corpus: { bytes: number; partBytes: number; parts: string[] };
	/** Browser-facing files served straight from the release: path to digest. */
	public?: Record<string, string>;
}

export interface HttpInput {
	url: string;
	method: HTTPMethod;
	headers: [string, string][];
	body: ArrayBuffer;
}

export type RuntimeCommand =
	| { kind: "initialize" }
	| { kind: "http"; request: HttpInput }
	| { kind: "database"; action: DatabaseAction }
	| { kind: "migrate" };

// Strings preserve SQLite integers beyond JavaScript's safe integer range.
export type DatabaseRow = Record<string, string | null>;
export type DatabaseAction =
	| { kind: "inspect"; table: string | null; offset: number }
	| { kind: "update"; table: string; original: DatabaseRow; values: DatabaseRow };
export interface DatabasePage {
	tables: string[];
	table: string | null;
	columns: { name: string; type: string; primaryKey: boolean }[];
	rows: { values: DatabaseRow; editable: boolean }[];
	offset: number;
	hasMore: boolean;
}

export interface RuntimeInput {
	requestLimitBytes?: number;
	command: RuntimeCommand;
	environment?: Record<string, string>;
	/** The committed tree: the database and durable storage, as a file manifest or raw SQLite bytes. */
	database: ArrayBuffer;
	/** The ephemeral tree: sessions and cache, as a file manifest or empty. */
	ephemeral: ArrayBuffer;
	secrets: RuntimeSecrets;
	origin: string;
}

export interface HttpOutput {
	file?: FileReference;
	status: number;
	headers: [string, string][];
	body: string;
}

export interface RuntimeOutput {
	database: ArrayBuffer;
	ephemeral: ArrayBuffer;
	response: HttpOutput;
}
