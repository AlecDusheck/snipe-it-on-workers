<?php
// Upstream writes QR images directly into this installer-created directory.
Illuminate\Support\Facades\File::ensureDirectoryExists(public_path('uploads/barcodes'));

// The front Worker blocks private paths; a loopback probe would deadlock the tenant queue.
final class WorkersSetupController extends App\Http\Controllers\SetupController
{
    protected function dotEnvFileIsExposed(): bool { return false; }
}
$app->bind(App\Http\Controllers\SetupController::class, WorkersSetupController::class);
