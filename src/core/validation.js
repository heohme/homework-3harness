import Ajv from 'ajv';

export class HarnessError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.status = status;
  }
}

export function fail(code, message, status = 400) {
  throw new HarnessError(code, message, status);
}

export function errorInfo(error) {
  return { code: error.code || 'INTERNAL_ERROR', message: error instanceof HarnessError ? error.message : '操作失败，请检查本地文件、配置或插件实现。' };
}

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false, addUsedSchema: false });
export function validate(schema, value, label = '输入') {
  let check;
  try { check = ajv.compile(schema); }
  catch { fail('INVALID_SCHEMA', `${label}的 JSON Schema 无效或包含未支持的引用。`); }
  if (!check(value)) {
    const detail = check.errors.slice(0, 3).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ');
    fail('VALIDATION_ERROR', `${label}不符合协议：${detail}`);
  }
  return value;
}

export function object(value, label = '输入') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('VALIDATION_ERROR', `${label}必须是 JSON 对象。`);
  return value;
}

export function jsonSize(value, max = 131072) {
  let text;
  try { text = JSON.stringify(value); }
  catch { fail('INVALID_RESULT', '数据必须可以序列化为 JSON。'); }
  if (text === undefined || Buffer.byteLength(text) > max) fail('SIZE_LIMIT', '数据超过大小限制，或不是有效 JSON 值。');
  return text;
}
