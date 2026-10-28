const vscode = require('vscode');

/**
 * Все найденные задачи. Общее хранилище для дерева и плана.
 * @type {{ uri: vscode.Uri, line: number, tag: string, text: string }[]}
 */
let items = [];

/**
 * Читает настройки расширения (секция `todoScanner`).
 * Вызывается при каждом скане, поэтому изменения настроек применяются сразу.
 * @returns {{ tags: string[], caseSensitive: boolean, pattern: string, include: string, exclude: string, maxFiles: number, groupBy: 'file' | 'tag' }}
 */
function getConfig() {
  const c = vscode.workspace.getConfiguration('todoScanner');
  return {
    tags: c.get('tags'),
    caseSensitive: c.get('caseSensitive'),
    pattern: c.get('pattern'),
    include: c.get('include'),
    exclude: c.get('exclude'),
    maxFiles: c.get('maxFiles'),
    groupBy: c.get('groupBy'),
  };
}

/**
 * Собирает регулярку из шаблона настроек: подставляет вместо `$TAGS`
 * экранированные метки через `|` (например `BUG|FIXME|TODO`).
 * @param {ReturnType<typeof getConfig>} config настройки
 * @returns {RegExp} регулярка: группа 1 — метка, группа 2 — текст
 * @throws {SyntaxError} если шаблон в настройках некорректный
 */
function buildRegex(config) {
  const tags = config.tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(config.pattern.replace('$TAGS', () => tags), config.caseSensitive ? '' : 'i');
}

/**
 * Ищет метки в тексте файла построчно.
 * @param {vscode.Uri} uri файл, из которого текст
 * @param {string} text содержимое файла
 * @param {ReturnType<typeof getConfig>} config настройки
 * @param {RegExp} regex регулярка из buildRegex
 * @returns {typeof items} найденные задачи (номера строк с 0)
 */
function parse(uri, text, config, regex) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = regex.exec(line);
    if (!m) return;
    // Метка пишется как в настройках, чтобы "todo" и "TODO" попали в одну группу.
    const tag = config.tags.find((t) => t.toLowerCase() === m[1].toLowerCase()) || m[1];
    const text = (m[2] || '').replace(/\s*(\*\/|-->)\s*$/, '').trim();
    found.push({ uri, line: i, tag, text });
  });
  return found;
}

/**
 * Читает файл с диска и разбирает его через parse.
 * Бинарные файлы (с байтом `\0`) и ошибки чтения дают пустой результат.
 * @param {vscode.Uri} uri файл
 * @param {ReturnType<typeof getConfig>} config настройки
 * @param {RegExp} regex регулярка из buildRegex
 * @returns {Promise<typeof items>} найденные задачи
 */
async function scanFile(uri, config, regex) {
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    return text.includes('\0') ? [] : parse(uri, text, config, regex);
  } catch {
    return [];
  }
}

/**
 * Строит план — Markdown-чеклист, сгруппированный по меткам.
 * Порядок разделов = порядок меток в настройках (приоритет).
 * @param {string[]} tags метки из настроек
 * @returns {string} текст плана в Markdown
 */
