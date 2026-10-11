import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ProjectMode } from './ports.js';

// C0/C1 controls except tab/LF/CR, DEL, Unicode line separators and bidi controls that can hide text.
const unsafeCharacters = '\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069';
export interface ProjectInput { purpose?: string; constraints?: string[]; }
export function validateProjectInput(input: ProjectInput): { purpose?: string; constraints: string[] } {
  function value(text: string, label: string): string {
    const trimmed = text.trim();
    if (!trimmed) throw new Error(`${label} must not be empty.`);
    // Check the raw value so unsafe characters are rejected rather than silently trimmed.
    if (new RegExp(`[${unsafeCharacters}]`).test(text)) {
      throw new Error(`${label} must not contain control or bidirectional formatting characters.`);
    }
    // Count code points, not UTF-16 units, so emoji and other astral characters count as one.
    if ([...trimmed].length > 4000) throw new Error(`${label} must be at most 4000 characters.`);
    return trimmed;
  }
  return {
    ...(input.purpose !== undefined ? { purpose: value(input.purpose, 'Purpose') } : {}),
    constraints: (input.constraints ?? []).map(item => value(item, 'Constraint')),
  };
}
/** Display-only rendering for any value, including untrusted manifest data that cannot be rejected. */
function markdown(value: string): string {
  return value.replace(new RegExp(`[${unsafeCharacters}\\r\\n]+`, 'g'), ' ').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#!|~@]/g, '\\$&')
    // Defuse GFM autolinks and leading list markers, which single-symbol escaping does not cover.
    .replace(/:(?=\/\/)/g, '\\:').replace(/\b(www)\./gi, '$1\\.')
    .replace(/^(\s*)(\d+)\./, '$1$2\\.').replace(/^(\s*)([-+])/, '$1\\$2');
}
export interface InitResult { directory: string; }
export interface Initializer {
  initialize(root: string, mode: ProjectMode, input?: ProjectInput): Promise<InitResult>;
}
const markers: Record<string, string> = {
  'package.json': 'JavaScript/TypeScript', 'go.mod': 'Go', 'Gemfile': 'Ruby',
  'pubspec.yaml': 'Dart/Flutter', 'Package.swift': 'Swift',
  'build.gradle': 'JVM/Android', 'build.gradle.kts': 'Kotlin/JVM/Android',
  'Cargo.toml': 'Rust', 'pyproject.toml': 'Python',
};
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}

/** Local drafts only. Does not grant approval or write Spec Kit's Constitution. */
export class LocalInitializer implements Initializer {
  async initialize(root: string, mode: ProjectMode, input: ProjectInput = {}): Promise<InitResult> {
    const projectInput = validateProjectInput(input);
    const projectRoot = resolve(root);
    const entries = await readdir(projectRoot, { withFileTypes: true });
    const manifests = entries.filter(entry => entry.isFile() && Object.hasOwn(markers, entry.name));
    const existingConstitution = await exists(join(projectRoot, '.specify/memory/constitution.md'));
    let name = basename(projectRoot);
    const packageEntry = manifests.find(entry => entry.name === 'package.json');
    if (mode === 'brownfield' && packageEntry) {
      const path = join(projectRoot, packageEntry.name);
      const info = await lstat(path);
      if (info.size > 1024 * 1024) throw new Error('package.json exceeds the 1 MiB inspection limit.');
      const content = await readFile(path, 'utf8');
      let data: unknown;
      try { data = JSON.parse(content); } catch (error) {
        throw new Error(`package.json is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`, { cause: error });
      }
      if (typeof data === 'object' && data !== null && 'name' in data && typeof data.name === 'string') name = data.name;
    }
    const technologies = mode === 'brownfield' ? manifests.map(entry => markers[entry.name]!) : [];
    const state = {
      schemaVersion: 2, input: projectInput, status: 'draft', mode, projectName: name,
      detectedManifests: manifests.map(entry => entry.name), technologies,
      existingConstitution,
    };
    const draft = `# ${markdown(name)} Constitution — 未承認の下書き\n\n` +
      `この文書はローカル初期化で作成したテンプレートです。AI生成・承認済み成果物ではありません。\n\n` +
      `## プロジェクト情報\n\n- モード: ${mode}\n- 目的: ${projectInput.purpose ? markdown(projectInput.purpose) : 'TODO — 解決する課題と利用者を記入'}\n` +
      `- 技術: ${technologies.length ? technologies.join(', ') : 'TODO — 採用技術を記入'}\n\n` +
      `## プロジェクト固有の制約\n\n${projectInput.constraints.length ? projectInput.constraints.map(item => `- ${markdown(item)}`).join('\n') : 'TODO — 技術・運用・互換性の制約を記入'}\n\n` +
      `## 開発原則（レビュー候補）\n\n` +
      `1. 仕様・設計をレビューし、mainへのマージ後に次フェーズを開始する。\n` +
      `2. 既存のコード・設定・ユーザーデータを保護し、変更の影響を説明する。\n` +
      `3. 変更に応じたテスト・ビルド・静的検査を実施し、結果をPRに記載する。\n` +
      `4. 秘密情報を成果物やログに含めない。\n` +
      `5. TODO — 品質・運用・セキュリティのプロジェクト固有要件を記入する。\n\n` +
      (mode === 'brownfield' ? `## 既存システム\n\nTODO — 現行の振る舞い、互換性、移行・ロールバック条件を確認する。\n\n` : '') +
      `## 承認\n\n未承認。目的・制約・原則を具体化し、レビュー用PRで合意する。\n`;
    const context = `# 初期化コンテキスト\n\n` +
      `- プロジェクト: ${markdown(name)}\n- モード: ${mode}\n` +
      `- ルート直下の技術マニフェスト: ${manifests.map(entry => entry.name).join(', ') || 'なし'}\n` +
      `- 既存のSpec Kit Constitution: ${existingConstitution ? 'あり（変更しない）' : 'なし'}\n\n` +
      `これはルート直下の限定的な検出です。ソースコード・依存関係の詳細分析は行っていません。\n` +
      `greenfieldでは既存マニフェストを参考情報に留め、採用技術を自動決定しません。\n\n` +
      `## 入力された目的・制約\n\n- 目的: ${projectInput.purpose ? markdown(projectInput.purpose) : '未入力'}\n${projectInput.constraints.length ? projectInput.constraints.map(item => `- 制約: ${markdown(item)}`).join('\n') : '- 制約: 未入力'}\n\n` +
      `## 次の作業\n\n1. ConstitutionのTODOを記入してレビューする。\n` +
      `2. 既存Constitutionがある場合は、それを基準に下書きを比較する。\n` +
      `3. 後続のSpec Kit・worktree・Draft PR連携で承認工程へ進む。\n\n` +
      `このローカル下書きはWorkflow Gateの承認証拠にはなりません。\n`;
    const parent = join(projectRoot, '.dev-assistant');
    try { await mkdir(parent); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('.dev-assistant must be a real directory, not a symlink.');
    const directory = join(parent, 'init');
    // Exclusive ownership: repeat/concurrent runs must not overwrite a draft.
    try { await mkdir(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Initialization draft already exists at .dev-assistant/init; existing files were preserved.');
      throw error;
    }
    try {
      await writeFile(join(directory, 'constitution.draft.md'), draft, { flag: 'wx' });
      await writeFile(join(directory, 'context.md'), context, { flag: 'wx' });
      await writeFile(join(directory, 'state.json'), JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { directory };
  }
}
