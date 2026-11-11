import { randomUUID } from 'node:crypto';

const STORAGE_KEY = 'notes';
const MAX_STORED_NOTES = 1000;
const MAX_NOTES_BYTES = 96 * 1024;
const NOTE_FIELDS = ['uuid', 'date', 'title', 'content', 'notebook', 'tags'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} 必须是对象`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_INPUT', `${label} 含未声明字段`);
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail('INVALID_INPUT', `${label} 必须是 1–${max} 字符的非空文本`);
  }
  return value;
}

function integer(value, label, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail('INVALID_INPUT', `${label} 必须是 1–${max} 的整数`);
  return value;
}

function tags(value) {
  if (!Array.isArray(value) || value.length > 12) fail('INVALID_INPUT', 'tags 必须是最多 12 项的数组');
  const result = value.map((tag) => text(tag, 'tag', 40).trim());
  if (new Set(result).size !== result.length) fail('INVALID_INPUT', 'tags 去除首尾空白后不能重复');
  return result;
}

async function loadNotes(ctx) {
  const value = await ctx.call('storage.get', { key: STORAGE_KEY });
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_STORED_NOTES) {
    fail('STORAGE_CORRUPT', 'notes 存储不是有效的有界笔记数组；未覆盖原数据');
  }
  const seen = new Set();
  try {
    for (const note of value) {
      object(note, NOTE_FIELDS, '存储笔记');
      if (typeof note.uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(note.uuid) || seen.has(note.uuid)) {
        fail('INVALID_INPUT', '笔记 UUID 无效或重复');
      }
      seen.add(note.uuid);
      if (typeof note.date !== 'string' || note.date.length !== 24 || !Number.isFinite(Date.parse(note.date)) || new Date(note.date).toISOString() !== note.date) {
        fail('INVALID_INPUT', '笔记日期无效');
      }
      text(note.title, 'title', 160);
      text(note.content, 'content', 8000);
      text(note.notebook, 'notebook', 80);
      tags(note.tags);
    }
  } catch {
    fail('STORAGE_CORRUPT', 'notes 包含格式无效的笔记；未覆盖原数据');
  }
  return value;
}

export default async function execute({ tool, args = {}, config = {} }, ctx) {
  object(config, ['notebook', 'maxNotes'], 'config');
  const notebook = text(config.notebook === undefined ? 'Inbox' : config.notebook, 'notebook', 80).trim();
  const maxNotes = integer(config.maxNotes === undefined ? 200 : config.maxNotes, 'maxNotes', MAX_STORED_NOTES);
  const fields = { add: ['title', 'content', 'tags'], search: ['query', 'limit'], list: ['limit'] };
  if (!Object.hasOwn(fields, tool)) fail('UNKNOWN_TOOL', '笔记插件不支持此工具');
  object(args, fields[tool], 'args');

  if (tool === 'add') {
    // 所有输入先校验，再读取/写入持久化存储。
    const title = text(args.title, 'title', 160).trim();
    const content = text(args.content, 'content', 8000);
    const noteTags = tags(args.tags === undefined ? [] : args.tags);
    const notes = await loadNotes(ctx);
    if (notes.length >= maxNotes) fail('NOTES_FULL', `笔记已达到总上限 ${maxNotes}，未删除或覆盖已有笔记`);
    const note = { uuid: randomUUID(), date: new Date().toISOString(), title, content, notebook, tags: noteTags };
    const stored = [...notes, note];
    if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > MAX_NOTES_BYTES) {
      fail('STORAGE_LIMIT', '笔记 JSON 超过 96 KiB 安全传输预算，未写入；请缩短正文或备份后整理笔记');
    }
    const result = await ctx.call('storage.set', { key: STORAGE_KEY, value: stored });
    if (!result || result.ok !== true) fail('BROKER_RESPONSE_INVALID', 'storage.set 未确认写入成功');
    return { note, total: stored.length };
  }

  const limit = integer(args.limit === undefined ? 20 : args.limit, 'limit', 50);
  const query = tool === 'search' ? text(args.query, 'query', 200).trim() : undefined;
  const notes = await loadNotes(ctx);
  const needle = query?.toLowerCase();
  const selected = notes.filter((note) => note.notebook === notebook && (
    tool === 'list' || [note.title, note.content, ...note.tags].some((part) => part.toLowerCase().includes(needle))
  )).reverse();
  // 每项内容最多 8000 字符，单次最多 50 项；不返回其他笔记本的数据。
  const result = { notebook, notes: selected.slice(0, limit), total: selected.length, truncated: selected.length > limit };
  if (tool === 'search') result.query = query;
  return result;
}
