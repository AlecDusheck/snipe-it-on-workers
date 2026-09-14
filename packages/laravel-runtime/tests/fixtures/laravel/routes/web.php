<?php
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Storage;

Route::get('/contract', function (Request $request) {
    DB::statement('CREATE TABLE IF NOT EXISTS contract (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    DB::table('contract')->insert(['value' => 'durable']);
    $request->session()->increment('visits');
    return response()->json([
        'framework' => app()->version(),
        'rows' => DB::table('contract')->count(),
        'visits' => $request->session()->get('visits'),
        'csrf' => csrf_token(),
        'locale' => app()->getLocale(),
    ]);
});
Route::get('/rollback', function () {
    try {
        DB::transaction(function () {
            DB::table('contract')->insert(['value' => 'rolled back']);
            throw new RuntimeException('rollback');
        });
    } catch (RuntimeException $error) {
        if ($error->getMessage() !== 'rollback') throw $error;
    }
    return response()->json(['rows' => DB::table('contract')->count()]);
});
Route::post('/storage', function (Request $request) {
    Storage::disk('local')->put('contract.txt', $request->input('value'));
    return response()->json(['stored' => Storage::disk('local')->get('contract.txt')]);
});
Route::get('/storage', fn () => response(Storage::disk('local')->get('contract.txt')));
Route::get('/stream', fn () => response()->stream(function () {
    echo str_repeat('a', 70000);
    echo str_repeat('b', 70000);
}));
// Interpreter facts for memory benchmarks: extension state, opcache and peak usage.
Route::get('/php', function () {
    $ini = [];
    foreach (['memory_limit', 'opcache.enable', 'opcache.enable_cli', 'opcache.memory_consumption', 'opcache.jit', 'opcache.jit_buffer_size', 'opcache.interned_strings_buffer', 'realpath_cache_size'] as $name) {
        $ini[$name] = ini_get($name);
    }
    return response()->json([
        'version' => PHP_VERSION,
        'peak' => memory_get_peak_usage(true),
        'real' => memory_get_usage(true),
        'ini' => $ini,
        'opcache' => function_exists('opcache_get_status') ? (opcache_get_status(false) ?: null) : 'absent',
        'extensions' => get_loaded_extensions(),
    ]);
});
Route::get('/discard', function () {
    DB::table('contract')->insert(['value' => 'uncommitted']);
    Storage::disk('local')->put('discard.txt', 'uncommitted');
    return response('discard', 500);
});
Route::get('/discard-state', fn () => response()->json([
    'rows' => DB::table('contract')->count(),
    'file' => Storage::disk('local')->exists('discard.txt'),
]));
Route::get('/file-mutations/{phase}', function (string $phase) {
    $root = storage_path('app/mutations');
    if ($phase === 'create') {
        mkdir($root.'/before', 0777, true);
        file_put_contents($root.'/before/data', 'original bytes');
        file_put_contents($root.'/replaced', 'old target');
    } elseif ($phase === 'edit') {
        $file = fopen($root.'/before/data', 'r+');
        fwrite($file, 'new');
        ftruncate($file, 3);
        fclose($file);
        chmod($root.'/before/data', 0600);
    } elseif ($phase === 'move') {
        rename($root.'/before', $root.'/after');
        rename($root.'/after/data', $root.'/replaced');
        rmdir($root.'/after');
    } elseif ($phase === 'remove') {
        unlink($root.'/replaced');
    }
    return response()->json([
        'before' => is_dir($root.'/before'),
        'after' => is_dir($root.'/after'),
        'value' => file_exists($root.'/replaced') ? file_get_contents($root.'/replaced') : null,
        'edited' => file_exists($root.'/before/data') ? file_get_contents($root.'/before/data') : null,
    ]);
});
