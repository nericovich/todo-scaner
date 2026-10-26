# TODO Scanner

Расширение VS Code: находит в проекте `TODO`, `FIXME`, `BUG` и любые свои метки, показывает их в отдельной панели и собирает из них план.

## Запуск

Откройте папку в VS Code и нажмите **F5** — запустится окно с расширением. Сборка и зависимости не нужны.

## Сборка и установка

Чтобы расширение работало всегда, без F5, соберите `.vsix` и установите его (нужен Node.js):

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license -o todo-scanner.vsix
code --install-extension todo-scanner.vsix --force
```

Затем перезапустите VS Code. После изменений в коде повторите обе команды — `--force` заменит установленную версию.

Если `code` не найден в терминале: в VS Code выполните ⇧⌘P → **Shell Command: Install 'code' command in PATH**. Или установите вручную: вкладка Extensions → `⋯` → **Install from VSIX…**.

Удалить: `code --uninstall-extension neri.todo-scanner`.

## Использование

- Иконка **TODO Scanner** в Activity Bar — список найденных задач (клик открывает строку).
- Кнопки панели: **Refresh** — пересканировать, **Generate Plan** — Markdown-чеклист, **⚙** — настройки.
- При сохранении файла список обновляется автоматически.

## Настройки

Открываются кнопкой ⚙ (или `TODO Scanner: Open Settings`):

| Настройка | Что делает |
| --- | --- |
| `todoScanner.tags` | Список меток. Можно добавлять свои (`REVIEW`, `@todo`, …). Порядок = приоритет в плане. |
| `todoScanner.caseSensitive` | Учитывать регистр. |
| `todoScanner.pattern` | Регулярка для строки. `$TAGS` заменяется на метки, группа 1 — метка, группа 2 — текст. |
| `todoScanner.include` / `exclude` | Какие файлы сканировать / пропускать (glob). |
| `todoScanner.maxFiles` | Ограничение на число файлов. |
| `todoScanner.groupBy` | Группировка в панели: `file` или `tag`. |

Пример: искать метки в квадратных скобках где угодно — `\[($TAGS)\]\s*(.*)`.
