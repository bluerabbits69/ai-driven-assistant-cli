# AI-driven Assistant CLI

Spec Kit連携によるAI駆動開発CLIのTypeScript MVP。公開コマンド名は `dev`。

## 開発・実行

Node.js 20以上とnpmを使用します。

```sh
npm ci
npm run build
npm test
npm run typecheck
npm run dev -- --help
npm run dev -- init --mode greenfield
npm run dev -- init --mode brownfield
npm run dev -- spec --feature 001-reservation
npm run dev -- design --feature 001-reservation
npm run dev -- implement --feature 001-reservation
```

ビルド後は `node dist/cli.js ...` でも実行できます。npmパッケージのbinを有効化した環境では `dev ...` を使用します。

## MVPの範囲

入力検証、4コマンド、共通Workflow Gate、外部連携の型、ローカルinitを実装しています。

`init`は実行先のカレントディレクトリに次の未承認成果物を作成します。

- `.dev-assistant/init/constitution.draft.md`: プロジェクト名・モード・開発原則候補・目的/制約のTODO。
- `.dev-assistant/init/context.md`: 検出結果と次の作業。
- `.dev-assistant/init/state.json`: スキーマバージョン、モード、検出情報、`draft`状態。承認情報ではありません。

brownfieldはルート直下の既知マニフェストから技術候補を検出します。ソース分析は行いません。greenfieldは採用技術を自動決定しません。package.jsonは名前取得のため最大1 MiBまで読み込み、不正なJSONでは出力前に停止します。マニフェストのシンボリックリンクは検出対象外です。

既存の`.specify/memory/constitution.md`は変更しません。出力先が存在すれば、再実行・同時実行は上書きせず停止します。`.dev-assistant`のシンボリックリンクは拒否します。書き込み失敗時は今回作成したinitディレクトリを削除します（削除に失敗した場合は残存内容を確認してください）。

**AI生成、Spec Kit実行、worktree操作、PR作成は未実装です。** ローカル生成の成功は、プロジェクト初期化全体の承認完了を意味しません。ほかのフェーズは承認情報取得アダプターが未接続のためGateで停止します。
終了コード: 0 = ヘルプ/ローカルinit成功、1 = 入力・初期化エラー/Gate停止、2 = 未接続ワークフロー。

新しいプロジェクトから試す例（CLI本体は事前にビルドしてください）:

```sh
mkdir my-new-project
cd my-new-project
node /Users/yasukawashun/my-project/technology-hub/projects/ai-proj/ai-driven-assistant-cli/dist/cli.js init --mode greenfield
```

## 構成と責務

- `src/cli.ts`: 実行入口と依存の組み立て。
- `src/app.ts`: 引数検証とコマンド骨組み。Gateをワークフロー開始前に実行。
- `src/gate.ts`: 読み取り専用のWorkflowGate/ApprovalReaderと判定ロジック。
- `src/init.ts`: ローカル初期化の契約とLocalInitializer。
- `src/ports.ts`: WorkspaceManager、SpecKitAdapter、PullRequestPublisher、設計案の拡張境界。
- `tests/cli.test.mjs`: フェーズ対応、入力検証、Gate停止条件、実行入口のテスト。

## 合意したワークフロー

| コマンド | 次フェーズを許可するための承認対象 |
|---|---|
| `dev init --mode greenfield\|brownfield` | 前提フェーズなし。プロジェクトごとのConstitutionを作成してPR提示 |
| `dev spec --feature <id>` | プロジェクトConstitutionのレビューとmainへのマージ |
| `dev design --feature <id>` | 対象Featureの仕様PRのレビューとmainへのマージ |
| `dev implement --feature <id>` | 対象Featureの設計PRのレビューとmainへのマージ |

Gateは対象フェーズ/Featureの一致、レビュー、マージ先main、マージコミットのmain履歴への包含、成果物の存在と承認内容との一致を要求します。取得失敗や情報不足は停止します。GitHub/Gitからの検証済み証拠の取得は後続実装です。

## 次の実装単位

1. GitHub/Git読み取りアダプター: FeatureとPRの共有可能な対応情報、レビュー方針、mainの最新状態、成果物の照合を実装する。
2. WorkspaceManager: Gate通過後にmainからworktreeを作成。既存作業を上書きせず、失敗時の復旧と再実行を設計する。
3. 初期化の拡張: ローカル下書きに目的/制約の入力とAIによる既存コード分析を追加し、Spec Kit ConstitutionとPR工程へつなぐ。
4. Spec Kit/AIアダプター: 承認済みコンテキストを読み込み、仕様・設計・実装を段階的に実行する。
5. Design: 複数案と推奨順位、判断根拠、トレードオフをDraft PRに提示する。選定後のplan/tasksと整合性確認を含める。
6. Implementation: 実装・検証・修正・セルフレビュー後にDraft PRを提示する。マージは人間に委ねる。

[Spec Kit公式](https://github.com/github/spec-kit)のエージェントスキル呼び出しと、セットアップ用の`specify` CLIは別の境界として扱います。スキル名をOSコマンドとして直接実行しません。連携バージョンとエージェントごとの呼び出し形式は実アダプター導入時に固定します。

## 設計ドキュメント

- [クラス・インターフェース概説](docs/architecture.md)
