import { runtimeDriver } from "@simplyalec/laravel-cf-workers-laravel-runtime/testing/driver";
import { application } from "./application";

// Benchmarks and release snapshots drive the Snipe-IT runtime directly through this worker.
export default runtimeDriver(application);
