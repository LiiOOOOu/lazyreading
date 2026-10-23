"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { bomStart, fitUtf8Prefix, movePage, pageStartBefore, snapUtf8Offset, toStatusText } = require("./pageWindow");
const { findChapters, findLine, lineAtOffset } = require("./chapterScan");
const { goToHtml, goToPlace } = require("./goToView");

const PLACE_STATE = "lazier.pageByPath";
const DIRECTORY_STATE = "lazier.lastDirectory";
const VISIBLE_STATE = "lazier.statusTextVisible";

let extensionContext;
let statusItem;
let watcher;
let reloadTimer;
let sourceKey = "";
let watchRoot = "";
let sourceSignature = "";
let textEntries = [];
let entryIndex = 0;
let pageOffset = 0;
let statusTextVisible = true;
let goToPanel;

function activate(context) {
  extensionContext = context;
  statusTextVisible = context.globalState.get(VISIBLE_STATE, true) !== false;
  statusItem = vscode.window.createStatusBarItem("lazier.page", vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(
    statusItem,
    { dispose: closeWatch },
    vscode.commands.registerCommand("lazier.nextPage", () => shiftPage(1)),
    vscode.commands.registerCommand("lazier.prevPage", () => shiftPage(-1)),
    vscode.commands.registerCommand("lazier.toggleStatusText", toggleStatusText),
    vscode.commands.registerCommand("lazier.selectFile", selectFile),
    vscode.commands.registerCommand("lazier.reload", applySource),
    vscode.commands.registerCommand("lazier.jumpChapter", jumpToChapter),
    vscode.commands.registerCommand("lazier.jumpPosition", jumpToPosition),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("lazier")) {
        applySource();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isCurrentFile(document.uri.fsPath)) {
        scheduleReload();
      }
    })
  );
  applySource();
}

function deactivate() {
  clearTimeout(reloadTimer);
  closeWatch();
}

function config() {
  return vscode.workspace.getConfiguration("lazier");
}

function configuredPageBytes() {
  const value = Number(config().get("pageBytes"));
  if (!Number.isFinite(value)) {
    return 60;
  }
  return Math.min(4096, Math.max(1, Math.floor(value)));
}

function wrapEnabled() {
  return config().get("wrap") !== false;
}

function resolveSourcePath() {
  const selected = String(config().get("filePath") || "").trim();
  const legacyDirectory = String(config().get("directory") || "").trim();
  const raw = selected || legacyDirectory;
  if (!raw) {
    return "";
  }
  if (path.isAbsolute(raw)) {
    return path.normalize(raw);
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return path.normalize(root ? path.join(root, raw) : raw);
}

function readContentStart(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(3);
    const read = fs.readSync(fd, head, 0, 3, 0);
    return bomStart(head.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
}

function readRaw(filePath, offset, length) {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function readPage(filePath, offset, pageBytes) {
  const raw = readRaw(filePath, offset, pageBytes + 3);
  return raw.subarray(0, fitUtf8Prefix(raw, pageBytes));
}

function buildTextEntries(absPath) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    return { root: "", entries: [], signature: "", kind: "directory" };
  }
  if (!stat.isFile()) {
    return { root: "", entries: [], signature: "" };
  }
  const entry = describeFile(absPath, path.basename(absPath));
  return { root: path.dirname(absPath), entries: entry ? [entry] : [], signature: entry ? fileSignature(entry) : "" };
}

function describeFile(absPath, name) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      return undefined;
    }
    return { name, absPath, size: stat.size, start: readContentStart(absPath) };
  } catch {
    return undefined;
  }
}

function fileSignature(entry) {
  return `${entry.name}:${entry.size}:${entry.start}`;
}

function refreshEntrySize(entry) {
  try {
    entry.size = fs.statSync(entry.absPath).size;
  } catch {
    entry.size = 0;
  }
}

function applySource() {
  const resolved = resolveSourcePath();
  const pathChanged = resolved !== sourceKey;
  const previousName = textEntries[entryIndex]?.name;
  const previousOffset = pageOffset;
  sourceKey = resolved;
  if (!resolved || !fs.existsSync(resolved)) {
    clearEntries();
    renderPrompt(resolved ? "missing" : "empty");
    return;
  }
  let built;
  try {
    built = buildTextEntries(resolved);
  } catch (error) {
    clearEntries();
    renderPrompt("error", error);
    return;
  }
  if (built.kind === "directory") {
    clearEntries();
    renderPrompt("directory");
    return;
  }
  const rootChanged = built.root !== watchRoot;
  watchRoot = built.root;
  sourceSignature = built.signature;
  textEntries = built.entries;
  if (!textEntries.length) {
    entryIndex = 0;
    pageOffset = 0;
    if (rootChanged) {
      armWatch();
    }
    renderPrompt("nofiles");
    return;
  }
  if (pathChanged) {
    restorePlace();
  } else {
    const found = textEntries.findIndex((entry) => entry.name === previousName);
    entryIndex = found >= 0 ? found : 0;
    pageOffset = found >= 0 ? previousOffset : textEntries[entryIndex].start;
  }
  clampCurrent();
  rememberPlace();
  if (rootChanged || !watcher) {
    armWatch();
  }
  render();
}

