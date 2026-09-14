<?php
function editor_identifier(string $name): string {
    return '"'.str_replace('"', '""', $name).'"';
}
function editor_row(array $raw, array $columns): array {
    $values = [];
    $editable = false;
    $safe = true;
    $count = count($columns);
    foreach ($columns as $i => $column) {
        $value = $raw[$i];
        if ($column['pk']) {
            $editable = true;
            if ($value === null) $safe = false;
        }
        if ($column['hidden']) $safe = false;
        if ($raw[$count + $i] === 'blob' || ($value !== null && preg_match('//u', $value) !== 1)) {
            $value = '[Binary: '.strlen($value).' bytes]';
            $safe = false;
        }
        $values[$column['name']] = $value;
    }
    if (strlen(json_encode($values, JSON_THROW_ON_ERROR)) > 60000) $safe = false;
    return ['values' => $values, 'editable' => $editable && $safe];
}
function editor_page(PDO $db, array $tables, ?string $table, array $columns, string $projection, int $offset): array {
    $rows = [];
    if ($table !== null) {
        $keys = array_filter($columns, fn ($column) => $column['pk'] > 0);
        usort($keys, fn ($a, $b) => $a['pk'] <=> $b['pk']);
        // A complete row order also works for WITHOUT ROWID and keyless tables.
        $order = implode(', ', array_map(fn ($column) => editor_identifier($column['name']), $keys ?: $columns));
        $query = $db->query('SELECT '.$projection.' FROM '.editor_identifier($table).' ORDER BY '.$order.' LIMIT 51 OFFSET '.$offset);
        foreach ($query->fetchAll(PDO::FETCH_NUM) as $raw) $rows[] = editor_row($raw, $columns);
    }
    $more = count($rows) > 50;
    if ($more) array_pop($rows);
    return [
        'tables' => $tables, 'table' => $table,
        'columns' => array_map(fn ($column) => ['name' => $column['name'], 'type' => $column['type'], 'primaryKey' => $column['pk'] > 0], $columns),
        'rows' => $rows, 'offset' => $offset, 'hasMore' => $more,
    ];
}
function editor_execute(array $action): array {
    $db = new PDO('sqlite:/app/database/database.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_STRINGIFY_FETCHES => true]);
    $db->exec('PRAGMA journal_mode = DELETE');
    $db->exec('PRAGMA foreign_keys = ON');
    $tables = $db->query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
    $table = $action['table'] ?? ($tables[0] ?? null);
    if ($table !== null && !in_array($table, $tables, true)) return [404, ['error' => 'Table not found.']];
    $columns = $table === null ? [] : $db->query('PRAGMA table_xinfo('.editor_identifier($table).')')->fetchAll(PDO::FETCH_ASSOC);
    $names = array_column($columns, 'name');
    $projection = implode(', ', array_merge(array_map('editor_identifier', $names), array_map(fn ($name) => 'typeof('.editor_identifier($name).')', $names)));
    if ($action['kind'] === 'update') {
        $original = $action['original'];
        $values = $action['values'];
        foreach ([$original, $values] as $row) {
            if (count($row) !== count($names) || array_diff($names, array_keys($row))) return [400, ['error' => 'Include exactly the table columns.']];
        }
        $keys = array_filter($columns, fn ($column) => $column['pk'] > 0);
        if (!$keys) return [400, ['error' => 'Tables without a primary key are read-only.']];
        $where = implode(' AND ', array_map(fn ($column) => editor_identifier($column['name']).' IS ?', $keys));
        $keyValues = array_values(array_map(fn ($column) => $original[$column['name']], $keys));
        $db->beginTransaction();
        try {
            $find = $db->prepare('SELECT '.$projection.' FROM '.editor_identifier($table).' WHERE '.$where);
            $find->execute($keyValues);
            $matches = $find->fetchAll(PDO::FETCH_NUM);
            $current = count($matches) === 1 ? editor_row($matches[0], $columns) : null;
            if ($current === null) {
                $db->rollBack();
                return [409, ['error' => 'This row changed or was deleted. Reload it before saving.']];
            }
            // Strict comparison distinguishes SQL NULL from an empty string.
            foreach ($names as $name) {
                if ($current['values'][$name] !== $original[$name]) {
                    $db->rollBack();
                    return [409, ['error' => 'This row changed. Reload it before saving.']];
                }
            }
            if (!$current['editable']) {
                $db->rollBack();
                return [400, ['error' => 'Binary, generated, oversized or nullable-key rows are read-only.']];
            }
            $changes = array_filter($names, fn ($name) => $values[$name] !== $original[$name]);
            if ($changes) {
                $set = implode(', ', array_map(fn ($name) => editor_identifier($name).' = ?', $changes));
                $update = $db->prepare('UPDATE '.editor_identifier($table).' SET '.$set.' WHERE '.$where);
                $parameters = array_merge(array_values(array_map(fn ($name) => $values[$name], $changes)), $keyValues);
                foreach ($parameters as $i => $value) $update->bindValue($i + 1, $value, $value === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
                $update->execute();
                if ($update->rowCount() !== 1) throw new RuntimeException('Unexpected row count');
            }
            $db->commit();
        } catch (PDOException $error) {
            if ($db->inTransaction()) $db->rollBack();
            return [400, ['error' => 'The edit violates a database constraint or column type.']];
        }
    }
    if ($db->query('PRAGMA quick_check')->fetchColumn() !== 'ok') throw new RuntimeException('Database integrity check failed');
    return [200, editor_page($db, $tables, $table, $columns, $projection, $action['offset'] ?? 0)];
}
[$status, $result] = editor_execute($command['action']);
file_put_contents('/response.json', json_encode(['ok' => true, 'response' => ['status' => $status, 'headers' => [], 'body' => base64_encode(json_encode($result, JSON_THROW_ON_ERROR))]], JSON_THROW_ON_ERROR));
