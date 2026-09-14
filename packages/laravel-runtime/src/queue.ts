// GET requests can write sessions; reads must serialize with every other operation.
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();
	run<T>(work: () => Promise<T>): Promise<T> {
		const next = this.tail.then(work);
		this.tail = next.catch(() => {});
		return next;
	}
}
