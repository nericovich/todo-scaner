const vscode = require('vscode');

/** @type {{ uri: vscode.Uri, line: number, tag: string, text: string }[]} */
let items = [];

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

function buildRegex(config) {
  const tags = config.tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(config.pattern.replace('$TAGS', () => tags), config.caseSensitive ? '' : 'i');
}

/** Finds tags in a file's text. Group 1 of the pattern is the tag, group 2 the text. */
function parse(uri, text, config, regex) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = regex.exec(line);
    if (!m) return;
    // Use the spelling from settings so "todo" and "TODO" end up in one group.
    const tag = config.tags.find((t) => t.toLowerCase() === m[1].toLowerCase()) || m[1];
    const text = (m[2] || '').replace(/\s*(\*\/|-->)\s*$/, '').trim();
    found.push({ uri, line: i, tag, text });
  });
  return found;
}

async function scanFile(uri, config, regex) {
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    return text.includes('\0') ? [] : parse(uri, text, config, regex); // skip binary files
  } catch {
    return [];
  }
}

class TodoTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() {
    this.emitter.fire();
  }

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

  getTreeItem(node) {
    if (node.items) {
      const ti = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      ti.description = String(node.items.length);
      return ti;
    }
    const ti = new vscode.TreeItem(node.text || node.tag);
    ti.description = `${node.tag} · ${vscode.workspace.asRelativePath(node.uri)}:${node.line + 1}`;
    ti.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [node.uri, { selection: new vscode.Range(node.line, 0, node.line, 0) }],
    };
    return ti;
  }
}

function activate(context) {
  const tree = new TodoTree();
  const view = vscode.window.createTreeView('todoScanner.view', { treeDataProvider: tree });

  const update = () => {
    view.badge = items.length ? { value: items.length, tooltip: `${items.length} tasks` } : undefined;
    tree.refresh();
  };

  const scanAll = async () => {
    const config = getConfig();
    let regex;
    try {
      regex = buildRegex(config);
    } catch (e) {
      vscode.window.showErrorMessage(`TODO Scanner: invalid pattern — ${e.message}`);
      return;
    }
    const files = await vscode.workspace.findFiles(config.include, config.exclude, config.maxFiles);
    const results = await Promise.all(files.map((uri) => scanFile(uri, config, regex)));
    items = results.flat();
    update();
  };

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand('todoScanner.refresh', scanAll),
    vscode.commands.registerCommand('todoScanner.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),
    // Rescan only the saved file instead of the whole project.
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
          // invalid pattern is reported by scanAll
        }
      }
      update();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('todoScanner')) scanAll();
    }),
  );

  scanAll();
}

function deactivate() {}

module.exports = { activate, deactivate };
