# CLIのクラス・インターフェース概説

現時点のMVPは、2つのクラスと、CLI処理を担う関数、将来の外部連携に向けたインターフェースで構成されています。この文書は現在の実装と拡張予定を区別して説明します。

## ファイル構成

| ファイル | 責務 |
|---|---|
| `src/cli.ts` | 実行入口。依存を組み立て、引数と出力先を`run()`に渡し、終了コードを設定する |
| `src/app.ts` | コマンドの入力検証と振り分け |
| `src/gate.ts` | 前工程の承認を確認するための契約と共通判定 |
| `src/init.ts` | ローカル初期化の契約と下書き生成 |
| `src/ports.ts` | worktree・Spec Kit・PR連携に向けた契約とデータ型 |
| `tests/cli.test.mjs` | 入力検証、Gate条件、フェーズ対応、実行入口の基本テスト |

## クラス図と依存関係

### 現在の実装

`CliEntry`と`CommandFunctions`は説明用の表記です。実際にはクラスではなく、それぞれ`cli.ts`のトップレベル処理と`app.ts`の関数です。`StubApprovalReader`も名前付きクラスではなく、実行入口で作成している仮のオブジェクトを表します。

```mermaid
classDiagram
    direction LR
    class CliEntry {
        <<module>>
    }
    class CommandFunctions {
        <<module>>
        parseCommand(args) Command
        run(args, gate, output) Promise~number~
    }
    class Initializer {
        <<interface>>
        initialize(root, mode) Promise
    }
    class LocalInitializer {
        initialize(root, mode) Promise
    }
    class WorkflowGate {
        <<interface>>
        check(phase, featureId) Promise~GateResult~
    }
    class ReviewMergeGate {
        -ApprovalReader approvals
        check(phase, featureId) Promise~GateResult~
    }
    class ApprovalReader {
        <<interface>>
        read(phase, featureId) Promise
    }
    class StubApprovalReader {
        <<object>>
        read() Promise
    }
    class ApprovalEvidence {
        <<interface>>
        phase
        featureId
        reviewed
        merged
        baseBranch
        mergeCommitOnMain
        artifactsPresent
        artifactsMatchApproved
    }
    class GateResult {
        <<type>>
    }
    class Output {
        <<interface>>
        out(message) void
        error(message) void
    }
    CliEntry ..> LocalInitializer : creates and injects
    CommandFunctions ..> Initializer : calls initialize
    LocalInitializer ..|> Initializer : implements
    CliEntry ..> CommandFunctions : calls run
    CliEntry ..> ReviewMergeGate : creates
    CliEntry ..> StubApprovalReader : creates and injects
    CommandFunctions ..> WorkflowGate : calls check
    CommandFunctions ..> Output : writes
    ReviewMergeGate ..|> WorkflowGate : implements
    ReviewMergeGate --> ApprovalReader : constructor injection
    StubApprovalReader ..|> ApprovalReader : structurally satisfies
    ApprovalReader ..> ApprovalEvidence : returns optional evidence
    ReviewMergeGate ..> ApprovalEvidence : validates
    WorkflowGate ..> GateResult : returns
    ReviewMergeGate ..> GateResult : returns
```

点線矢印`..>`は利用、実線矢印`-->`は保持する参照、三角の矢印`..|>`はインターフェースの実装を表します。`ApprovalReader.read()`の正確な戻り値は`Promise<ApprovalEvidence | undefined>`です。

`run()`は`ReviewMergeGate`を直接生成せず、`WorkflowGate`を受け取ります。`ReviewMergeGate`も具体的なGitHubクライアントではなく`ApprovalReader`を受け取ります。この2か所で依存を注入し、テスト時に差し替えられます。具体的な実装を選んで接続する責務は`cli.ts`に置いています。

### 外部連携の契約（定義済み・未接続）

以下は現在存在するインターフェース間の型の依存です。ワークフローからこれらを呼ぶ実装はまだありません。

