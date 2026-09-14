<?php
use Illuminate\Support\Facades\DB;

try {
    foreach (json_decode(file_get_contents('/environment.json'), true, 512, JSON_THROW_ON_ERROR) as $name => $value) {
        $_ENV[$name] = $_SERVER[$name] = $value;
        putenv($name.'='.$value);
    }
    $_SERVER['PHP_SELF'] = '/index.php';
    $_SERVER['SCRIPT_NAME'] = '/index.php';
    $_SERVER['SCRIPT_FILENAME'] = '/app/public/index.php';
    $_SERVER['SERVER_SOFTWARE'] = 'workerd/php-wasm';
    $envelope = json_decode(file_get_contents('/request.json'), true, 512, JSON_THROW_ON_ERROR);
    $command = $envelope['command'];
    if ($command['kind'] === 'database') { require '/database.php'; return; }
    require '/app/vendor/autoload.php';
    $app = require '/app/bootstrap/app.php';
    $http = $command['request'] ?? ['url' => $envelope['origin'].'/login', 'method' => 'GET', 'headers' => []];
    $server = [];

    foreach ($http['headers'] as [$name, $value]) {
        if ($name === 'x-platform-client-ip') {
            $server['REMOTE_ADDR'] = $value;
        } else {
            $server[(in_array($name, ['content-type', 'content-length'], true) ? '' : 'HTTP_').strtoupper(str_replace('-', '_', $name))] = $value;
        }
    }
    $body = file_get_contents('php://input');
    $parameters = $_POST;
    if (str_starts_with($server['CONTENT_TYPE'] ?? '', 'application/x-www-form-urlencoded')) { parse_str($body, $parameters); }
    $request = Illuminate\Http\Request::create($http['url'], $http['method'], $parameters, $_COOKIE, $_FILES, $server, $body);
    $app->instance('request', $request);
    $kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
    $kernel->bootstrap();
    require '/laravel.php';
    require '/application.php';
    DB::statement('PRAGMA journal_mode = DELETE');
    DB::statement('PRAGMA foreign_keys = ON');
    DB::statement('PRAGMA mmap_size = 0');
    DB::statement('PRAGMA cache_size = -2048');

    if ($command['kind'] === 'initialize') {
        $response = new Illuminate\Http\Response('', 201);
    } elseif ($command['kind'] === 'migrate') {
        $migrator = $app->make('migrator');
        $repository = $migrator->getRepository();
        if (! $repository->repositoryExists()) { $repository->createRepository(); }
        $files = [];
        foreach (array_merge($migrator->paths(), [$app->databasePath('migrations')]) as $directory) {
            if (!is_dir($directory)) continue;
            foreach (scandir($directory) as $name) {
                if (preg_match('/^.+_.+\.php$/', $name)) $files[] = $directory . '/' . $name;
            }
        }
        $migrator->run($files, ['pretend' => false, 'step' => false]);
        $response = new Illuminate\Http\Response('', 200);
    } else {
        $response = $kernel->handle($request);
    }
    if (in_array($command['kind'], ['initialize', 'migrate'], true)) {
        $integrity = DB::select('PRAGMA quick_check');
        if (count($integrity) !== 1 || $integrity[0]->quick_check !== 'ok') { throw new RuntimeException('Database integrity check failed'); }
    }
    $headers = [];
    foreach ($response->headers->allPreserveCaseWithoutCookies() as $name => $values) {
        foreach ($values as $value) { $headers[] = [$name, $value]; }
    }
    foreach ($response->headers->getCookies() as $cookie) { $headers[] = ['Set-Cookie', (string) $cookie]; }
    $content = $response->getContent();
    $bodyFile = null;
    if (!is_string($content)) {
        $bodyFile = '/app/tmp/response';
        $stream = fopen($bodyFile, 'wb');
        if ($stream === false) throw new RuntimeException('Cannot open response spool');
        // Chunk callback output even when Symfony emits a single large buffer.
        ob_start(static function ($chunk) use ($stream) {
            for ($offset = 0; $offset < strlen($chunk); $offset += 65536) {
                $part = substr($chunk, $offset, 65536);
                if (fwrite($stream, $part) !== strlen($part)) throw new RuntimeException('Cannot write response spool');
            }
            return '';
        }, 65536);
        try { $response->sendContent(); } finally { ob_end_flush(); fclose($stream); }
        $content = '';
    }
    if ($command['kind'] === 'http') $kernel->terminate($request, $response);
    $opcache = function_exists('opcache_get_status') ? opcache_get_status(false) : false;
    file_put_contents('/response.json', json_encode(['ok' => true, 'bodyFile' => $bodyFile, 'peak' => memory_get_peak_usage(true), 'opcache' => $opcache['memory_usage']['used_memory'] ?? 0, 'opcacheFull' => $opcache['cache_full'] ?? false, 'opcacheKeys' => $opcache['opcache_statistics']['num_cached_keys'] ?? 0, 'opcacheMaxKeys' => $opcache['opcache_statistics']['max_cached_keys'] ?? 0, 'response' => ['status' => $response->getStatusCode(), 'headers' => $headers, 'body' => base64_encode($content)]], JSON_THROW_ON_ERROR));
} catch (Throwable $error) {
    file_put_contents('/response.json', json_encode(['ok' => false, 'error' => get_class($error)], JSON_THROW_ON_ERROR));
}
