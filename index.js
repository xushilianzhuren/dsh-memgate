/**
 * 记忆门 · 插件（Host 侧，零依赖，无构建）
 *
 * 管"答前先搜"：检索先行、记忆三域、写入回仓。
 *
 * 为什么原生实现：这族两个主力件都坏了——统一搜索器.py 直接报"rg不可用"，
 * 记忆全域查.py 静默空转，且两者都把根写死 <workspace>。包壳＝把空转搬进提示，
 * 所以这里直接调系统 ripgrep，搜不到时退回 Node 内扫四文件（保底可用）。
 *
 * @module dsh-memgate
 */

import { existsSync } from 'node:fs'
import { readFile, stat, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ql-memory'

export const inject = ['systemPrompt', 'tools']

const SECTION_NAME = 'ql:memory'

const DEFAULTS = Object.freeze({ order: 110, tool: true, enabled: true })

const FOUR = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md']

function normalizeConfig(config) {
  const raw = config ?? {}
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('ql-memory: config.enabled must be a boolean')
  }
  if (raw.tool !== undefined && typeof raw.tool !== 'boolean') {
    throw new Error('ql-memory: config.tool must be a boolean')
  }
  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) {
    throw new Error('ql-memory: config.order must be a finite number')
  }
  if (raw.root !== undefined && (typeof raw.root !== 'string' || raw.root.trim() === '')) {
    throw new Error('ql-memory: config.root must be a non-empty path string')
  }
  return {
    order: raw.order ?? DEFAULTS.order,
    tool: raw.tool ?? DEFAULTS.tool,
    root: raw.root === undefined ? undefined : raw.root.trim(),
    enabled: raw.enabled ?? DEFAULTS.enabled,
  }
}

function isWorkspace(dir) {
  try {
    return existsSync(join(dir, 'AGENTS.md'))
      && existsSync(join(dir, 'scripts'))
      && (existsSync(join(dir, 'SOUL.md')) || existsSync(join(dir, 'USER.md')))
  } catch {
    return false
  }
}

function findRoot(configured) {
  const candidates = []
  if (configured !== undefined) candidates.push(configured)
  try {
    candidates.push(dirname(dirname(fileURLToPath(import.meta.url))))
  } catch {
    /* 非文件装法 */
  }
  let dir = process.cwd()
  for (let hop = 0; hop < 6; hop += 1) {
    candidates.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  candidates.push('~//Smart Agentharness')
  for (const candidate of candidates) {
    if (isWorkspace(candidate)) return candidate
  }
  return candidates[0]
}

function run(cmd, args, cwd, timeoutMs = 30000) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : String(error?.message ?? ''),
      })
    })
  })
}

function clip(text, limit) {
  const flat = String(text).replace(/\s+\n/g, '\n').trim()
  return flat.length > limit ? flat.slice(0, limit) + '\n…[已截断]' : flat
}

/** 检索面：四文件、脚本、台账、报告各多少件。 */
async function surface(root) {
  const lines = ['【检索面】']
  for (const name of FOUR) {
    try {
      const size = (await stat(join(root, name))).size
      lines.push(`  ${name}：${size} B`)
    } catch {
      lines.push(`  ${name}：缺件`)
    }
  }
  let scriptCount = 0
  try {
    const dirs = [join(root, 'scripts')]
    while (dirs.length > 0) {
      const dir = dirs.pop()
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!['__pycache__', '.git', 'node_modules'].includes(entry.name)) dirs.push(join(dir, entry.name))
        } else if (entry.name.endsWith('.py')) {
          scriptCount += 1
        }
      }
    }
  } catch {
    scriptCount = -1
  }
  let reportCount = 0
  try {
    reportCount = (await readdir(join(root, 'scripts', '裁撤归置'))).length
  } catch {
    reportCount = -1
  }
  let ledgerCount = 0
  try {
    ledgerCount = (await readdir(join(root, 'scripts'))).filter(name => name.endsWith('.jsonl')).length
  } catch {
    ledgerCount = -1
  }
  lines.push(`  scripts 下 .py：${scriptCount < 0 ? '读不出' : scriptCount} 件`)
  lines.push(`  裁撤归置 文档：${reportCount < 0 ? '读不出' : reportCount} 件`)
  lines.push(`  scripts 下台账 .jsonl：${ledgerCount < 0 ? '读不出' : ledgerCount} 本`)
  return lines.join('\n')
}

/** rg 直搜；rg 不在就退回 Node 内扫四文件。 */
async function search(root, query, scope) {
  const scopes = {
    全部: { paths: ['.'], globs: [] },
    四文件: { paths: FOUR, globs: [] },
    脚本: { paths: ['scripts'], globs: ['*.py', '*.js', '*.mjs'] },
    台账: { paths: ['scripts'], globs: ['*.jsonl', '*.json', '*.md'] },
    报告: { paths: ['scripts/裁撤归置'], globs: [] },
  }
  const target = scopes[scope] ?? scopes['全部']
  // 注意：--glob 必须在 "--" 之前；放到路径之后就变成"要搜的文件名"了（这里踩过一次）。
  const args = ['-n', '--no-heading', '-C', '1', '--max-count', '200']
  for (const glob of target.globs) args.push('--glob', glob)
  args.push('--', query, ...target.paths)
  const result = await run('rg', args, root, 30000)
  if (result.ok || result.code === 1) {
    const lines = result.stdout.split('\n')
    const kept = lines.filter(line => line.trim() !== '').slice(0, 60)
    if (kept.length === 0) {
      return `【检索「${query}」·范围 ${scope}】零命中。\n注意：零命中≠不存在——可能是词形不同；换词再搜或明标"未检索到"。`
    }
    const total = lines.filter(line => line.trim() !== '').length
    return [`【检索「${query}」·范围 ${scope}】命中 ${total} 行（示前 ${kept.length}）：`, ...kept.map(line => clip(line, 180))].join('\n')
  }
  // rg 不可用：退回四文件内扫
  const out = [`【检索「${query}」·rg 不可用·退回四文件内扫】`]
  let hits = 0
  for (const name of FOUR) {
    try {
      const text = await readFile(join(root, name), 'utf8')
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(query)) {
          hits += 1
          if (hits <= 30) out.push(`  ${name}:${i + 1}: ${clip(lines[i], 160)}`)
        }
      }
    } catch {
      /* 缺件跳过 */
    }
  }
  if (hits === 0) {
    out.push('  零命中（仅扫了四文件，脚本与台账未扫——明标"未检索全"）')
  } else {
    out.splice(1, 0, `  命中 ${hits} 行（仅四文件·示前 30）：`)
  }
  return out.join('\n')
}