function clearEntries() {
  textEntries = [];
  entryIndex = 0;
  pageOffset = 0;
  sourceSignature = "";
  watchRoot = "";
  closeWatch();
}

function restorePlace() {
  entryIndex = 0;
  const saved = readSavedOffset(textEntries[0].absPath);
  pageOffset = Number.isInteger(saved) ? saved : textEntries[0].start;
}

function placeKey(filePath) {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readSavedOffset(filePath) {
  const saved = extensionContext.globalState.get(PLACE_STATE, {})[placeKey(filePath)];
  if (Number.isInteger(saved)) {
    return saved;
  }
  if (saved && Number.isInteger(saved.offset)) {
    return saved.offset;
  }
  return undefined;
}

function clampCurrent() {
  const entry = textEntries[entryIndex];
  if (!entry) {
    return;
  }
  refreshEntrySize(entry);
  const page = configuredPageBytes();
  if (pageOffset >= entry.size) {
    pageOffset = lastOffsetOf(entry, page);
  } else if (pageOffset < entry.start) {
    pageOffset = entry.start;
  } else {
    alignCurrent();
  }
}

function alignCurrent() {
  const entry = textEntries[entryIndex];
  if (!entry || pageOffset <= entry.start) {
    pageOffset = entry ? entry.start : 0;
    return;
  }
  const from = Math.max(entry.start, pageOffset - 3);
  const bytes = readRaw(entry.absPath, from, pageOffset - from + 1);
  pageOffset = snapUtf8Offset(bytes, pageOffset - from, from);
  if (pageOffset < entry.start) {
    pageOffset = entry.start;
  }
}

function previousOffsetOf(entry, page) {
  return pageStartOf(entry, pageOffset, page);
}

function lastOffsetOf(entry, page) {
  return pageStartOf(entry, entry.size, page);
}

function pageStartOf(entry, target, page) {
  if (target <= entry.start) {
    return entry.start;
  }
  const span = target - entry.start;
  if (span > 4 * 1024 * 1024) {
    let offset = entry.start;
    while (offset < target) {
      const raw = readRaw(entry.absPath, offset, page + 3);
      const size = fitUtf8Prefix(raw, page);
      if (size <= 0 || offset + size >= target) {
        return offset;
      }
      offset += size;
    }
    return entry.start;
  }
  const bytes = readRaw(entry.absPath, entry.start, span + 3);
  return entry.start + pageStartBefore(bytes, span, page);
}

function rememberPlace() {
  const entry = textEntries[entryIndex];
  if (!entry) {
    return;
  }
  // 按文件绝对路径分开记，换另一个 txt 时不会冲掉这个文件上次的位置
  const map = { ...extensionContext.globalState.get(PLACE_STATE, {}) };
  map[placeKey(entry.absPath)] = pageOffset;
  void extensionContext.globalState.update(PLACE_STATE, map);
}

function rememberVisible() {
  void extensionContext.globalState.update(VISIBLE_STATE, statusTextVisible);
}

function renderPrompt(kind, error) {
  if (kind === "missing") {
    statusItem.text = "$(warning) 文件不存在";
    statusItem.tooltip = sourceKey;
    statusItem.accessibilityInformation = { label: "文件不存在" };
  } else if (kind === "error") {
    statusItem.text = "$(error) 无法读取";
    statusItem.tooltip = `${sourceKey}\n${error}`;
    statusItem.accessibilityInformation = { label: "无法读取" };
  } else if (kind === "directory") {
    statusItem.text = "$(file) 请选择 txt";
    statusItem.tooltip = sourceKey;
    statusItem.accessibilityInformation = { label: "请选择 txt 文件" };
  } else if (kind === "nofiles") {
    statusItem.text = "$(info) 没有可阅读的文本";
    statusItem.tooltip = sourceKey;
    statusItem.accessibilityInformation = { label: "没有可阅读的文本" };
  } else {
    statusItem.text = "$(file) 选择文本";
    statusItem.tooltip = "点击选择要按字节翻页的 txt";
    statusItem.accessibilityInformation = { label: "选择文本" };
  }
  statusItem.command = "lazier.selectFile";
  showStatusItem();
}

function render() {
  const entry = textEntries[entryIndex];
  if (!entry) {
    renderPrompt(sourceKey ? "nofiles" : "empty");
    return;
  }
  const page = configuredPageBytes();
  refreshEntrySize(entry);
  let chunk;
  try {
    if (pageOffset >= entry.size) {
      pageOffset = lastOffsetOf(entry, page);
    } else if (pageOffset < entry.start) {
      pageOffset = entry.start;
    } else {
      alignCurrent();
    }
    chunk = readPage(entry.absPath, pageOffset, page);
  } catch (error) {
    statusItem.text = "$(error) 读取失败";
    statusItem.tooltip = `${entry.absPath}\n${error}`;
    statusItem.accessibilityInformation = { label: "读取失败" };
    statusItem.command = "lazier.selectFile";
    showStatusItem();
    return;
  }
  const end = pageOffset + chunk.length;
  const range = chunk.length === 0 ? "空" : `${pageOffset + 1}-${end}/${entry.size}`;
  const text = toStatusText(chunk);
  statusItem.text = text ? `${entry.name}  ${range}  ${text}` : `${entry.name}  ${range}`;
  statusItem.tooltip = `${entry.absPath}\n字节 ${range}`;
  statusItem.accessibilityInformation = { label: `${entry.name}，字节 ${range}。${text}` };
  statusItem.command = "lazier.nextPage";
  showStatusItem();
}

function showStatusItem() {
  if (statusTextVisible) {
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

function shiftPage(direction) {
  if (!textEntries.length) {
    return selectFile();
  }
  const page = configuredPageBytes();
  const current = textEntries[entryIndex];
  refreshEntrySize(current);
  const neighborIndex = direction > 0
    ? (entryIndex + 1 < textEntries.length ? entryIndex + 1 : 0)
    : (entryIndex > 0 ? entryIndex - 1 : textEntries.length - 1);
  const neighbor = textEntries[neighborIndex];
  refreshEntrySize(neighbor);
  let step = 0;
  let previousOffset = pageOffset;
  let lastOffset = neighbor.start;
  try {
    clampCurrent();
    if (direction > 0) {
      step = readPage(current.absPath, pageOffset, page).length;
    } else if (pageOffset > current.start) {
      previousOffset = previousOffsetOf(current, page);
    }
    if (direction < 0) {
      lastOffset = lastOffsetOf(neighbor, page);
    }
  } catch {
    render();
    return;
  }
  const moved = movePage(
    direction,
    {
      index: entryIndex,
      offset: pageOffset,
      count: textEntries.length,
      length: current.size,
      start: current.start,
      step,
      previousOffset,
      wrap: wrapEnabled(),
    },
    { start: neighbor.start, lastOffset }
  );
  if (!moved.moved) {
    return;
  }
  entryIndex = moved.index;
  pageOffset = moved.offset;
  rememberPlace();
  render();
}

function readCurrentFile(entry) {
  refreshEntrySize(entry);
  return fs.readFileSync(entry.absPath);
}

function goToOffset(offset) {
  const entry = textEntries[entryIndex];
  if (!entry) {
    return;
  }
  refreshEntrySize(entry);
  pageOffset = offset;
  clampCurrent();
  rememberPlace();
  render();
}

async function jumpToChapter() {
  const entry = textEntries[entryIndex];
  if (!entry) {
    return selectFile();
  }
  let chapters;
  try {
    chapters = findChapters(readCurrentFile(entry), entry.start);
  } catch (error) {
    vscode.window.showErrorMessage(`读取章节失败：${error}`);
    return;
  }
  if (chapters.length === 0) {
    vscode.window.showInformationMessage("没有识别到章节");
    return;
  }
  let active = 0;
  for (let index = 0; index < chapters.length; index += 1) {
    if (chapters[index].offset <= pageOffset) {
      active = index;
    }
  }
  const pick = vscode.window.createQuickPick();
  pick.title = "跳转到章节";
  pick.items = chapters.map((chapter) => ({
    label: chapter.title,
    description: `第 ${chapter.line} 行`,
    offset: chapter.offset,
  }));
  pick.activeItems = [pick.items[active]];
  pick.onDidAccept(() => {
    const selected = pick.selectedItems[0];
    pick.hide();
    if (selected) {
      goToOffset(selected.offset);
    }
  });
  pick.onDidHide(() => pick.dispose());
  pick.show();
}

function readGoToPlace() {
  const entry = textEntries[entryIndex];
  if (!entry) {
    return undefined;
  }
  const file = readCurrentFile(entry);
  const located = findLine(file, entry.start, 1);
  const offsetEnd = entry.size;
  return goToPlace({
    lineCurrent: lineAtOffset(file, entry.start, pageOffset),
    lineEnd: located.lineCount,
    offsetCurrent: offsetEnd < 1 ? 0 : Math.min(offsetEnd, pageOffset + 1),
    offsetEnd,
  });
}

function jumpToPosition() {
  const entry = textEntries[entryIndex];
  if (!entry) {
    return selectFile();
  }
  let place;
  try {
    place = readGoToPlace();
  } catch (error) {
    vscode.window.showErrorMessage(`读取位置失败：${error}`);
    return;
  }
  if (!place) {
    return selectFile();
  }
  if (goToPanel) {
    goToPanel.reveal(vscode.ViewColumn.Active);
    goToPanel.webview.postMessage({ type: "reset", ...place });
    return;
  }
  const panel = vscode.window.createWebviewPanel("lazier.goTo", "转至...", vscode.ViewColumn.Active, { enableScripts: true });
  goToPanel = panel;
  const nonce = crypto.randomBytes(16).toString("hex");
  panel.webview.html = goToHtml(nonce, place);
  panel.onDidDispose(() => {
    if (goToPanel === panel) {
      goToPanel = undefined;
    }
  });
  panel.webview.onDidReceiveMessage((message) => {
    if (!message || message.type === "cancel") {
      panel.dispose();
      return;
    }
    if (message.type !== "go") {
      return;
    }
    const error = applyGoTo(message.mode, message.value);
    if (error) {
      panel.webview.postMessage({ type: "error", text: error });
      return;
    }
    panel.dispose();
  });
}

function applyGoTo(mode, raw) {
  const entry = textEntries[entryIndex];
  if (!entry) {
    return "没有打开文本";
  }
  const text = String(raw ?? "").trim();
  if (mode === "offset") {
    refreshEntrySize(entry);
    if (entry.size < 1 || !/^\d+$/.test(text)) {
      return entry.size < 1 ? "文件是空的" : `请输入 1 到 ${entry.size} 的整数`;
    }
    const position = Number(text);
    if (position < 1 || position > entry.size) {
      return `请输入 1 到 ${entry.size} 的整数`;
    }
    goToOffset(position - 1);
    return "";
  }
  let file;
  try {
    file = readCurrentFile(entry);
  } catch (error) {
    return `读取失败：${error}`;
  }
  const located = findLine(file, entry.start, 1);
  if (!/^\d+$/.test(text)) {
    return `请输入 1 到 ${located.lineCount} 的整数`;
  }
  const lineNumber = Number(text);
  if (lineNumber < 1 || lineNumber > located.lineCount) {
    return `请输入 1 到 ${located.lineCount} 的整数`;
  }
  const target = findLine(file, entry.start, lineNumber);
  if (!Number.isInteger(target.offset)) {
    return "行号无效";
  }
  goToOffset(target.offset);
  return "";
}

function toggleStatusText() {
  statusTextVisible = !statusTextVisible;
  rememberVisible();
  if (textEntries.length) {
    render();
  } else {
    showStatusItem();
  }
}

function openDialogUri() {
  const current = resolveSourcePath();
  if (current && fs.existsSync(current)) {
    return vscode.Uri.file(current);
  }
  // 当前文件不在了，或这次还没选过文件时，选择框仍回到上次打开的文件夹
  const saved = String(extensionContext.globalState.get(DIRECTORY_STATE, "") || "");
  if (saved && fs.existsSync(saved)) {
    return vscode.Uri.file(saved);
  }
  if (current) {
    const parent = path.dirname(current);
    if (parent && fs.existsSync(parent)) {
      return vscode.Uri.file(parent);
    }
  }
  return undefined;
}

function rememberDirectory(filePath) {
  void extensionContext.globalState.update(DIRECTORY_STATE, path.dirname(filePath));
}

async function selectFile() {
  rememberPlace();
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "选择",
    filters: { 文本: ["txt"] },
    defaultUri: openDialogUri(),
  });
  if (!picked || picked.length === 0) {
    return;
  }
  rememberDirectory(picked[0].fsPath);
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await config().update("filePath", picked[0].fsPath, target);
  applySource();
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reloadIfChanged, 150);
}

function reloadIfChanged() {
  if (!sourceKey || !fs.existsSync(sourceKey)) {
    applySource();
    return;
  }
  try {
    const built = buildTextEntries(sourceKey);
    if (built.signature === sourceSignature && built.root === watchRoot) {
      return;
    }
  } catch {
    applySource();
    return;
  }
  applySource();
}

function isCurrentFile(filePath) {
  const entry = textEntries[0];
  if (!entry) {
    return false;
  }
  return placeKey(entry.absPath) === placeKey(filePath);
}

function armWatch() {
  closeWatch();
  if (!watchRoot) {
    return;
  }
  try {
    watcher = fs.watch(watchRoot, () => scheduleReload());
    watcher.on("error", () => scheduleReload());
  } catch {
    // 目录刚被删掉时监听会失败，状态栏会在下次翻页时再提示
  }
}

function closeWatch() {
  if (!watcher) {
    return;
  }
  watcher.close();
  watcher = undefined;
}

module.exports = { activate, deactivate };
