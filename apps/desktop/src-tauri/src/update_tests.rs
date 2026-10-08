use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};

#[test]
#[ignore = "requires an actual signed installer from a release build"]
fn built_installer_has_valid_versioned_signature() {
    let installer =
        std::env::var("SPATIAL_UPDATE_INSTALLER").expect("Set SPATIAL_UPDATE_INSTALLER");
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let key = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let key = String::from_utf8(STANDARD.decode(key).unwrap()).unwrap();
    let key = PublicKey::decode(&key).unwrap();
    let encoded = std::fs::read_to_string(format!("{installer}.sig")).unwrap();
    let signed = String::from_utf8(STANDARD.decode(encoded.trim()).unwrap()).unwrap();
    let signature = Signature::decode(&signed).unwrap();
    let payload = std::fs::read(installer).unwrap();
    key.verify(&payload, &signature, false).unwrap();
    let signed_version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .unwrap();
    assert_eq!(signed_version, config["version"].as_str().unwrap());
    let mut changed = payload;
    changed[0] ^= 1;
    assert!(key.verify(&changed, &signature, false).is_err());
}

#[test]
fn updater_key_authenticates_payload_and_rejects_tampering() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let key = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let key = String::from_utf8(STANDARD.decode(key).unwrap()).unwrap();
    let key = PublicKey::decode(&key).unwrap();
    let signed = String::from_utf8(
        STANDARD
            .decode(include_str!("../../tests/fixtures/update-payload.txt.sig").trim())
            .unwrap(),
    )
    .unwrap();
    let signature = Signature::decode(&signed).unwrap();
    let payload = include_bytes!("../../tests/fixtures/update-payload.txt");
    key.verify(payload, &signature, false).unwrap();
    assert!(key.verify(b"changed installer", &signature, false).is_err());
    let mut changed = signed.into_bytes();
    let position = changed.iter().position(|byte| *byte == b'\n').unwrap() + 5;
    changed[position] = if changed[position] == b'A' {
        b'B'
    } else {
        b'A'
    };
    let changed = Signature::decode(std::str::from_utf8(&changed).unwrap()).unwrap();
    assert!(key.verify(payload, &changed, false).is_err());
    assert!(signature.trusted_comment().contains("0.1.3"));
    assert_eq!(config["plugins"]["updater"]["requireSignedVersion"], true);
}