function buildPlan(tags) {
  const lines = ['# Plan', ''];
  for (const tag of tags) {
    const group = items.filter((i) => i.tag === tag);
    if (!group.length) continue;
    lines.push(`## ${tag} (${group.length})`, '');
    for (const i of group) {
      lines.push(`- [ ] ${i.text || '(no text)'} — \`${vscode.workspace.asRelativePath(i.uri)}:${i.line + 1}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Источник данных для панели задач (TreeDataProvider).
 * Узлы дерева: группа `{ label, items }` или задача из `items`.
 */
class TodoTree {
  /** Создаёт событие, через которое VS Code узнаёт об изменении данных. */
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  /** Просит VS Code перерисовать дерево. */
  refresh() {
    this.emitter.fire();
  }

  /**
   * Возвращает дочерние узлы.
   * Без аргумента — группы (по файлу или по метке), с группой — её задачи.
   * @param {{ label: string, items: typeof items } | undefined} group
   */
  getChildren(group) {
    if (group) return group.items;
    const { groupBy, tags } = getConfig();
    const key = (item) => (groupBy === 'tag' ? item.tag : vscode.workspace.asRelativePath(item.uri));
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(key(item))) groups.set(key(item), { label: key(item), items: [] });
      groups.get(key(item)).items.push(item);
    }
    const order = (label) => (groupBy === 'tag' ? tags.indexOf(label) : 0);
    return [...groups.values()].sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label));
  }

  /**
   * Превращает узел в элемент дерева: у группы — число задач,
   * у задачи — `МЕТКА: текст` (метка выделена) и `файл:строка`, клик открывает эту строку.
   * @param {object} node группа или задача
   * @returns {vscode.TreeItem}
   */
  getTreeItem(node) {
    if (node.items) {
      const ti = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      ti.description = String(node.items.length);
      return ti;
    }
    const label = node.text ? `${node.tag}: ${node.text}` : node.tag;
    const ti = new vscode.TreeItem({ label, highlights: [[0, node.tag.length]] });
    ti.description = `${vscode.workspace.asRelativePath(node.uri)}:${node.line + 1}`;
    ti.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [node.uri, { selection: new vscode.Range(node.line, 0, node.line, 0) }],
    };
    return ti;
  }
}

/**
 * Точка входа: VS Code вызывает её при запуске расширения.
 * Создаёт панель, регистрирует команды и подписки, запускает первый скан.
 * @param {vscode.ExtensionContext} context контекст; всё из `subscriptions` освобождается при выключении
 */
function activate(context) {
  const tree = new TodoTree();
  const view = vscode.window.createTreeView('todoScanner.view', { treeDataProvider: tree });

  /** Обновляет бейдж с числом задач на иконке и перерисовывает дерево. */
  const update = () => {
    view.badge = items.length ? { value: items.length, tooltip: `${items.length} tasks` } : undefined;
    tree.refresh();
  };

  /**
   * Полный скан проекта: находит файлы по include/exclude и параллельно их разбирает.
   * Пока идёт скан, в панели крутится индикатор, итог пишется в строку состояния.
   * Любая ошибка показывается с типом (например `SyntaxError: ...`), список при этом не меняется.
   */
  const scanAll = async () => {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showWarningMessage('TODO Scanner: open a folder to scan for tasks.');
      return;
    }
    try {
      const config = getConfig();
      const regex = buildRegex(config);
      await vscode.window.withProgress({ location: { viewId: 'todoScanner.view' } }, async () => {
        const files = await vscode.workspace.findFiles(config.include, config.exclude, config.maxFiles);
        const results = await Promise.all(files.map((uri) => scanFile(uri, config, regex)));
        items = results.flat();
        vscode.window.setStatusBarMessage(`TODO Scanner: ${items.length} tasks in ${files.length} files`, 4000);
      });
      update();
    } catch (e) {
      vscode.window.showErrorMessage(`TODO Scanner: ${e.name}: ${e.message}`);
    }
  };

  context.subscriptions.push(
    view,
    // Кнопка Refresh: пересканировать весь проект.
    vscode.commands.registerCommand('todoScanner.refresh', scanAll),
    // Кнопка Generate Plan: открыть план в новом несохранённом документе.
    vscode.commands.registerCommand('todoScanner.generatePlan', async () => {
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: buildPlan(getConfig().tags) });
      vscode.window.showTextDocument(doc);
    }),
    // Кнопка ⚙: открыть настройки VS Code, отфильтрованные по этому расширению.
    vscode.commands.registerCommand('todoScanner.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),
    // При сохранении пересканируется только этот файл, а не весь проект.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const config = getConfig();
      const inProject =
        vscode.languages.match({ pattern: config.include }, doc) > 0 &&
        vscode.languages.match({ pattern: config.exclude }, doc) === 0;
      items = items.filter((i) => i.uri.toString() !== doc.uri.toString());
      if (inProject) {
        try {
          items.push(...parse(doc.uri, doc.getText(), config, buildRegex(config)));
        } catch {
          // об ошибке в регулярке сообщает scanAll
        }
      }
      update();
    }),
    // При изменении настроек расширения — полное пересканирование.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('todoScanner')) scanAll();
    }),
  );

  scanAll();
}

/** Вызывается при выключении расширения. Ресурсы освобождает VS Code через `context.subscriptions`. */
function deactivate() {}

module.exports = { activate, deactivate };
