//! plyfold-probe: 各 CLI の ACP 対応状況を調べる検証用 CLI

mod bench;
mod codebench;
mod config;
mod conn;
mod handler;
mod keys;
mod scenario;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use clap::{Parser, Subcommand};

use config::Config;
use handler::Policy;
use scenario::Opts;

#[derive(Parser)]
#[command(name = "plyfold-probe", about = "各 CLI の ACP 対応状況を調べる検証用 CLI")]
struct Cli {
    /// 設定ファイル
    #[arg(long, global = true, default_value = "probe.toml")]
    config: PathBuf,
    /// 作業ディレクトリ（既定: probe-runs/workspace）
    #[arg(long, global = true)]
    cwd: Option<PathBuf>,
    /// session/new の前に authenticate する認証方法の id
    #[arg(long, global = true)]
    auth: Option<String>,
    /// session/new の後に切り替えるモード（caps の「モード」の id）
    #[arg(long, global = true)]
    mode: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 設定済みのエージェントとプロファイルを表示
    List,
    /// initialize と session/new の結果から、対応機能を表示（トークンは使わない）
    Caps {
        /// プロファイル名かエージェント名
        target: String,
    },
    /// プロンプトを 1 回送り、ストリーム・権限確認・差分・中断を記録
    Run {
        target: String,
        /// 送るプロンプト（--session だけなら開き直しの確認のみ）
        #[arg(long)]
        prompt: Option<String>,
        /// 権限確認への応じ方
        #[arg(long, value_enum, default_value_t = Policy::Ask)]
        permission: Policy,
        /// 指定秒数後に session/cancel を送る（Ctrl-C でも送る）
        #[arg(long)]
        cancel_after: Option<u64>,
        /// 既存セッションを session/load か session/resume で開き直す
        #[arg(long)]
        session: Option<String>,
    },
    /// 複数のプロファイルで同時にプロンプトを送る（キーの分離の確認）
    Parallel {
        targets: Vec<String>,
        #[arg(long)]
        prompt: String,
        #[arg(long, value_enum, default_value_t = Policy::Reject)]
        permission: Policy,
    },
    /// 軽いベンチマーク（トークナイザーの指紋・答えが決まった問題・速さ）を同時に実行
    Bench {
        targets: Vec<String>,
        /// 問題のセットを何回分やるか（1 回 = 4 問）
        #[arg(long, default_value_t = 2)]
        trials: u64,
    },
    /// コーディングのベンチマーク（Rust の小さな課題 4 つ。隠しテストで採点）
    Codebench {
        targets: Vec<String>,
        /// 実行はせず、codebench-*.json の作業フォルダを採点し直す
        #[arg(long)]
        regrade: Option<PathBuf>,
    },
    /// 全エージェントの caps を集めて probe-runs/matrix.md に書き出す
    Matrix { targets: Vec<String> },
    /// キーチェーンの API キーを管理
    Keys {
        #[command(subcommand)]
        cmd: KeysCmd,
    },
}

#[derive(Subcommand)]
enum KeysCmd {
    /// 登録（値は対話入力）
    Set { profile: String, var: String },
    /// 削除
    Delete { profile: String, var: String },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    if let Cmd::Keys { cmd } = &cli.cmd {
        return match cmd {
            KeysCmd::Set { profile, var } => keys::set(profile, var),
            KeysCmd::Delete { profile, var } => keys::delete(profile, var),
        };
    }

    let cfg = Config::load(&cli.config)?;
    let opts = Opts {
        root: scenario::root_of(&cli.config),
        policy: Policy::Ask,
        quiet: false,
        cwd: cli.cwd.clone(),
        auth: cli.auth.clone(),
        mode: cli.mode.clone(),
    };

    match cli.cmd {
        Cmd::List => {
            println!("エージェント:");
            for (id, a) in &cfg.agents {
                println!("  {id:10} {} {}", a.command, a.args.join(" "));
            }
            println!("プロファイル:");
            for (name, p) in &cfg.profiles {
                let keys: Vec<_> = p.keys.iter().map(|(k, v)| format!("{k}←{v}")).collect();
                println!(
                    "  {name:16} agent={} isolate={} {}",
                    p.agent,
                    p.isolate,
                    keys.join(" ")
                );
            }
        }
        Cmd::Caps { target } => {
            scenario::caps(&cfg, &target, &opts).await?;
        }
        Cmd::Run { target, prompt, permission, cancel_after, session } => {
            if prompt.is_none() && session.is_none() {
                anyhow::bail!("--prompt か --session のどちらかを指定してください");
            }
            let opts = Opts { policy: permission, ..opts };
            let s = scenario::run(&cfg, &target, &opts, prompt, cancel_after, session).await?;
            if s.error.is_some() {
                std::process::exit(1);
            }
        }
        Cmd::Parallel { targets, prompt, permission } => {
            let opts = Opts { policy: permission, ..opts };
            scenario::parallel(Arc::new(cfg), targets, opts, prompt).await?;
        }
        Cmd::Bench { targets, trials } => {
            let opts = Opts { policy: Policy::Reject, ..opts };
            let path = bench::bench(Arc::new(cfg), targets, opts, trials).await?;
            eprintln!("書き出し: {}", path.display());
        }
        Cmd::Codebench { targets, regrade } => {
            let path = match regrade {
                Some(json) => codebench::regrade(&json).await?,
                None => codebench::codebench(Arc::new(cfg), targets, opts).await?,
            };
            eprintln!("書き出し: {}", path.display());
        }
        Cmd::Matrix { targets } => {
            let path = scenario::matrix(&cfg, targets, &opts).await?;
            eprintln!("書き出し: {}", path.display());
        }
        Cmd::Keys { .. } => unreachable!(),
    }
    Ok(())
}
