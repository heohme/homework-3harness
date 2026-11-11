// LOOM local console. Session credentials deliberately live only in this module's memory.
const $ = (id) => document.getElementById(id);
const pages = { plugins: '插件管理', run: '运行台', history: '运行历史', settings: '模型设置' };
const activeStatuses = new Set(['running', 'awaiting_approval']);
const statusLabels = { running: '运行中', awaiting_approval: '等待批准', success: '已完成', error: '失败', cancelled: '已取消' };
let token = null;
let sessionRequest = null;
let stateRequest = null;
let state = null;
let page = 'plugins';
let selectedRunId = '';
let installedSignature = '';
let pendingRunSubmission = false;
let catalogSignature = '';
let historySignature = '';
let toolSignature = '';
let currentTool = null;
let toolEditor = null;
let modelHydrated = false;
let modelDirty = false;
let retryNotification = null;
let dialogOperation = null;
let dialogBusy = false;
let dialogReturnFocus = null;
let dialogFocusIdentity = null;
let lastExecutionSignature = '';
let lastApprovalSignature = '';
let renderedEventRunId = '';
const submittedApprovals = new Set();
const busyActions = new Set();
let fieldCounter = 0;

function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'value') element.value = value;
    else if (key === 'checked') element.checked = Boolean(value);
    else if (key === 'disabled') element.disabled = Boolean(value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child !== undefined && child !== null) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
