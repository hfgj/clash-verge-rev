//! HFGJ: macOS system DNS is user-owned.
//!
//! The fork intentionally never reads or writes system DNS settings. This
//! function keeps upstream call sites intact while doing nothing.

/// HFGJ no-op: never install, restore, or rewrite the macOS system DNS.
pub async fn sync_public_dns() {}
