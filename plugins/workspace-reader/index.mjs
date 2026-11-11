// 独立插件：不直接访问文件系统，不导入宿主模块。
const MAX_FILES = 100;
const MAX_ERRORS = 8;
const MAX_SNIPPET = 512;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', `${label} 必须是对象`);
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail('INVALID_INPUT', `${label} 含未声明字段`);
  }
}

function string(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail('INVALID_INPUT', `${label} 必须是 1–${max} 字符的非空文本`);
  }
  return value;
}

function integer(value, label, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    fail('INVALID_INPUT', `${label} 必须是 1–${max} 的整数`);
  }
  return value;
}

function relativePath(value) {
  const path = string(value, 'path', 1024);
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
    fail('INVALID_INPUT', 'path 必须是授权根目录内的相对路径，不允许 ..');
  }
  return path;
}

async function listFiles(ctx, path) {
  const result = await ctx.call('workspace.list', { path });
  if (!result || !Array.isArray(result.files) || typeof result.truncated !== 'boolean') {
    fail('BROKER_RESPONSE_INVALID', 'workspace.list 返回格式无效');
  }
  const files = result.files.slice(0, MAX_FILES).map((file) => {
    if (!file || typeof file.path !== 'string' || !Number.isFinite(file.size) || file.size < 0) {
      fail('BROKER_RESPONSE_INVALID', 'workspace.list 文件条目无效');
    }
    return { path: relativePath(file.path), size: file.size };
  });
  return { files, truncated: result.truncated || result.files.length > MAX_FILES };
}

async function readFile(ctx, path) {
  const result = await ctx.call('workspace.read', { path });
  if (!result || typeof result.path !== 'string' || typeof result.content !== 'string' || typeof result.truncated !== 'boolean') {
    fail('BROKER_RESPONSE_INVALID', 'workspace.read 返回格式无效');
  }
  return { path: relativePath(result.path), content: result.content, truncated: result.truncated };
}

export default async function execute({ tool, args = {}, config = {} }, ctx) {
  object(config, ['root', 'maxResults'], 'config');
  string(config.root === undefined ? './examples/workspace' : config.root, 'root', 1024);
  const maxResults = integer(config.maxResults === undefined ? 8 : config.maxResults, 'maxResults', 100);
  const fields = { list: ['path', 'limit'], read: ['path'], search: ['query', 'path', 'limit', 'caseSensitive'] };
  if (!Object.hasOwn(fields, tool)) fail('UNKNOWN_TOOL', '工作区插件不支持此工具');
  object(args, fields[tool], 'args');
  const path = relativePath(args.path === undefined ? (tool === 'read' ? '' : '.') : args.path);

  if (tool === 'read') return readFile(ctx, path);
  const limit = Math.min(integer(args.limit === undefined ? maxResults : args.limit, 'limit', 100), maxResults);
  if (tool === 'list') {
    const result = await listFiles(ctx, path);
    return { path, files: result.files.slice(0, limit), truncated: result.truncated || result.files.length > limit };
  }

  const query = string(args.query, 'query', 200).trim();
  const caseSensitive = args.caseSensitive === undefined ? false : args.caseSensitive;
  if (typeof caseSensitive !== 'boolean') fail('INVALID_INPUT', 'caseSensitive 必须是布尔值');
  const needle = caseSensitive ? query : query.toLowerCase();
  const listing = await listFiles(ctx, path);
  const matches = [];
  const errors = [];
  let scannedFiles = 0;
  let errorCount = 0;
  let truncated = listing.truncated;

  for (const file of listing.files) {
    let result;
    try {
      result = await readFile(ctx, file.path);
    } catch (error) {
      if (['PERMISSION_DENIED', 'CANCELLED', 'PLUGIN_TIMEOUT', 'RPC_LIMIT', 'OUTPUT_LIMIT', 'SIZE_LIMIT'].includes(error?.code)) {
        throw error;
      }
      errorCount += 1;
      if (errors.length < MAX_ERRORS) {
        errors.push({
          path: file.path,
          code: String(error?.code ?? 'READ_FAILED').slice(0, 80),
          message: String(error?.message ?? '文件读取失败').replace(/[\r\n]/g, ' ').slice(0, 240)
        });
      }
      continue;
    }
    scannedFiles += 1;
    truncated ||= result.truncated;
    const lines = result.content.split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const hit = (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
      if (hit < 0) continue;
      // 多观察一个命中，才能准确标记结果数量截断。
      if (matches.length === limit) {
        return { query, path, matches, scannedFiles, truncated: true, errorCount, errors };
      }
      const start = Math.max(0, hit - 100);
      matches.push({
        path: result.path,
        line: index + 1,
        text: line.slice(start, start + MAX_SNIPPET),
        textTruncated: start > 0 || line.length > start + MAX_SNIPPET
      });
    }
  }
  return { query, path, matches, scannedFiles, truncated, errorCount, errors };
}
