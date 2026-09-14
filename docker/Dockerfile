# Native PHP for Composer; deployed requests run in WASM.
FROM php:8.4-cli
RUN apt-get update && apt-get install -y --no-install-recommends git unzip libzip-dev libpng-dev libjpeg-dev \
	libfreetype6-dev libldap2-dev libicu-dev libxml2-dev libsqlite3-dev \
	&& docker-php-ext-configure gd --with-freetype --with-jpeg \
	&& docker-php-ext-install -j"$(nproc)" gd zip bcmath ldap intl pdo_sqlite exif \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
