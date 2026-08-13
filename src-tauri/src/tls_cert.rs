// Self-signed TLS certificate for the shared LAN server. Plain HTTP was the original design, but
// getUserMedia() (camera/mic -- needed for video calls and QR scanning) requires a "secure
// context": HTTPS, or literally localhost. A LAN IP like 172.20.10.3 over plain HTTP never
// qualifies, no matter what -- confirmed live when a user's iPhone Safari never even showed a
// permission prompt for a video call reached over the LAN URL. There's no real domain name or
// public DNS for a clinic's local network, so a normal CA-issued certificate isn't an option;
// self-signed is the standard answer for local-network HTTPS, at the cost of each device needing
// a one-time manual "trust this certificate" step (see shared_server.rs's cert-download route).
use std::path::Path;

const CERT_FILE: &str = "clinux-shared-cert.pem";
const KEY_FILE: &str = "clinux-shared-key.pem";
const SANS_FILE: &str = "clinux-shared-cert-sans.txt"; // which SANs the cached cert actually covers

/// Returns (cert_pem, key_pem) for the shared server's TLS. Reuses a cached cert across ordinary
/// restarts on the SAME network -- regenerating on every launch would force every device to
/// re-trust a brand new certificate for no reason, defeating "trust it once". Only regenerates
/// when there's no cache yet, or the host machine's LAN IP has changed since the cert was last
/// generated (a different WiFi network, a new DHCP lease, ...) -- the old cert's SAN list
/// wouldn't cover the new IP, so devices would need to re-trust anyway; there's no way around
/// that without a real DNS name, which a LAN clinic setup doesn't have.
pub fn load_or_generate(app_data_dir: &Path, lan_ip: &str) -> (Vec<u8>, Vec<u8>) {
    let cert_path = app_data_dir.join(CERT_FILE);
    let key_path = app_data_dir.join(KEY_FILE);
    let sans_path = app_data_dir.join(SANS_FILE);

    let cached_sans = std::fs::read_to_string(&sans_path).unwrap_or_default();
    let still_covers_current_ip = cached_sans.lines().any(|l| l == lan_ip);

    if still_covers_current_ip {
        if let (Ok(cert), Ok(key)) = (std::fs::read(&cert_path), std::fs::read(&key_path)) {
            log::info!("reusing cached self-signed TLS certificate (covers {lan_ip})");
            return (cert, key);
        }
    }

    log::info!("generating a new self-signed TLS certificate for the shared server (covers localhost, 127.0.0.1, {lan_ip}) -- devices will need to (re-)trust it");
    let sans = vec!["localhost".to_string(), "127.0.0.1".to_string(), lan_ip.to_string()];
    let rcgen::CertifiedKey { cert, signing_key } = rcgen::generate_simple_self_signed(sans.clone())
        .expect("failed to generate self-signed certificate");
    let cert_pem = cert.pem();
    let key_pem = signing_key.serialize_pem();

    let _ = std::fs::create_dir_all(app_data_dir);
    let _ = std::fs::write(&cert_path, &cert_pem);
    let _ = std::fs::write(&key_path, &key_pem);
    let _ = std::fs::write(&sans_path, sans.join("\n"));

    (cert_pem.into_bytes(), key_pem.into_bytes())
}
