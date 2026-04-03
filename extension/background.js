// ScreenShare Extension — Background Service Worker
// Подключается к relay-серверу, получает команды управления,
// инжектирует их в активную вкладку браузера.

let ws = null;
let relayUrl = '';
let roomId = '';
let connected = false;
let targetTabId = null;
let reconnectTimer = null;

// ── Получить настройки из storage ──
async function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['relayUrl', 'roomId', 'targetTabId'], resolve);
  });
}

// ── Подключиться к relay ──
async function connect() {
  const settings = await loadSettings();
  relayUrl = settings.relayUrl || '';
  roomId = settings.roomId || '';
  targetTabId = settings.targetTabId || null;

  if (!relayUrl || !roomId) {
    broadcastStatus('not_configured');
    return;
  }

  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }

  const wsUrl = relayUrl.replace(/^http/, 'ws') + '/control-ws';
  console.log('[extension] Connecting to', wsUrl);

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error('[extension] WebSocket create error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    console.log('[extension] Connected, joining room', roomId);
    ws.send(JSON.stringify({ type: 'extension-join', roomId }));
    broadcastStatus('connected');
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleCommand(msg);
  };

  ws.onclose = () => {
    connected = false;
    broadcastStatus('disconnected');
    scheduleReconnect();
  };

  ws.onerror = () => {
    connected = false;
    broadcastStatus('error');
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 4000);
}

function broadcastStatus(status) {
  chrome.runtime.sendMessage({ type: 'status', status, roomId }).catch(() => {});
}

// ── Выполнить команду в вкладке ──
async function handleCommand(msg) {
  if (msg.type === 'joined-ack') {
    console.log('[extension] Room joined, waiting for commands');
    return;
  }

  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  // Определить целевую вкладку
  let tabId = targetTabId;
  if (!tabId) {
    // Взять активную вкладку текущего окна
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length > 0) tabId = tabs[0].id;
  }
  if (!tabId) return;

  try {
    if (msg.type === 'mousemove') {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectMouseMove,
        args: [msg.x, msg.y, msg.vw, msg.vh],
      });
      return;
    }

    if (msg.type === 'mousedown' || msg.type === 'mouseup' || msg.type === 'click') {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectMouseClick,
        args: [msg.type, msg.x, msg.y, msg.vw, msg.vh, msg.button || 0],
      });
      return;
    }

    if (msg.type === 'dblclick') {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectDblClick,
        args: [msg.x, msg.y, msg.vw, msg.vh],
      });
      return;
    }

    if (msg.type === 'contextmenu') {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectContextMenu,
        args: [msg.x, msg.y, msg.vw, msg.vh],
      });
      return;
    }

    if (msg.type === 'wheel') {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectWheel,
        args: [msg.x, msg.y, msg.vw, msg.vh, msg.dx, msg.dy],
      });
      return;
    }

    if (msg.type === 'keydown') {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectKeydown,
        args: [msg.key, msg.code, msg.ctrlKey, msg.shiftKey, msg.altKey, msg.metaKey],
      });
      return;
    }

    if (msg.type === 'keyup') {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectKeyup,
        args: [msg.key, msg.code, msg.ctrlKey, msg.shiftKey, msg.altKey, msg.metaKey],
      });
      return;
    }

    if (msg.type === 'select-tab') {
      targetTabId = msg.tabId;
      chrome.storage.local.set({ targetTabId: msg.tabId });
      broadcastStatus('connected');
      return;
    }

  } catch (e) {
    console.warn('[extension] executeScript error:', e.message);
  }
}

// ══════════════════════════════════════════
// Функции инжектируются в страницу
// Координаты приходят в пикселях видео-фрейма
// (vw × vh), масштабируем до реального размера страницы
// ══════════════════════════════════════════

function injectMouseMove(x, y, vw, vh) {
  const sx = (x / vw) * window.innerWidth;
  const sy = (y / vh) * window.innerHeight;
  const el = document.elementFromPoint(sx, sy) || document.body;
  el.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, cancelable: true,
    clientX: sx, clientY: sy,
    screenX: sx, screenY: sy,
  }));
  // Показать кастомный курсор
  let cur = document.getElementById('__remote_cursor__');
  if (!cur) {
    cur = document.createElement('div');
    cur.id = '__remote_cursor__';
    cur.style.cssText = `
      position:fixed;top:0;left:0;width:20px;height:20px;
      background:rgba(99,102,241,0.85);border-radius:50%;
      border:2px solid #fff;pointer-events:none;
      transition:transform 0.05s;z-index:2147483647;
      box-shadow:0 0 0 2px rgba(99,102,241,0.4);
      transform:translate(-50%,-50%);
    `;
    document.body.appendChild(cur);
  }
  cur.style.left = sx + 'px';
  cur.style.top = sy + 'px';
}

