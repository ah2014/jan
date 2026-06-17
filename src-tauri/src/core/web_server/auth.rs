//! Simple single-password auth for the web UI.
//!
//! Model: one password (configured via Settings) gates every `/api/*` call.
//! On successful `POST /api/auth/login` the server sets a signed, HttpOnly
//! session cookie. The cookie is `payload.signature` where `payload` is the
//! base64url-encoded expiry timestamp (seconds since epoch) and `signature`
//! is HMAC-SHA256(password_hash, payload). Re-keying on the password hash
//! means changing the password invalidates all outstanding sessions — which
//! is the desired behaviour.

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub const COOKIE_NAME: &str = "jan_web_session";
/// Sessions are valid for 30 days.
pub const SESSION_TTL_SECS: u64 = 30 * 24 * 60 * 60;

/// SHA-256 hex digest of the password. Stored at rest in `store.json` so the
/// raw password is never persisted.
pub fn hash_password(password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hex::encode(hasher.finalize())
}

/// Constant-time-ish comparison of two hex digests.
pub fn verify_password(password: &str, expected_hash: &str) -> bool {
    let actual = hash_password(password);
    // `hex` strings are equal-length; compare in a way that short-circuits on
    // length mismatch only (which leaks no useful secret material).
    if actual.len() != expected_hash.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (a, b) in actual.bytes().zip(expected_hash.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Build a signed session token: `base64url(expiry).hmac_hex`.
pub fn create_session_token(password_hash: &str) -> Option<String> {
    if password_hash.is_empty() {
        return None;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let expiry = now + SESSION_TTL_SECS;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(expiry.to_le_bytes());

    let mut mac = HmacSha256::new_from_slice(password_hash.as_bytes()).ok()?;
    mac.update(payload.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());
    Some(format!("{payload}.{sig}"))
}

/// Verify a session token. Returns `true` if the signature matches and the
/// token has not expired.
pub fn verify_session_token(token: &str, password_hash: &str) -> bool {
    if password_hash.is_empty() {
        return false;
    }
    let (payload, sig) = match token.rsplit_once('.') {
        Some((p, s)) => (p, s),
        None => return false,
    };

    let mut mac = match HmacSha256::new_from_slice(password_hash.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(payload.as_bytes());
    if let Err(_) = mac.verify_slice(hex::decode(sig).unwrap_or_default().as_slice()) {
        return false;
    }

    // Decode expiry and ensure it is still in the future.
    let bytes = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) {
        Ok(b) => b,
        Err(_) => return false,
    };
    if bytes.len() < 8 {
        return false;
    }
    let expiry = u64::from_le_bytes(bytes[..8].try_into().unwrap_or([0u8; 8]));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    expiry > now
}

/// Extract the value of `name` from a `Cookie:` header.
pub fn parse_cookie(header: Option<&str>, name: &str) -> Option<String> {
    let header = header?;
    for entry in header.split(';') {
        let entry = entry.trim();
        if let Some((k, v)) = entry.split_once('=') {
            if k.trim() == name {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Build the `Set-Cookie` header value for a session cookie.
pub fn session_cookie(value: &str, max_age_secs: u64) -> String {
    format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        COOKIE_NAME,
        value,
        max_age_secs
    )
}

/// Build a `Set-Cookie` header that clears the session cookie.
pub fn clear_cookie() -> String {
    format!(
        "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        COOKIE_NAME
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_round_trips() {
        let hash = hash_password("hunter2");
        assert!(verify_password("hunter2", &hash));
        assert!(!verify_password("wrong", &hash));
    }

    #[test]
    fn session_token_round_trips() {
        let hash = hash_password("hunter2");
        let token = create_session_token(&hash).expect("token");
        assert!(verify_session_token(&token, &hash));
        // Wrong key invalidates.
        assert!(!verify_session_token(&token, &hash_password("other")));
    }

    #[test]
    fn token_rejects_garbage() {
        let hash = hash_password("hunter2");
        assert!(!verify_session_token("not-a-token", &hash));
        assert!(!verify_session_token("aaaa.bbbb", &hash));
    }

    #[test]
    fn cookie_parsing() {
        let header = "other=1; jan_web_session=abc.def; foo=bar";
        assert_eq!(
            parse_cookie(Some(header), COOKIE_NAME),
            Some("abc.def".to_string())
        );
        assert_eq!(parse_cookie(Some(header), "missing"), None);
        assert_eq!(parse_cookie(None, COOKIE_NAME), None);
    }
}
