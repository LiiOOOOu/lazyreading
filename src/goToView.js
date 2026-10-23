"use strict";

function count(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    return 0;
  }
  return number;
}

function goToPlace(place) {
  return {
    lineCurrent: count(place.lineCurrent),
    lineEnd: count(place.lineEnd),
    offsetCurrent: count(place.offsetCurrent),
    offsetEnd: count(place.offsetEnd),
  };
}

// 扩展接口没有带单选按钮的小对话框，用一页表单摆成和 Notepad++「转至」相同的三行布局
function goToHtml(nonce, place) {
  const data = JSON.stringify(goToPlace(place));
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
form { display: grid; grid-template-columns: 7em 11em auto; column-gap: 12px; row-gap: 10px; align-items: center; width: max-content; padding: 16px 18px; }
.radios { grid-column: 1 / -1; display: flex; gap: 28px; margin-bottom: 4px; }
label.choice { display: flex; align-items: center; gap: 6px; cursor: pointer; }
input[type="radio"] { margin: 0; }
input[type="text"] { width: 100%; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; }
input[type="text"]:focus { outline: 1px solid var(--vscode-focusBorder); }
button { min-width: 76px; padding: 3px 10px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-contrastBorder, transparent); cursor: pointer; }
button:focus { outline: 1px solid var(--vscode-focusBorder); }
.error { grid-column: 1 / -1; min-height: 1.2em; color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<form>
  <div class="radios">
    <label class="choice"><input type="radio" name="mode" value="line" checked>行(<u>L</u>)</label>
    <label class="choice"><input type="radio" name="mode" value="offset">偏移量(<u>O</u>)</label>
  </div>
  <span>当前位置:</span><span id="current"></span><span></span>
  <span>目标位置:</span><input id="target" type="text" spellcheck="false" autocomplete="off"><button id="go" type="button">定位(<u>G</u>)</button>
  <span>截止位置:</span><span id="end"></span><button id="cancel" type="button">取消</button>
  <div id="error" class="error"></div>
</form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const state = ${data};
let mode = "line";
const currentEl = document.getElementById("current");
const endEl = document.getElementById("end");
const errorEl = document.getElementById("error");
const targetEl = document.getElementById("target");
const radios = document.querySelectorAll('input[name="mode"]');

function show() {
  const line = mode === "line";
  currentEl.textContent = String(line ? state.lineCurrent : state.offsetCurrent);
  endEl.textContent = String(line ? state.lineEnd : state.offsetEnd);
  errorEl.textContent = "";
}

function setMode(next) {
  mode = next;
  for (const radio of radios) radio.checked = radio.value === next;
  show();
  targetEl.focus();
}

function submit() {
  vscode.postMessage({ type: "go", mode, value: targetEl.value });
}

for (const radio of radios) {
  radio.addEventListener("change", () => { if (radio.checked) setMode(radio.value); });
}
document.getElementById("go").addEventListener("click", submit);
document.getElementById("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { vscode.postMessage({ type: "cancel" }); return; }
  if (event.key === "Enter") { event.preventDefault(); submit(); return; }
  if (!event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "l") { event.preventDefault(); setMode("line"); }
  else if (key === "o") { event.preventDefault(); setMode("offset"); }
  else if (key === "g") { event.preventDefault(); submit(); }
});
window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "error") { errorEl.textContent = message.text || ""; return; }
  if (message.type === "reset") {
    state.lineCurrent = message.lineCurrent;
    state.lineEnd = message.lineEnd;
    state.offsetCurrent = message.offsetCurrent;
    state.offsetEnd = message.offsetEnd;
    targetEl.value = "";
    setMode("line");
  }
});
show();
targetEl.focus();
</script>
</body>
</html>`;
}

module.exports = { goToPlace, goToHtml };
