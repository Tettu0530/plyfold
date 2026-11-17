//! plyfold-probe: test CLI that checks how well each agent CLI supports ACP

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
#[command(name = "plyfold-probe", about = "Checks how well each agent CLI supports ACP")]
struct Cli {
    /// Config file
    #[arg(long, global = true, default_value = "probe.toml")]
    config: PathBuf,
    /// Working directory (default: probe-runs/workspace)
    #[arg(long, global = true)]
    cwd: Option<PathBuf>,
    /// Id of the auth method to authenticate with before session/new
    #[arg(long, global = true)]
    auth: Option<String>,
    /// Mode to switch to after session/new (an id from the "modes" line of caps)
    #[arg(long, global = true)]
    mode: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show configured agents and profiles
    List,
    /// Show supported features from initialize and session/new (spends no tokens)
    Caps {
        /// Profile name or agent name
        target: String,
    },
    /// Send one prompt and record streaming, permission requests, diffs and cancellation
    Run {
        target: String,
        /// Prompt to send (with only --session, just checks reopening)
        #[arg(long)]
        prompt: Option<String>,
        /// How to answer permission requests
        #[arg(long, value_enum, default_value_t = Policy::Ask)]
        permission: Policy,
        /// Send session/cancel after this many seconds (Ctrl-C also sends it)
        #[arg(long)]
        cancel_after: Option<u64>,
        /// Reopen an existing session with session/load or session/resume
        #[arg(long)]
        session: Option<String>,
    },
    /// Send a prompt from several profiles at once (checks key isolation)
    Parallel {
        targets: Vec<String>,
        #[arg(long)]
        prompt: String,
        #[arg(long, value_enum, default_value_t = Policy::Reject)]
        permission: Policy,
    },
    /// Run a light benchmark concurrently (tokenizer fingerprint, fixed-answer questions, speed)
    Bench {
        targets: Vec<String>,
        /// Number of question sets to run (1 set = 4 questions)
        #[arg(long, default_value_t = 2)]
        trials: u64,
    },
    /// Coding benchmark (4 small Rust tasks, graded with hidden tests)
    Codebench {
        targets: Vec<String>,
        /// Don't run anything; regrade the work folders from a codebench-*.json
        #[arg(long)]
        regrade: Option<PathBuf>,
    },
    /// Collect caps for all agents and write probe-runs/matrix.md
    Matrix { targets: Vec<String> },
    /// Manage API keys in the Keychain
    Keys {
        #[command(subcommand)]
        cmd: KeysCmd,
    },
}

#[derive(Subcommand)]
enum KeysCmd {
    /// Store (value is read interactively)
    Set { profile: String, var: String },
    /// Delete
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
    let opts =
        Opts { root: scenario::root_of(&cli.config), policy: Policy::Ask, quiet: false, cwd: cli.cwd.clone(), auth: cli.auth.clone(), mode: cli.mode.clone() };

    match cli.cmd {
        Cmd::List => {
            println!("Agents:");
            for (id, a) in &cfg.agents {
                println!("  {id:10} {} {}", a.command, a.args.join(" "));
            }
            println!("Profiles:");
            for (name, p) in &cfg.profiles {
                let keys: Vec<_> = p.keys.iter().map(|(k, v)| format!("{k}←{v}")).collect();
                println!("  {name:16} agent={} isolate={} {}", p.agent, p.isolate, keys.join(" "));
            }
        }
        Cmd::Caps { target } => {
            scenario::caps(&cfg, &target, &opts).await?;
        }
        Cmd::Run { target, prompt, permission, cancel_after, session } => {
            if prompt.is_none() && session.is_none() {
                anyhow::bail!("Specify --prompt or --session");
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
            eprintln!("wrote: {}", path.display());
        }
        Cmd::Codebench { targets, regrade } => {
            let path = match regrade {
                Some(json) => codebench::regrade(&json).await?,
                None => codebench::codebench(Arc::new(cfg), targets, opts).await?,
            };
            eprintln!("wrote: {}", path.display());
        }
        Cmd::Matrix { targets } => {
            let path = scenario::matrix(&cfg, targets, &opts).await?;
            eprintln!("wrote: {}", path.display());
        }
        Cmd::Keys { .. } => unreachable!(),
    }
    Ok(())
}
