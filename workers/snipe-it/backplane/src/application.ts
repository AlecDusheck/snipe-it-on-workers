import type { ApplicationProfile } from "@simplyalec/laravel-cf-workers-laravel-runtime/application";
import bootstrap from "./application.php";
import { createSnipeSecrets } from "./secrets";

export const application: ApplicationProfile = {
	bootstrap,
	environment: (origin) => ({ APP_LOCALE: "en-US", SECURE_COOKIES: String(origin.startsWith("https:")) }),
	environmentBinding: "SNIPEIT_ENV",
	storageDirectories: ["/app/public/uploads", "/app/storage/private_uploads", "/app/storage/app"],
	createSecrets: createSnipeSecrets,
};
