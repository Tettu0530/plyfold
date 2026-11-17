//! Plyfold's ACP client
//!
//! - The transport ([`transport`]) is a small in-house JSON-RPC. Every message sent or received can be fed to a [`FrameSink`]
//! - Types come from the official `agent-client-protocol-schema` (v1). So that unknown updates do not break us,
//!   session/update always keeps the raw JSON as well ([`AgentMessage::Update`])

pub mod client;
pub mod redact;
pub mod transport;

pub use agent_client_protocol_schema::v1 as schema;
pub use client::{AcpClient, AgentMessage, TurnResult};
pub use redact::Redactor;
pub use transport::{AcpError, Connection, Direction, FrameSink, Incoming, SpawnSpec};