/** 五源扇出：四文件／脚本／台账／报告／名册各取命中数与前几条。 */
async function fanout(root, query) {
  const specs = [
    ['四文件', FOUR, []],
    ['脚本', ['scripts'], ['--glob', '*.py']],
    ['台账', ['scripts'], ['--glob', '*.jsonl']],
    ['报告', ['scripts/裁撤归置'], []],
    ['名册', ['scripts/能力注册表.jsonl'], []],
  ]
  const lines = [`【五源扇出「${query}」】`]
  for (const [label, paths, globs] of specs) {
    const args = ['-n', '--no-heading', '--max-count', '20']
    for (const glob of globs) args.push('--glob', glob)
    args.push('--', query, ...paths)
    const result = await run('rg', args, root, 30000)
    const rows = result.stdout.split('\n').filter(line => line.trim() !== '')
    lines.push(`${label}：命中 ${rows.length}${rows.length >= 20 ? '+' : ''}`)
    for (const row of rows.slice(0, 2)) lines.push(`   · ${clip(row, 120)}`)
  }
  return lines.join('\n')
}

function renderSection() {
  return [
    '## 记忆门令 · 常驻（答前先搜，搜完再说话）',
    '',
    '**"以为记得"≠"查过"**。任何事实、条款、路径、读数的断言，第一动作是检索；'
      + '查不到就明标"未检索到"，禁拿记忆当证据。',
    '',
    '**一、检索先行三条**（会话开工先跑 ql_memory 五源扇出：四文件／脚本／台账／报告／名册）',
    '①凡涉及宪法条款、历史踩坑、既有铸件的回答，先搜再答（工具有 ql_memory，直接调 rg）；',
    '②零命中要说"零命中≠不存在"——可能是词形不同，换词再搜或说明只扫了哪些面；',
    '③死区条款（注入页看不到的部分）一律回溯磁盘原文，禁凭注入残页背书。',
    '',
    '**二、记忆三域（找东西先去对的那一域）**',
    '· 宪法记忆：四文件（AGENTS/SOUL/USER/IDENTITY）——规矩、身份、主人偏好；',
    '· 经历记忆：scripts 下的台账（issue log/固化账/名册/事件台账）——发生过什么；',
    '· 派生记忆：裁撤归置里的报告与扫描件——算出来的结论（可重算，别当原生事实）。',
    '',
    '**三、写入回仓（不落账＝下个会话重来）**',
    '重要结论三选一：落条款（宪法）／落台账（经历）／落报告（派生）。'
      + '只留在对话里＝会话一死全死。',
    '',
    '**四、记忆的诚实**',
    '过期读数按过期处理（标注日期与复验命令）；旧结论与现况冲突时以实测为准，'
      + '并回写一条"旧读数已过期"的说明——记忆会腐烂，腐烂要留痕。',
    '',
    '**判据**：本轮若有事实性断言，自问"这条我是搜来的，还是想当然的"——答"想当然"＝不合格。',
  ].join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('ql-memory：主开关关着，未挂载')
    return
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: cfg.order,
    text: () => renderSection(),
  }), 'ql-memory.section()')

  if (cfg.tool) {
    ctx.effect(() => ctx.tools.register({
      name: 'ql_memory',
      description: '记忆门检索：按范围（全部／四文件／脚本／台账／报告）全文检索工作区，返回命中行与行号；'
        + '另有检索面盘点（四文件体量、脚本数、台账数、报告数）。原生调 rg，不依赖已死的旧检索脚本。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['检索', '检索面', '五源扇出'],
            description: '要执行的动作。',
          },
          query: { type: 'string', description: '检索关键词（action=检索 时必填）。' },
          scope: {
            type: 'string',
            enum: ['全部', '四文件', '脚本', '台账', '报告'],
            description: '检索范围，默认全部。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { report: { type: 'string' } },
          required: ['report'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: async (args) => {
        const root = findRoot(cfg.root)
        const action = typeof args?.action === 'string' ? args.action : '检索'
        const query = typeof args?.query === 'string' ? args.query : ''
        const scope = typeof args?.scope === 'string' ? args.scope : '全部'
        try {
          if (action === '检索面') return { report: await surface(root) }
          if (action === '五源扇出') {
            if (query.trim() === '') return { report: '五源扇出需要 query（关键词）。' }
            return { report: await fanout(root, query) }
          }
          if (query.trim() === '') return { report: '检索需要 query（关键词）。' }
          return { report: await search(root, query, scope) }
        } catch (error) {
          return { report: `记忆门内部错：${clip(error?.message ?? error, 200)}` }
        }
      },
    }), 'ql-memory.tool()')
  }

  ctx.logger?.info?.('ql-memory：区块 %s 已注册（order=%d）', SECTION_NAME, cfg.order)
}