```mermaid
classDiagram
    direction LR
    class WorkspaceManager {
        <<interface>>
        createFromMain(featureId, phase) Promise
    }
    class WorkflowPhase {
        <<type>>
    }
    class SpecKitAdapter {
        <<interface>>
        constitution(context) Promise~void~
        specify(featureId, workspace) Promise~void~
        design(featureId, workspace) Promise
        implement(featureId, workspace) Promise~void~
    }
    class ProjectContext {
        <<interface>>
        root string
        mode ProjectMode
    }
    class ProjectMode {
        <<type>>
    }
    class DesignProposal {
        <<interface>>
        title string
        rank number
        rationale string
        tradeoffs string[]
    }
    class PullRequestPublisher {
        <<interface>>
        createDraft(input) Promise
    }
    WorkspaceManager ..> WorkflowPhase : phase argument
    SpecKitAdapter ..> ProjectContext : constitution argument
    ProjectContext ..> ProjectMode : mode field
    SpecKitAdapter ..> DesignProposal : design returns list
    PullRequestPublisher ..> DesignProposal : optional input list
```

### 拡張時に守る依存の向き

- コマンド処理と今後のWorkflow Runnerはインターフェースに依存し、GitHub・Git・AIの具体的な実装は実行入口で接続する。
- Gateは承認の判定に限定する。worktree作成やPR公開はRunnerが各契約を通じて実行し、Gateから呼び出さない。
- 外部連携アダプターからコマンド処理やRunnerを呼び戻さない。実行順序と失敗時の扱いはRunnerに集約する。
- 承認を確認したmainと、worktreeの作成元を同じコミットに揃える設計が必要。現在の契約にはそのコミットを引き渡す項目がないため、実接続時に拡張する。

現在は`app.ts`が`ProjectMode`を`ports.ts`から、`ports.ts`が`WorkflowPhase`を`gate.ts`から型として参照しています。共有型が増えた場合は、外部連携やCLIに依存しない共通の型ファイルへの切り出しを検討します。現段階で新しい抽象クラスやRunnerを実装したわけではありません。

## クラスとインターフェース

### LocalInitializer（実装済みのクラス）

`Initializer.initialize(root, mode)`を実装し、ルート直下の既知マニフェストと既存Constitutionの有無を確認して、`.dev-assistant/init`にローカル下書きを作成します。既存出力は上書きしません。AI生成・Spec Kit連携・Git操作・承認は担当しません。

`Initializer`と`InitResult`も`src/init.ts`で定義しています。`run()`は任意の第4引数として`{ initializer, root }`を受け取り、CLI入口では`LocalInitializer`と`process.cwd()`を渡します。注入されていない場合は従来の未実装表示と終了コード2を維持します。

### ReviewMergeGate（実装済みのクラス）

`WorkflowGate`を実装し、次のフェーズを開始できるか判定します。コンストラクターで`ApprovalReader`を受け取るため、承認情報の取得方法を判定ロジックから分離できます。

`check(phase, featureId?)`は以下を確認し、許可または停止理由を返します。

1. Design・ImplementationにはFeature IDがあること。
2. 前工程の承認情報が存在し、フェーズとFeatureが一致すること。
3. レビュー済みかつmainへマージ済みであること。
4. マージコミットが現在のmainの履歴に含まれること。
5. 必要な成果物が存在し、承認済み内容と一致すること。

取得失敗や情報不足では停止します。Gate自体はGitHub/Gitを直接操作せず、渡された証拠を判定します。worktree作成、ファイル生成、PR作成も担当しません。

### WorkflowGate（インターフェース）

`check(phase: WorkflowPhase, featureId?: string): Promise<GateResult>`を定義します。CLIはこの契約に依存し、具体的な判定クラスの詳細には依存しません。

### ApprovalReader（インターフェース）

`read(phase: ArtifactPhase, featureId?: string)`で前工程の承認情報を取得します。戻り値は`ApprovalEvidence`または`undefined`です。

現在の実行入口では、常に`undefined`を返す仮実装を接続しています。GitHub/Gitを確認する実アダプターは未実装です。将来は、ユーザーが編集した承認フラグではなく、実際のレビュー・マージ・成果物から証拠を取得します。

### WorkspaceManager（契約のみ）

`createFromMain(featureId, phase)`でmainを基点に作業用worktreeとブランチを用意し、そのパスとブランチ名を返すための境界です。実装・呼び出しはまだありません。

現在の`phase`型はSpecification・Design・Implementationのみです。Constitution作成のための作業領域は、init実装時に契約を拡張するか、別の入口を設ける必要があります。

### SpecKitAdapter（契約のみ）

