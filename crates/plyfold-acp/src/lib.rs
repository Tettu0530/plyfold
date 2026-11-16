//! Plyfold の ACP クライアント
//!
//! - 輸送（[`transport`]）は自前の小さな JSON-RPC。送受信した全メッセージを [`FrameSink`] に流せる
//! - 型は公式の `agent-client-protocol-schema`（v1）を使う。ただし未知の更新でも落ちないよう、
//!   session/update は生の JSON も必ず残す（[`AgentMessage::Update`]）

pub mod client;
pub mod redact;
pub mod transport;

pub use agent_client_protocol_schema::v1 as schema;
pub use client::{AcpClient, AgentMessage, TurnResult};
pub use redact::Redactor;
pub use transport::{AcpError, Connection, Direction, FrameSink, Incoming, SpawnSpec};
