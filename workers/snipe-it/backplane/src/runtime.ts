import { runtimeEntrypoint } from "@simplyalec/laravel-cf-workers-laravel-runtime/entrypoint";
import { application } from "./application";

export default runtimeEntrypoint(application);
