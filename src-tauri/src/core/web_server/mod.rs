//! Web UI server: serves the built web app + an authenticated JSON API that
//! reuses the existing Tauri command implementations.

pub mod auth;
pub mod commands;
pub mod server;
