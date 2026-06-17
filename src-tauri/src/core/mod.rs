pub mod app;
#[cfg(feature = "cli")]
pub mod cli;
pub mod downloads;
pub mod extensions;
pub mod filesystem;
pub mod mcp;
pub mod server;
pub mod setup;
pub mod state;
pub mod system;
pub mod threads;
pub mod web_server;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod updater;