エージェントを通じてSpec Kitへ処理をつなぐ境界です。

| メソッド | 想定する処理 | 戻り値 |
|---|---|---|
| `constitution(context)` | プロジェクト固有の開発原則を生成 | `Promise<void>` |
| `specify(featureId, workspace)` | Featureの仕様を生成 | `Promise<void>` |
| `design(featureId, workspace)` | 設計案を生成 | `Promise<DesignProposal[]>` |
| `implement(featureId, workspace)` | 設計に基づく実装 | `Promise<void>` |

いずれも実装・呼び出しはまだありません。Spec KitのエージェントスキルをOSコマンドとして直接実行する構成ではありません。

### PullRequestPublisher（契約のみ）

`createDraft()`でブランチ、タイトル、本文、任意の設計案を受け取り、Draft PRの番号とURLを返す境界です。実装・呼び出しはまだありません。レビューやマージの操作はこの契約に含まれません。

## 主なデータ型

| 型 | 内容 |
|---|---|
| `WorkflowPhase` | `specification`・`design`・`implementation` |
| `ArtifactPhase` | 承認対象となる`constitution`・`specification`・`design` |
| `GateResult` | `{ allowed: true }`または`{ allowed: false; reason: string }` |
| `ApprovalEvidence` | 対象フェーズ/Feature、レビュー・マージ・main上の成果物に関する判定情報 |
| `ProjectMode` | `greenfield`または`brownfield` |
| `ProjectContext` | プロジェクトのルートパスとモード |
| `DesignProposal` | 案の名前、推奨順位、判断根拠、トレードオフ。順位の制約や検証は未実装 |
| `Command` | 検証済みのコマンドとオプション |
| `Output` | 通常出力とエラー出力の関数 |

## 関数と実行入口

`parseCommand()`は引数を検証し、`Command`を返します。不明なコマンド、必須オプションの不足、不正なmodeやFeature ID、余分な引数は例外になります。

`run()`は入力を解析し、helpならヘルプを表示します。initはGateを実行せず、注入されたInitializerでローカル下書きを作成します。それ以外はGateを実行し、許可された場合のみ後続の位置へ進みます。spec/design/implementのワークフロー本体は未実装なので、許可後も終了コード2で停止します。

`cli.ts`は`ReviewMergeGate`と仮の`ApprovalReader`を組み立て、ローカル初期化の依存も渡し、`run()`の戻り値をプロセスの終了コードに設定します。

## 現在の処理フロー

```mermaid
flowchart TD
    A[cli.ts] --> B[run]
    B --> C[parseCommand]
    C --> D{コマンド}
    D -->|help| E[ヘルプ表示・終了コード0]
    D -->|init| F[LocalInitializerで下書き生成・終了コード0]
    D -->|spec / design / implement| G[ReviewMergeGate.check]
    G --> H[ApprovalReader.read]
    H --> I{承認条件を満たすか}
    I -->|いいえ / 取得失敗| J[理由表示・終了コード1]
    I -->|はい| K[Gate通過表示・未実装・終了コード2]
    C -->|入力エラー| J
```

実行入口の仮Readerは承認情報を返さないため、通常のCLIからspec・design・implementを実行するとGateで停止します。Gate通過はテスト用Readerで検証しています。

## フェーズと前工程の対応

| コマンド | Gateのフェーズ | 承認対象 | 範囲 |
|---|---|---|---|
| `dev init --mode greenfield\|brownfield` | Gateなし | なし | プロジェクト |
| `dev spec --feature <id>` | `specification` | `constitution` | プロジェクト共通。ReaderにはFeature IDを渡さない |
| `dev design --feature <id>` | `design` | `specification` | 対象Feature |
| `dev implement --feature <id>` | `implementation` | `design` | 対象Feature |

## 今後の拡張

実ワークフローでは、Gate通過後にworktree作成、承認済みコンテキストの読み込み、Spec Kit実行、検証、Draft PR提示を順に接続する予定です。これを統括するWorkflow Runnerはまだ実装していません。

Designでは複数案・推奨順位・判断根拠・トレードオフをPRに提示できるようにします。initではローカル検出と下書き生成を実装済みです。今後、目的・制約の入力とAI/Spec Kit連携を追加します。既存ファイルの保護、途中失敗からの復旧、再実行時の扱いは各実装時に具体化します。
