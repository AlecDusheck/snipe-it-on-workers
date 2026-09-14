import { BLOCK_BYTES, readBlock } from "./files";
import type { BlockStorage, FileReference } from "./files";

const LOOKAHEAD = 4;

/** Streams a file's blocks in order, keeping a few reads in flight ahead of the consumer. */
export function fileStream(
	file: FileReference,
	storage: BlockStorage,
	onDone?: () => void,
): ReadableStream<Uint8Array> {
	let next = 0;
	const pending: Promise<Uint8Array>[] = [];
	const load = (index: number): Promise<Uint8Array> => {
		const block = file.blocks[index];
		const bytes = new Uint8Array(Math.min(BLOCK_BYTES, file.size - index * BLOCK_BYTES));
		if (!block) return Promise.resolve(bytes);
		return readBlock(storage, block).then((data) => {
			bytes.set(data.subarray(0, Math.min(bytes.length, data.length)));
			return bytes;
		});
	};
	const fill = (): void => {
		while (pending.length < LOOKAHEAD && next < file.blocks.length) pending.push(load(next++));
	};
	let finished = false;
	const finish = (): void => {
		if (finished) return;
		finished = true;
		onDone?.();
	};
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				fill();
				const head = pending.shift();
				if (!head) {
					controller.close();
					finish();
					return;
				}
				try {
					controller.enqueue(await head);
				} catch (error) {
					finish();
					throw error;
				}
				fill();
			},
			cancel: finish,
		},
		{ highWaterMark: 0 },
	);
}