function button(text, handler, classes = '', testId = '') {
  const result = node('button', { type: 'button', class: `button ${classes}`, text, 'data-testid': testId || undefined });
  result.addEventListener('click', handler);
  return result;
}
function text(id, value) {
  const element = $(id);
  const next = String(value ?? '');
  if (element.textContent !== next) element.textContent = next;
}
function json(value) {
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return '[内容无法序列化]'; }
}
function date(value, short = false) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('zh-CN', short ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function setStatus(element, status, label = '') {
  const style = status === 'success' ? 'success' : status === 'error' ? 'error' : status === 'awaiting_approval' ? 'warning' : status === 'running' ? 'running' : 'neutral';
  element.className = `status-pill ${style}`;
  element.textContent = label || statusLabels[status] || status || '未知';
}
function pill(status, label) {
  const result = node('span');
  setStatus(result, status, label);
  return result;
}
function notify(message, kind = 'success', retry = null) {
  text('notification-text', message);
  $('notification').className = `notice ${kind === 'error' ? 'danger' : kind === 'warning' ? 'warning' : ''}`;
  $('notification').hidden = false;
  retryNotification = retry;
  $('notification-retry').hidden = !retry;
}
function errorText(error) {
  return error?.message || '请求失败，请稍后重试。';
}
class APIError extends Error {
  constructor(message, code, status) { super(message); this.name = 'APIError'; this.code = code; this.status = status; }
}
async function request(path, method = 'GET', body, authenticated = true, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (authenticated) {
      await getSession();
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    let data;
    try { data = await response.json(); } catch { throw new APIError('宿主返回了非 JSON 响应。请确认打开的是 LOOM 本地服务。', 'INVALID_RESPONSE', response.status); }
    if (!response.ok) {
      if (response.status === 401) token = null;
      throw new APIError(data.error?.message || `请求失败（HTTP ${response.status}）`, data.error?.code || 'REQUEST_FAILED', response.status);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new APIError('请求超时，宿主尚未响应。请检查服务后重试；操作可能已完成，请先查看最新状态。', 'TIMEOUT', 0);
    if (error instanceof TypeError) throw new APIError('无法访问本地宿主。请确认服务已启动，并从它提供的本机地址打开控制台。', 'NETWORK_ERROR', 0);
    throw error;
  } finally { clearTimeout(timeout); }
}
async function getSession() {
  if (token) return token;
  if (!sessionRequest) {
    sessionRequest = request('/api/session', 'GET', undefined, false).then((data) => {
      if (typeof data.token !== 'string' || !data.token) throw new APIError('宿主未提供有效的会话令牌。', 'INVALID_SESSION', 0);
      token = data.token;
      return token;
    }).finally(() => { sessionRequest = null; });
  }
  return sessionRequest;
}
async function refresh(force = false) {
  if (force && stateRequest) await stateRequest;
  if (stateRequest) return stateRequest;
  stateRequest = request('/api/state').then((data) => {
    state = data;
    $('connection-dot').className = 'status-dot online';
    text('connection-label', '本地宿主已连接');
    $('connection-error').hidden = true;
    renderState();
    return data;
  }).catch((error) => {
    $('connection-dot').className = 'status-dot offline';
    text('connection-label', '宿主连接中断');
    text('connection-error-text', errorText(error));
    $('connection-error').hidden = false;
    updateControlStates();
    return null;
  }).finally(() => { stateRequest = null; });
  return stateRequest;
}
async function action(key, control, operation, success = '') {
  if (busyActions.has(key)) return;
  busyActions.add(key);
  const previousLabel = control?.textContent;
  const previousDisabled = control?.disabled;
  if (control) { control.disabled = true; control.setAttribute('aria-busy', 'true'); control.textContent = '请求中…'; }
  try {
    const result = await operation();
    if (success) notify(success);
    await refresh(true);
    return result;
  } catch (error) {
    notify(errorText(error), 'error', () => action(key, control, operation, success));
  } finally {
    busyActions.delete(key);
    if (control) { control.disabled = previousDisabled; control.removeAttribute('aria-busy'); control.textContent = previousLabel; }
    updateControlStates();
  }
}
function focusIdentity(element) {
  return { testId: element?.dataset?.testid, card: element?.closest('[data-testid]')?.dataset.testid, plugin: element?.closest('.installed-card')?.dataset.testid };
}
function restoreFocus(identity, fallback) {
  const candidates = [...document.querySelectorAll('[data-testid]')];
  const exact = identity?.testId && candidates.find((element) => element.dataset.testid === identity.testId);
  const plugin = identity?.plugin && candidates.find((element) => element.dataset.testid === identity.plugin);
  const target = exact || plugin?.querySelector('button') || (fallback?.isConnected ? fallback : null);
  target?.focus({ preventScroll: true });
}
function replacePreservingFocus(container, ...children) {
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const identity = focused && focusIdentity(focused);
  container.replaceChildren(...children);
  if (focused) restoreFocus(identity, container);
}
function renderState() {
  const plugins = state.plugins || [];
  text('app-version', `v${state.version || '0.1.0'}`);
  text('stat-installed', plugins.length);
  text('stat-enabled', plugins.filter((plugin) => plugin.enabled).length);
  text('stat-tools', (state.tools || []).length);
  text('installed-count', plugins.length);
  text('catalog-count', (state.catalog || []).length);
  renderPlugins();
  renderTools();
  renderModel();
  renderRunOptions();
  renderExecution();
  renderHistory();
  updateControlStates();
}
function empty(title, description, actionLabel, handler, classes = '') {
  const result = node('div', { class: `empty-state ${classes}` }, node('div', { class: 'empty-symbol', 'aria-hidden': 'true', text: '∷' }), node('h3', { text: title }), node('p', { text: description }));
  if (actionLabel) result.append(button(actionLabel, handler, 'primary'));
  return result;
}
function renderPlugins() {
  const plugins = state.plugins || [];
  const nextInstalled = JSON.stringify(plugins);
  if (nextInstalled !== installedSignature) {
    installedSignature = nextInstalled;
    if (!plugins.length) {
      replacePreservingFocus($('installed-plugins'), empty('还没有安装插件。这是你的起点。', '从下方真实本地目录选择插件，或指定一个已审查的目录。安装后需配置并授权，才能接入运行台。', '安装第一个插件', () => openInstall(), 'zero-plugins'));
    } else {
      const list = node('div', { class: 'installed-list' });
      for (const record of plugins) {
        const manifest = record.manifest || {};
        const id = manifest.id;
        const card = node('article', { class: 'installed-card', 'data-testid': `plugin-${id}` });
        const identity = node('div', { class: 'installed-identity' }, node('div', { class: 'plugin-glyph', 'aria-hidden': 'true', text: '⌘' }), node('div', {}, node('div', { class: 'plugin-name' }, node('h3', { text: manifest.name || id }), node('span', { class: 'plugin-version', text: `v${manifest.version || '—'}` })), node('p', { class: 'plugin-description', text: manifest.description || '本地插件' }), node('div', { class: 'plugin-details' }, node('span', { class: 'mono', text: id }), node('span', { text: `${manifest.tools?.length || 0} 个工具` }), node('span', { text: `安装于 ${date(record.installedAt)}` }))));
        const permissions = node('div', { class: 'permission-list', 'aria-label': '声明权限' });
        for (const permission of manifest.permissions || []) permissions.append(node('span', { class: 'permission-tag', text: permission }));
        identity.lastChild.append(permissions);
        card.append(node('div', { class: 'installed-header' }, identity, pill(record.enabled ? 'success' : 'neutral', record.enabled ? '已启用' : '已安装 · 未启用')));
        const actions = node('div', { class: 'installed-actions' });
        if (record.enabled) {
          const disable = button('禁用', () => openDisable(record), 'small', `disable-${id}`);
          actions.append(disable, button('去运行', () => { setPage('run'); setMode('tool'); const tool = (state.tools || []).find((item) => item.pluginId === id); if (tool) { $('tool-select').value = tool.name; selectTool(); } }, 'small primary', `run-${id}`));
        } else actions.append(button('启用并授权', () => openEnable(record), 'small primary', `enable-${id}`));
        actions.append(button('配置', () => openConfig(record), 'small', `config-${id}`), button('查看清单', () => openManifest(record), 'small', `manifest-${id}`), button('卸载', () => openUninstall(record), 'small danger-outline', `uninstall-${id}`));
        card.append(actions);
        list.append(card);
      }
      replacePreservingFocus($('installed-plugins'), list);
    }
  }
  const nextCatalog = JSON.stringify([state.catalog, plugins.map((item) => item.manifest?.id)]);
  if (nextCatalog !== catalogSignature) {
    catalogSignature = nextCatalog;
    const catalog = state.catalog || [];
    if (!catalog.length) replacePreservingFocus($('catalog-list'), empty('本地目录中暂无插件', '你仍可从自己的本机目录安装符合协议的插件。不连接任何在线插件市场。', '选择本地目录', () => openInstall()));
    else replacePreservingFocus($('catalog-list'), ...catalog.map((item) => {
      const manifest = item.manifest || {};
      const installed = plugins.some((record) => record.manifest?.id === manifest.id);
      const inspect = () => installed ? openDialog(manifest.name || manifest.id, [digestBox([['源目录', item.path]]), node('pre', { text: json(manifest), tabindex: '0' })], '', null, { eyebrow: 'CATALOG / LOCAL SOURCE' }) : openInstall(item.path);
      return node('article', { class: 'catalog-row', 'data-testid': `catalog-${manifest.id}` }, node('div', { class: 'plugin-glyph', 'aria-hidden': 'true', text: '＋' }), node('div', {}, node('div', { class: 'plugin-name' }, node('h3', { text: manifest.name || manifest.id }), node('span', { class: 'plugin-version', text: `v${manifest.version || '—'}` }), ...(installed ? [pill('success', '已安装')] : [])), node('p', { class: 'plugin-description', text: manifest.description || '本机目录中的插件' }), node('p', { class: 'plugin-path', text: item.path })), button(installed ? '查看本地清单' : '预检并安装', inspect, 'small', `catalog-install-${manifest.id}`));
    }));
  }
}

// The schema editor uses DOM construction only. Unknown/complex schemas remain editable as JSON.
function schemaEditor(container, schema = {}, initial = {}, options = {}) {
  const form = options.form || node('form', { 'aria-label': options.label || 'Schema 配置表单' });
  const fields = node('div', { class: 'schema-fields' });
  let bindings = [];
  const unsupportedRoot = (schema.type && schema.type !== 'object') || !schema.properties || schema.oneOf || schema.anyOf || schema.allOf || schema.$ref;
  function build(parent, definition, values, path = []) {
    const required = new Set(definition.required || []);
    for (const [key, property] of Object.entries(definition.properties || {})) {
      const keyPath = [...path, key];
      const value = values?.[key] ?? property.default;
      const requiredField = required.has(key);
      const wrapper = node('div', { class: 'schema-field' });
      const type = Array.isArray(property.type) ? property.type.find((item) => item !== 'null') : property.type || (property.properties ? 'object' : 'string');
      const complex = property.oneOf || property.anyOf || property.allOf || property.$ref || Array.isArray(property.type);
      const id = `schema-field-${++fieldCounter}`;
      const title = property.title || key;
      const label = node('label', { for: id }, title, requiredField ? node('span', { class: 'required', text: '*' }) : null, node('span', { class: 'schema-type', text: `${key} / ${type}` }));
      let control;
      if (type === 'object' && property.properties && !complex) {
        const nestedFields = node('div', { class: 'schema-fields' });
        wrapper.append(node('fieldset', {}, node('legend', { text: `${title}${requiredField ? ' *' : ''}` }), nestedFields));
        build(nestedFields, property, value || {}, keyPath);
      } else {
        if (property.enum && !complex) {
          control = node('select', { id, 'data-schema-path': keyPath.join('.'), 'data-testid': `field-${keyPath.join('-')}` });
          if (!requiredField || value === undefined) control.append(node('option', { value: '', text: '请选择' }));
          property.enum.forEach((item, index) => control.append(node('option', { value: String(index), text: typeof item === 'string' ? item : json(item) })));
          const selected = property.enum.findIndex((item) => JSON.stringify(item) === JSON.stringify(value));
          control.value = selected >= 0 ? String(selected) : '';
        } else if (type === 'boolean' && !complex) {
          control = node('input', { id, type: 'checkbox', checked: value === true, 'data-schema-path': keyPath.join('.'), 'data-testid': `field-${keyPath.join('-')}` });
          wrapper.append(node('label', { class: 'check-row', for: id }, control, node('span', { text: title }, node('span', { class: 'schema-type', text: key }))));
        } else if (type === 'array' || type === 'object' || complex) {
          control = node('textarea', { id, class: 'code-input', rows: '4', spellcheck: 'false', 'data-schema-path': keyPath.join('.'), 'data-testid': `field-${keyPath.join('-')}` });
          control.value = value !== undefined ? json(value) : requiredField ? (type === 'array' ? '[]' : type === 'object' ? '{}' : '') : '';
          wrapper.append(label, control);
        } else {
          control = node('input', { id, type: type === 'number' || type === 'integer' ? 'number' : 'text', 'data-schema-path': keyPath.join('.'), 'data-testid': `field-${keyPath.join('-')}` });
          if (type === 'number' || type === 'integer') {
            control.step = type === 'integer' ? '1' : property.multipleOf || 'any';
            if (property.minimum !== undefined) control.min = property.minimum;
            if (property.maximum !== undefined) control.max = property.maximum;
          } else {
            if (property.minLength !== undefined) control.minLength = property.minLength;
            if (property.maxLength !== undefined) control.maxLength = property.maxLength;
          }
          control.value = value === undefined ? '' : String(value);
          wrapper.append(label, control);
        }
        if (control.tagName === 'SELECT') wrapper.append(label, control);
        if (type !== 'boolean') control.required = requiredField;
        bindings.push({ control, type, property, path: keyPath, complex });
      }
      if (property.description) wrapper.append(node('p', { class: 'field-help', text: property.description }));
      parent.append(wrapper);
    }
  }
  build(fields, schema, initial);
  container.replaceChildren(fields);
  if (!options.form) container.replaceChildren(form), form.append(fields);
  if (unsupportedRoot) fields.prepend(node('p', { class: 'field-help', text: '此 Schema 使用复杂结构或没有常规字段，请使用高级 JSON 输入。宿主会验证完整 Schema。' }));
  let advanced = options.advanced;
  let editor = options.editor;
  if (!advanced) {
    const editorId = `schema-json-${++fieldCounter}`;
    editor = node('textarea', { id: editorId, class: 'code-input', rows: '8', spellcheck: 'false', 'data-testid': 'config-json' });
    advanced = node('details', { class: 'advanced' }, node('summary', { text: '高级 JSON 配置' }), node('p', { class: 'field-help', text: '展开后以 JSON 为准。所有数据最终由宿主 Schema 验证。' }), node('label', { for: editorId, text: '插件配置 JSON' }), editor);
    form.append(advanced);
  }
  editor.value = json(initial ?? {});
  const validObject = (value) => {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('请输入一个 JSON 对象，而不是数组、null 或其他值。');
    return value;
  };
  function collect(validate = true, generatedOnly = false) {
    if (advanced.open && !generatedOnly) {
      try { return validObject(JSON.parse(editor.value)); } catch (error) { throw new Error(`JSON 输入无效：${error.message}`); }
    }
    if (validate && !form.reportValidity()) throw new Error('请完成必填字段并修正输入格式。');
    const output = {};
    for (const binding of bindings) {
      const { control, type, property, path, complex } = binding;
      let value;
      if (property.enum && !complex) { if (control.value === '') continue; value = property.enum[Number(control.value)]; }
      else if (type === 'boolean' && !complex) value = control.checked;
      else if (control.value === '') continue;
      else if (type === 'array' || type === 'object' || complex) {
        try { value = JSON.parse(control.value); } catch { throw new Error(`${path.join('.')} 必须是有效 JSON。`); }
      } else if (type === 'number' || type === 'integer') {
        value = Number(control.value);
        if (!Number.isFinite(value)) throw new Error(`${path.join('.')} 必须是有效数字。`);
      } else value = control.value;
      let target = output;
      for (const part of path.slice(0, -1)) {
        if (!Object.hasOwn(target, part)) Object.defineProperty(target, part, { value: {}, enumerable: true, configurable: true, writable: true });
        target = target[part];
      }
      Object.defineProperty(target, path.at(-1), { value, enumerable: true, configurable: true, writable: true });
    }
    return output;
  }
  let wasOpen = false;
  let editorChanged = false;
  let lastAutomaticJSON = editor.value;
  let prepared = false;
  const onEditorInput = () => { editorChanged = true; };
  const prepareAdvanced = () => {
    if (!advanced.open) {
      try { editor.value = json(collect(false, true)); lastAutomaticJSON = editor.value; editorChanged = false; } catch { /* Preserve valid advanced content if a complex field is incomplete. */ }
      prepared = true;
      bindings.forEach((binding) => { binding.control.disabled = true; });
    }
  };
  const summary = advanced.querySelector('summary');
  summary.addEventListener('click', prepareAdvanced);
  editor.addEventListener('input', onEditorInput);
  const toggle = () => {
    if (advanced.open && !wasOpen) {
      // Summary clicks prepare synchronously; programmatic opens must not clobber edited JSON.
      if (!prepared && !editorChanged && editor.value === lastAutomaticJSON) {
        try { editor.value = json(collect(false, true)); lastAutomaticJSON = editor.value; } catch { /* Preserve JSON if a complex field is incomplete. */ }
      }
      prepared = false;
    } else if (!advanced.open && wasOpen) {
      try {
        const values = validObject(JSON.parse(editor.value));
        for (const binding of bindings) {
          const value = binding.path.reduce((target, key) => target?.[key], values);
          if (binding.property.enum && !binding.complex) { const index = binding.property.enum.findIndex((item) => JSON.stringify(item) === JSON.stringify(value)); binding.control.value = index >= 0 ? String(index) : ''; }
          else if (binding.type === 'boolean' && !binding.complex) binding.control.checked = value === true;
          else binding.control.value = value === undefined ? '' : binding.type === 'array' || binding.type === 'object' || binding.complex ? json(value) : String(value);
        }
      } catch { advanced.open = true; notify('高级 JSON 尚未有效，已保留编辑模式。请修正后再切回表单。', 'warning'); }
    }
    wasOpen = advanced.open;
    for (const binding of bindings) binding.control.disabled = advanced.open;
    fields.hidden = advanced.open && Boolean(unsupportedRoot);
  };
  advanced.addEventListener('toggle', toggle);
  if (unsupportedRoot) {
    // Avoid replacing the provided initial value during automatic advanced-mode entry.
    wasOpen = true;
    advanced.open = true;
    bindings.forEach((binding) => { binding.control.disabled = true; });
    fields.hidden = true;
  }
  return { collect, form, advanced, editor, dispose: () => { advanced.removeEventListener('toggle', toggle); summary.removeEventListener('click', prepareAdvanced); editor.removeEventListener('input', onEditorInput); } };
}

function openDialog(title, content, confirmLabel, operation, { danger = false, eyebrow = 'LOCAL ACTION', disabled = false } = {}) {
  if (dialogBusy) return;
  if (!$('action-dialog').open) { dialogReturnFocus = document.activeElement; dialogFocusIdentity = focusIdentity(dialogReturnFocus); }
  text('dialog-title', title);
  text('dialog-eyebrow', eyebrow);
  $('dialog-content').replaceChildren(...(Array.isArray(content) ? content : [content]));
  $('dialog-confirm').className = `button ${danger ? 'danger' : 'primary'}`;
  $('dialog-confirm').disabled = disabled;
  text('dialog-confirm', confirmLabel);
  $('dialog-confirm').hidden = !operation;
  text('dialog-cancel', operation ? '取消' : '关闭');
  $('dialog-error').hidden = true;
  dialogOperation = operation;
  if (!$('action-dialog').open) $('action-dialog').showModal();
}
function closeDialog() {
  if (dialogBusy) return;
  $('action-dialog').close();
}
function checkConfirmation(label, testId = 'trust-confirm') {
  const input = node('input', { type: 'checkbox', id: `confirm-${++fieldCounter}`, 'data-testid': testId });
  const row = node('label', { class: 'check-row', for: input.id }, input, node('span', { text: label }));
  input.addEventListener('change', () => { $('dialog-confirm').disabled = !input.checked; });
  return { input, row };
}
function digestBox(items) {
  const list = node('dl');
  items.forEach(([key, value]) => list.append(node('dt', { text: key }), node('dd', { text: value })));
  return node('div', { class: 'digest-box' }, list);
}
function openInstall(path = '') {
  const form = node('form', { 'aria-label': '预检本地插件', 'data-testid': 'install-form' });
  const input = node('input', { id: 'install-path', value: path, required: true, autocomplete: 'off', placeholder: '/本机路径/my-plugin', 'data-testid': 'install-path' });
  form.append(node('p', { class: 'field-help', text: '指定宿主可访问的本地目录，包含 plugin.json 与 ESM 入口。这不是文件上传；不会访问在线市场。' }), node('label', { for: 'install-path', text: '插件本地目录' }), input);
  openDialog('先检查，再决定是否信任。', form, '预检目录', async () => {
    if (!form.reportValidity()) throw new Error('请填写插件本地目录。');
    const inspection = await request('/api/plugins/inspect', 'POST', { path: input.value.trim() });
    return { after: () => openInstallTrust(inspection) };
  }, { eyebrow: 'INSTALL / 01 · INSPECT' });
  form.addEventListener('submit', (event) => { event.preventDefault(); $('dialog-confirm').click(); });
  requestAnimationFrame(() => input.focus());
}
function openInstallTrust(inspection) {
  const manifest = inspection.manifest || {};
  const trusted = checkConfirmation('我已审查并信任这份插件代码，理解它不是在恶意代码安全沙箱内运行。');
  const content = [node('p', { text: manifest.description || '请核对插件身份和本地快照摘要。' }), digestBox([['插件', `${manifest.name || manifest.id} · ${manifest.id}`], ['版本', manifest.version], ['作者', manifest.author || '未提供'], ['目录', inspection.path], ['文件数', inspection.filesCount], ['SHA-256', inspection.digest]]), node('p', { class: 'field-help', text: `声明权限：${(manifest.permissions || []).join('、') || '无宿主能力权限'}。安装后默认禁用，运行前需要另行授权。` }), node('details', { class: 'advanced' }, node('summary', { text: '查看完整清单' }), node('pre', { text: json(manifest), tabindex: '0' })), trusted.row];
  openDialog(`安装 ${manifest.name || manifest.id}？`, content, '信任并安装', async () => {
    if (!trusted.input.checked) throw new Error('请先确认你已审查并信任插件代码。');
    await request('/api/plugins/install', 'POST', { path: inspection.path, digest: inspection.digest, trusted: true });
    return { message: '插件已安装，默认未启用。请配置后确认权限。' };
  }, { eyebrow: 'INSTALL / 02 · TRUST SNAPSHOT', disabled: true });
}
function openManifest(record) {
  openDialog(record.manifest?.name || '插件清单', [digestBox([['安装摘要', record.digest || '—'], ['安装时间', date(record.installedAt)], ['授权', (record.grants || []).join(', ') || '无']]), node('pre', { text: json(record.manifest), tabindex: '0' })], '', null, { eyebrow: 'MANIFEST / INSTALLED SNAPSHOT' });
}
function openConfig(record) {
  const container = node('div');
  const editor = schemaEditor(container, record.manifest?.configSchema || { type: 'object', properties: {} }, record.config || {}, { label: '插件配置' });
  const content = [node('p', { text: '保存任何配置更改会自动禁用插件并清除已授予权限。你需要重新授权才能运行。' }), container];
  openDialog(`配置 ${record.manifest?.name || record.manifest?.id}`, content, '保存配置', async () => {
    const config = editor.collect();
    await request(`/api/plugins/${encodeURIComponent(record.manifest.id)}/config`, 'PUT', { config });
    return { message: '配置已保存，插件已禁用。请重新启用并确认权限。' };
  }, { eyebrow: 'CONFIG / JSON SCHEMA' });
  editor.form.addEventListener('submit', (event) => { event.preventDefault(); $('dialog-confirm').click(); });
}
const permissionDescriptions = { 'workspace.read': '读取配置中明确授权的工作区目录', 'storage.read': '读取此插件隔离的本地持久化存储', 'storage.write': '写入此插件隔离的本地持久化存储' };
function openEnable(record) {
  const permissions = record.manifest?.permissions || [];
  const grants = node('div');
  for (const permission of permissions) grants.append(node('div', { class: 'digest-box' }, node('code', { text: permission }), node('p', { class: 'field-help', text: permissionDescriptions[permission] || '插件请求的宿主能力权限，请检查协议与源代码。' })));
  const agreed = checkConfirmation(permissions.length ? '我同意授予上述全部声明权限，并信任该插件运行。' : '我信任该插件代码，并同意启用。', 'grants-confirm');
  openDialog(`启用 ${record.manifest?.name || record.manifest?.id}`, [node('p', { text: '这些权限约束宿主能力代理，并不能限制插件直接访问操作系统。只启用已审查的可信代码。' }), grants, node('details', { class: 'advanced' }, node('summary', { text: '核对当前配置' }), node('pre', { text: json(record.config || {}), tabindex: '0' })), agreed.row], '授权并启用', async () => {
    if (!agreed.input.checked) throw new Error('请确认权限和信任范围。');
    await request(`/api/plugins/${encodeURIComponent(record.manifest.id)}/enable`, 'POST', { grants: permissions });
    return { message: '插件已启用，工具现在可用于运行台与 Agent。' };
  }, { eyebrow: 'PERMISSIONS / EXPLICIT GRANT', disabled: true });
}
function openDisable(record) {
  openDialog(`禁用 ${record.manifest?.name || record.manifest?.id}？`, node('p', { text: '插件工具将不再可用，正在运行的相关任务会被取消。代码、配置与存储会保留。' }), '禁用插件', async () => {
    await request(`/api/plugins/${encodeURIComponent(record.manifest.id)}/disable`, 'POST', {});
    return { message: '插件已禁用。' };
  });
}
function openUninstall(record) {
  const agree = checkConfirmation('确认删除该插件的代码快照、配置与所有插件存储。此操作不可撤销。', 'uninstall-confirm');
  openDialog(`卸载 ${record.manifest?.name || record.manifest?.id}？`, [node('p', { text: '这会删除本地安装记录与插件私有数据。原始插件目录不受影响；相关运行会被取消。' }), agree.row], '确认卸载', async () => {
    if (!agree.input.checked) throw new Error('请明确确认删除范围。');
    await request(`/api/plugins/${encodeURIComponent(record.manifest.id)}`, 'DELETE');
    return { message: '插件已卸载，其安装快照、配置与插件存储已删除。' };
  }, { danger: true, eyebrow: 'DESTRUCTIVE ACTION / UNINSTALL', disabled: true });
}

function setPage(next, updateHash = true) {
  if (!Object.hasOwn(pages, next)) next = 'plugins';
  page = next;
  Object.keys(pages).forEach((name) => { $(`page-${name}`).hidden = name !== next; });
  document.querySelectorAll('.nav-link').forEach((link) => { const active = link.dataset.page === next; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  text('breadcrumb-page', pages[next]);
  document.title = `${pages[next]} · LOOM`;
  if (updateHash && location.hash !== `#${next}`) location.hash = next;
  if (state) renderState();
}
function setMode(mode) {
  const agent = mode === 'agent';
  $('agent-pane').hidden = !agent;
  $('tool-pane').hidden = agent;
  ['agent', 'tool'].forEach((name) => { const selected = name === mode; $(`tab-${name}`).classList.toggle('active', selected); $(`tab-${name}`).setAttribute('aria-selected', String(selected)); $(`tab-${name}`).tabIndex = selected ? 0 : -1; });
}
function renderTools() {
  const tools = state.tools || [];
  const next = JSON.stringify(tools);
  if (next === toolSignature) return;
  toolSignature = next;
  const previous = $('tool-select').value;
  const options = tools.length ? tools.map((tool) => node('option', { value: tool.name, text: `${tool.name}${tool.mutates ? ' · 写入' : ''}` })) : [node('option', { value: '', text: '暂无可用工具，请先启用插件' })];
  $('tool-select').replaceChildren(...options);
  $('tool-select').value = tools.some((tool) => tool.name === previous) ? previous : tools[0]?.name || '';
  const selected = tools.find((tool) => tool.name === $('tool-select').value);
  if (JSON.stringify(selected) !== JSON.stringify(currentTool)) selectTool();
}
function selectTool() {
  const selected = (state?.tools || []).find((tool) => tool.name === $('tool-select').value);
  toolEditor?.dispose();
  currentTool = selected || null;
  text('tool-description', selected?.description || '先安装、配置并启用插件，工具才会出现在这里。');
  $('tool-mutates-warning').hidden = !selected?.mutates;
  if (selected) {
    $('tool-advanced').open = false;
    toolEditor = schemaEditor($('tool-fields'), selected.inputSchema || {}, {}, { form: $('tool-form'), advanced: $('tool-advanced'), editor: $('tool-json') });
  } else {
    $('tool-fields').replaceChildren(node('p', { class: 'field-help', text: '工具列表来自宿主，不包含预设或虚构工具。' }));
    $('tool-json').value = '{}';
    toolEditor = null;
  }
  updateControlStates();
}
async function startRun(path, payload) {
  pendingRunSubmission = true;
  setStatus($('execution-status'), 'running', '正在提交新任务');
  try {
    const response = await request(path, 'POST', payload);
    if (!response.run?.id) throw new APIError('宿主没有返回运行编号，请刷新状态查看是否已启动。', 'INVALID_RUN_RESPONSE', 0);
    await refresh(true);
    selectedRunId = response.run.id;
    if (state && !state.runs?.some((run) => run.id === response.run.id)) state.runs = [response.run, ...(state.runs || [])];
    lastExecutionSignature = '';
    return response;
  } finally {
    pendingRunSubmission = false;
    if (state) renderState();
    else setStatus($('execution-status'), 'neutral', '尚未运行');
  }
}
function confirmToolRun(tool, args, operation) {
  openDialog('确认这次本地写入', [node('p', { text: '此工具声明会修改本地数据。请核对工具与参数，只批准这一次调用。' }), node('code', { text: tool.name }), node('pre', { text: json(args), tabindex: '0' })], '确认并运行', async () => { await operation(); return { message: '工具运行已启动，执行详情将显示真实事件。' }; }, { eyebrow: 'WRITE TOOL / ONE-TIME CONSENT' });
}
function remoteModel(model) {
  try { return !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(model.baseUrl).hostname.toLowerCase()); } catch { return false; }
}
function currentRun() { return (state?.runs || []).find((run) => run.id === selectedRunId); }
function runErrorHelp(run) {
  if (run.status === 'cancelled') return '任务已取消，不会再批准新的调用。已经开始的写入可能已完成，请检查真实结果再决定是否重试。';
  if (run.error?.code === 'APPROVAL_DENIED') return '这一次写工具调用未获批准，不会执行该写入。后续调用仍需独立批准。';
  if (run.error?.code === 'AGENT_STEP_LIMIT' || run.error?.code === 'AGENT_CALL_LIMIT') return '已达到有界执行限制。请缩小任务范围，或在模型设置中调整有限的最大步数。';
  if (run.type === 'agent' && (run.error?.code?.startsWith('MODEL_') || ['EMPTY_MODEL_REPLY', 'INVALID_MODEL_URL', 'REMOTE_NOT_ALLOWED'].includes(run.error?.code))) return '模型未连通、认证失败或回复无效时不会生成替代回答。请在模型设置中测试连接，检查模型名称和宿主环境变量，再重试。';
  return '请核对插件是否启用、配置与工具输入是否符合 Schema，以及插件快照是否完整。Agent 调用的工具失败也会记录真实错误。';
}
function renderRunOptions() {
  const runs = state.runs || [];
  if (!selectedRunId || !runs.some((run) => run.id === selectedRunId)) selectedRunId = runs[0]?.id || '';
  const signature = JSON.stringify(runs.map((run) => [run.id, run.status]));
  if ($('run-select').dataset.signature !== signature) {
    $('run-select').dataset.signature = signature;
    $('run-select').replaceChildren(...(runs.length ? runs.map((run) => node('option', { value: run.id, text: `${run.type === 'agent' ? 'Agent' : run.toolName || '工具'} · ${statusLabels[run.status] || run.status} · ${run.id.slice(0, 8)}` })) : [node('option', { value: '', text: '暂无运行记录' })]));
    $('run-select').value = selectedRunId;
  }
}
function renderExecution() {
  if (pendingRunSubmission) { setStatus($('execution-status'), 'running', '正在提交新任务'); return; }
  const run = currentRun();
  $('execution-empty').hidden = Boolean(run);
  $('execution-content').hidden = !run;
  $('execution-meta').hidden = !run;
  $('cancel-run').hidden = !run || !activeStatuses.has(run.status);
  setStatus($('execution-status'), run?.status || 'neutral', run ? undefined : '尚未运行');
  if (!run) { $('approval-container').replaceChildren(); lastExecutionSignature = ''; lastApprovalSignature = ''; return; }
  text('execution-meta', `${run.type === 'agent' ? 'AGENT' : run.toolName || 'TOOL'} / ${run.id}\n${date(run.startedAt)}${run.endedAt ? ` → ${date(run.endedAt)}` : ''}`);
  const signature = JSON.stringify([run.id, run.events, run.result, run.error, run.status, run.prompt]);
  if (signature !== lastExecutionSignature) {
    lastExecutionSignature = signature;
    const list = $('event-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 55;
    const events = run.events || [];
    if (renderedEventRunId !== run.id) { list.replaceChildren(); renderedEventRunId = run.id; }
    if (events.length && list.firstElementChild?.classList.contains('event-placeholder')) list.replaceChildren();
    events.forEach((event, index) => {
      const eventSignature = JSON.stringify(event);
      const existing = list.children[index];
      if (existing?.dataset.signature === eventSignature) return;
      const details = node('div', {}, node('div', { class: 'event-type', text: event.type || 'info' }), node('p', { class: 'event-title', text: event.message || (event.type === 'approval' ? '等待一次写工具调用批准' : '宿主事件') }));
      if (event.data !== undefined) details.append(node('details', {}, node('summary', { class: 'field-help', text: '事件数据' }), node('pre', { text: json(event.data), tabindex: '0' })));
      const item = node('li', { class: 'event-item', 'data-type': event.type, 'data-signature': eventSignature }, node('time', { datetime: event.at, text: date(event.at, true) }), details);
      if (existing) { const expanded = existing.querySelector('details')?.open; existing.replaceWith(item); if (expanded && item.querySelector('details')) item.querySelector('details').open = true; }
      else list.append(item);
    });
    if (!events.length) {
      const placeholder = list.firstElementChild || node('li', { class: 'event-placeholder' });
      placeholder.textContent = activeStatuses.has(run.status) ? '任务已启动，等待宿主事件。' : '没有可恢复的事件。历史可能仅保留了摘要。';
      if (!placeholder.parentElement) list.append(placeholder);
    }
    if (nearBottom) list.scrollTop = list.scrollHeight;
    $('result-block').hidden = !Object.hasOwn(run, 'result');
    if (Object.hasOwn(run, 'result')) text('run-result', typeof run.result === 'string' ? run.result : json(run.result));
    $('run-error').hidden = !run.error;
    if (run.error) {
      text('run-error-code', run.error.code || '运行失败');
      text('run-error-message', run.error.message || '宿主报告运行失败。');
      text('run-error-help', runErrorHelp(run));
      $('retry-run').hidden = run.type === 'agent' ? !run.prompt : !run.toolName;
    }
    $('run-summary-note').hidden = Boolean(run.events || Object.hasOwn(run, 'result') || run.prompt) || activeStatuses.has(run.status);
  }
  renderApproval(run);
}
function renderApproval(run) {
  const approvalEvents = (run.events || []).filter((event) => event.type === 'approval' && event.data?.callId);
  // The newest approval event is the pending call; prior calls remain in the trace for audit.
  const pending = run.status === 'awaiting_approval' ? approvalEvents.at(-1)?.data : null;
  const key = pending ? `${run.id}:${pending.callId}` : '';
  const signature = `${key}:${submittedApprovals.has(key)}`;
  if (signature === lastApprovalSignature) return;
  lastApprovalSignature = signature;
  if (!pending) { $('approval-container').replaceChildren(); return; }
  if (submittedApprovals.has(key)) { $('approval-container').replaceChildren(node('div', { class: 'notice compact', text: '批准决定已发送，等待宿主继续执行。' })); return; }
  const card = node('section', { class: 'approval-card', 'aria-label': '待批准的写入操作', 'data-testid': `approval-${pending.callId}` }, node('div', { class: 'eyebrow', text: 'APPROVAL / ONE CALL ONLY' }), node('h3', { text: '需要你的决定：一次写入调用' }), node('p', { text: '批准只对本次调用有效。拒绝不会执行这次写入。' }), node('code', { text: pending.name }), node('pre', { text: json(pending.args), tabindex: '0' }));
  const controls = node('div', { class: 'approval-actions' });
  async function decide(approved, clicked) {
    if (busyActions.has(`approve-${key}`)) return;
    const others = [...controls.querySelectorAll('button')];
    others.forEach((control) => { control.disabled = true; });
    await action(`approve-${key}`, clicked, async () => {
      await request(`/api/runs/${encodeURIComponent(run.id)}/approve`, 'POST', { callId: pending.callId, approved });
      submittedApprovals.add(key);
      lastApprovalSignature = '';
      return true;
    }, approved ? '本次调用已批准。后续写入仍需逐次批准。' : '本次调用已拒绝。');
    others.forEach((control) => { control.disabled = false; });
  }
  const approve = button('批准这一次', () => decide(true, approve), 'primary small', 'approve-call');
  const reject = button('拒绝', () => decide(false, reject), 'small danger-outline', 'reject-call');
  controls.append(approve, reject);
  card.append(controls);
  $('approval-container').replaceChildren(card);
}
function renderHistory() {
  const runs = state.runs || [];
  text('history-count', runs.length);
  const signature = JSON.stringify(runs.map((run) => [run.id, run.type, run.toolName, run.status, run.startedAt, run.endedAt]));
  if (signature === historySignature) return;
  historySignature = signature;
  if (!runs.length) replacePreservingFocus($('history-list'), empty('还没有运行记录', '从运行台发起一个真实工具或 Agent 任务，运行摘要将出现在这里。', '前往运行台', () => setPage('run'), 'history-empty'));
  else replacePreservingFocus($('history-list'), ...runs.map((run) => node('article', { class: 'history-row', 'data-testid': `history-${run.id}` }, node('div', {}, node('h3', { class: 'history-name', text: run.type === 'agent' ? 'Agent 指令运行' : run.toolName || '工具运行' }), node('p', { class: 'history-id', text: run.id })), pill(run.status), node('time', { class: 'history-time', datetime: run.startedAt, text: date(run.startedAt) }), button('查看详情', () => { selectedRunId = run.id; lastExecutionSignature = ''; $('run-select').dataset.signature = ''; setPage('run'); }, 'small', `view-run-${run.id}`))));
}
function readModelForm() {
  return { provider: $('model-provider').value, baseUrl: $('model-base-url').value.trim(), model: $('model-name').value.trim(), maxSteps: Number($('model-max-steps').value), allowRemote: $('model-allow-remote').checked };
}
function renderModel() {
  const model = state.model || {};
  text('run-model-summary', `${model.provider === 'openai' ? 'OpenAI 兼容' : 'Ollama'} / ${model.model || '未配置模型'}`);
  $('agent-remote-warning').hidden = !remoteModel(model);
  text('model-key-status', model.apiKeyConfigured ? '环境变量状态：已配置（只显示状态，不显示密钥）' : '环境变量状态：未配置。Ollama 本地模式通常无需密钥。');
  if (!modelHydrated || (!modelDirty && !busyActions.has('model-save') && !$('model-form').contains(document.activeElement))) {
    $('model-provider').value = model.provider || 'ollama';
    $('model-base-url').value = model.baseUrl || 'http://127.0.0.1:11434';
    $('model-name').value = model.model || '';
    $('model-max-steps').value = model.maxSteps ?? 6;
    $('model-allow-remote').checked = Boolean(model.allowRemote);
    modelHydrated = true;
  }
  $('remote-notice').hidden = !remoteModel(readModelForm());
  $('model-dirty-note').hidden = !modelDirty;
}
function updateControlStates() {
  const connected = Boolean(state) && $('connection-error').hidden;
  if (!busyActions.has('tool-run')) $('tool-submit').disabled = !connected || !currentTool;
  if (!busyActions.has('agent-run')) $('agent-submit').disabled = !connected;
  if (!busyActions.has('model-save')) $('model-save').disabled = !connected;
  if (!busyActions.has('model-test')) $('model-test').disabled = !connected;
  const active = (state?.runs || []).some((run) => activeStatuses.has(run.status));
  $('clear-history').disabled = !connected || active || !(state?.runs || []).length;
  $('history-active-note').hidden = !active;
  if (!busyActions.has('cancel-run')) $('cancel-run').disabled = !connected;
  $('install-open').disabled = !connected;
}

$('install-open').addEventListener('click', () => openInstall());
$('retry-connection').addEventListener('click', () => action('reconnect', $('retry-connection'), async () => { token = null; await getSession(); const result = await refresh(); if (!result) throw new Error($('connection-error-text').textContent); }));
$('dismiss-notification').addEventListener('click', () => { $('notification').hidden = true; retryNotification = null; });
$('notification-retry').addEventListener('click', () => { const retry = retryNotification; $('notification').hidden = true; retry?.(); });
$('dialog-close').addEventListener('click', closeDialog);
$('dialog-cancel').addEventListener('click', closeDialog);
$('action-dialog').addEventListener('cancel', (event) => { if (dialogBusy) event.preventDefault(); });
$('action-dialog').addEventListener('close', () => { dialogOperation = null; restoreFocus(dialogFocusIdentity, dialogReturnFocus); });
$('dialog-confirm').addEventListener('click', async () => {
  if (dialogBusy || !dialogOperation) return;
  const operation = dialogOperation;
  const oldLabel = $('dialog-confirm').textContent;
  dialogBusy = true;
  $('dialog-error').hidden = true;
  ['dialog-confirm', 'dialog-cancel', 'dialog-close'].forEach((id) => { $(id).disabled = true; });
  text('dialog-confirm', '请求中…');
  $('dialog-confirm').setAttribute('aria-busy', 'true');
  let outcome;
  try {
    outcome = await operation();
  } catch (error) {
    text('dialog-error', `${errorText(error)} 你可以修正输入或再次点击确认重试。`);
    $('dialog-error').hidden = false;
  } finally {
    dialogBusy = false;
    ['dialog-confirm', 'dialog-cancel', 'dialog-close'].forEach((id) => { $(id).disabled = false; });
    $('dialog-confirm').removeAttribute('aria-busy');
    text('dialog-confirm', oldLabel);
  }
  if (outcome) {
    if (outcome.after) outcome.after();
    else { closeDialog(); if (outcome.message) notify(outcome.message); await refresh(true); }
  }
});
window.addEventListener('hashchange', () => setPage(location.hash.slice(1), false));
$('tab-agent').addEventListener('click', () => setMode('agent'));
$('tab-tool').addEventListener('click', () => setMode('tool'));
for (const mode of ['agent', 'tool']) $(`tab-${mode}`).addEventListener('keydown', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'agent' : event.key === 'End' ? 'tool' : mode === 'agent' ? 'tool' : 'agent'; setMode(next); $(`tab-${next}`).focus(); }
});
$('tool-select').addEventListener('change', selectTool);
$('tool-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!currentTool || !toolEditor) return;
  let args;
  try { args = toolEditor.collect(); } catch (error) { notify(errorText(error), 'error'); return; }
  const tool = currentTool;
  const operation = () => startRun('/api/tools/run', { name: tool.name, args });
  if (tool.mutates) confirmToolRun(tool, args, operation);
  else action('tool-run', $('tool-submit'), operation, '工具运行已启动。');
});
$('agent-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = $('agent-prompt').value.trim();
  if (!prompt) { $('agent-prompt').setCustomValidity('请输入真实 Agent 指令。'); $('agent-prompt').reportValidity(); return; }
  const operation = () => startRun('/api/agent/run', { prompt });
  if (remoteModel(state?.model || {})) {
    if (!state.model.allowRemote) { notify('当前模型地址是远程端点，但未允许数据外发。请先在模型设置中明确授权。', 'error'); return; }
    openDialog('确认向远程模型发送这次任务？', node('p', { text: `这次指令、工具描述与工具返回内容可能发送至 ${state.model.baseUrl}。只在接受此数据边界时继续。` }), '确认外发并运行', async () => { await operation(); return { message: 'Agent 运行已启动，每次写入仍需批准。' }; }, { eyebrow: 'REMOTE MODEL / DATA CONSENT' });
  } else action('agent-run', $('agent-submit'), operation, 'Agent 运行已启动，正在请求真实模型。');
});
$('agent-prompt').addEventListener('input', () => $('agent-prompt').setCustomValidity(''));
$('run-select').addEventListener('change', () => { selectedRunId = $('run-select').value; lastExecutionSignature = ''; lastApprovalSignature = ''; renderExecution(); });
$('cancel-run').addEventListener('click', () => {
  const run = currentRun();
  if (!run || !activeStatuses.has(run.status)) return;
  action('cancel-run', $('cancel-run'), () => request(`/api/runs/${encodeURIComponent(run.id)}/cancel`, 'POST', {}), '已发送运行取消请求。');
});
$('retry-run').addEventListener('click', () => {
  const run = currentRun();
  if (!run) return;
  if (run.type === 'agent' && run.prompt) { $('agent-prompt').value = run.prompt; setMode('agent'); $('agent-form').requestSubmit(); }
  else {
    const original = (run.events || []).find((event) => event.data?.args && (event.data?.name === run.toolName || event.type === 'tool_start'));
    const tool = (state.tools || []).find((item) => item.name === run.toolName);
    if (!tool) { notify('该工具当前未启用，请先在插件页检查配置和授权。', 'error'); return; }
    $('tool-select').value = tool.name; selectTool(); setMode('tool');
    if (original) { $('tool-advanced').open = true; toolEditor.editor.value = json(original.data.args); }
    notify('已恢复工具选择。请核对或重新填写参数后运行；历史摘要可能没有保留原始输入。', 'warning');
    $('tool-select').focus();
  }
});
$('copy-result').addEventListener('click', () => action('copy-result', $('copy-result'), async () => {
  if (!navigator.clipboard?.writeText) throw new Error('此浏览器不支持自动复制，请选中结果文本手动复制。');
  await navigator.clipboard.writeText($('run-result').textContent);
}, '结果已复制。'));
$('clear-history').addEventListener('click', () => {
  openDialog('清空所有运行历史？', node('p', { text: '会删除磁盘运行摘要与当前内存中的输入、事件和结果。此操作不可撤销；有活动任务时宿主会拒绝清空。' }), '确认清空', async () => {
    await request('/api/runs', 'DELETE'); selectedRunId = ''; submittedApprovals.clear(); return { message: '运行历史与内存结果已清空。' };
  }, { danger: true, eyebrow: 'DESTRUCTIVE ACTION / RUN ARCHIVE' });
});
$('model-form').addEventListener('input', () => { modelDirty = true; $('model-test-result').hidden = true; $('model-dirty-note').hidden = false; $('remote-notice').hidden = !remoteModel(readModelForm()); });
$('model-form').addEventListener('change', () => { modelDirty = true; $('model-dirty-note').hidden = false; $('remote-notice').hidden = !remoteModel(readModelForm()); });
$('model-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!$('model-form').reportValidity()) return;
  const config = readModelForm();
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型服务地址仅支持 HTTP 或 HTTPS。');
    if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含密钥、账号密码、查询参数或 URL 片段。密钥只通过宿主环境变量设置。');
    if (remoteModel(config) && url.protocol !== 'https:') throw new Error('远程模型必须使用 HTTPS。');
    if (remoteModel(config) && config.provider === 'ollama') throw new Error('Ollama 仅支持本机回环地址；远程模型请使用 OpenAI 兼容协议。');
    if (!config.model) throw new Error('请填写模型名称。');
    if (remoteModel(config) && !config.allowRemote) throw new Error('此服务地址可能外发数据，请先明确勾选“允许模型数据外发”，或改用本机回环地址。');
  } catch (error) { notify(errorText(error), 'error'); return; }
  const save = async () => { await request('/api/model', 'PUT', config); modelDirty = false; return true; };
  if (config.allowRemote) {
    const agree = checkConfirmation('我理解指令、工具描述和返回内容可能发送到模型服务商，并同意允许数据外发。', 'remote-confirm');
    openDialog('允许模型数据外发？', [node('p', { text: `模型端点：${config.baseUrl}。启用后 Agent 会真实请求此服务，不会自动过滤工具输出中的敏感内容。` }), agree.row], '确认并保存', async () => { if (!agree.input.checked) throw new Error('请明确确认数据外发。'); await save(); return { message: '模型设置已保存，已明确允许模型数据外发。' }; }, { disabled: true, eyebrow: 'REMOTE MODEL / DATA BOUNDARY' });
  } else action('model-save', $('model-save'), save, '模型设置已保存。可以测试真实连接。');
});
$('model-test').addEventListener('click', () => action('model-test', $('model-test'), async () => {
  $('model-test-result').hidden = true;
  try {
    const result = await request('/api/model/test', 'POST', {}, true, 60000);
    $('model-test-result').className = 'notice compact';
    $('model-test-result').textContent = result.message || '真实连接检查成功。';
    $('model-test-result').hidden = false;
    return result;
  } catch (error) {
    $('model-test-result').className = 'notice danger compact';
    $('model-test-result').textContent = `${errorText(error)} 请确认模型服务已启动、模型名称正确；兼容 API 的密钥由 HARNESS_MODEL_API_KEY 提供。`;
    $('model-test-result').hidden = false;
    throw error;
  }
}));

setPage(location.hash.slice(1) || 'plugins', false);
updateControlStates();
refresh();
// A single in-flight poll at a time. Forms and dialogs are never rebuilt by polling.
setInterval(() => { if (!document.hidden) refresh(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