function injectMouseClick(type, x, y, vw, vh, button) {
  const sx = (x / vw) * window.innerWidth;
  const sy = (y / vh) * window.innerHeight;
  const el = document.elementFromPoint(sx, sy) || document.body;
  el.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true,
    clientX: sx, clientY: sy,
    screenX: sx, screenY: sy,
    button, buttons: button === 0 ? 1 : 2,
  }));
  if (type === 'click' && el.tagName === 'A') {
    // Разрешить переход по ссылке
  }
  if (type === 'mousedown') {
    // Фокус на элемент
    if (['INPUT','TEXTAREA','SELECT'].includes(el.tagName) || el.isContentEditable) {
      el.focus();
    }
  }
}

function injectDblClick(x, y, vw, vh) {
  const sx = (x / vw) * window.innerWidth;
  const sy = (y / vh) * window.innerHeight;
  const el = document.elementFromPoint(sx, sy) || document.body;
  el.dispatchEvent(new MouseEvent('dblclick', {
    bubbles: true, cancelable: true, clientX: sx, clientY: sy,
  }));
}

function injectContextMenu(x, y, vw, vh) {
  const sx = (x / vw) * window.innerWidth;
  const sy = (y / vh) * window.innerHeight;
  const el = document.elementFromPoint(sx, sy) || document.body;
  el.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: sx, clientY: sy,
  }));
}

function injectWheel(x, y, vw, vh, dx, dy) {
  const sx = (x / vw) * window.innerWidth;
  const sy = (y / vh) * window.innerHeight;
  const el = document.elementFromPoint(sx, sy) || document.body;
  el.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true,
    clientX: sx, clientY: sy,
    deltaX: dx, deltaY: dy, deltaMode: 0,
  }));
}

function injectKeydown(key, code, ctrlKey, shiftKey, altKey, metaKey) {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true, cancelable: true,
    key, code, ctrlKey, shiftKey, altKey, metaKey,
  }));
  // Симулировать ввод текста
  if (key.length === 1 && !ctrlKey && !altKey && !metaKey) {
    if (['INPUT','TEXTAREA'].includes(el.tagName)) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.value = el.value.slice(0, start) + key + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + 1;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      document.execCommand('insertText', false, key);
    }
  }
  if (key === 'Backspace') {
    if (['INPUT','TEXTAREA'].includes(el.tagName)) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      if (start === end && start > 0) {
        el.value = el.value.slice(0, start - 1) + el.value.slice(start);
        el.selectionStart = el.selectionEnd = start - 1;
      } else if (start !== end) {
        el.value = el.value.slice(0, start) + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.isContentEditable) {
      document.execCommand('delete', false);
    }
  }
  if (key === 'Enter') {
    if (el.tagName === 'INPUT') {
      const form = el.closest('form');
      if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  }
}

function injectKeyup(key, code, ctrlKey, shiftKey, altKey, metaKey) {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keyup', {
    bubbles: true, cancelable: true,
    key, code, ctrlKey, shiftKey, altKey, metaKey,
  }));
}

// ── Слушать сообщения от popup ──
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'get-status') {
    reply({ connected, roomId, relayUrl });
    return true;
  }
  if (msg.type === 'connect') {
    relayUrl = msg.relayUrl;
    roomId = msg.roomId;
    chrome.storage.local.set({ relayUrl, roomId });
    connect();
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'disconnect') {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connected = false;
    broadcastStatus('disconnected');
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'get-tabs') {
    chrome.tabs.query({}, (tabs) => {
      reply({ tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active })) });
    });
    return true;
  }
  if (msg.type === 'set-target-tab') {
    targetTabId = msg.tabId;
    chrome.storage.local.set({ targetTabId: msg.tabId });
    reply({ ok: true });
    return true;
  }
});

// ── Автозапуск при старте браузера ──
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Запуск сразу
connect();
