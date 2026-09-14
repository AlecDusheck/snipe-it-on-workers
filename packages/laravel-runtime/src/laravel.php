<?php
// Sessions and the cache live in the ephemeral tree, outside the committed database. Compiled
// views ship with the release and never change under one interpreter.
config([
	'view.check_cache_timestamps' => false,
	'session.driver' => 'file',
	'session.files' => '/app/storage/framework/sessions',
	'cache.default' => 'file',
	'cache.stores.file' => [
		'driver' => 'file',
		'path' => '/app/storage/framework/cache/data',
		'lock_path' => '/app/storage/framework/cache/data',
	],
]);
